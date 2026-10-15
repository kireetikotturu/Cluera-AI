'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const desktop=path.resolve(__dirname,'../desktop');
function validateTarget(directory=desktop){
 const read=name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'));
 const metadata=read('package.json'),lock=read('package-lock.json'),version=read('resources/cluera-version.json');
 if(metadata.name!=='cluera-ai-desktop'||!/^\d+[.]\d+[.]\d+$/.test(metadata.version)
  ||lock.name!==metadata.name||lock.version!==metadata.version||lock.packages?.['']?.name!==metadata.name
  ||lock.packages[''].version!==metadata.version||version.version!==metadata.version)throw Error('Cluera TEST version metadata mismatch.');
 const output=path.join(directory,'release-cluera-staging',metadata.version);
 // A version is immutable even if an earlier build stopped before the EXE existed.
 // Inspect the failure and choose a new version; never overwrite retained candidates.
 if(fs.existsSync(output))throw Error('Cluera TEST output already exists; retained candidates are immutable.');
 return {version:metadata.version,output};
}
function packageTest(){
 validateTarget();
 const env={...process.env};
 // Unsigned TEST only. Do not consume machine/global signing credentials.
 for(const key of Object.keys(env))if(/^(?:WIN_)?CSC_|^SIGNING_|^GH_TOKEN$|^GITHUB_TOKEN$/.test(key))delete env[key];
 env.CSC_IDENTITY_AUTO_DISCOVERY='false';
 const cache=path.resolve(desktop,'../.build-cache');
 for(const name of ['electron-builder','electron','temp'])fs.mkdirSync(path.join(cache,name),{recursive:true});
 env.ELECTRON_BUILDER_CACHE=path.join(cache,'electron-builder');
 env.ELECTRON_CACHE=path.join(cache,'electron');
 env.TEMP=env.TMP=path.join(cache,'temp');
 const result=spawnSync(process.execPath,[path.join(desktop,'node_modules/electron-builder/out/cli/cli.js'),
  '--config','electron-builder.cluera.cjs','--win','nsis','--x64','--publish','never'],{cwd:desktop,env,stdio:'inherit',windowsHide:true,shell:false});
 if(result.error)console.error('Cluera TEST packaging could not start.');
 return result.status??1;
}
module.exports={validateTarget,packageTest};
if(require.main===module)try{process.exitCode=packageTest();}catch{console.error('Cluera TEST packaging refused: use consistent metadata and a new, absent version directory.');process.exitCode=1;}
