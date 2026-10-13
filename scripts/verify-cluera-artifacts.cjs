'use strict';
const fs=require('node:fs'),path=require('node:path');
const {detectSecrets,loadKnownSecrets}=require('./security/source-secret-scan.cjs');
const root=path.resolve(__dirname,'..');
function scan(){
 const known=loadKnownSecrets(root),targets=['desktop/dist','backend/dist','web/.next/static'];
 if(process.argv.includes('--web')&&!fs.existsSync(path.join(root,'web/.next/static')))throw Error('Web artifacts absent.');
 if(process.argv.includes('--release'))targets.push('desktop/release-cluera-staging');
 let files=0;const findings=[];
 for(const target of targets){const base=path.join(root,target);if(!fs.existsSync(base))continue;const pending=[base];
  while(pending.length){const current=pending.pop();for(const entry of fs.readdirSync(current,{withFileTypes:true})){
   const p=path.join(current,entry.name);if(entry.isSymbolicLink())throw Error('Artifact symlink refused.');
   if(entry.isDirectory()){pending.push(p);continue;}if(!entry.isFile())throw Error('Artifact type refused.');
   if(/\.env(?:\.|$)|private[-_.]?key/i.test(entry.name))findings.push({category:'sensitive filename'});
   if(!/\.(?:js|mjs|cjs|json|html|css|txt|pem|asar|exe|wasm|map)$/.test(p))continue;
   files++;const kinds=detectSecrets(fs.readFileSync(p),known);if(kinds.length)findings.push({file:files,kinds});
  }}
 }
 if(findings.length)throw Object.assign(Error('Artifact rejected'),{categories:[...new Set(findings.flatMap(f=>f.kinds??[f.category]))]});
 return {status:'passed',files,historyBlobs:0};
}
module.exports={scan};
if(require.main===module)try{console.log(JSON.stringify(scan()));}catch(error){console.error(JSON.stringify({status:'failed',categories:error.categories??['scan unavailable']}));process.exitCode=1;}
