import { NodeIO, PropertyType } from '@gltf-transform/core';
import {
weld, draco, join, flatten, dedup
} from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';

import draco3d from 'draco3dgltf';
import fs from 'fs-extra';

// Optionally, a library that can parse widths/heights (for non-KTX):
import sizeOf from 'image-size';

// 1) Create a function that prints out relevant statistics for the "original" Document.
async function printStats(document) {
const root = document.getRoot();

// (a) Check if Draco mesh compression is present:
const extensionsUsed = root.listExtensionsUsed().map(ext => ext.extensionName);
const hasDraco = extensionsUsed.includes('KHR_draco_mesh_compression');
console.log(Draco Compression? ${hasDraco});

// (b) Count total triangles in all meshes:
let totalTriangles = 0;
for (const mesh of root.listMeshes()) {
for (const prim of mesh.listPrimitives()) {
const indices = prim.getIndices();
if (indices) {
totalTriangles += indices.getCount() / 3;
} else {
// If there are no indices, the primitive is using vertex arrays only.
// In that case, the vertex count is (some multiple of 3).
const position = prim.getAttribute('POSITION');
if (position) {
totalTriangles += position.getCount() / 3;
}
}
}
}
console.log(Total Triangles: ${totalTriangles});

// (c) List texture info: mimeType + resolution if possible.
const textures = root.listTextures();
for (let i = 0; i < textures.length; i++) {
const texture = textures[i];
const mimeType = texture.getMimeType(); // e.g., 'image/jpeg', 'image/png', 'image/ktx2', etc.

console.log(`Texture ${i}: mimeType = ${mimeType}`);

// If you need resolution for JPEG/PNG (and are OK re-decoding):
// Note: sizeOf() can decode JPEG, PNG, but not KTX2 without a specialized library.
const imageData = texture.getImage(); // returns a Uint8Array or Buffer for the raw image

// Only attempt sizeOf() for common formats:
if (mimeType === 'image/jpeg' || mimeType === 'image/png') {
try {
const dimensions = sizeOf(imageData);
console.log(`Texture ${i}: width=${dimensions.width}, height=${dimensions.height}`);
} catch (err) {
console.warn(`Texture ${i}: could not decode dimensions (${err.message}).`);
}
} else if (mimeType === 'image/ktx2') {
console.log(`Texture ${i}: KTX2 file (use a KTX2 loader for exact resolution).`);
}
}
}

// 2) Incorporate that function into your workflow. For example, in your compress function:
async function compress(file, dracoCompression, ktx, doubleSided) {
let transforms = [];
transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
transforms.push(flatten());
transforms.push(join({ keepNamed: false }));

// Possibly add KTX transformation
if (ktx) {
transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
}

// Possibly disable backface culling
if (doubleSided) {
transforms.push(backfaceCulling({ cull: false }));
}

// Possibly add Draco compression
if (dracoCompression) {
transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
}

//------------------------------------------------------------------
// B3DM path:
//------------------------------------------------------------------
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
const batchTableStart = featureTableStart + featureTableLength;
const batchTableLength = batchTableJSONByteLength + batchTableBinaryByteLength;
const batchTable = arrayBuffer.subarray(batchTableStart, batchTableStart + batchTableLength);
const glbStart = batchTableStart + batchTableLength;
const glbBytes = arrayBuffer.subarray(glbStart, byteLength);

const document = await io.readBinary(glbBytes);

// Print out stats from the original B3DM’s GLB content:
await printStats(document);

// Now apply your desired transforms:
await document.transform(...transforms);
const glb = await io.writeBinary(document);

const totalLength = 28 + featureTableLength + batchTableLength + glb.length;
const header = Buffer.alloc(28);
header.writeInt32LE(magic, 0);
header.writeInt32LE(version, 4);
header.writeInt32LE(totalLength, 8);
header.writeInt32LE(featureTableJSONByteLength, 12);
header.writeInt32LE(featureTableBinaryByteLength, 16);
header.writeInt32LE(batchTableJSONByteLength, 20);
header.writeInt32LE(batchTableBinaryByteLength, 24);

const concat = Buffer.concat([header, featureTable, batchTable, glb], totalLength);
fs.writeFileSync(file, concat);
//------------------------------------------------------------------
// GLB / GLTF path:
//------------------------------------------------------------------
} else if (file.endsWith(".glb") || file.endsWith(".gltf")) {
// Read document.
const document = await io.read(file);

// Print out stats BEFORE transformations:
await printStats(document);

// Perform transformations.
await document.transform(...transforms);

// Write back to GLB.
const glb = await io.writeBinary(document);
fs.writeFileSync(file, glb);
}
}

// The backfaceCulling transform remains the same
function backfaceCulling(options) {
return (document) => {
for (const material of document.getRoot().listMaterials()) {
material.setDoubleSided(!options.cull);
}
};
}

// 3) Initialize your NodeIO (including Draco modules and KHR extensions).
// Make sure this block of code appears at the top level, outside the compress function:
const io = new NodeIO()
.registerExtensions(KHRONOS_EXTENSIONS)
.registerDependencies({
'draco3d.decoder': await draco3d.createDecoderModule(),
'draco3d.encoder': await draco3d.createEncoderModule(),
});

// 4) Read command line args, then run.
const args = process.argv.slice(2);
if (args.length < 1) {
console.error('Usage: node script.js <file> [dracoCompression] [ktx] [doubleSided]');
process.exit(1);
}

const file = args[0];
const dracoCompression = args[1] === 'true';
const ktx = args[2] === 'true';
const doubleSided = args[3] === 'true';

compress(file, dracoCompression, ktx, doubleSided).catch(e => console.error(e));
