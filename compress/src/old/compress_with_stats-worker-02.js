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

    const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let isKTX1 = true;
    let isKTX2 = true;
    for (let i = 0; i < KTX_IDENTIFIER.length; i++) {
        if (buffer[i] !== KTX_IDENTIFIER[i]) isKTX1 = false;
        if (buffer[i] !== KTX2_IDENTIFIER[i]) isKTX2 = false;
    }

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

    const startTime = Date.now(); // Record the start time

    if (!fs.existsSync(file)) {
        console.error(`File does not exist: ${file}`);
        process.send(`Error processing ${file}: File does not exist.`);
        process.exit(1);
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
            process.send(`Error processing ${file}: Failed to read B3DM file.`);
            process.exit(1);
        }
        originalStats = await getModelStatistics(document);
    } else if (file.endsWith(".glb") || file.endsWith(".gltf")) {
        document = await io.read(file).catch(e => console.log(`Error reading GLB/GLTF: ${e}`));
        if (!document) {
            console.error('Failed to read GLB or GLTF file.');
            process.send(`Error processing ${file}: Failed to read GLB or GLTF file.`);
            process.exit(1);
        }
        originalStats = await getModelStatistics(document);
    } else {
        console.error('Unsupported file format. Only .b3dm, .glb, and .gltf files are supported.');
        process.send(`Error processing ${file}: Unsupported file format.`);
        process.exit(1);
    }

//    let textureFormat = originalStats.textures.map(texture => texture.format);
//    console.log(textureFormat);

    const hasKTXTexture = originalStats.textures.some(texture => texture.format === 'KTX');
    let ktxApplied = false;
    let dracoApplied = false;

    let transforms = [];
    if (ktx && !hasKTXTexture) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
        ktxApplied = true;
    }
    if (dracoCompression && !originalStats.dracoCompression) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
        dracoApplied = true;
    }

    await document.transform(...transforms).catch(e => console.log(`Error transforming document: ${e}`));

    const transformedStats = await getModelStatistics(document);

    const glbBuffer = await io.writeBinary(document).catch(e => console.log(`Error writing GLB: ${e}`));
    if (!glbBuffer) {
        console.error('Failed to write GLB file.');
        process.send(`Error processing ${file}: Failed to write GLB file.`);
        process.exit(1);
    }

    const outputFilePath = file.endsWith('.b3dm') ? file.replace('.b3dm', '.glb') : file;
    fs.writeFileSync(outputFilePath, glbBuffer);
//    console.log(`Processed file saved as: ${outputFilePath}`);

    if (file.endsWith('.b3dm')) {
        fs.unlinkSync(file);
//        console.log(`Original B3DM file deleted: ${file}`);
    }


    const endTime = Date.now(); // Record the end time
    const executionTime = (endTime - startTime) / 1000; // Calculate execution time in seconds

    const ktxInfo = ktxApplied ? 'KTX     Applied' : 'KTX Not Applied';
    const dracoInfo = dracoApplied ? 'Draco     Applied' : 'Draco Not Applied';

//    process.send(`Successfully processed ${file}. Execution time: ${executionTime.toFixed(2)}s  `);
    process.send(`, Execution time: ${executionTime.toFixed(2)}s.  ${ktxInfo}. ${dracoInfo}   `);
    process.exit(0);
}

if (process.argv.length < 5) {
    console.error('Usage: node worker-script.js <file> [dracoCompression:true/false] [ktx:true/false]');
    process.exit(1);
}

const file = process.argv[2];
const dracoCompression = process.argv[3] === 'true';
const ktx = process.argv[4] === 'true';

compress(file, dracoCompression, ktx).catch(error => {
    console.error(`Error processing ${file}:`, error);
    process.send('');
    process.send(`Error processing ${file}: ${error.message}`);
    process.exit(1);
});
