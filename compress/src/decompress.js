import { NodeIO } from '@gltf-transform/core';
import fetch from 'node-fetch';
import { simplify, draco } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import readline from 'readline';
import { MeshoptSimplifier } from 'meshoptimizer';

// Configure I/O.
const io = new NodeIO(fetch)
    .setAllowHTTP(true)
    .registerExtensions(KHRONOS_EXTENSIONS)
    .registerDependencies({
        'draco3d.decoder': await draco3d.createDecoderModule(),
    });


handle(process.argv[2], process.argv[3])
async function handle(input, output) {

   /*  const args = input.match(/(".*?"|\S+)/g).map(arg => {
        // If it's an argument wrapped in quotes, remove the quotes
        if (arg[0] === "\"" && arg[arg.length - 1] === "\"") {
            return arg.substring(1, arg.length - 1);
        }

        // Otherwise, parse the boolean string as a boolean
        return arg === "true" ? true : (arg === "false" ? false : arg);
    }); */

    await decompress(input, !output ? input : output);

    
}

async function decompress(file, out) {
    
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

        document.getRoot().listExtensionsUsed().forEach(extension => {
            if (extension.extensionName == 'KHR_draco_mesh_compression' ||
                extension.extensionName == 'KHR_texture_transform') {
                extension.dispose();
            }
        })
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
        fs.writeFileSync(out, concat);
    } else if (file.endsWith(".glb")|| file.endsWith(".gltf")) {
        const document = await io.read(file).catch(e => console.log(e));

        document.getRoot().listExtensionsUsed().forEach(extension => {
            if (extension.extensionName == 'KHR_draco_mesh_compression' ||
                extension.extensionName == 'KHR_texture_transform') {
                extension.dispose();
            }
        })
        await io.write(out, document);
    }
}

function backfaceCulling(options) {
    return (document) => {
        for (const material of document.getRoot().listMaterials()) {
            material.setDoubleSided(!options.cull);
        }
    };
}


