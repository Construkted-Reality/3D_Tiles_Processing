import { NodeIO, PropertyType, Document } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import path from 'path';
import pLimit from 'p-limit';
import winston from 'winston';

// Configure logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level}]: ${message}`;
        })
    ),
    transports: [
        new winston.transports.File({ filename: 'processing.log' }),
        new winston.transports.Console()
    ]
});

// Progress tracking
class ProgressTracker {
    constructor(totalFiles) {
        this.totalFiles = totalFiles;
        this.processedFiles = 0;
        this.startTime = Date.now();
        this.processingTimes = [];
    }

    updateProgress(fileProcessingTime) {
        this.processedFiles++;
        this.processingTimes.push(fileProcessingTime);
        
        const averageTime = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
        const remainingFiles = this.totalFiles - this.processedFiles;
        const estimatedTimeRemaining = (remainingFiles * averageTime) / 1000; // in seconds

        logger.info(`Progress: ${this.processedFiles}/${this.totalFiles} files processed`);
        logger.info(`Last file processing time: ${fileProcessingTime.toFixed(2)}ms`);
        logger.info(`Estimated time remaining: ${estimatedTimeRemaining.toFixed(2)} seconds`);
    }

    getSummary() {
        const totalTime = (Date.now() - this.startTime) / 1000; // in seconds
        const averageTime = this.processingTimes.reduce((a, b) => a + b, 0) / this.processingTimes.length;
        
        return {
            totalFiles: this.totalFiles,
            processedFiles: this.processedFiles,
            totalTime: totalTime.toFixed(2),
            averageProcessingTime: averageTime.toFixed(2)
        };
    }
}

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
        try {
            transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
        } catch (error) {
            console.warn('Initial toktx check failed, retrying:', error);
            // Retry once
            try {
                transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
            } catch (retryError) {
                console.error('Retry failed:', retryError);
                throw retryError;
            }
        }
    }

    return document.transform(...transforms);
}

function getFeatureTableLength(arrayBuffer) {
    return arrayBuffer.readInt32LE(12) + arrayBuffer.readInt32LE(16);
}

function getBatchTableLength(arrayBuffer) {
    return arrayBuffer.readInt32LE(20) + arrayBuffer.readInt32LE(24);
}

async function processFile(inputFilePath, outputFolderPath, progressTracker) {
    const startTime = Date.now();
    const ext = path.extname(inputFilePath).toLowerCase();
    let document;

    try {
        if (ext === '.b3dm') {
            const arrayBuffer = fs.readFileSync(inputFilePath);
            const glbStart = 28 + getFeatureTableLength(arrayBuffer) + getBatchTableLength(arrayBuffer);
            const glbBytes = arrayBuffer.subarray(glbStart, arrayBuffer.byteLength);
            document = await io.readBinary(glbBytes);
        } else if (ext === '.glb') {
            document = await io.read(inputFilePath);
        } else {
            logger.warn(`Unsupported file format: ${ext}`);
            return;
        }

        const processedDocument = await compress(document);
        const relativePath = path.relative(inputFolderPath, inputFilePath);
        const outputFilePath = path.join(outputFolderPath, relativePath.replace(ext, '.glb'));
        fs.ensureDirSync(path.dirname(outputFilePath));
        
        const glb = await io.writeBinary(processedDocument);
        if (glb) {
            fs.writeFileSync(outputFilePath, glb);
            const processingTime = Date.now() - startTime;
            progressTracker.updateProgress(processingTime);
            logger.info(`Processed and saved: ${outputFilePath}`);
        }
    } catch (error) {
        logger.error(`Error processing ${inputFilePath}: ${error.message}`);
    }
}

async function processFilesConcurrently(files, outputFolderPath, concurrencyLimit) {
    const progressTracker = new ProgressTracker(files.length);
    const limit = pLimit(concurrencyLimit);

    logger.info(`Starting processing of ${files.length} files with concurrency limit of ${concurrencyLimit}`);

    const processingPromises = files.map(file => 
        limit(() => processFile(file, outputFolderPath, progressTracker))
    );

    await Promise.all(processingPromises);

    const summary = progressTracker.getSummary();
    logger.info('Processing complete. Summary:');
    logger.info(`Total files processed: ${summary.processedFiles}/${summary.totalFiles}`);
    logger.info(`Total processing time: ${summary.totalTime} seconds`);
    logger.info(`Average processing time per file: ${summary.averageProcessingTime}ms`);
}

// Configure I/O
const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
    });

// Main execution
const args = process.argv.slice(2);
if (args.length < 2) {
    logger.error('Usage: node script.js <folder> <concurrency_limit>');
    process.exit(1);
}

const inputFolderPath = args[0];
const concurrencyLimit = parseInt(args[1], 10);

if (isNaN(concurrencyLimit) || concurrencyLimit <= 0) {
    logger.error('Concurrency limit must be a positive integer.');
    process.exit(1);
}

const outputFolderPath = path.join(inputFolderPath, 'processed');

collectFiles(inputFolderPath)
    .then(files => processFilesConcurrently(files, outputFolderPath, concurrencyLimit))
    .catch(e => logger.error('Error during folder crawling or file processing:', e));
