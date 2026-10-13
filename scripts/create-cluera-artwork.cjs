'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),sharp=require(path.join(root,'desktop/node_modules/sharp'));
async function build(){
 const source=path.join(root,'desktop/src/renderer/assets/cluera-ai.svg');
 const png=await sharp(source).resize(256,256).png().toBuffer();
 const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);
 header[8]=0;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(png.length,14);header.writeUInt32LE(22,18);
 fs.writeFileSync(path.join(root,'desktop/resources/cluera.ico'),Buffer.concat([header,png]));
 fs.writeFileSync(path.join(root,'desktop/resources/cluera.png'),png);
 console.log('Cluera-owned SVG artwork rendered to PNG/Windows icon.');
}
if(require.main===module)build().catch(()=>{console.error('Artwork generation failed.');process.exitCode=1;});
module.exports={build};
