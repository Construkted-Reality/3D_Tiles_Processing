// qwen 2.5 , multithreaded, no b3dm, batch processing

import { NodeIO, PropertyType, Document } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import path from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';
import { exec } from 'child_process';

if (isMainThread) {
    // Main thread code
    const numCPUs = os.cpus().length;

    async function distributeWork(files, outputFolderPath) {
        const chunkSize = Math.ceil(files.length / numCPUs);
        const workers = [];
        for (let i = 0; i < numCPUs; i++) {
            const start = i * chunkSize;
            const end = start + chunkSize;
            const fileChunk = files.slice(start, end);
            if (fileChunk.length > 0) {
                const worker = new Worker(new URL(import.meta.url), {
                    workerData: {
                        files: fileChunk,
                        outputFolderPath
                    }
                });
                workers.push(new Promise((resolve, reject) => {
                    worker.on('message', resolve);
                    worker.on('error', reject);
                    worker.on('exit', (code) => {
                        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
                    });
                }));
            }
        }
        await Promise.all(workers);
    }

    async function crawlFolder(folderPath) {
        const files = [];
        async function crawl(currentPath) {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    await crawl(fullPath);
                } else if (path.extname(entry.name).toLowerCase() === '.glb') {
                    files.push(fullPath);
                }
            }
        }
        await crawl(folderPath);
        return files;
    }

    // Get command line arguments
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node script.js <folder>');
        process.exit(1);
    }
    const inputFolderPath = args[0];
    const outputFolderPath = path.join(inputFolderPath, 'processed');

    // Ensure the output directory exists
    fs.ensureDirSync(outputFolderPath);

    // Start processing
    console.log(`Starting processing using ${numCPUs} CPU cores...`);
    crawlFolder(inputFolderPath)
        .then(files => distributeWork(files, outputFolderPath))
        .then(() => console.log('Processing complete.'))
        .catch(e => console.error('Error during processing:', e));
} else {
    // Worker thread code

    function batchConvertToKTX(inputFiles, outputDir) {
        const commands = inputFiles.map(file => {
            const outputPath = path.join(outputDir, path.basename(file, path.extname(file)) + '.ktx');
            return `toktx --t2 --encode etc1s --clevel 1 --qlevel 125 "${outputPath}" "${file}"`;
        });
        return Promise.all(commands.map(cmd => {
            return new Promise((resolve, reject) => {
                exec(cmd, (error, stdout, stderr) => {
                    if (error) reject(error);
                    else resolve(stdout);
                });
            });
        }));
    }

    async function initIO() {
        const io = new NodeIO()
            .registerExtensions(KHRONOS_EXTENSIONS)
            .registerDependencies({
                'draco3d.decoder': await draco3d.createDecoderModule(),
                'draco3d.encoder': await draco3d.createEncoderModule(),
            });
        return io;
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
        statistics.textures = textures.map(texture => ({
            encoding: texture.getMimeType(),
            resolution: texture.getImage() ? `${texture.getImage().width}x${texture.getImage().height}` : 'N/A'
        }));
        return statistics;
    }

/**
    async function compress(document) {
        let transforms = [];
        transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
        transforms.push(flatten());
        transforms.push(join({ keepNamed: false }));
        const statistics = await extractStatistics(document);
        if (!statistics.dracoCompressed) {
            transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
        }

        return document.transform(...transforms);
    }
**/

    async function compress(document) {
        let transforms = [];
        const statistics = await extractStatistics(document);
        
        // Always apply these optimizations
        transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
        transforms.push(flatten());
        transforms.push(join({ keepNamed: false }));
        
        // Only apply Draco compression if not already compressed
        if (!statistics.dracoCompressed) {
            console.log('Applying Draco compression...');
            transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
        } else {
            console.log('Mesh is already Draco compressed, skipping compression...');
        }
        
        return document.transform(...transforms);
    }

/**
    async function processFile(inputFilePath, outputFolderPath, io) {
        try {
            const document = await io.read(inputFilePath);
            const processedDocument = await compress(document);

            // Extract textures and convert them to KTX format
            const tempImagePaths = [];
            for (const texture of processedDocument.getRoot().listTextures()) {
                if (texture.getMimeType() !== 'image/ktx') {
                    const imageBuffer = texture.getImage();
                    if (!imageBuffer) continue; // Skip if no image buffer is available

                    const tempImagePath = path.join(outputFolderPath, `${path.basename(inputFilePath, '.glb')}_${tempImagePaths.length}.png`);
                    fs.writeFileSync(tempImagePath, imageBuffer);
                    tempImagePaths.push(tempImagePath);
                }
            }

            if (tempImagePaths.length > 0) {
                await batchConvertToKTX(tempImagePaths, outputFolderPath);

                // Replace the original textures with KTX textures
                for (let i = 0; i < processedDocument.getRoot().listTextures().length; i++) {
                    const texture = processedDocument.getRoot().listTextures()[i];
                    if (texture.getMimeType() !== 'image/ktx') {
                        const ktxPath = path.join(outputFolderPath, `${path.basename(inputFilePath, '.glb')}_${i}.ktx`);
                        const ktxBuffer = fs.readFileSync(ktxPath);
                        texture.setImage(ktxBuffer, 'image/ktx');
                    }
                }

                // Clean up temporary PNG files
                tempImagePaths.forEach(fs.unlinkSync);
            }

            const relativePath = path.relative(path.dirname(inputFilePath), inputFilePath);
            const outputFilePath = path.join(outputFolderPath, relativePath);
            fs.ensureDirSync(path.dirname(outputFilePath));
            const glb = await io.writeBinary(processedDocument);
            fs.writeFileSync(outputFilePath, glb);
            console.log(`Processed: ${inputFilePath}`);
        } catch (error) {
            console.error(`Error processing ${inputFilePath}:`, error);
        }
    }
**/

async function processFile(inputFilePath, outputFolderPath, io) {
    try {
        const document = await io.read(inputFilePath);
        const processedDocument = await compress(document);
        
        // Extract textures and convert them to KTX format
        const tempImagePaths = [];
        const texturesToProcess = [];
        
        // First, identify which textures need processing
        processedDocument.getRoot().listTextures().forEach((texture, index) => {
            if (texture.getMimeType() === 'image/ktx') {
                console.log(`Texture ${index} is already in KTX format, skipping...`);
            } else {
                const imageBuffer = texture.getImage();
                if (imageBuffer) {
                    texturesToProcess.push({ texture, index });
                    const tempImagePath = path.join(outputFolderPath, 
                        `${path.basename(inputFilePath, '.glb')}_${index}.png`);
                    fs.writeFileSync(tempImagePath, imageBuffer);
                    tempImagePaths.push(tempImagePath);
                }
            }
        });

        // Only process textures that aren't already in KTX format
        if (tempImagePaths.length > 0) {
            await batchConvertToKTX(tempImagePaths, outputFolderPath);
            
            // Replace only the non-KTX textures with their converted versions
            for (const { texture, index } of texturesToProcess) {
                const ktxPath = path.join(outputFolderPath, 
                    `${path.basename(inputFilePath, '.glb')}_${index}.ktx`);
                const ktxBuffer = fs.readFileSync(ktxPath);
                texture.setImage(ktxBuffer, 'image/ktx');
            }
            
            // Clean up temporary PNG files
            tempImagePaths.forEach(fs.unlinkSync);
            
            // Clean up converted KTX files
            texturesToProcess.forEach(({ index }) => {
                const ktxPath = path.join(outputFolderPath, 
                    `${path.basename(inputFilePath, '.glb')}_${index}.ktx`);
                fs.unlinkSync(ktxPath);
            });
        }

        const relativePath = path.relative(path.dirname(inputFilePath), inputFilePath);
        const outputFilePath = path.join(outputFolderPath, relativePath);
        fs.ensureDirSync(path.dirname(outputFilePath));
        const glb = await io.writeBinary(processedDocument);
        fs.writeFileSync(outputFilePath, glb);
        console.log(`Processed: ${inputFilePath}`);
        
    } catch (error) {
        console.error(`Error processing ${inputFilePath}:`, error);
    }
}


    // Process files in worker
    (async () => {
        const io = await initIO();
        const { files, outputFolderPath } = workerData;
        for (const file of files) {
            await processFile(file, outputFolderPath, io);
        }
        parentPort.postMessage('done');
    })();
}
