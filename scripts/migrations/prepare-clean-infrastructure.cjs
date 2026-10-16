'use strict';
// Offline owner-only infrastructure preparation. No environment imports, old
// secret reads, network, provider keys, signing trust or hosted writes.
const fs=require('node:fs'),path=require('node:path'),{randomBytes}=require('node:crypto');
const PROJECT='yhnqlfcgrmckhyjdxegg';
const FILE=`cluera-${PROJECT}-infrastructure.private.json`;
const KEY_FILE=`cluera-${PROJECT}-server-keys.private.json`;
function readPrivateJson(file){
 try{
  const stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error();
  return JSON.parse(fs.readFileSync(file,'utf8'));
 }catch{throw Error('Private clean input unavailable.');}
}
function keySlots(directory){
 const file=path.join(directory,KEY_FILE);
 if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({projectRef:PROJECT,webSecretKey:'',relaySecretKey:''},null,2)+'\n',{flag:'wx',mode:0o600});
 const data=readPrivateJson(file);
 const valid=value=>value===''||typeof value==='string'&&/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(value);
 if(Object.keys(data).sort().join(',')!=='projectRef,relaySecretKey,webSecretKey'||data.projectRef!==PROJECT||!valid(data.webSecretKey)||!valid(data.relaySecretKey)
  ||data.webSecretKey&&data.webSecretKey===data.relaySecretKey)throw Error('Invalid separate clean server-key slots; no overwrite.');
 return file;
}
function prepare(root=path.resolve(__dirname,'../..'),projectRef=PROJECT){
 if(projectRef!==PROJECT)throw Error('Clean Cluera target mismatch.');
 const directory=path.join(root,'.local-secrets'),file=path.join(directory,FILE);
 if(fs.existsSync(directory)){
  const stat=fs.lstatSync(directory);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Private clean directory refused.');
 }
 if(fs.existsSync(file)){
  const data=readPrivateJson(file);
  const valid=value=>typeof value==='string'&&Buffer.from(value,'base64').length===32&&Buffer.from(value,'base64').toString('base64')===value;
  if(data.projectRef!==PROJECT||!valid(data.web?.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64)||!valid(data.web?.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64)
   ||data.relay?.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64!==data.web.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64
   ||data.web.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64===data.web.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64)throw Error('Existing clean settings are invalid; no overwrite.');
  return {status:'retained',file,keyFile:keySlots(directory),valuesDisplayed:false};
 }
 const cookie=randomBytes(32).toString('base64'),rate=randomBytes(32).toString('base64');
 const data={projectRef:PROJECT,preparedOnly:true,
  instructions:'Private owner copy only. Do not paste into chat/Git or apply until the coordinated clean-source rollout. New Supabase web/relay sb_secret_ keys must be separately created in this project. Provider vault/worker/signing keys are not generated here.',
  web:{SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:cookie,SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:rate},
  relay:{SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:rate}};
 fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(file,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});
 return {status:'prepared',file,keyFile:keySlots(directory),valuesDisplayed:false};
}
module.exports={PROJECT,FILE,KEY_FILE,prepare};
if(require.main===module)try{const result=prepare();console.log(JSON.stringify({status:result.status,privateFilePrepared:true,valuesDisplayed:false}));}
catch{console.error('Clean Cluera infrastructure preparation refused; no overwrite.');process.exitCode=1;}
