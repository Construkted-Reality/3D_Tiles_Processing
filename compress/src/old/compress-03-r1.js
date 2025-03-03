import { NodeIO, PropertyType } from '@gltf-transform/core';
import { KHR_DRACO_MESH_COMPRESSION } from '@gltf-transform/extensions';
import { Mode, toktx } from '@gltf-transform/cli';
import draco3d from 'draco3dgltf';
import fs from 'fs-extra';
import { read } from 'ktx-parse';
import sizeOf from 'image-size';

// Helper function to analyze texture
async function getTextureStats(image) {
    const stats = {
        encoding: 'Unknown',
        format: null,
        resolution: 'undefinedxundefined',
        mimeType: image.getMimeType()
    };

    // Detect encoding from MIME type
    if (stats.mimeType === 'image/ktx2') {
        stats.encoding = 'KTX';
    } else if (stats.mimeType === 'image/jpeg') {
        stats.encoding = 'JPG';
    } else if (stats.mimeType === 'image/png') {
        stats.encoding = 'PNG';
    }

    // Get resolution from buffer data
    const bufferView = image.getBufferView();
    if (bufferView) {
        const buffer = bufferView.getBuffer().getArrayBuffer();
        try {
            if (stats.mimeType === 'image/ktx2') {
                const ktx = read(new Uint8Array(buffer));
                stats.resolution = `${ktx.pixelWidth}x${ktx.pixelHeight}`;
                stats.format = ktx.dfdFormat;
            } else {
                const size = sizeOf(Buffer.from(buffer));
                if (size.width && size.height) {
                    stats.resolution = `${size.width}x${size.height}`;
                }
            }
        } catch (e) {
            console.warn('Error parsing texture:', e);
        }
    }

    return stats;
}

async function collectStats(document) {
    const stats = {
        dracoCompression: false,
        triangleCount: 0,
        textures: []
    };

    // Check for Draco compression
    const dracoExtension = document.getRoot().listExtensionsUsed()
        .find(ext => ext.extensionName === KHR_DRACO_MESH_COMPRESSION);
    stats.dracoCompression = !!dracoExtension;

    // Calculate triangle count
    for (const mesh of document.getRoot().listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
            const indices = primitive.getIndices();
            if (indices) {
                stats.triangleCount += indices.getCount() / 3;
            } else {
                // If no indices, count positions as triangles
                const position = primitive.getAttribute('POSITION');
                stats.triangleCount += position.getCount() / 3;
            }
        }
    }

    // Collect texture info
    for (const texture of document.getRoot().listTextures()) {
        const image = texture.getSource();
        if (image) {
            const textureStats = await getTextureStats(image);
            stats.textures.push(textureStats);
        }
    }

    return stats;
}

// Modified compress function to collect stats
async function compress(file, dracoCompression, ktx, doubleSided) {
    // ... [existing code] ...

    if (file.endsWith(".b3dm")) {
        // ... [existing code] ...
        const document = await io.readBinary(glbBytes).catch(e => console.log(e));
        const stats = await collectStats(document); // <-- Collect before transforms
        await document.transform(...transforms).catch(e => console.log(e));
        console.log('File Statistics:', stats); // <-- Print or process stats
        // ... [existing code] ...
    } else if (file.endsWith(".glb") || file.endsWith(".gltf")) {
        const document = await io.read(file).catch(e => console.log(e));
        const stats = await collectStats(document); // <-- Collect before transforms
        await document.transform(...transforms).catch(e => console.log(e));
        console.log('File Statistics:', stats); // <-- Print or process stats
        // ... [existing code] ...
    }
}
