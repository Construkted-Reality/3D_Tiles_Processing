# 3D Tiles Processing

Tools for working with 3d tiles

B3DM_Extract : extracts glb from b3dm files
compress: scans a tileset and applies the following optomizations:
- loads b3dm or glb from the input folder
- applies command line flags
   - applies draco compression
   - applies ktx2 image compression to all texture files
- writes back to disk a glb (regardless of initial format of b3dm or glb)
- parses tilset.json to replace any instance of b3dm with glb (if the initial files were b3dm)