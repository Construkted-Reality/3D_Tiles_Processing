import { NodeIO,PropertyType  } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import readline from 'readline';

// Configure I/O.
const io = new NodeIO()
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(), 
        'draco3d.encoder': await draco3d.createEncoderModule(), 
    });

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

function prompt() {
    rl.question('Enter path to b3dm: \n', async (input) => {
        if (input.trim().toLowerCase() === 'exit') {
            rl.close();
            return;
        }

        const args = input.match(/(".*?"|\S+)/g).map(arg => {
            // If it's an argument wrapped in quotes, remove the quotes
            if(arg[0] === "\"" && arg[arg.length - 1] === "\"") {
                return arg.substring(1, arg.length - 1);
            }

            // Otherwise, parse the boolean string as a boolean
            return arg === "true" ? true : (arg === "false" ? false : arg);
        });

        await compress(args[0], args[1], args[2], args[3]);
        prompt();
    });
}

prompt();
async function compress(file, dracoCompression, ktx, doubleSided) {
    let transforms = [];

    transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
    transforms.push(flatten());
    transforms.push(join({ keepNamed: false }));
    if (ktx) {
        //transforms.push(toktx({ mode: Mode.UASTC, slots: slotsUASTC }));
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 192, powerOfTwo: true }));
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
    } else if (file.endsWith(".glb")|| file.endsWith(".gltf")) {
        const document = await io.read(file).catch(e => console.log(e));

        await document.transform(...transforms).catch(e => console.log(e));

        const glb = await io.writeBinary(document).catch(e => console.log(e));
        await fs.writeFileSync(file, glb);
    }
}

function backfaceCulling(options) {
    return (document) => {
        for (const material of document.getRoot().listMaterials()) {
            material.setDoubleSided(!options.cull);
        }
    };
}


