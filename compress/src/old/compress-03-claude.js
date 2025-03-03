import { NodeIO, PropertyType } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';

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
    document.getRoot().listTextures().forEach(texture => {
        const image = texture.getImage();
        const mimeType = texture.getMimeType();
        let format = 'unknown';
        
        if (mimeType === 'image/jpeg') format = 'JPG';
        else if (mimeType === 'image/png') format = 'PNG';
        else if (mimeType === 'image/ktx2') format = 'KTX2';

        stats.textures.push({
            format: format,
            width: image ? image.width : 'unknown',
            height: image ? image.height : 'unknown',
        });
    });

    return stats;
}

// Add this function to get texture information
function getTextureInfo(texture) {
    const uri = texture.getURI();
    const mimeType = texture.getMimeType();
    const width = texture.getImage()?.width || 'unknown';
    const height = texture.getImage()?.height || 'unknown';

    let encoding = 'unknown';
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
        
        // Get statistics before transformation
        const originalStats = await getModelStatistics(document);
        console.log('Original File Statistics:');
        printStatistics(originalStats);

        await document.transform(...transforms).catch(e => console.log(e));

        // Get statistics after transformation
      //  const transformedStats = await getModelStatistics(document);
      //  console.log('Transformed File Statistics:');
      //  printStatistics(transformedStats);

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
        
        // Get statistics before transformation
        const originalStats = await getModelStatistics(document);
        console.log('Original File Statistics:');
        printStatistics(originalStats);


// new
        // Get statistics before transformation
        console.log('\nFile Statistics:');
        console.log('---------------');

        // Check for Draco compression
        const hasDraco = document.getRoot().listMeshes().some(mesh =>
            mesh.listPrimitives().some(primitive =>
                primitive.getExtension('KHR_draco_mesh_compression')
            )
        );
        console.log('Draco Compression:', hasDraco ? 'Yes' : 'No');

        // Get mesh statistics
        const meshStats = getMeshStats(document);
        console.log('Triangle Count:', meshStats.triangleCount);

        // Get texture information
        console.log('\nTexture Information:');
        document.getRoot().listTextures().forEach((texture, index) => {
            const textureInfo = getTextureInfo(texture);
            console.log(`\nTexture #${index + 1}:`);
            console.log('Resolution:', textureInfo.resolution);
            console.log('Encoding:', textureInfo.encoding);
        });

// new

        await document.transform(...transforms).catch(e => console.log(e));

        // Get statistics after transformation
        const transformedStats = await getModelStatistics(document);
        console.log('Transformed File Statistics:');
        printStatistics(transformedStats);

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
