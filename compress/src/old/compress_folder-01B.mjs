// Anthropic, Multithreaded

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

    // Configure I/O.
    const io = new NodeIO()
        .registerExtensions(KHRONOS_EXTENSIONS)
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(),
            'draco3d.encoder': await draco3d.createEncoderModule(),
        });

    async function getAllFiles(folderPath) {
        const files = [];
        async function crawl(currentPath) {
            const entries = await fs.readdir(currentPath, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(currentPath, entry.name);
                if (entry.isDirectory()) {
                    await crawl(fullPath);
                } else if (['.glb', '.b3dm'].includes(path.extname(entry.name).toLowerCase())) {
                    files.push(fullPath);
                }
            }
        }
        await crawl(folderPath);
        return files;
    }

    async function distributeWork(inputFolderPath, outputFolderPath) {
        const files = await getAllFiles(inputFolderPath);
        const chunkSize = Math.ceil(files.length / numCPUs);
        const workers = [];

        console.log(`Processing ${files.length} files using ${numCPUs} cores`);

        for (let i = 0; i < numCPUs; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, files.length);
            const fileChunk = files.slice(start, end);

            if (fileChunk.length === 0) continue;

            const worker = new Worker(new URL(import.meta.url), {
                workerData: {
                    files: fileChunk,
                    inputFolderPath,
                    outputFolderPath
                }
            });

            worker.on('message', message => console.log(message));
            worker.on('error', error => console.error(error));
            worker.on('exit', code => {
                if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
            });

            workers.push(worker);
        }

        await Promise.all(workers.map(worker => new Promise(resolve => worker.on('exit', resolve))));
        console.log('All processing complete.');
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
    distributeWork(inputFolderPath, outputFolderPath)
        .catch(e => console.error('Error during processing:', e));

} else {
    // Worker thread code
    const { files, inputFolderPath, outputFolderPath } = workerData;

    // Configure I/O for worker
    const io = new NodeIO()
        .registerExtensions(KHRONOS_EXTENSIONS)
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(),
            'draco3d.encoder': await draco3d.createEncoderModule(),
        });

    async function extractStatistics(document) {
        // ... (same as before)
    }

    async function compress(document) {
        // ... (same as before)
    }

    async function processFile(inputFilePath, outputFolderPath) {
        // ... (same as before)
    }

    function getFeatureTableLength(arrayBuffer) {
        // ... (same as before)
    }

    function getBatchTableLength(arrayBuffer) {
        // ... (same as before)
    }

    // Process files assigned to this worker
    async function processFiles() {
        for (const file of files) {
            try {
                await processFile(file, outputFolderPath);
                parentPort.postMessage(`Processed: ${file}`);
            } catch (error) {
                parentPort.postMessage(`Error processing ${file}: ${error.message}`);
            }
        }
    }

    processFiles()
        .then(() => parentPort.postMessage(`Worker finished processing ${files.length} files`))
        .catch(error => parentPort.postMessage(`Worker error: ${error.message}`));
}
