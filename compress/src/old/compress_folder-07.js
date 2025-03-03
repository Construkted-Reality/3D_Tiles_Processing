import { NodeIO, PropertyType, Document } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';

// Configure I/O.
const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
    });

const logFilePath = path.join(process.cwd(), 'process.log');
fs.ensureFileSync(logFilePath);
const logStream = fs.createWriteStream(logFilePath, { flags: 'a' });

/**
 * Logs message both to the console and to a file.
 */
function logMessage(message) {
    console.log(message);
    logStream.write(`${new Date().toISOString()} - ${message}\n`);
}

async function extractStatistics(document) {
    const statistics = {};
    const dracoExtension = document.getRoot().listExtensionsUsed().find(ext => ext.extensionName === 'KHR_draco_mesh_compression');
    statistics.dracoCompressed = !!dracoExtension;
    
    let triangleCount = 0;
    for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
            const indicesAccessor = primitive.getIndices();
            if (indicesAccessor) {
                triangleCount += indicesAccessor.getCount() / 3;
            }
        }
    }
    statistics.triangleCount = triangleCount;
    
    const textures = document.getRoot().listTextures();
    statistics.textures = textures.map(texture => {
        const mimeType = texture.getMimeType();
        const image = texture.getImage();
        const resolution = image ? `${image.width}x${image.height}` : 'N/A';
        return {
            encoding: mimeType,
            resolution: resolution
        };
    });
    return statistics;
}

async function compress(document) {
    let transforms = [];
    transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
    transforms.push(flatten());
    transforms.push(join({ keepNamed: false }));
    
    const statistics = await extractStatistics(document);
    if (!statistics.dracoCompressed) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
    }
    
    if (statistics.textures.some(tex => tex.encoding !== 'image/ktx')) {
        try {
            transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
        } catch (error) {
            logMessage('Initial toktx check failed, retrying: ' + error);
            try {
                transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
            } catch (retryError) {
                logMessage('Retry failed: ' + retryError);
                throw retryError;
            }
        }
    }
    return document.transform(...transforms);
}

async function processFile(inputFilePath, outputFolderPath, totalFiles, processedFilesRef) {
    const start = Date.now();
    const ext = path.extname(inputFilePath).toLowerCase();
    let document;
    
    if (ext === '.b3dm') {
        const arrayBuffer = fs.readFileSync(inputFilePath);
        const glbStart = 28 + getFeatureTableLength(arrayBuffer) + getBatchTableLength(arrayBuffer);
        const glbBytes = arrayBuffer.subarray(glbStart, arrayBuffer.byteLength);
        document = await io.readBinary(glbBytes).catch(e => logMessage(`Error reading ${inputFilePath}: ${e}`));
    } else if (ext === '.glb') {
        document = await io.read(inputFilePath).catch(e => logMessage(`Error reading ${inputFilePath}: ${e}`));
    } else {
        logMessage(`Unsupported file format: ${ext}`);
        return;
    }

    if (!document) return;

    const processedDocument = await compress(document);

    const relativePath = path.relative(inputFolderPath, inputFilePath);
    const outputFilePath = path.join(outputFolderPath, relativePath.replace(ext, '.glb'));
    fs.ensureDirSync(path.dirname(outputFilePath));
    const glb = await io.writeBinary(processedDocument).catch(e => logMessage(`Error writing ${outputFilePath}: ${e}`));
    if (glb) {
        fs.writeFileSync(outputFilePath, glb);
        const end = Date.now();
        const timeTaken = (end - start) / 1000;
        
        processedFilesRef.count++;
        const remainingFiles = totalFiles - processedFilesRef.count;
        const avgTimePerFile = processedFilesRef.sumTime / processedFilesRef.count;
        const estimatedRemainingTime = remainingFiles * avgTimePerFile;

        processedFilesRef.sumTime += timeTaken;

        logMessage(`Processed and saved: ${outputFilePath} in ${timeTaken.toFixed(2)}s. Remaining files: ${remainingFiles}, Estimated time left: ${estimatedRemainingTime.toFixed(2)}s`);
    }
}

function getFeatureTableLength(arrayBuffer) {
    return arrayBuffer.readInt32LE(12) + arrayBuffer.readInt32LE(16);
}

function getBatchTableLength(arrayBuffer) {
    return arrayBuffer.readInt32LE(20) + arrayBuffer.readInt32LE(24);
}

async function collectFiles(folderPath) {
    let files = [];
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    
    for (const entry of entries) {
        const fullPath = path.join(folderPath, entry.name);
        if (entry.isDirectory()) {
            files = [...files, ...(await collectFiles(fullPath))];
        } else if (['.glb', '.b3dm'].includes(path.extname(entry.name).toLowerCase())) {
            files.push(fullPath);
        }
    }
    
    return files;
}

async function processFilesConcurrently(files, outputFolderPath, concurrencyLimit) {
    const processedFilesRef = { count: 0, sumTime: 0 };
    const limit = pLimit(concurrencyLimit);
    
    const processingPromises = files.map(file => limit(() => processFile(file, outputFolderPath, files.length, processedFilesRef)));
    await Promise.all(processingPromises);
    
    const avgTime = processedFilesRef.sumTime / processedFilesRef.count;
    logMessage(`Summary: Total files processed: ${processedFilesRef.count}, Average processing time per file: ${avgTime.toFixed(2)}s`);
}

// Get command line arguments
const args = process.argv.slice(2);

if (args.length < 2) {
    logMessage('Usage: node script.js <folder> <concurrency_limit>');
    process.exit(1);
}

const inputFolderPath = args[0];
const concurrencyLimit = parseInt(args[1], 10);

if (isNaN(concurrencyLimit) || concurrencyLimit <= 0) {
    logMessage('Concurrency limit must be a positive integer.');
    process.exit(1);
}

const outputFolderPath = path.join(inputFolderPath, 'processed');

// Start collecting files and processing them concurrently
collectFiles(inputFolderPath)
    .then(files => processFilesConcurrently(files, outputFolderPath, concurrencyLimit))
    .then(() => {
        logMessage('Processing complete.');
        logStream.end();  // End the stream after all operations are finished
    })
    .catch(e => logMessage('Error during folder crawling or file processing: ' + e));
