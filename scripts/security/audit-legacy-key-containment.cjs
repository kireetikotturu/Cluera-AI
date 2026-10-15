'use strict';
// Operator-only, fixed-project GET diagnostic. PUBLIC keys only, no env imports.
const ORIGIN='https://dwqltsqumiwsxtkzdoaa.supabase.co';
const SETTINGS=ORIGIN+'/auth/v1/settings';
const EMPTY_READ=ORIGIN+'/rest/v1/customer_accounts?select=user_id&limit=0';
function publicKeys(input){
 if(!input||Object.keys(input).sort().join(',')!=='legacyPublicKey,modernPublicKey')throw Error('Invalid input');
 const {legacyPublicKey:legacy,modernPublicKey:modern}=input;
 if(typeof modern!=='string'||!/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(modern)
  ||typeof legacy!=='string'||legacy.length>8192||!/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(legacy))throw Error('Public keys required');
 const [h,p]=legacy.split('.'),header=JSON.parse(Buffer.from(h,'base64url').toString('utf8')),
  claims=JSON.parse(Buffer.from(p,'base64url').toString('utf8'));
 if(header.alg!=='HS256'||claims.role!=='anon'||claims.ref!=='dwqltsqumiwsxtkzdoaa')throw Error('Fixed public project required');
 const parts=legacy.split('.');
 parts[2]=(parts[2][0]==='A'?'B':'A')+parts[2].slice(1);
 return {legacy,modern,tampered:parts.join('.')};
}
async function run(input,fetcher=fetch){
 const result={checkedAt:new Date().toISOString(),configurationAccepted:false,legacyApiKeyRejected:false,
  modernPublishableAccepted:false,legacyPublicBearerPath:'inconclusive',privilegedBearerContainment:'unverified',
  checks:[],readOnlyRequests:0,mutations:0};
 let keys;try{keys=publicKeys(input);result.configurationAccepted=true;}catch{return result;}
 async function read(name,url,apikey,bearer){
  result.readOnlyRequests++;
  let status=0,category='unavailable',settingsAccepted=false,response;
  try{
   if(url!==SETTINGS&&url!==EMPTY_READ)throw Error('Fixed target required');
   const headers={apikey,Accept:'application/json'};if(bearer)headers.Authorization='Bearer '+bearer;
   const r=await fetcher(url,{method:'GET',headers,redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(7000)});
   response=r;
   status=r.status;
   if(!r.body||r.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error('JSON required');
   const reader=r.body.getReader(),chunks=[];let size=0;
   try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;
    if(size>65536)throw Error('Body bound');chunks.push(part.value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(status===401&&['PGRST301','PGRST303'].includes(body?.code))category='jwt-rejected';
   else if([401,403].includes(status)&&body?.code==='42501')category='permission-denied';
   else if(status===200&&url===EMPTY_READ&&Array.isArray(body)&&body.length===0)category='empty-read';
   else if(status===200&&url===SETTINGS&&body?.external&&typeof body.external==='object'&&!Array.isArray(body.external)){
    category='public-settings';settingsAccepted=true;
   }else if(status===401&&url===SETTINGS)category='api-key-rejected';
   else category='unexpected';
  }catch{/* Fixed categories only. Never return body, key, header or error. */}
  finally{await response?.body?.cancel().catch(()=>{});}
  const check={name,status,category};result.checks.push(check);return {...check,settingsAccepted};
 }
 const old=await read('legacy-api-key',SETTINGS,keys.legacy);
 result.legacyApiKeyRejected=old.status===401&&old.category==='api-key-rejected';
 result.modernPublishableAccepted=(await read('modern-public-key',SETTINGS,keys.modern)).settingsAccepted;
 if(!result.modernPublishableAccepted)return result;
 const baseline=await read('modern-empty-read',EMPTY_READ,keys.modern);
 const legacy=await read('legacy-public-bearer',EMPTY_READ,keys.modern,keys.legacy);
 const invalid=await read('tampered-public-bearer',EMPTY_READ,keys.modern,keys.tampered);
 const reachedDatabase=x=>['permission-denied','empty-read'].includes(x.category);
 if(reachedDatabase(baseline)&&invalid.category==='jwt-rejected'){
  if(reachedDatabase(legacy)&&legacy.category===baseline.category&&legacy.status===baseline.status)
   result.legacyPublicBearerPath='validated';
  else if(legacy.category==='jwt-rejected')result.legacyPublicBearerPath='rejected';
 }
 // Public-anon evidence NEVER certifies privileged service-role containment.
 return result;
}
module.exports={run,SETTINGS,EMPTY_READ};
if(require.main===module){
 try{
  const input=require('node:fs').readFileSync(0);if(input.length>16384)throw Error('Input bound');
  run(JSON.parse(input.toString('utf8'))).then(result=>{
   console.log('CLUERA_LEGACY_KEY_CONTAINMENT '+JSON.stringify(result));
   process.exitCode=2; // Security hold; never an automatic Phase A unlock.
  }).catch(()=>{console.error('Containment inspection unavailable.');process.exitCode=2;});
 }catch{console.error('Public-key input unavailable.');process.exitCode=2;}
}
