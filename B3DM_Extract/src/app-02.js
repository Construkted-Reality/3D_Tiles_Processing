const fs = require("fs-extra");
const { fdir } = require("fdir");

// Function to get command-line arguments
function getCommandLineArguments() {
    const args = {};
    process.argv.slice(2).forEach(arg => {
        if (arg.includes('=')) {
            const [key, value] = arg.split('=');
            args[key] = value;
        } else {
            args[arg] = true; // For flags without values
        }
    });
    return args;
}

// Get command-line arguments
const args = getCommandLineArguments();
const tilesetRoot = args['--folder'];

if (!tilesetRoot) {
    console.error("Please specify the folder to be crawled using --folder=<path>");
    process.exit(1);
}

/**
 * Extract a tileset glb payload
 */
const api = new fdir().withFullPaths()
    .filter((filePath, isDirectory) => !isDirectory && filePath.endsWith('.b3dm'))
    .crawl(tilesetRoot);

api.withPromise().then(files => {
    if (files.length === 0) {
        console.log("No .b3dm files found in the specified directory.");
        process.exit(0);
    }

    files.forEach(file => {
        fs.readFile(file, (err, arrayBuffer) => {
            if (err) {
                console.error(`Error reading file ${file}:`, err);
                return;
            }
            
//            const magic = arrayBuffer.readInt32LE(0);
//            if (magic !== 0x6d336262) { // 'b3dm' in little-endian
//                console.error(`File ${file} is not a valid B3DM file.`);
//                return;
//            }

            const version = arrayBuffer.readInt32LE(4);
            const byteLength = arrayBuffer.readInt32LE(8);
            const featureTableJSONByteLength = arrayBuffer.readInt32LE(12);
            const featureTableBinaryByteLength = arrayBuffer.readInt32LE(16);
            const batchTableJSONByteLength = arrayBuffer.readInt32LE(20);
            const batchTableBinaryByteLength = arrayBuffer.readInt32LE(24);

            const featureTableStart = 28;
            const featureTableLength = featureTableJSONByteLength + featureTableBinaryByteLength;
            // const featureTable = arrayBuffer.subarray(featureTableStart, featureTableStart + featureTableLength);

            const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
            const batchTableLength = batchTableJSONByteLength + batchTableBinaryByteLength;
            // const batchTable = arrayBuffer.subarray(batchTableStart, batchTableStart + batchTableLength);

            const glbStart = batchTableStart + batchTableLength;
            const glbBytes = arrayBuffer.subarray(glbStart, byteLength);

            const outputFilePath = file.replace('.b3dm', '.glb');
            fs.writeFile(outputFilePath, glbBytes, err => {
                if (err) {
                    console.error(`Error writing file ${outputFilePath}:`, err);
                } else {
                    console.log(`Converted ${file} to ${outputFilePath}`);
                }
            });
        });
    });
}).catch(err => {
    console.error("Error crawling the directory:", err);
});
