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
            /* Recurse into a subdirectory */
            results = results.concat(findFiles(file, exts));
        } else { 
            /* Is a file */
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
    const numCPUs = os.cpus().length - 1; // Leave one CPU free
    let completedTasks = 0;

    for (let i = 0; i < numCPUs && i < files.length; i++) {
        runChildProcess(files[i], dracoCompression, ktx);
    }

    function runChildProcess(file, dracoCompression, ktx) {
        const child = fork(path.resolve(__dirname, 'compress_with_stats-worker-02.js'), [file, dracoCompression, ktx]);

        child.on('message', (message) => {
            console.log(message);
            completedTasks++;
            if (completedTasks < files.length) {
                runChildProcess(files[completedTasks], dracoCompression, ktx); // Run next task
            } else if (completedTasks === files.length) {
                console.log("All tasks completed.");
            }
        });

        child.on('error', (err) => {
            console.error(`Error in child process: ${err.message}`);
            completedTasks++;
            if (completedTasks < files.length) {
                runChildProcess(files[completedTasks], dracoCompression, ktx); // Run next task
            } else if (completedTasks === files.length) {
                console.log("All tasks completed.");
            }
        });

        child.on('exit', (code) => {
            if (code !== 0)
                console.error(`Child process exited with code ${code}`);
        });
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
