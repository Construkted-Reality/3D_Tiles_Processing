import { NodeIO, PropertyType } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import { createCanvas, loadImage } from 'canvas';

const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
        'draco3d.encoder': await draco3d.createEncoderModule(),
    });

async function getModelStatistics(document) {
    const stats = {
        dracoCompression: document.getRoot().listExtensionsUsed().some(ext => ext.extensionName === 'KHR_draco_mesh_compression'),
        triangleCount: 0,
        textures: []
    };

    document.getRoot().listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(primitive => {
            const indices = primitive.getIndices();
            if (indices) stats.triangleCount += indices.getCount() / 3;
        });
    });

    stats.textures = await Promise.all(document.getRoot().listTextures().map(async texture => {
        return getTextureInfo(texture);
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
            if (mimeType && mimeType.includes('ktx')) {
                const imageData = new Uint8Array(image instanceof Buffer ? image : image);
                const ktxHeader = parseKTXHeader(imageData);
                if (ktxHeader) {
                    width = ktxHeader.pixelWidth;
                    height = ktxHeader.pixelHeight;
                    encoding = 'KTX';
                } else {
                    console.warn('Failed to parse KTX header');
                }
            } else if (image instanceof Buffer || image instanceof Uint8Array) {
                const img = await loadImage(Buffer.from(image));
                width = img.width;
                height = img.height;
            } else if (image.width && image.height) {
                width = image.width;
                height = image.height;
            }
        } catch (error) {
            console.error('Error getting texture dimensions:', error);
        }

        encoding = mimeType.includes('jpeg') ? 'JPG' : mimeType.includes('png') ? 'PNG' : mimeType.includes('ktx') ? 'KTX' : encoding;
    }

    return {
        resolution: `${width}x${height}`,
        encoding
    };
}

function parseKTXHeader(buffer) {
    const KTX_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x31, 0x31, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
    const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
    const dataView = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

    let isKTX1 = true;
    let isKTX2 = true;

    for (let i = 0; i < KTX_IDENTIFIER.length; i++) {
        if (buffer[i] !== KTX_IDENTIFIER[i]) isKTX1 = false;
        if (buffer[i] !== KTX2_IDENTIFIER[i]) isKTX2 = false;
    }

    return isKTX1 ? { pixelWidth: dataView.getUint32(36, true), pixelHeight: dataView.getUint32(40, true) } :
           isKTX2 ? { pixelWidth: dataView.getUint32(20, true), pixelHeight: dataView.getUint32(24, true) } :
           null;
}

function printStatistics(stats) {
    console.log('\n=== Model Statistics ===');
    console.log(`Draco Compression: ${stats.dracoCompression ? 'Yes' : 'No'}`);
    console.log(`Triangle Count: ${stats.triangleCount}`);
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
        throw new Error(`File does not exist: ${file}`);
    }

    let document;
    try {
        document = file.endsWith(".b3dm") ? await io.readBinary(await extractGLBFromB3DM(file)) : await io.read(file);
    } catch (e) {
        throw new Error(`Failed to read file ${file}: ${e.message}`);
    }

    const originalStats = await getModelStatistics(document);

    if (!ktx || originalStats.textures.some(texture => texture.format === 'KTX') && !dracoCompression || originalStats.dracoCompression) {
        process.send(`No changes needed for ${file}. Execution time: ${(Date.now() - startTime) / 1000}s`);
        process.exit(0);
    }

    const transforms = [];
    if (ktx && !originalStats.textures.some(texture => texture.format === 'KTX')) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
    }
    if (dracoCompression && !originalStats.dracoCompression) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
    }

    try {
        await document.transform(...transforms);
    } catch (e) {
        throw new Error(`Error transforming document: ${e.message}`);
    }

    const transformedStats = await getModelStatistics(document);

    const glbBuffer = await io.writeBinary(document).catch(e => { throw new Error(`Error writing GLB file: ${e.message}`); });
    fs.writeFileSync(file.endsWith('.b3dm') ? file.replace('.b3dm', '.glb') : file, glbBuffer);
    if (file.endsWith('.b3dm')) fs.unlinkSync(file);

    const endTime = Date.now();
    process.send(`Successfully processed ${file}. Execution time: ${(endTime - startTime) / 1000}s. KTX Applied: ${ktx && !originalStats.textures.some(texture => texture.format === 'KTX')}. Draco Applied: ${dracoCompression && !originalStats.dracoCompression}`);
    process.exit(0);
}

async function extractGLBFromB3DM(file) {
    const buffer = await fs.readFile(file);
    const byteLength = buffer.readInt32LE(8);
    const glbStart = 28 + buffer.readInt32LE(12) + buffer.readInt32LE(16) + buffer.readInt32LE(20) + buffer.readInt32LE(24);
    return buffer.subarray(glbStart, glbStart + byteLength);
}

if (process.argv.length < 5) {
    console.error('Usage: node worker-script.js <file> [dracoCompression:true/false] [ktx:true/false]');
    process.exit(1);
}

const file = process.argv[2];
const dracoCompression = process.argv[3] === 'true';
const ktx = process.argv[4] === 'true';

compress(file, dracoCompression, ktx).catch(error => {
    console.error(`Error processing ${file}:`, error.message);
    process.send('');
    process.exit(1);
});
