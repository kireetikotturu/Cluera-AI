import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url);
const {prepare,TARGET,requiredFiles}=require('../../scripts/prepare-cluera-staging-deployment.cjs');
const root=path.resolve(import.meta.dirname,'../..');
const hash=(text:string)=>createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
function fixture(){
 const webPackage=fs.readFileSync(path.join(root,'web/package.json'),'utf8'),webLock=fs.readFileSync(path.join(root,'web/package-lock.json'),'utf8');
 const rows=[...requiredFiles,'scripts/payments/audit-razorpay-test.cjs'].map((file:string)=>({path:file,type:'blob',mode:'100644',sha:hash(fs.readFileSync(path.join(root,file),'utf8')),size:fs.statSync(path.join(root,file)).size}));
 const all:any[]=[...rows],dirs=new Set<string>();
 for(const row of rows){let p=path.posix.dirname(row.path);while(p!=='.'){dirs.add(p);p=path.posix.dirname(p);}}
 const treeHash=(parent:string)=>{const entries=all.filter(r=>(path.posix.dirname(r.path)==='.'?'':path.posix.dirname(r.path))===parent).sort((a,b)=>Buffer.compare(Buffer.from(path.posix.basename(a.path)+(a.type==='tree'?'/':'')),Buffer.from(path.posix.basename(b.path)+(b.type==='tree'?'/':''))));
 const bytes=Buffer.concat(entries.map(r=>Buffer.concat([Buffer.from(`${r.type==='tree'?'40000':r.mode} ${path.posix.basename(r.path)}\0`),Buffer.from(r.sha,'hex')])));return createHash('sha1').update(`tree ${bytes.length}\0`).update(bytes).digest('hex');};
 for(const p of [...dirs].sort((a,b)=>b.split('/').length-a.split('/').length))all.push({path:p,type:'tree',mode:'040000',sha:treeHash(p)});
 const rootHash=treeHash('');
 return {commitSha:'a'.repeat(40),commitTreeSha:rootHash,branch:TARGET.branch,
  tree:{sha:rootHash,truncated:false,tree:all},webPackage,webLock,
  reviewedBlobs:Object.fromEntries(rows.map((row:any)=>[row.path,row.sha]))};
}
it('builds a complete SHA-pinned Account-only Git deployment with npm ci',()=>{
 const result=prepare(fixture());expect(result.teamId).toBe(TARGET.teamId);
 expect(result.requestBody).toMatchObject({project:TARGET.project,target:'production',gitSource:{type:'github',repoId:TARGET.repoId,ref:'a'.repeat(40)},
  projectSettings:{rootDirectory:'web',installCommand:'npm ci',buildCommand:'npm run build',sourceFilesOutsideRootDirectory:true,skipGitConnectDuringLink:true}});
 expect(result.requestBody).not.toHaveProperty('files');expect(result.requestBody).not.toHaveProperty('deploymentId');
});
it('rejects the failed two-file diagnostic source and a missing web lock',()=>{
 for(const paths of [['web/package.json','web/audit.cjs'],requiredFiles.filter((p:string)=>p!=='web/package-lock.json')]){
  const f=fixture();f.tree.tree=f.tree.tree.filter((row:any)=>paths.includes(row.path));expect(()=>prepare(f)).toThrow();
 }
});
it('rejects files uploads, redeployment IDs, main and unpinned/truncated/unreviewed trees',()=>{
 for(const change of [{files:[]},{deploymentId:'dpl_failed'},{branch:'main'},{commitSha:'main'},
  {tree:{...fixture().tree,truncated:true}},{commitTreeSha:'c'.repeat(40)},{reviewedBlobs:{}},
  {reviewedBlobs:{'web/package-lock.json':'d'.repeat(40)}}])expect(()=>prepare({...fixture(),...change})).toThrow();
});
it('rejects mismatched lock bytes even when a lock path is present',()=>{
 const f=fixture();expect(()=>prepare({...f,webLock:'{}'})).toThrow();
 const lock=JSON.parse(f.webLock);delete lock.packages[''].dependencies.next;
 f.webLock=JSON.stringify(lock);const changed=f.tree.tree.find((r:any)=>r.path==='web/package-lock.json')!;changed.sha=hash(f.webLock);changed.size=Buffer.byteLength(f.webLock);
 f.reviewedBlobs['web/package-lock.json']=hash(f.webLock);expect(()=>prepare(f)).toThrow();
});
it('private audits also require complete Git source; never produce a website by default',()=>{
 const result=prepare({...fixture(),diagnostic:true});expect(result.requestBody.projectSettings.installCommand).toBe('npm ci');
 expect(result.requestBody.projectSettings.buildCommand).toBe('node ../scripts/payments/audit-razorpay-test.cjs');
 const f=fixture();f.tree.tree=f.tree.tree.filter((row:any)=>row.path!=='scripts/payments/audit-razorpay-test.cjs');
 expect(()=>prepare({...f,diagnostic:true})).toThrow();
});
