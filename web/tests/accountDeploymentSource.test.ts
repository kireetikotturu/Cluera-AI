import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {expect,it} from 'vitest';
const require=createRequire(import.meta.url);
const {prepare,TARGET,requiredFiles}=require('../../scripts/prepare-cluera-staging-deployment.cjs');
const {verifyProxyFork,PREFIX}=require('../../scripts/verify-cluera-proxy-fork.cjs');
const {verifyTree}=require('../../scripts/prepare-reviewed-sources.cjs');
const root=path.resolve(import.meta.dirname,'../..');
const hash=(text:string)=>createHash('sha1').update('blob '+Buffer.byteLength(text)+'\0').update(text).digest('hex');
function completeTree(rows:any[]){
 const all:any[]=[...rows],dirs=new Set<string>();
 for(const row of rows){let p=path.posix.dirname(row.path);while(p!=='.'){dirs.add(p);p=path.posix.dirname(p);}}
 const treeHash=(parent:string)=>{const entries=all.filter(r=>(path.posix.dirname(r.path)==='.'?'':path.posix.dirname(r.path))===parent).sort((a,b)=>Buffer.compare(Buffer.from(path.posix.basename(a.path)+(a.type==='tree'?'/':'')),Buffer.from(path.posix.basename(b.path)+(b.type==='tree'?'/':''))));
 const bytes=Buffer.concat(entries.map(r=>Buffer.concat([Buffer.from(`${r.type==='tree'?'40000':r.mode} ${path.posix.basename(r.path)}\0`),Buffer.from(r.sha,'hex')])));return createHash('sha1').update(`tree ${bytes.length}\0`).update(bytes).digest('hex');};
 for(const p of [...dirs].sort((a,b)=>b.split('/').length-a.split('/').length))all.push({path:p,type:'tree',mode:'040000',sha:treeHash(p)});
 const rootHash=treeHash('');return{sha:rootHash,truncated:false,tree:all};
}
function fixture(vendor=false){
 const webPackage=fs.readFileSync(path.join(root,'web/package.json'),'utf8'),webLock=fs.readFileSync(path.join(root,'web/package-lock.json'),'utf8');
 const rows=[...requiredFiles,'scripts/payments/audit-razorpay-test.cjs'].map((file:string)=>({path:file,type:'blob',mode:'100644',sha:hash(fs.readFileSync(path.join(root,file),'utf8')),size:fs.statSync(path.join(root,file)).size}));
 if(vendor)for(const [file,pin] of verifyProxyFork())rows.push({path:file,type:'blob',mode:'100644',sha:pin.gitSha,size:pin.size});
 const tree=completeTree(rows);
 return {commitSha:'a'.repeat(40),commitTreeSha:tree.sha,branch:TARGET.branch,
  tree,webPackage,webLock,
  reviewedBlobs:Object.fromEntries(rows.map((row:any)=>[row.path,row.sha]))};
}
it('builds a complete SHA-pinned Account-only Git deployment with npm ci',()=>{
 const result=prepare(fixture());expect(result.teamId).toBe(TARGET.teamId);
 expect(result.requestBody).toMatchObject({project:TARGET.project,target:'production',gitSource:{type:'github',repoId:TARGET.repoId,ref:'a'.repeat(40)},
  projectSettings:{rootDirectory:'web',installCommand:'npm ci',buildCommand:'npm run build',sourceFilesOutsideRootDirectory:true,skipGitConnectDuringLink:true}});
 expect(result.requestBody).not.toHaveProperty('files');expect(result.requestBody).not.toHaveProperty('deploymentId');
});
it('accepts the complete fixed-manifest vendor package including all44 exact runtime files, not generic generated outputs',()=>{
 const f=fixture(true),pins=verifyProxyFork();expect(pins.size).toBe(77);
 expect([...pins.keys()].filter(file=>file.startsWith(PREFIX+'dist/'))).toHaveLength(44);
 expect(prepare(f).requestBody.gitSource.ref).toBe('a'.repeat(40));
 // Historical/general reference tree verification retains its original deny-all default.
 expect(()=>verifyTree(f.tree.tree,f.commitTreeSha)).toThrow(/GENERATED_OR_PRIVATE_SOURCE/);
});
it.each(['changed hash','changed size','missing runtime','missing manifest','symlink runtime','unknown runtime','unknown source','generated desktop','generated backend','unknown directory','extra empty directory'])('rejects %s even after the supplied complete Git tree and reviewed pins are recomputed',reason=>{
 const f=fixture(true);let rows=f.tree.tree.filter((r:any)=>r.type==='blob').map((r:any)=>({...r}));
 const target=PREFIX+'dist/classes/Agent.js';
 if(reason==='changed hash')rows.find((r:any)=>r.path===target)!.sha='d'.repeat(40);
 if(reason==='changed size')rows.find((r:any)=>r.path===target)!.size++;
 if(reason==='missing runtime')rows=rows.filter((r:any)=>r.path!==target);
 if(reason==='missing manifest')rows=rows.filter((r:any)=>r.path!==PREFIX+'CLUERA_MANIFEST.json');
 if(reason==='symlink runtime')rows.find((r:any)=>r.path===target)!.mode='120000';
 if(reason==='unknown runtime')rows.push({path:PREFIX+'dist/unreviewed.js',type:'blob',mode:'100644',sha:hash('unknown'),size:7});
 if(reason==='unknown source')rows.push({path:PREFIX+'src/unreviewed.ts',type:'blob',mode:'100644',sha:hash('unknown'),size:7});
 if(reason==='generated desktop')rows.push({path:'desktop/dist/main.js',type:'blob',mode:'100644',sha:hash('unknown'),size:7});
 if(reason==='generated backend')rows.push({path:'backend/dist/main.js',type:'blob',mode:'100644',sha:hash('unknown'),size:7});
 if(reason==='unknown directory')rows.push({path:PREFIX+'src/unreviewed/leaf.ts',type:'blob',mode:'100644',sha:hash('unknown'),size:7});
 if(reason==='extra empty directory')rows.push({path:PREFIX+'dist/empty',type:'tree',mode:'040000',sha:createHash('sha1').update('tree 0\0').digest('hex')});
 const tree=completeTree(rows);expect(()=>prepare({...f,tree,commitTreeSha:tree.sha,reviewedBlobs:Object.fromEntries(rows.filter((r:any)=>r.type==='blob').map((r:any)=>[r.path,r.sha]))})).toThrow();
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
