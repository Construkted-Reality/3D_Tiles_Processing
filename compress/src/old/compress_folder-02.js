import { NodeIO, PropertyType, Document } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import path from 'path';

// Configure I/O.
const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
    });

async function extractStatistics(document) {
    const statistics = {};
    // Check for Draco Compression
    const dracoExtension = document.getRoot().listExtensionsUsed().find(ext => ext.extensionName === 'KHR_draco_mesh_compression');
    statistics.dracoCompressed = !!dracoExtension;
    // Calculate Triangle Count
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
    // Texture Information
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

    // Check for draco compression and add the transform if needed
    const statistics = await extractStatistics(document);
    if (!statistics.dracoCompressed) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
    }

    // Check for KTX encoding and add the transform if needed
    if (statistics.textures.some(tex => tex.encoding !== 'image/ktx')) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
    }

    return document.transform(...transforms);
}

async function processFile(inputFilePath, outputFolderPath) {
    const ext = path.extname(inputFilePath).toLowerCase();
    let document;

    if (ext === '.b3dm') {
        const arrayBuffer = fs.readFileSync(inputFilePath);
        // Extract GLB part from B3DM
        const glbStart = 28 + getFeatureTableLength(arrayBuffer) + getBatchTableLength(arrayBuffer);
        const glbBytes = arrayBuffer.subarray(glbStart, arrayBuffer.byteLength);
        document = await io.readBinary(glbBytes).catch(e => console.error(`Error reading ${inputFilePath}:`, e));
    } else if (ext === '.glb') {
        document = await io.read(inputFilePath).catch(e => console.error(`Error reading ${inputFilePath}:`, e));
    } else {
        console.warn(`Unsupported file format: ${ext}`);
        return;
    }

    // Process the document
    const processedDocument = await compress(document);

    // Write the processed document to a new folder structure
    const relativePath = path.relative(inputFolderPath, inputFilePath);
    const outputFilePath = path.join(outputFolderPath, relativePath.replace(ext, '.glb'));
    fs.ensureDirSync(path.dirname(outputFilePath));
    const glb = await io.writeBinary(processedDocument).catch(e => console.error(`Error writing ${outputFilePath}:`, e));
    if (glb) {
        fs.writeFileSync(outputFilePath, glb);
        console.log(`Processed and saved: ${outputFilePath}`);
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

async function processFilesConcurrently(files, outputFolderPath) {
    const processingPromises = files.map(file => processFile(file, outputFolderPath));
    await Promise.all(processingPromises);
}

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node script.js <folder>');
    process.exit(1);
}
const inputFolderPath = args[0];
const outputFolderPath = path.join(inputFolderPath, 'processed');

// Start collecting files and processing them concurrently
collectFiles(inputFolderPath)
    .then(files => processFilesConcurrently(files, outputFolderPath))
    .then(() => console.log('Processing complete.'))
    .catch(e => console.error('Error during folder crawling or file processing:', e));
