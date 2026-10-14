'use strict';
// Read-only byte-pinned export for the connected Git object publisher.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),{detectSecrets,loadKnownSecrets}=require('./security/source-secret-scan.cjs');
const {verifyProxyFork,PREFIX}=require('./verify-cluera-proxy-fork.cjs');
function isReviewedVendorRuntime(name,pins){return name.startsWith(PREFIX+'dist/')&&pins.has(name);}
function reviewFile(base,name,known,pins){
 if(typeof name!=='string'||name.includes('\\')||path.isAbsolute(name))throw Error('Publication path refused.');
 const target=path.resolve(base,name),relative=path.relative(base,target);
 const blocked=/(?:^|\/)(?:node_modules|\.git|\.local-secrets|\.test-output|\.build-cache|\.migration-source|dist|release|release-[^/]*)\//.test(name);
 if(relative.startsWith('..')||path.isAbsolute(relative)||(blocked&&!isReviewedVendorRuntime(name,pins))
  ||/\.(?:exe|sqlite|pfx|key)$/.test(name))throw Error('Publication path refused.');
 const stat=fs.lstatSync(target);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2000000)throw Error('Publication path refused.');
 const bytes=fs.readFileSync(target);if(detectSecrets(bytes,known).length)throw Error('Publication secret findings.');
 const pin=pins.get(name);if(pin&&(bytes.length!==pin.size||crypto.createHash('sha256').update(bytes).digest('hex')!==pin.sha256))throw Error('Publication fork pin changed.');
 return {path:name,size:bytes.length,sha:crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),mode:'100644',type:'blob'};
}
function reviewPublication(){
 const pins=verifyProxyFork();
 const names=execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,'ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,windowsHide:true}).toString().split('\0').filter(Boolean);
 const unique=[...new Set(names)].sort();if([...pins.keys()].some(name=>!unique.includes(name)))throw Error('Reviewed proxy source omitted from Git inventory.');
 const known=loadKnownSecrets(root);const rows=unique.map(name=>reviewFile(root,name,known,pins));
if(process.argv[2]==='chunk'){
 const chunks=rows.flatMap(row=>Array.from({length:Math.max(1,Math.ceil(row.size/24000))},(_,i)=>({path:row.path,sha:row.sha,offset:i*24000})));
 const groups=[];let group=[],length=0;for(const item of chunks){const row=rows.find(r=>r.path===item.path),size=Math.min(24000,row.size-item.offset);if(length+size>24000&&group.length){groups.push(group);group=[];length=0;}group.push(item);length+=size;}if(group.length)groups.push(group);
 const selected=groups[Number(process.argv[3])];if(!selected)throw Error('Invalid review group.');console.log(JSON.stringify(selected.map(item=>{
 const row=rows.find(r=>r.path===item.path);if(!row||row.sha!==item.sha)throw Error('Source changed since review.');
 const bytes=fs.readFileSync(path.join(root,row.path));return {path:row.path,sha:row.sha,offset:item.offset,data:bytes.subarray(item.offset,item.offset+24000).toString('base64')};
 })));
}else console.log(JSON.stringify(rows));
}
if(require.main===module)reviewPublication();
module.exports={isReviewedVendorRuntime,reviewFile};
