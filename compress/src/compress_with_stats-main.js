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
        const child = fork(path.resolve(__dirname, 'compress_with_stats-worker-04.js'), [file, dracoCompression, ktx]);
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

        updateTilesetJson(folderPath);
    }

    runNextBatch(); // Initial batch of tasks
}
/*
// Function to update tileset.json
function updateTilesetJson(folderPath) {
    const tilesetFilePath = path.join(folderPath, 'tileset.json');
    if (!fs.existsSync(tilesetFilePath)) {
        console.warn('tileset.json not found in the folder.');
        return;
    }

    try {
        // Read and parse tileset.json
        let tilesetContent = JSON.parse(fs.readFileSync(tilesetFilePath, 'utf8'));

        // Replace .b3dm with .glb recursively
        tilesetContent = replaceB3dmWithGlb(tilesetContent);

        // Write updated tileset.json back to file
        fs.writeFileSync(tilesetFilePath, JSON.stringify(tilesetContent, null, 2), 'utf8');
        console.log('tileset.json has been updated successfully.');
    } catch (err) {
        console.error(`Error updating tileset.json: ${err.message}`);
    }
}
*/


function updateTilesetJson(folderPath) {
    function processJsonFile(filePath) {
        try {
            // Read and parse JSON file
            let jsonContent = JSON.parse(fs.readFileSync(filePath, 'utf8'));

            // Replace .b3dm with .glb recursively
            jsonContent = replaceB3dmWithGlb(jsonContent);

            // Write updated JSON back to file
            fs.writeFileSync(filePath, JSON.stringify(jsonContent, null, 2), 'utf8');
            console.log(`${path.basename(filePath)} has been updated successfully.`);
        } catch (err) {
            console.error(`Error updating ${path.basename(filePath)}: ${err.message}`);
        }
    }

    function traverseDirectory(directoryPath) {
        const files = fs.readdirSync(directoryPath);

        for (const file of files) {
            const filePath = path.join(directoryPath, file);
            const stat = fs.statSync(filePath);

            if (stat.isDirectory()) {
                // Recursively traverse subdirectories
                traverseDirectory(filePath);
            } else if (path.extname(filePath) === '.json') {
                // Process JSON files
                processJsonFile(filePath);
            }
        }
    }

    // Start traversing the directory
    traverseDirectory(folderPath);
}


// Function to replace .b3dm with .glb recursively
function replaceB3dmWithGlb(obj) {
    if (typeof obj === 'string') {
        return obj.replace(/\.b3dm/g, '.glb');
    } else if (Array.isArray(obj)) {
        return obj.map(item => replaceB3dmWithGlb(item));
    } else if (obj && typeof obj === 'object') {
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                obj[key] = replaceB3dmWithGlb(obj[key]);
            }
        }
    }
    return obj;
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
