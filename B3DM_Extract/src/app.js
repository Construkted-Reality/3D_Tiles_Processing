
const fs = require("fs-extra");
const { fdir } = require("fdir");
/**
 * Extract a tileset glb payload
 */

 const api = new fdir().withFullPaths().crawl("/home/outsider/3d_tiles_processing/body_tiles");
 api.withPromise().then(files => {
     files.forEach(file=>{
        fs.readFile(file,(err,arrayBuffer)=>{
            const magic = arrayBuffer.readInt32LE(0);
            const version = arrayBuffer.readInt32LE(4);
            const byteLength = arrayBuffer.readInt32LE(8);
            const featureTableJSONByteLength = arrayBuffer.readInt32LE(12);
            const featureTableBinaryByteLength = arrayBuffer.readInt32LE(16);
            const batchTableJSONByteLength = arrayBuffer.readInt32LE(20);
            const batchTableBinaryByteLength = arrayBuffer.readInt32LE(24);
        
            const featureTableStart = 28;
            const featureTableLength = featureTableJSONByteLength + featureTableBinaryByteLength;
            const featureTable = arrayBuffer.subarray(featureTableStart,featureTableStart+featureTableLength);
            
            const batchTableStart = featureTableStart + featureTableJSONByteLength + featureTableBinaryByteLength;
            const batchTableLength = batchTableJSONByteLength + batchTableBinaryByteLength;
            const batchTable = arrayBuffer.subarray(batchTableStart,batchTableStart+batchTableLength);
            
            const glbStart = batchTableStart + batchTableLength;
            const glbBytes = arrayBuffer.subarray(glbStart, byteLength);
            fs.writeFile(file.replace(".b3dm", ".glb"), glbBytes);
        });
     })
 });

