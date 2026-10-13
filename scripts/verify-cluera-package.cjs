'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,createPublicKey}=require('node:crypto');
const root=path.resolve(__dirname,'..'),desktop=path.join(root,'desktop');
const desktopRequire=require('node:module').createRequire(path.join(desktop,'package.json'));
const PIN='89d6409d29c8eed4f583936bdd2cab0b84a97b15552c340f5697b7336da6c5c1';
function verify(requireArtifact=false){
 const config=require(path.join(desktop,'electron-builder.cluera.cjs')),p=require(path.join(desktop,'package.json'));
 const distribution=require(path.join(desktop,'resources/account-distribution.json'));
 if(config.appId!=='ai.cluera.desktop'||config.productName!=='Cluera AI'||config.extraMetadata.clueraProduct!=='cluera-ai'
  ||config.extraMetadata.name!==p.name||p.name!=='cluera-ai-desktop'||config.directories.output!==`release-cluera-staging/${p.version}`
  ||distribution.channel!=='cluera-beta'||distribution.audience!=='cluera-ai-desktop-test-update'
  ||distribution.profile!=='cluera-ai-desktop-staging'||distribution.database!=='cluera-ai.sqlite'
  ||config.nsis.perMachine||config.nsis.allowElevation||config.nsis.allowToChangeInstallationDirectory)throw Error('Cluera identity invalid.');
 const key=createPublicKey(fs.readFileSync(path.join(desktop,'resources/cluera-public-key.pem')));
 if(key.asymmetricKeyType!=='ed25519'||createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex')!==PIN)throw Error('Cluera trust invalid.');
 for(const file of ['main/main.js','preload/preload.js','renderer/index.html'])if(!fs.existsSync(path.join(desktop,'dist',file)))throw Error('Complete Cluera build required.');
 const out=path.join(desktop,config.directories.output,'win-unpacked/resources/app.asar');
 if(requireArtifact&&(!fs.existsSync(out)||!fs.existsSync(path.join(desktop,config.directories.output,`ClueraAITestSetup-${p.version}.exe`))))throw Error('Complete Cluera installer required.');
 if(requireArtifact&&fs.existsSync(out)){
  const asar=require(path.join(desktop,'node_modules/@electron/asar'));
  const paths=asar.listPackage(out).map(p=>p.replaceAll('\\','/'));
  const forbidden=/\/(?:licensing|src|tests|\.local-secrets)(?:\/|$)|\.env(?:\.|$)|private[-_.]?key|node_modules\/(?:argparse|sprintf-js)\//i;
  if(paths.some(p=>forbidden.test(p)))throw Error('Unapproved archive contents.');
  const metadata=JSON.parse(asar.extractFile(out,'package.json').toString());
  if(metadata.name!==p.name||metadata.version!==p.version||metadata.clueraProduct!=='cluera-ai')throw Error('Archive identity mismatch.');
  const packed=createPublicKey(asar.extractFile(out,path.join('resources','cluera-public-key.pem')));
  if(!packed.export({type:'spki',format:'der'}).equals(key.export({type:'spki',format:'der'})))throw Error('Archive public trust mismatch.');
  const {getCurrentFuseWire,FuseV1Options,FuseState}=desktopRequire('@electron/fuses');
  const exe=path.join(desktop,config.directories.output,'win-unpacked/Cluera AI.exe'),wire=getCurrentFuseWire(exe);
  // getCurrentFuseWire is async; verify it in the command-line final pass below.
  return {entries:paths.length,fuseCheck:Promise.resolve(wire).then(w=>{
   for(const [name,value] of Object.entries({RunAsNode:0,EnableCookieEncryption:1,EnableNodeOptionsEnvironmentVariable:0,EnableNodeCliInspectArguments:0,EnableEmbeddedAsarIntegrityValidation:1,OnlyLoadAppFromAsar:1}))
    if(w[FuseV1Options[name]]!==(value?FuseState.ENABLE:FuseState.DISABLE))throw Error('Cluera Electron fuse mismatch.');
  })};
 }
 return {entries:0};
}
module.exports=()=>{const result=verify();return result.fuseCheck;};
module.exports.verify=verify;
if(require.main===module)Promise.resolve().then(()=>verify(true)).then(async r=>{await r.fuseCheck;console.log(JSON.stringify({status:'passed',entries:r.entries}));}).catch(()=>{console.error('Cluera package verification failed.');process.exitCode=1;});
