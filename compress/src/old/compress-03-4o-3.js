import { NodeIO, PropertyType, Document, Accessor } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
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

// Function to extract statistics
async function extractStatistics(document) {
    const statistics = {};

    // Check for Draco Compression
    const dracoExtension = document.getRoot().listExtensionsUsed().find(ext => ext.extensionName === 'KHR_draco_mesh_compression');
    statistics.dracoCompressed = !!dracoExtension;

    // Calculate Triangle Count
    let triangleCount = 0;
    for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
            const indicesAccessor = primitive.getIndices();
            if (indicesAccessor) {
                triangleCount += indicesAccessor.getCount() / 3;
            }
        }
    }
    statistics.triangleCount = triangleCount;

    // Texture Information
    const textures = document.getRoot().listTextures();
    statistics.textures = await Promise.all(textures.map(async texture => {
        const mimeType = texture.getMimeType();

 /**
        const image = texture.getImage();
        const resolution = image ? `${image.width}x${image.height}` : 'N/A';
        return {
            encoding: mimeType,
            resolution: resolution
        };
**/
/**
        let image = texture.getImage();

        if (!image) {
            // If the image is not directly available, try to get it from the URI
            const uri = texture.getURI();
            if (uri) {
                image = await fs.readFile(uri);
            }
        }

        let resolution;
        if (image) {
            const size = await getImageSize(image);
            resolution = `${size.width}x${size.height}`;
        } else {
            resolution = 'N/A';
        }

        return {
            encoding: mimeType,
            resolution: resolution
        };
**/
    }));

    return statistics;
}

async function getImageSize(image) {
    const img = await loadImage(image);
    return {
        width: img.width,
        height: img.height
    };
}

async function compress(file, dracoCompression, ktx, doubleSided) {
    let transforms = [];
    transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
    transforms.push(flatten());
    transforms.push(join({ keepNamed: false }));
    if (ktx) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
    }
    if (doubleSided) {
        transforms.push(backfaceCulling({ cull: false }));
    }
    if (dracoCompression) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
    }

    // Handle .b3dm, .glb, and .gltf files.
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
        const document = await io.readBinary(glbBytes).catch(e => console.log(e));
        
        // Extract and display statistics
        const statistics = await extractStatistics(document);
        console.log('Statistics:', statistics);

        await document.transform(...transforms).catch(e => console.log(e));
        const glb = await io.writeBinary(document).catch(e => console.log(e));
        const totalLength = 28 + featureTableLength + batchTableLength + glb.length;
        var header = Buffer.alloc(28);
        header.writeInt32LE(magic, 0);
        header.writeInt32LE(version, 4);
        header.writeInt32LE(totalLength, 8);
        header.writeInt32LE(featureTableJSONByteLength, 12);
        header.writeInt32LE(featureTableBinaryByteLength, 16);
        header.writeInt32LE(batchTableJSONByteLength, 20);
        header.writeInt32LE(batchTableBinaryByteLength, 24);
        const concat = Buffer.concat([header, featureTable, batchTable, glb], totalLength);
        fs.writeFileSync(file, concat);
    } else if (file.endsWith(".glb") || file.endsWith(".gltf")) {
        const document = await io.read(file).catch(e => console.log(e));

        // Extract and display statistics
        const statistics = await extractStatistics(document);
        console.log('Statistics:', statistics);

        await document.transform(...transforms).catch(e => console.log(e));
        const glb = await io.writeBinary(document).catch(e => console.log(e));
        fs.writeFileSync(file, glb);
    }
}

function backfaceCulling(options) {
    return (document) => {
        for (const material of document.getRoot().listMaterials()) {
            material.setDoubleSided(!options.cull);
        }
    };
}

// Get command line arguments
const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node script.js <file> [dracoCompression] [ktx] [doubleSided]');
    process.exit(1);
}
const file = args[0];
const dracoCompression = args[1] === 'true';
const ktx = args[2] === 'true';
const doubleSided = args[3] === 'true';

// Call the compress function with the provided arguments
compress(file, dracoCompression, ktx, doubleSided);
