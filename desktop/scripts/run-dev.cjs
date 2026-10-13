'use strict';
// Argument-array subprocesses, no shell parser or untrusted command interpolation.
const path=require('node:path'),fs=require('node:fs'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),children=new Set();let stopped=false,electron;
function run(script,args=[],env=process.env){const p=spawn(process.execPath,[path.join(root,script),...args],{cwd:root,stdio:'inherit',env,shell:false,windowsHide:true});children.add(p);p.on('exit',code=>{children.delete(p);if(code&&p!==electron)stop(code);});p.on('error',()=>stop(1));return p;}
function stop(code=0){if(stopped)return;stopped=true;clearInterval(ready);watch?.close();for(const child of children)child.kill();process.exitCode=code;}
run('node_modules/vite/bin/vite.js',['--host','127.0.0.1']);
run('node_modules/typescript/bin/tsc',['-p','tsconfig.main.json','--watch','--preserveWatchOutput']);
let watch,restartTimer;const start=()=>{if(stopped)return;electron?.kill();electron=run('scripts/run-electron.cjs',[],{...process.env,VITE_DEV_SERVER_URL:'http://127.0.0.1:5173'});};
const ready=setInterval(()=>{if(!fs.existsSync(path.join(root,'dist/main/main.js'))||!fs.existsSync(path.join(root,'dist/preload/preload.js')))return;clearInterval(ready);start();watch=fs.watch(path.join(root,'dist'),{recursive:true},()=>{clearTimeout(restartTimer);restartTimer=setTimeout(start,700);});},250);
process.once('SIGINT',()=>stop());process.once('SIGTERM',()=>stop());
