'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const desktop=path.resolve(__dirname,'../desktop'),env={...process.env};
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
process.exitCode=result.status??1;
