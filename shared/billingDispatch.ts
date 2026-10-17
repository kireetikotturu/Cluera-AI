import {createHash,createHmac,timingSafeEqual} from 'node:crypto';

export const SCHEDULER_PROJECT_REF='yhnqlfcgrmckhyjdxegg';
export const SCHEDULER_SUPABASE_URL='https://yhnqlfcgrmckhyjdxegg.supabase.co';
export const WEB_DISPATCH_URL='https://cluera-ai-staging.vercel.app/api/internal/billing/cluera/dispatch';
export const RELAY_WAKE_URL='https://cluera-ai-relay-staging.onrender.com/internal/billing/wake';
export const RELAY_STATUS_URL='https://cluera-ai-relay-staging.onrender.com/internal/billing/status';
export type SchedulerPurpose='DISPATCH'|'WAKE'|'STATUS';
export type SchedulerEnv=Record<string,string|undefined>;
export type SchedulerVerification={issuedSeconds:number;nonce:string};
const body=Buffer.from('{}'),digest=createHash('sha256').update(body).digest('hex');
const nonceShape=/^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const target=(purpose:SchedulerPurpose)=>purpose==='DISPATCH'?WEB_DISPATCH_URL:purpose==='WAKE'?RELAY_WAKE_URL:purpose==='STATUS'?RELAY_STATUS_URL:null;
const validSecret=(secret:unknown):secret is string=>typeof secret==='string'&&secret.length>=32&&secret.length<=256&&!/[\x00-\x1f\x7f]/.test(secret);
const validSeconds=(seconds:number)=>Number.isSafeInteger(seconds)&&seconds>0&&seconds<=9999999999999;
const same=(a:string,b:string)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
export const schedulerEnabled=(env:SchedulerEnv=process.env)=>env.CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED==='true';
export const schedulerSecret=(env:SchedulerEnv=process.env):string|null=>validSecret(env.SIGMAROUND_BILLING_WORKER_SECRET)?env.SIGMAROUND_BILLING_WORKER_SECRET:null;
export function schedulerTargetMatches(env:SchedulerEnv=process.env):boolean{
 return env.SIGMAROUND_ACCOUNTS_ENABLED==='true'&&env.SIGMAROUND_ACCOUNT_ORIGIN==='https://cluera-ai-staging.vercel.app'&&env.NEXT_PUBLIC_SUPABASE_URL===SCHEDULER_SUPABASE_URL;
}
export function schedulerNonce(purpose:SchedulerPurpose,issuedSeconds:number,secret:string):string{
 const url=target(purpose);if(!url||!validSeconds(issuedSeconds)||!validSecret(secret))throw Error('SCHEDULER_CONFIGURATION');
 const bytes=createHmac('sha256',secret).update(['CLUERA-BILLING-SCHEDULER-NONCE-V1',purpose,url,Math.floor(issuedSeconds/60)].join('\n')).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
export function schedulerProofMessage(purpose:SchedulerPurpose,issuedSeconds:number,nonce:string):string{
 const url=target(purpose);if(!url||!validSeconds(issuedSeconds)||!nonceShape.test(nonce))throw Error('SCHEDULER_CONFIGURATION');
 return ['CLUERA-BILLING-SCHEDULER-V1',purpose,'POST',url,issuedSeconds,nonce,digest].join('\n');
}
export function createSchedulerProof(purpose:SchedulerPurpose,issuedSeconds:number,secret:string){
 const nonce=schedulerNonce(purpose,issuedSeconds,secret);
 return {time:String(issuedSeconds),nonce,proof:createHmac('sha256',secret).update(schedulerProofMessage(purpose,issuedSeconds,nonce)).digest('hex')};
}
export function schedulerHeaders(purpose:SchedulerPurpose,secret:string,nowMs=Date.now()):Record<string,string>{
 if(!Number.isFinite(nowMs))throw Error('SCHEDULER_CONFIGURATION');const proof=createSchedulerProof(purpose,Math.floor(nowMs/1000),secret);
 return {'Content-Type':'application/json','x-cluera-scheduler-time':proof.time,'x-cluera-scheduler-nonce':proof.nonce,'x-cluera-scheduler-proof':proof.proof};
}
export function verifySchedulerProof(purpose:SchedulerPurpose,input:{url:string;method:string;headers:Headers;body:Uint8Array},secret:string,nowMs=Date.now()):SchedulerVerification|null{
 try{
  if(!validSecret(secret)||!target(purpose)||input.url!==target(purpose)||input.method!=='POST'||!Number.isFinite(nowMs)||input.headers.has('authorization')||input.headers.has('cookie')||input.headers.has('origin')||input.headers.has('content-encoding')||input.headers.has('transfer-encoding')||input.headers.get('content-type')!=='application/json'||input.headers.has('content-length')&&input.headers.get('content-length')!=='2'||input.body.byteLength!==2||input.body[0]!==123||input.body[1]!==125)return null;
  const time=input.headers.get('x-cluera-scheduler-time')??'',nonce=input.headers.get('x-cluera-scheduler-nonce')??'',signature=input.headers.get('x-cluera-scheduler-proof')??'';
  const seconds=Number(time),now=Math.floor(nowMs/1000);
  if(!/^[1-9][0-9]{0,12}$/.test(time)||!validSeconds(seconds)||seconds<now-60||seconds>now+5||!nonceShape.test(nonce)||!same(nonce,schedulerNonce(purpose,seconds,secret))||!/^[a-f0-9]{64}$/.test(signature))return null;
  const expected=createHmac('sha256',secret).update(schedulerProofMessage(purpose,seconds,nonce)).digest();
  return timingSafeEqual(expected,Buffer.from(signature,'hex'))?{issuedSeconds:seconds,nonce}:null;
 }catch{return null;}
}
export async function verifySchedulerRequest(request:Request,purpose:SchedulerPurpose,secret:string,nowMs=Date.now()):Promise<SchedulerVerification|null>{
 if(!verifySchedulerProof(purpose,{url:request.url,method:request.method,headers:request.headers,body},secret,nowMs)||!request.body)return null;
 let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(Error('SCHEDULER_UNAVAILABLE'));void reader?.cancel().catch(()=>{});},2000);});
 try{
  reader=request.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
  for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>2)return null;chunks.push(part.value);}
  return verifySchedulerProof(purpose,{url:request.url,method:request.method,headers:request.headers,body:Buffer.concat(chunks)},secret,nowMs);
 }catch{return null;}finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* No unbounded cancellation wait. */}}
}
