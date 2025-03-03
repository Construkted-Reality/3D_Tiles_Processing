// qwen2.5


import { NodeIO, PropertyType, Document } from '@gltf-transform/core';
import { weld, draco, join, flatten, dedup, resample } from '@gltf-transform/functions';
import { KHRONOS_EXTENSIONS } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import path from 'path';

// Function to initialize Draco modules
async function initializeDraco() {
    const [decoderModule, encoderModule] = await Promise.all([
        draco3d.createDecoderModule(),
        draco3d.createEncoderModule()
    ]);
    return { decoderModule, encoderModule };
}

// Configure I/O.
const io = new NodeIO().registerExtensions(KHRONOS_EXTENSIONS);

function extractStatistics(document) {
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
    statistics.textures = textures.map(texture => {
        const mimeType = texture.getMimeType();
        const image = texture.getImage();
        const resolution = image ? `${image.width}x${image.height}` : 'N/A';
        return {
            encoding: mimeType,
            resolution: resolution
        };
    });
    return statistics;
}

function compress(document) {
    let transforms = [];
    transforms.push(dedup({ propertyTypes: [PropertyType.MATERIAL, PropertyType.MESH, PropertyType.ACCESSOR, PropertyType.TEXTURE] }));
    transforms.push(flatten());
    transforms.push(join({ keepNamed: false }));
    // Check for draco compression and add the transform if needed
    const statistics = extractStatistics(document);
    if (!statistics.dracoCompressed) {
        transforms.push(draco({ compressionLevel: 7, quantizePositionBits: 16 }));
    }
    // Check for KTX encoding and add the transform if needed
    if (statistics.textures.some(tex => tex.encoding !== 'image/ktx')) {
        transforms.push(toktx({ mode: Mode.ETC1S, compression: 1, quality: 125, powerOfTwo: true }));
    }
    return document.transform(...transforms);
}

async function processFile(inputFilePath, outputFolderPath, inputFolderPath) {
    const ext = path.extname(inputFilePath).toLowerCase();
    let document;
    if (ext === '.glb') {
        try {
            const arrayBuffer = await fs.readFile(inputFilePath);
            document = await io.readBinary(arrayBuffer);
        } catch (e) {
            console.error(`Error reading ${inputFilePath}:`, e);
            return;
        }
    } else {
        console.warn(`Unsupported file format: ${ext}`);
        return;
    }

    if (!(document instanceof Document)) {
        console.error(`Invalid document object for file: ${inputFilePath}`);
        return;
    }

    // Process the document
    const processedDocument = compress(document);

    // Write the processed document to a new folder structure
    const relativePath = path.relative(inputFolderPath, inputFilePath);
    const outputFilePath = path.join(outputFolderPath, relativePath.replace(ext, '.glb'));
    await fs.ensureDir(path.dirname(outputFilePath));
    try {
        const glb = io.writeBinary(processedDocument);
        await fs.writeFile(outputFilePath, glb);
    } catch (e) {
        console.error(`Error writing ${outputFilePath}:`, e);
    }
}

async function crawlFolder(folderPath, outputFolderPath, inputFolderPath) {
    const files = await fs.readdir(folderPath, { withFileTypes: true });
    for (const file of files) {
        const fullPath = path.join(folderPath, file.name);
        if (file.isDirectory()) {
            await crawlFolder(fullPath, outputFolderPath, inputFolderPath);
        } else if (path.extname(file.name).toLowerCase() === '.glb') {
            await processFile(fullPath, outputFolderPath, inputFolderPath);
        }
    }
}

async function main() {
    // Initialize Draco modules
    const { decoderModule, encoderModule } = await initializeDraco();
    io.registerDependencies({
        'draco3d.decoder': decoderModule,
        'draco3d.encoder': encoderModule,
    });

    // Get command line arguments
    const args = process.argv.slice(2);
    if (args.length < 1) {
        console.error('Usage: node script.js <folder>');
        process.exit(1);
    }
    const inputFolderPath = args[0];
    const outputFolderPath = path.join(inputFolderPath, 'processed');

    // Start crawling and processing files
    await crawlFolder(inputFolderPath, outputFolderPath, inputFolderPath);
    console.log('Processing complete.');
}

// Run the main function
main().catch(console.error);
