'use strict';
// Offline only: no network, environment write, database, scheduler, provider,
// secret import, deployment or activation. Default is inspection.
const fs=require('node:fs'),path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'../..'),PROJECT='yhnqlfcgrmckhyjdxegg';
const RELATIVE='.local-secrets/cluera-billing-scheduler.private.json';
const VARIABLE='SIGMAROUND_BILLING_WORKER_SECRET',GATE='CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED';
const PURPOSE='CLUERA_EXTERNAL_BILLING_SCHEDULER_BOOTSTRAP_ONLY';
const policy=Object.freeze({[GATE]:false,CLUERA_BILLING_V2_ENABLED:false,
 CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:false,SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:false,
 SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:false,SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:false,
 SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:true});
const FAILURE='Cluera scheduler private preparation refused.';
const fail=()=>{throw Error(FAILURE);};
function samePath(a,b){const x=path.resolve(a),y=path.resolve(b);return process.platform==='win32'?x.toLowerCase()===y.toLowerCase():x===y;}
function regularDirectory(directory){
 const absolute=path.resolve(directory),parsed=path.parse(absolute);let cursor=parsed.root;
 for(const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
  cursor=path.join(cursor,segment);const stat=fs.lstatSync(cursor,{bigint:true});
  if(!stat.isDirectory()||stat.isSymbolicLink()||!samePath(fs.realpathSync(cursor),cursor))fail();
 }
}
function plain(value,keys){
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype)fail();
 const names=Reflect.ownKeys(value);
 if(names.some(key=>typeof key!=='string')||names.sort().join(',')!==[...keys].sort().join(','))fail();
 if(Object.values(Object.getOwnPropertyDescriptors(value)).some(property=>!Object.hasOwn(property,'value')))fail();
 return value;
}
function secretBytes(value){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))fail();
 const bytes=Buffer.from(value,'base64url');
 if(bytes.length!==32||bytes.toString('base64url')!==value||new Set(bytes).size<8)fail();
 return bytes;
}
const INSTRUCTIONS='Owner-only private copy after reviewed provisioning approval: save the same SIGMAROUND_BILLING_WORKER_SECRET in dedicated Cluera Vercel Production-only Secret and Cluera Render server settings. Keep CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED=false in BOTH servers and retain every disabledPolicy value. This file does not authorize a deployment, migration, merchant pin, webhook change, payment, worker tick, provider call, scheduling or activation. Never paste values into chat, logs, Git or client variables. Keep this file private; Windows permissions require separate owner custody.';
function validate(value){
 plain(value,['version','projectRef','purpose','web','relay','disabledPolicy','instructions']);
 if(value.version!==1||value.projectRef!==PROJECT||value.purpose!==PURPOSE)fail();
 for(const name of ['web','relay'])plain(value[name],[VARIABLE,GATE]);
 if(value.web[GATE]!==false||value.relay[GATE]!==false)fail();
 const web=secretBytes(value.web[VARIABLE]),relay=secretBytes(value.relay[VARIABLE]);
 try{if(!timingSafeEqual(web,relay))fail();}finally{web.fill(0);relay.fill(0);}
 plain(value.disabledPolicy,Object.keys(policy));
 if(Object.entries(policy).some(([name,expected])=>value.disabledPolicy[name]!==expected)||value.instructions!==INSTRUCTIONS)fail();
 return true;
}
function git(root,args){return execFileSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:8192});}
function ignoredPrivatePath(root){
 const stat=fs.lstatSync(path.join(root,'.gitignore'),{bigint:true});
 if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)fail();
 const top=git(root,['rev-parse','--show-toplevel']).trim();regularDirectory(top);
 // Git can report the physical drive for a SUBST checkout. Compare exact
 // directory identity, not a weaker prefix or a skipped repository check.
 const expected=fs.lstatSync(root,{bigint:true}),actual=fs.lstatSync(top,{bigint:true});
 if(expected.ino<=0n||expected.dev!==actual.dev||expected.ino!==actual.ino)fail();
 git(root,['check-ignore','--no-index','--quiet','--',RELATIVE]);
 if(git(root,['ls-files','--',RELATIVE]).trim())fail();
}
function readPrivate(output){
 const before=fs.lstatSync(output,{bigint:true});
 if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||before.size<1n||before.size>8192n)fail();
 if(process.platform!=='win32'&&(before.mode&0o077n)!==0n)fail();
 const descriptor=fs.openSync(output,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const opened=fs.fstatSync(descriptor,{bigint:true});
  if(!opened.isFile()||opened.nlink!==1n||opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size)fail();
  validate(JSON.parse(fs.readFileSync(descriptor,'utf8')));
  const after=fs.lstatSync(output,{bigint:true});
  if(after.isSymbolicLink()||after.nlink!==1n||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size)fail();
 }finally{fs.closeSync(descriptor);}
}
function inspectAndPrepare({root=ROOT,projectRef=PROJECT,mode='check'}={}){
 let stage='CONTEXT';
 try{
  if(typeof root!=='string'||typeof projectRef!=='string'||projectRef!==PROJECT||!['check','prepare'].includes(mode))fail();
  root=path.resolve(root);stage='PATH';regularDirectory(root);stage='IGNORE';ignoredPrivatePath(root);stage='PRIVATE';
  const directory=path.join(root,'.local-secrets'),output=path.join(root,RELATIVE);
  let exists=false;
  try{fs.lstatSync(directory,{bigint:true});exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists){regularDirectory(directory);try{fs.lstatSync(output,{bigint:true});readPrivate(output);return {status:'retained',projectRef:PROJECT,file:output,valuesDisplayed:false,activationAuthorized:false};}catch(error){if(error.code!=='ENOENT')throw error;}}
  if(mode==='check')return {status:'absent',projectRef:PROJECT,file:output,valuesDisplayed:false,activationAuthorized:false};
  // Only a new parent and exclusive leaf. Never overwrite or rotate.
  if(!exists)fs.mkdirSync(directory,{mode:0o700});
  regularDirectory(directory);ignoredPrivatePath(root);
  const random=randomBytes(32);let secret;
  try{secret=random.toString('base64url');}finally{random.fill(0);}
  const value={version:1,projectRef:PROJECT,purpose:PURPOSE,
   web:{[VARIABLE]:secret,[GATE]:false},relay:{[VARIABLE]:secret,[GATE]:false},
   disabledPolicy:{...policy},instructions:INSTRUCTIONS};
  validate(value);
  const descriptor=fs.openSync(output,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|(fs.constants.O_NOFOLLOW??0),0o600);
  try{const stat=fs.fstatSync(descriptor,{bigint:true});if(!stat.isFile()||stat.nlink!==1n)fail();fs.writeFileSync(descriptor,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(descriptor);}
  finally{fs.closeSync(descriptor);}
  regularDirectory(directory);readPrivate(output);ignoredPrivatePath(root);
  return {status:'prepared',projectRef:PROJECT,file:output,valuesDisplayed:false,activationAuthorized:false};
 }catch{const error=Error(FAILURE);error.code=stage;throw error;}
}
function cli(argv=process.argv.slice(2)){
 if(argv.length>1||(argv.length===1&&!['--check','--prepare'].includes(argv[0])))fail();
 return inspectAndPrepare({mode:argv[0]==='--prepare'?'prepare':'check'});
}
module.exports={PROJECT,RELATIVE,VARIABLE,GATE,PURPOSE,FAILURE,INSTRUCTIONS,policy,validate,inspectAndPrepare,cli};
if(require.main===module)try{console.log(JSON.stringify(cli()));}catch{console.error(FAILURE);process.exitCode=1;}
