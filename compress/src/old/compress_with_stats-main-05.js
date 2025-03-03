import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

// Get the current filename and directory in ES module scope
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Function to recursively find all .glb, .gltf, and .b3dm files in the directory
function findFiles(dir, exts) {
    let results = [];
    const list = fs.readdirSync(dir);
    for (let file of list) {
        file = path.resolve(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            results = results.concat(findFiles(file, exts));
        } else {
            const ext = path.extname(file).toLowerCase();
            if (exts.includes(ext)) {
                results.push(file);
            }
        }
    }
    return results;
}

// Function to process files using child processes
function processFiles(files, dracoCompression, ktx) {
    const numCPUs = Math.max(1, os.cpus().length - 1); // Leave one CPU free, ensure at least one
    let completedTasks = 0;
    const totalFiles = files.length;
    const startTime = Date.now();
    let activeProcesses = 0;
    
    console.log(`Starting processing of ${totalFiles} files with ${numCPUs} parallel processes.`);

    for (let i = 0; i < numCPUs && i < totalFiles; i++) {
        runChildProcess(files[completedTasks], dracoCompression, ktx);
    }

    function runChildProcess(file, dracoCompression, ktx) {
        activeProcesses++;
        const child = fork(path.resolve(__dirname, 'compress_with_stats-worker-02.js'), [file, dracoCompression, ktx]);

        child.on('message', (message) => {
//            console.log(message);
            handleCompletion();
        });

        child.on('error', (err) => {
            console.error(`Error in child process: ${err.message}`);
            handleCompletion();
        });

        child.on('exit', (code) => {
            if (code !== 0) console.error(`Child process exited with code ${code}`);
        });

        function handleCompletion() {
            completedTasks++;
            activeProcesses--;
            updateProgress();

            if (completedTasks < totalFiles) {
                // Start the next file only if there are files left
                runChildProcess(files[completedTasks], dracoCompression, ktx);
            } else if (activeProcesses === 0) {
                // Finish processing only after all processes have completed
                finishProcessing(startTime);
            }
        }
    }

    function updateProgress() {
        const remainingFiles = totalFiles - completedTasks;
        console.log(`Processed: ${completedTasks}/${totalFiles}, Remaining: ${remainingFiles}`);
    }

    function finishProcessing(startTime) {
        const endTime = Date.now();
        const totalTime = (endTime - startTime) / 1000; // in seconds
        const averageTimePerFile = totalTime / totalFiles;
        console.log(`\nAll tasks completed.`);
        console.log(`Total files processed: ${totalFiles}`);
        console.log(`Total time taken: ${totalTime.toFixed(2)} seconds`);
        console.log(`Average processing time per file: ${averageTimePerFile.toFixed(4)} seconds`);
    }
}

// Main thread
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node script.js <folder> [dracoCompression:true/false] [ktx:true/false]');
    process.exit(1);
}

const folderPath = args[0];
const dracoCompression = args[1] === 'true';
const ktx = args[2] === 'true';

if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
    console.error('Provided path is not a valid directory.');
    process.exit(1);
}

const files = findFiles(folderPath, ['.glb', '.gltf', '.b3dm']);
console.log(`Found ${files.length} files to process.`);
processFiles(files, dracoCompression, ktx);
