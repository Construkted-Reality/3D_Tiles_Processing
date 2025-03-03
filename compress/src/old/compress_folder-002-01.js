import { NodeIO, PropertyType } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import { createCanvas, loadImage } from 'canvas';

// Configure I/O.
const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
    });



async function getModelStatistics(document) {
    const stats = {
        dracoCompression: false,
        triangleCount: 0,
        textures: []
    };

    // Check for Draco compression
    document.getRoot().listExtensionsUsed().forEach(ext => {
        if (ext.extensionName === 'KHR_draco_mesh_compression') {
            stats.dracoCompression = true;
        }
    });

    // Count triangles
    document.getRoot().listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(primitive => {
            const indices = primitive.getIndices();
            if (indices) {
                stats.triangleCount += indices.getCount() / 3;
            }
        });
    });

    // Collect texture information
    for (const texture of document.getRoot().listTextures()) {
        const textureInfo = await getTextureInfo(texture);
        stats.textures.push({
            format: textureInfo.encoding,
            width: textureInfo.resolution.split('x')[0],
            height: textureInfo.resolution.split('x')[1],
        });
    }

    return stats;
}

// Add this function to get texture information

async function getTextureInfo(texture) {
    const image = texture.getImage();
    const mimeType = texture.getMimeType();
    let width = 'unknown';
    let height = 'unknown';
    let encoding = 'unknown';

    if (image) {
        try {
            if (mimeType && mimeType.includes('ktx')) {
                // Convert image data to Uint8Array if it isn't already
                let imageData;
                if (image instanceof Buffer) {
                    imageData = new Uint8Array(image);
                } else if (image instanceof Uint8Array) {
                    imageData = image;
                } else {
                    console.warn('KTX image data is in unexpected format:', typeof image);
                    imageData = new Uint8Array(image);
                }

                const ktxHeader = parseKTXHeader(imageData);
                if (ktxHeader) {
//                    console.log('KTX Header:', ktxHeader); // Debug log
                    width = ktxHeader.pixelWidth;
                    height = ktxHeader.pixelHeight;
                    encoding = 'KTX';
                } else {
                    console.warn('Failed to parse KTX header');
                }
            } else {
                // Handle JPG/PNG as before
                if (image instanceof Buffer || image instanceof Uint8Array) {
                    const img = await loadImage(Buffer.from(image));
                    width = img.width;
                    height = img.height;
                } else if (image.width && image.height) {
                    width = image.width;
                    height = image.height;
                }
            }
        } catch (error) {
            console.error('Error getting texture dimensions:', error);
        }
    }

    if (mimeType) {
        if (mimeType.includes('jpeg')) encoding = 'JPG';
        else if (mimeType.includes('png')) encoding = 'PNG';
        else if (mimeType.includes('ktx')) encoding = 'KTX';
    }

    // Debug log
/**
    console.log('Texture Info:', {
        mimeType,
        width,
        height,
        encoding,
        imageType: image ? typeof image : 'null',
        imageLength: image ? image.length || image.byteLength : 'n/a'
    });
**/
    return {
        resolution: `${width}x${height}`,
        encoding: encoding
    };
}

function parseKTXHeader(buffer) {
    // KTX1 identifier
    const KTX_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x31, 0x31, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
    
    // KTX2 identifier
    const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

    if (!(buffer instanceof Uint8Array)) {
        console.warn('Buffer is not Uint8Array:', typeof buffer);
        return null;
    }

    // Check if it's KTX1
    let isKTX1 = true;
    let isKTX2 = true;
    for (let i = 0; i < KTX_IDENTIFIER.length; i++) {
        if (buffer[i] !== KTX_IDENTIFIER[i]) isKTX1 = false;
        if (buffer[i] !== KTX2_IDENTIFIER[i]) isKTX2 = false;
    }

/**
    console.log('Format detection:', { isKTX1, isKTX2 }); // Debug log
**/

    const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    if (isKTX1) {
        return {
            pixelWidth: dataView.getUint32(36, true),
            pixelHeight: dataView.getUint32(40, true),
        };
    } else if (isKTX2) {
        return {
            pixelWidth: dataView.getUint32(20, true),
            pixelHeight: dataView.getUint32(24, true),
        };
    }

    console.warn('Neither KTX1 nor KTX2 format detected');
    return null;
}

// Add this function to get mesh statistics
function getMeshStats(document) {
    let totalTriangles = 0;

    document.getRoot().listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(primitive => {
            const indices = primitive.getIndices();
            if (indices) {
                totalTriangles += indices.getCount() / 3;
            }
        });
    });

    return {
        triangleCount: totalTriangles
    };
}

function printStatistics(stats) {
    console.log('\n=== Model Statistics ===');
    console.log(`Draco Compression: ${stats.dracoCompression ? 'Yes' : 'No'}`);
    console.log(`Triangle Count: ${stats.triangleCount}`);
    console.log('\nTextures:');
    stats.textures.forEach((texture, index) => {
        console.log(`  Texture ${index + 1}:`);
        console.log(`    Format: ${texture.format}`);
        console.log(`    Resolution: ${texture.width}x${texture.height}`);
    });
    console.log('=====================\n');
}

async function compress(file, dracoCompression, ktx) {
    let document;
    let originalStats;

    // Check if the file exists
    if (!fs.existsSync(file)) {
        console.error(`File does not exist: ${file}`);
        return;
    }

    if (file.endsWith(".b3dm")) {
        const arrayBuffer = fs.readFileSync(file);
        const magic = arrayBuffer.readInt32LE(0);
        const version = arrayBuffer.readInt32LE(4);
        const byteLength = arrayBuffer.readInt32LE(8);
        const featureTableJSONByteLength = arrayBuffer.readInt32LE(12);
        const featureTableBinaryByteLength = arrayBuffer.readInt32LE(16);
        const batchTableJSONByteLength = arrayBuffer.readInt32LE(20);
        const batchTableBinaryByteLength = arrayBuffer.readInt32LE(24);
        const featureTableStart = 28;
        const featureTableLength = featureTableJSONByteLength + featureTableBinaryByteLength;
        const featureTable = arrayBuffer.subarray(featureTableStart, featureTableStart + featureTableLength);
        const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
        const batchTableLength = batchTableJSONByteLength + batchTableBinaryByteLength;
        const batchTable = arrayBuffer.subarray(batchTableStart, batchTableStart + batchTableLength);
        const glbStart = batchTableStart + batchTableLength;
        const glbBytes = arrayBuffer.subarray(glbStart, byteLength);

        document = await io.readBinary(glbBytes).catch(e => console.log(`Error reading B3DM: ${e}`));
        if (!document) {
            console.error('Failed to read B3DM file.');
            return;
        }
        originalStats = await getModelStatistics(document);
    } else if (file.endsWith(".glb") || file.endsWith(".gltf")) {
        document = await io.read(file).catch(e => console.log(`Error reading GLB/GLTF: ${e}`));
        if (!document) {
            console.error('Failed to read GLB or GLTF file.');
            return;
        }
        originalStats = await getModelStatistics(document);
    } else {
        console.error('Unsupported file format. Only .b3dm, .glb, and .gltf files are supported.');
        return;
    }

//    console.log('Original File Statistics:');
//    printStatistics(originalStats);
//    console.log(originalStats.textures.format.every);
    let textureFormat = originalStats.textures.map(texture => texture.format);
    console.log(textureFormat);

    // Check if any texture is already in KTX format
    const hasKTXTexture = originalStats.textures.some(texture => texture.format === 'KTX');

    // Apply transformations
    let transforms = [];
    if (ktx && !hasKTXTexture) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125 }));
    }
    if (dracoCompression && !originalStats.dracoCompression) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
    }

    await document.transform(...transforms).catch(e => console.log(`Error transforming document: ${e}`));

    // Get statistics after transformation
    const transformedStats = await getModelStatistics(document);
//    console.log('Transformed File Statistics:');
//    printStatistics(transformedStats);

    // Write the processed document as a .glb file
    const glbBuffer = await io.writeBinary(document).catch(e => console.log(`Error writing GLB: ${e}`));
    if (!glbBuffer) {
        console.error('Failed to write GLB file.');
        return;
    }
    const outputFilePath = file.endsWith('.b3dm') ? file.replace('.b3dm', '.glb') : file;

    fs.writeFileSync(outputFilePath, glbBuffer);
    console.log(`Processed file saved as: ${outputFilePath}`);

    // Delete the original .b3dm file if it was converted
    if (file.endsWith('.b3dm')) {
        fs.unlinkSync(file);
        console.log(`Original B3DM file deleted: ${file}`);
    }
}

/**
// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node script.js <file> [dracoCompression:true/false] [ktx:true/false]');
    process.exit(1);
}
const file = args[0];
const dracoCompression = args[1] === 'true';
const ktx = args[2] === 'true';

// Call the compress function with the provided arguments
compress(file, dracoCompression, ktx);
**/

async function processDirectory(directory, dracoCompression, ktx) {
    try {
        // Read all files in the directory
        const items = await fs.readdir(directory, { withFileTypes: true });

        for (const item of items) {
            const fullPath = `${directory}/${item.name}`;

            if (item.isDirectory()) {
                // Recursively process subdirectories
                await processDirectory(fullPath, dracoCompression, ktx);
            } else if (item.isFile()) {
                // Check if the file has a supported extension
                const supportedExtensions = ['.glb', '.gltf', '.b3dm'];
                const fileExtension = item.name.toLowerCase().match(/\.[^.]+$/)?.[0];

                if (supportedExtensions.includes(fileExtension)) {
                    console.log(`Processing file: ${fullPath}`);
                    await compress(fullPath, dracoCompression, ktx);
                }
            }
        }
    } catch (error) {
        console.error(`Error processing directory ${directory}:`, error);
    }
}

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node script.js <directory> [dracoCompression:true/false] [ktx:true/false]');
    process.exit(1);
}

const directory = args[0];
const dracoCompression = args[1] === 'true';
const ktx = args[2] === 'true';

// Verify that the input directory exists
if (!fs.existsSync(directory)) {
    console.error(`Directory does not exist: ${directory}`);
    process.exit(1);
}

// Check if the input is actually a directory
if (!fs.statSync(directory).isDirectory()) {
    console.error(`The specified path is not a directory: ${directory}`);
    process.exit(1);
}

// Process the directory
processDirectory(directory, dracoCompression, ktx)
    .then(() => console.log('Processing complete'))
    .catch(error => console.error('Error:', error));
