'use strict';
// Request preparation only: no credentials, network, Git mutation or deployment side effect.
const {createHash}=require('node:crypto');
const path=require('node:path');
const {verifyTree}=require('./prepare-reviewed-sources.cjs');
const {verifyProxyFork,PREFIX}=require('./verify-cluera-proxy-fork.cjs');
const TARGET={teamId:'team_AksnPXhi2VBXI5UsY2xBIakc',project:'cluera-ai-staging',
 name:'cluera-ai-staging',branch:'staging',repoId:'1416291494'};
const requiredFiles=['web/package.json','web/package-lock.json','web/next.config.ts','web/tsconfig.json',
 'web/app/layout.tsx','web/app/page.tsx','web/app/account/checkout/page.tsx',
 'web/app/api/account/payments/checkout/route.ts','web/app/api/payments/razorpay/test/webhook/route.ts',
 'web/lib/payments/core/config.ts','scripts/verify-cluera-artifacts.cjs','scripts/security/source-secret-scan.cjs'];
function prepare(input){
 const {commitSha,commitTreeSha,branch,tree,webPackage,webLock,reviewedBlobs,diagnostic=false}=input;
 if(branch!==TARGET.branch||! /^[a-f0-9]{40}$/.test(commitSha??'')||tree?.sha!==commitTreeSha
  ||! /^[a-f0-9]{40}$/.test(commitTreeSha??'')||tree.truncated!==false||!Array.isArray(tree.tree)
  ||'files' in input||'deploymentId' in input||typeof diagnostic!=='boolean')throw Error('Unreviewed or incomplete deployment source.');
 const reviewedGeneratedPaths=new Set();
 const vendorRows=tree.tree.filter(row=>row.path===PREFIX.slice(0,-1)||row.path.startsWith(PREFIX));
 if(vendorRows.length){
  // The locally reverified, fixed-digest manifest is the authority, not caller
  // blob pins or a permissive dist allowlist. Every fork source/runtime file
  // must be present and exactly match its reviewed Git hash AND byte length.
  const pins=verifyProxyFork(),parents=new Set();
  for(const file of pins.keys()){
   let parent=path.posix.dirname(file);
   while(parent!=='.'){parents.add(parent);parent=path.posix.dirname(parent);}
   if(file.startsWith(PREFIX+'dist/'))reviewedGeneratedPaths.add(file);
  }
  for(const parent of parents)if(parent===PREFIX+'dist'||parent.startsWith(PREFIX+'dist/'))reviewedGeneratedPaths.add(parent);
  for(const row of vendorRows){
   if(row.type==='blob'){
    const pin=pins.get(row.path);
    if(!pin||row.mode!=='100644'||row.sha!==pin.gitSha||row.size!==pin.size)throw Error('Reviewed vendor source mismatch.');
   }else if(row.type!=='tree'||!parents.has(row.path))throw Error('Unreviewed vendor source directory.');
  }
  for(const file of pins.keys())if(!vendorRows.some(row=>row.path===file&&row.type==='blob'))throw Error('Complete reviewed vendor source required.');
 }
 verifyTree(tree.tree,commitTreeSha,reviewedGeneratedPaths);
 const blobs=new Map();
 for(const row of tree.tree){if(blobs.has(row.path))throw Error('Duplicate source path.');blobs.set(row.path,row);}
 const required=diagnostic?[...requiredFiles,'scripts/payments/audit-razorpay-test.cjs']:requiredFiles;
 for(const file of required){const row=blobs.get(file);if(row?.type!=='blob'||row.mode!=='100644'||! /^[a-f0-9]{40}$/.test(row.sha))throw Error('Complete Account source and lockfile required.');}
 if(!reviewedBlobs||Object.keys(reviewedBlobs).length!==tree.tree.filter(row=>row.type==='blob').length)throw Error('Reviewed blob pins required.');
 for(const [file,sha] of Object.entries(reviewedBlobs))if(blobs.get(file)?.sha!==sha)throw Error('Reviewed source mismatch.');
 function parsePinned(file,bytes){
  if(typeof bytes!=='string')throw Error('Manifest and lock bytes required.');
  const data=Buffer.from(bytes),sha=createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex');
  if(blobs.get(file)?.sha!==sha)throw Error('Manifest or lock does not match reviewed tree.');
  return JSON.parse(bytes);
 }
 const manifest=parsePinned('web/package.json',webPackage),lock=parsePinned('web/package-lock.json',webLock);
 if(manifest.name!=='cluera-ai-web'||lock.name!==manifest.name||lock.lockfileVersion!==3||!lock.packages?.[''])throw Error('Complete web lock required.');
 for(const section of ['dependencies','devDependencies']){
  const actual=lock.packages[''][section]??{},expected=manifest[section]??{};
  if(Object.keys(actual).length!==Object.keys(expected).length||Object.entries(expected).some(([key,value])=>actual[key]!==value))throw Error('Web manifest/lock mismatch.');
 }
 return{teamId:TARGET.teamId,requestBody:{name:TARGET.name,project:TARGET.project,target:'production',
  gitSource:{type:'github',repoId:TARGET.repoId,ref:commitSha},projectSettings:{rootDirectory:'web',framework:'nextjs',
   buildCommand:diagnostic?'node ../scripts/payments/audit-razorpay-test.cjs':'npm run build',installCommand:'npm ci',
   nodeVersion:'24.x',sourceFilesOutsideRootDirectory:true,skipGitConnectDuringLink:true}}};
}
module.exports={prepare,TARGET,requiredFiles};
