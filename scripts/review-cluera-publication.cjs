'use strict';
// Read-only byte-pinned export for the connected Git object publisher.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),{detectSecrets,loadKnownSecrets}=require('./security/source-secret-scan.cjs');
const names=execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,'ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,windowsHide:true}).toString().split('\0').filter(Boolean);
const known=loadKnownSecrets(root);const rows=[...new Set(names)].sort().map(name=>{
 const target=path.resolve(root,name),relative=path.relative(root,target),stat=fs.lstatSync(target);
 if(relative.startsWith('..')||path.isAbsolute(relative)||!stat.isFile()||stat.isSymbolicLink()||stat.size>2000000||/(?:^|\/)(?:node_modules|\.git|\.local-secrets|\.test-output|\.build-cache|\.migration-source|dist|release|release-[^/]*)\//.test(name)||/\.(?:exe|sqlite|pfx|key)$/.test(name))throw Error('Publication path refused.');
 const bytes=fs.readFileSync(target);if(detectSecrets(bytes,known).length)throw Error('Publication secret findings.');
 return {path:name,size:bytes.length,sha:crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),mode:'100644',type:'blob'};
});
if(process.argv[2]==='chunk'){
 const chunks=rows.flatMap(row=>Array.from({length:Math.max(1,Math.ceil(row.size/24000))},(_,i)=>({path:row.path,sha:row.sha,offset:i*24000})));
 const groups=[];let group=[],length=0;for(const item of chunks){const row=rows.find(r=>r.path===item.path),size=Math.min(24000,row.size-item.offset);if(length+size>24000&&group.length){groups.push(group);group=[];length=0;}group.push(item);length+=size;}if(group.length)groups.push(group);
 const selected=groups[Number(process.argv[3])];if(!selected)throw Error('Invalid review group.');console.log(JSON.stringify(selected.map(item=>{
 const row=rows.find(r=>r.path===item.path);if(!row||row.sha!==item.sha)throw Error('Source changed since review.');
 const bytes=fs.readFileSync(path.join(root,row.path));return {path:row.path,sha:row.sha,offset:item.offset,data:bytes.subarray(item.offset,item.offset+24000).toString('base64')};
 })));
}else console.log(JSON.stringify(rows));
