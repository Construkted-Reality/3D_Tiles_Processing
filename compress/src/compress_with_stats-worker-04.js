import { NodeIO, PropertyType } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import { createCanvas, loadImage } from 'canvas';

// Configure I/O once and reuse the instance; also await necessary extensions only once.
const dracoDecoder = await draco3d.createDecoderModule();
const dracoEncoder = await draco3d.createEncoderModule();
const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({ 'draco3d.decoder': dracoDecoder, 'draco3d.encoder': dracoEncoder });

async function getModelStatistics(document) {
    const stats = {
        dracoCompression: false,
        triangleCount: 0,
        textures: []
    };

    const root = document.getRoot();

    // Check for Draco compression
    root.listExtensionsUsed().forEach(ext => {
        if (ext.extensionName === 'KHR_draco_mesh_compression') {
            stats.dracoCompression = true;
        }
    });

    // Count triangles
    root.listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(primitive => {
            const indices = primitive.getIndices();
            if (indices) {
                stats.triangleCount += indices.getCount() / 3;
            }
        });
    });

    // Collect texture information
    const texturePromises = root.listTextures().map(getTextureInfo);
    const textureInfos = await Promise.all(texturePromises);

    stats.textures = textureInfos.map(textureInfo => ({
        format: textureInfo.encoding,
        width: textureInfo.resolution.split('x')[0],
        height: textureInfo.resolution.split('x')[1],
    }));

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
            const isKTX = mimeType?.includes('ktx');
            let imageData;
            if (image instanceof Buffer || image instanceof Uint8Array) {
                imageData = new Uint8Array(image);
            } else {
                console.warn('Unexpected image format:', typeof image);
                return { resolution: `${width}x${height}`, encoding };
            }

            if (isKTX) {
                const ktxHeader = parseKTXHeader(imageData);
                if (ktxHeader) {
                    width = ktxHeader.pixelWidth;
                    height = ktxHeader.pixelHeight;
                    encoding = 'KTX';
                } else {
                    console.warn('Failed to parse KTX header');
                }
            } else {
                const img = await loadImage(Buffer.from(image));
                width = img.width;
                height = img.height;
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

    return { resolution: `${width}x${height}`, encoding };
}

function parseKTXHeader(buffer) {
    // KTX identifiers
    const KTX_IDENTIFIERS = [
        [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x31, 0x31, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A],
        [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A]
    ];

    if (!(buffer instanceof Uint8Array)) {
        console.warn('Buffer is not Uint8Array:', typeof buffer);
        return null;
    }

    const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let isKTX1 = true, isKTX2 = true;

    for (let i = 0; i < KTX_IDENTIFIERS[0].length; ++i) {
        if (buffer[i] !== KTX_IDENTIFIERS[0][i]) isKTX1 = false;
        if (buffer[i] !== KTX_IDENTIFIERS[1][i]) isKTX2 = false;
    }

    if (isKTX1) {
        return { pixelWidth: dataView.getUint32(36, true), pixelHeight: dataView.getUint32(40, true) };
    } else if (isKTX2) {
        return { pixelWidth: dataView.getUint32(20, true), pixelHeight: dataView.getUint32(24, true) };
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
    const startTime = Date.now();
    if (!fs.existsSync(file)) {
        console.error(`File does not exist: ${file}`);
        process.send(`Error processing ${file}: File does not exist.`);
        process.exit(1);
    }

    let document;
    let originalStats;

    if (file.endsWith(".b3dm")) {
        const arrayBuffer = fs.readFileSync(file);
        const glbStart = 28 + arrayBuffer.readInt32LE(12) + arrayBuffer.readInt32LE(16) + arrayBuffer.readInt32LE(20) + arrayBuffer.readInt32LE(24);
        const glbBytes = arrayBuffer.subarray(glbStart);
        document = await io.readBinary(glbBytes).catch(e => console.log(`Error reading B3DM: ${e}`));
    } else if (file.endsWith(".glb") || file.endsWith(".gltf")) {
        document = await io.read(file).catch(e => console.log(`Error reading GLB/GLTF: ${e}`));
    }

    if (!document) {
        console.error('Failed to read the file.');
        process.send(`Error processing ${file}: Failed to read the file.`);
        process.exit(1);
    }

    originalStats = await getModelStatistics(document);
    const hasKTXTexture = originalStats.textures.some(texture => texture.format === 'KTX');
    let ktxApplied = false;
    let dracoApplied = false;
    const transforms = [];

    if (ktx && !hasKTXTexture) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
        ktxApplied = true;
    }

    if (dracoCompression && !originalStats.dracoCompression) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
        dracoApplied = true;
    }

    if (transforms.length > 0) {
        await document.transform(...transforms).catch(e => console.log(`Error transforming document: ${e}`));
    }

    const glbBuffer = await io.writeBinary(document).catch(e => console.log(`Error writing GLB: ${e}`));
    if (!glbBuffer) {
        console.error('Failed to write GLB file.');
        process.send(`Error processing ${file}: Failed to write GLB file.`);
        process.exit(1);
    }

    const outputFilePath = file.endsWith('.b3dm') ? file.replace('.b3dm', '.glb') : file;
    fs.writeFileSync(outputFilePath, glbBuffer);

    if (file.endsWith('.b3dm')) {
        fs.unlinkSync(file);
    }

    const executionTime = (Date.now() - startTime) / 1000;
    process.send(`, Execution time: ${executionTime.toFixed(2)}s. ${ktxApplied ? 'KTX Applied' : 'KTX Not Applied'}. ${dracoApplied ? 'Draco Applied' : 'Draco Not Applied'}`);
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
    process.send(`Error processing ${file}: ${error.message}`);
    process.exit(1);
});
