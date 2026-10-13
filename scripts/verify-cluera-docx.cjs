'use strict';
// Static archive extraction plus packaged library execution; never runs NSIS.
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module');
const root=path.resolve(__dirname,'..'),desktop=path.join(root,'desktop'),ownRequire=createRequire(path.join(desktop,'package.json'));
async function check(){
 const out=path.join(desktop,'release-cluera-staging',ownRequire('./package.json').version,'win-unpacked/resources/app.asar');
 const base=path.join(root,'.test-output');fs.mkdirSync(base,{recursive:true});const extracted=fs.mkdtempSync(path.join(base,'cluera-docx-'));
 ownRequire('@electron/asar').extractAll(out,extracted);
 const packedRequire=createRequire(path.join(extracted,'package.json')),mammoth=packedRequire('mammoth');
 const libraryRequire=createRequire(packedRequire.resolve('mammoth')),JSZip=libraryRequire('jszip'),zip=new JSZip();
 zip.file('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Cluera DOCX content</w:t></w:r></w:p></w:body></w:document>');
 const result=await mammoth.extractRawText({buffer:await zip.generateAsync({type:'nodebuffer'})});
 if(result.value.trim()!=='Synthetic Cluera DOCX content')throw Error();
 for(const name of ['argparse','sprintf-js'])try{libraryRequire.resolve(name);throw Error('Unapproved CLI dependency.');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
 console.log(JSON.stringify({status:'passed',packagedDocxLibrary:true,excludedCliDependencies:true,installerExecuted:false}));
}
check().catch(()=>{console.error('Packaged Cluera DOCX check failed.');process.exitCode=1;});
