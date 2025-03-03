import fs from 'fs';
import path from 'path';
import { fork } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

// Get the current filename and directory in the ES module scope
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
    const totalFiles = files.length;
    let completedTasks = 0;
    let activeProcesses = 0;
    const startTime = Date.now();
    console.log(`Starting processing of ${totalFiles} files with ${numCPUs} parallel processes.`);
    
    function runNextBatch() {
        // As long as we have room for more CPU processes
        while (activeProcesses < numCPUs && completedTasks < totalFiles) {
            runChildProcess(files[completedTasks++], dracoCompression, ktx);
        }
    }

    function runChildProcess(file, dracoCompression, ktx) {
        const child = fork(path.resolve(__dirname, 'compress_with_stats-worker-02.js'), [file, dracoCompression, ktx]);
        activeProcesses++;
        
        child.on('message', (message) => {
            handleCompletion(message);
        });
        
        child.on('error', (err) => {
            console.error(`Error in child process: ${err.message}`);
            handleCompletion(`Error processing ${file}: ${err.message}`);
        });
        
        child.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Child process exited with code ${code}`);
            }
        });
    }
/**
    function handleCompletion(message) {
        activeProcesses--;
        updateProgress(message);
        if (completedTasks < totalFiles) {
            runNextBatch();
        } else if (activeProcesses === 0) {
            finishProcessing();
        }
    }
**/

function handleCompletion(message) {
    activeProcesses--;
    updateProgress(message);
    if (completedTasks === totalFiles && activeProcesses === 0) {
        finishProcessing();
    } else if (activeProcesses < numCPUs) {
        runNextBatch(); // Only start new processes if we have room and more files
    }
}

    function updateProgress(message = '') {
        const remainingFiles = totalFiles - (completedTasks - activeProcesses);
        process.stdout.write(`\rProcessed: ${completedTasks - activeProcesses}/${totalFiles}, Remaining: ${remainingFiles} ${message}`);
    }

    function finishProcessing() {
        console.log(''); // Move to the next line after finishing
        const endTime = Date.now();
        const totalTime = (endTime - startTime) / 1000; // in seconds
        const averageTimePerFile = totalTime / totalFiles;
        console.log(`All tasks completed.`);
        console.log(`Total files processed: ${totalFiles}`);
        console.log(`Total time taken: ${totalTime.toFixed(2)} seconds`);
        console.log(`Average processing time per file: ${averageTimePerFile.toFixed(4)} seconds`);
    }

    runNextBatch(); // Initial batch of tasks
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
