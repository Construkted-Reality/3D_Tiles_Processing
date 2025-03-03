// Antropic, multithreaded, no b3dm

import { NodeIO, PropertyType, Document } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import path from 'path';
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import os from 'os';

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

    // Start processing
    console.log(`Starting processing using ${numCPUs} CPU cores...`);
    crawlFolder(inputFolderPath)
        .then(files => distributeWork(files, outputFolderPath))
        .then(() => console.log('Processing complete.'))
        .catch(e => console.error('Error during processing:', e));

} else {
    // Worker thread code
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
            transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
        }

        return document.transform(...transforms);
    }

    async function processFile(inputFilePath, outputFolderPath, io) {
        try {
            const document = await io.read(inputFilePath);
            const processedDocument = await compress(document);
            
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
