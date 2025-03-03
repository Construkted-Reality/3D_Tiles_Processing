import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { loadImage } from 'canvas';

async function initIO() {
    return new NodeIO()
        .registerExtensions(KHRONOS_EXTENSIONS)
        .registerDependencies({
            'draco3d.decoder': await draco3d.createDecoderModule(),
        });
}

async function getModelStatistics(document) {
    const stats = {
        triangleCount: 0,
        textures: []
    };

    document.getRoot().listMeshes().forEach(mesh => {
        mesh.listPrimitives().forEach(primitive => {
            const indices = primitive.getIndices();
            if (indices) {
                stats.triangleCount += indices.getCount() / 3;
            }
        });
    });

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

function parseKTXHeader(buffer) {
    const KTX_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x31, 0x31, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
    const KTX2_IDENTIFIER = [0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];

    if (!(buffer instanceof Uint8Array)) {
        console.warn('Buffer is not Uint8Array:', typeof buffer);
        return null;
    }

    let isKTX1 = true;
    let isKTX2 = true;
    for (let i = 0; i < KTX_IDENTIFIER.length; i++) {
        if (buffer[i] !== KTX_IDENTIFIER[i]) isKTX1 = false;
        if (buffer[i] !== KTX2_IDENTIFIER[i]) isKTX2 = false;
    }

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

    return null;
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
                let imageData;
                if (image instanceof Buffer) {
                    imageData = new Uint8Array(image);
                } else if (image instanceof Uint8Array) {
                    imageData = image;
                } else {
                    imageData = new Uint8Array(image);
                }
                const ktxHeader = parseKTXHeader(imageData);
                if (ktxHeader) {
                    width = ktxHeader.pixelWidth;
                    height = ktxHeader.pixelHeight;
                    encoding = 'KTX';
                }
            } else {
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

function printStatistics(stats) {
    console.log('\n=== Model Statistics ===');
    console.log(`Triangle Count: ${stats.triangleCount}`);
    console.log('\nTextures:');
    stats.textures.forEach((texture, index) => {
        console.log(`  Texture ${index + 1}:`);
        console.log(`    Format: ${texture.format}`);
        console.log(`    Resolution: ${texture.width}x${texture.height}`);
    });
    console.log('=====================\n');
}

async function analyzeFile(file) {
    if (file.endsWith(".glb") || file.endsWith(".gltf")) {
        const io = await initIO();
        const document = await io.read(file);
        if (!document) {
            console.error('Failed to read document');
            return;
        }
        const stats = await getModelStatistics(document);
        console.log('File Statistics:');
        printStatistics(stats);
    } else {
        console.error('Unsupported file format. Please provide a .glb or .gltf file.');
    }
}

const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node script.js <file>');
    process.exit(1);
}

const file = args[0];
analyzeFile(file).catch(error => {
    console.error('Error analyzing file:', error);
});
