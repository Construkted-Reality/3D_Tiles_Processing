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
            // Handle flags without values as true
            args[arg] = true;
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

// Validate that the provided path is a string and exists
if (typeof tilesetRoot !== 'string') {
    console.error("The folder path must be a string.");
    process.exit(1);
}

fs.access(tilesetRoot, fs.constants.F_OK, (err) => {
    if (err) {
        console.error(`The specified directory does not exist: ${tilesetRoot}`);
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

                const version = arrayBuffer.readInt32LE(4);
                const byteLength = arrayBuffer.readInt32LE(8);
                const featureTableJSONByteLength = arrayBuffer.readInt32LE(12);
                const featureTableBinaryByteLength = arrayBuffer.readInt32LE(16);
                const batchTableJSONByteLength = arrayBuffer.readInt32LE(20);
                const batchTableBinaryByteLength = arrayBuffer.readInt32LE(24);

                const featureTableStart = 28;
                const featureTableLength = featureTableJSONByteLength + featureTableBinaryByteLength;

                const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
                const batchTableLength = batchTableJSONByteLength + batchTableBinaryByteLength;

                const glbStart = batchTableStart + batchTableLength;
                const glbBytes = arrayBuffer.subarray(glbStart, byteLength);

                const outputFilePath = file.replace('.b3dm', '.glb');
                fs.writeFile(outputFilePath, glbBytes, err => {
                    if (err) {
                        console.error(`Error writing file ${outputFilePath}:`, err);
                    } else {
                        console.log(`Converted ${file} to ${outputFilePath}`);

                        // Remove the original .b3dm file
                        fs.unlink(file, err => {
                            if (err) {
                                console.error(`Error deleting file ${file}:`, err);
                            } else {
                                console.log(`Deleted original file ${file}`);
                            }
                        });
                    }
                });
            });
        });

        // Process tileset.json
        const tilesetJsonPath = `${tilesetRoot}/tileset.json`;
        fs.readFile(tilesetJsonPath, 'utf8', (err, data) => {
            if (err) {
                console.error(`Error reading file ${tilesetJsonPath}:`, err);
                return;
            }

            let tilesetJson;
            try {
                tilesetJson = JSON.parse(data);
            } catch (parseErr) {
                console.error(`Error parsing JSON from ${tilesetJsonPath}:`, parseErr);
                return;
            }

            // Function to recursively replace .b3dm with .glb in the JSON
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

            const updatedTilesetJson = replaceB3dmWithGlb(tilesetJson);

            fs.writeFile(tilesetJsonPath, JSON.stringify(updatedTilesetJson, null, 2), 'utf8', (err) => {
                if (err) {
                    console.error(`Error writing file ${tilesetJsonPath}:`, err);
                } else {
                    console.log(`Updated tileset.json to reflect .glb references`);
                }
            });
        });
    }).catch(err => {
        console.error("Error crawling the directory:", err);
    });
});
