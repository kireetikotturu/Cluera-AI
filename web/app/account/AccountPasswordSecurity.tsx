'use client';
import {useEffect,useRef,useState} from 'react';
import {z} from 'zod';
import {authFailure} from '../../lib/accounts/publicAuth';

export type PasswordSecurityState={accountId:string;passwordRecovery:boolean;status:'checking'|'ready'|'mfa'|'expired'|'unavailable'};
const snapshot=z.object({accountId:z.uuid(),passwordRecovery:z.boolean(),recoveryExpired:z.boolean(),needsMfa:z.boolean(),
 factors:z.array(z.object({id:z.uuid(),type:z.literal('totp')}).strict()).max(20)}).strict()
 .refine(value=>new Set(value.factors.map(factor=>factor.id)).size===value.factors.length&&(!value.recoveryExpired||value.passwordRecovery));
const verified=z.object({ok:z.literal(true)}).strict();
const failed=z.object({code:z.string().max(80),error:z.string().max(1000)}).strict();

async function securityRequest(path:string,controller:AbortController,body?:object){
 let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNAVAILABLE'));},10000);});
 const canceled=new Promise<never>((_,reject)=>controller.signal.addEventListener('abort',()=>reject(Error('CANCELED')),{once:true}));
 const wait=<T,>(value:Promise<T>)=>Promise.race([value,expired,canceled]);
 try{
  if(controller.signal.aborted)throw Error('CANCELED');
  const response=await wait(fetch(path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal,
   ...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}));
  if(response.redirected||response.url&&response.url!==new URL(path,window.location.origin).href
   ||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)throw Error('UNAVAILABLE');
  const length=response.headers.get('content-length');if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>8192))throw Error('UNAVAILABLE');
  reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  for(;;){const part=await wait(reader.read());if(part.done)break;size+=part.value.byteLength;if(size>8192)throw Error('UNAVAILABLE');parts.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  return{status:response.status,data:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))as unknown};
 }finally{clearTimeout(timer);void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* Do not wait on cancellation. */}}
}

/** Password authorization only. No factor enrollment/removal, password replay,
 * email request, workspace promotion or token is exposed by this component. */
export function AccountPasswordSecurity({accountId,passwordRecovery,refresh,disabled,onChange,onVerified,onRestartRecovery}:{
 accountId:string;passwordRecovery:boolean;refresh:number;disabled:boolean;onChange:(state:PasswordSecurityState)=>void;onVerified:()=>void;onRestartRecovery:()=>void;
}){
 const [state,setState]=useState<z.infer<typeof snapshot>|null>(null),[message,setMessage]=useState('Checking password security…'),[busy,setBusy]=useState(false),[factorId,setFactorId]=useState('');
 const alive=useRef(true),generation=useRef(0),request=useRef<AbortController|null>(null);
 const callbacks=useRef({onChange,onVerified});callbacks.current={onChange,onVerified};
 const scope=useRef({accountId,passwordRecovery});scope.current={accountId,passwordRecovery};
 function change(status:PasswordSecurityState['status']){callbacks.current.onChange({accountId,passwordRecovery,status});}
 async function load(afterMfa=false){
  request.current?.abort();const controller=new AbortController(),version=++generation.current;
  request.current=controller;setBusy(true);setState(null);change('checking');setMessage('Checking password security…');
  const current=()=>alive.current&&generation.current===version&&scope.current.accountId===accountId&&scope.current.passwordRecovery===passwordRecovery;
  try{
   const response=await securityRequest(`/api/account/password-security?${new URLSearchParams({expectedAccountId:accountId})}`,controller);
   if(!current())return;
   if(response.status!==200){const error=failed.safeParse(response.data);throw Error(error.success&&response.status===401?'AUTHENTICATION_REQUIRED':'UNAVAILABLE');}
   const value=snapshot.parse(response.data);if(value.accountId!==accountId||value.passwordRecovery!==passwordRecovery)throw Error('UNAVAILABLE');
   if(value.needsMfa&&!value.factors.length)throw Error('UNAVAILABLE');
   setState(value);setFactorId(value.factors.length===1?value.factors[0].id:'');
   change(value.recoveryExpired?'expired':value.needsMfa?'mfa':'ready');
   setMessage(value.recoveryExpired?'This reset link has expired. Request a new one to continue.'
    :value.needsMfa?'Enter the six-digit code from your authenticator app to continue.'
     :afterMfa?'Authenticator verified. Choose your new password.':'Ready to update your password.');
   if(afterMfa&&!value.needsMfa&&!value.recoveryExpired)callbacks.current.onVerified();
  }catch(error){if(current()){change('unavailable');setMessage(error instanceof Error&&error.message==='AUTHENTICATION_REQUIRED'
   ?passwordRecovery?'This recovery session is no longer valid. Restart recovery or sign in explicitly.':'Your sign-in must be checked before updating your password.'
   :'Password security is unavailable. Check again before submitting a password update.');}}
  finally{if(current()){request.current=null;setBusy(false);}controller.abort();}
 }
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++generation.current;request.current?.abort();};},[accountId,passwordRecovery,refresh]);
 async function verify(form:HTMLFormElement){
  if(disabled||busy||request.current||!state?.needsMfa||state.recoveryExpired||!state.factors.some(factor=>factor.id===factorId))return;
  const code=String(new FormData(form).get('code')??'');form.reset();if(!/^[0-9]{6}$/.test(code)){setMessage('Enter the current six-digit authenticator code.');return;}
  const controller=new AbortController(),version=++generation.current;request.current=controller;setBusy(true);change('checking');setMessage('Verifying authenticator…');
  const current=()=>alive.current&&generation.current===version&&scope.current.accountId===accountId&&scope.current.passwordRecovery===passwordRecovery;
  try{
   const response=await securityRequest('/api/account/password-mfa',controller,{expectedAccountId:accountId,factorId,code});
   if(!current())return;
   if(response.status!==200){const error=failed.safeParse(response.data);
    if(response.status===401||error.success&&error.data.code==='RECOVERY_SESSION_REQUIRED'){request.current=null;await load();return;}
    setMessage(authFailure(response.status,'password-mfa',error.success?error.data.code:undefined));change('mfa');return;}
   verified.parse(response.data);request.current=null;await load(true);
  }catch{if(current()){setState(null);change('unavailable');setMessage('Authenticator verification could not be confirmed. Check password security before trying again.');}}
  finally{if(current()){request.current=null;setBusy(false);}controller.abort();}
 }
 if(state&&!state.recoveryExpired&&!state.needsMfa&&!busy)return null;
 return <section className="account-password-security" aria-label="Password security verification" aria-busy={busy}>
  <p role="status" aria-live="polite">{message}</p>
  {state?.needsMfa&&!state.recoveryExpired?<form aria-label="Verify password authenticator" onSubmit={event=>{event.preventDefault();void verify(event.currentTarget);}}>
   <fieldset disabled={disabled||busy}><legend>Existing authenticator</legend>
    {state.factors.length>1?<label>Authenticator<select value={factorId} onChange={event=>setFactorId(event.target.value)} required><option value="">Choose authenticator</option>{state.factors.map((factor,index)=><option key={factor.id}value={factor.id}>Authenticator {index+1}</option>)}</select></label>:null}
    <label>Six-digit authenticator code<input name="code" type="text" inputMode="numeric" pattern="[0-9]{6}" minLength={6}maxLength={6}autoComplete="one-time-code" required/></label>
    <button type="submit">Verify authenticator</button>
   </fieldset>
  </form>:null}
  {!state?<button className="button secondary" type="button" disabled={disabled||busy} onClick={()=>void load()}>Check password security</button>:null}
  {passwordRecovery&&(state?.recoveryExpired||!state&&!busy)?<button className="button secondary" type="button" disabled={disabled||busy} onClick={onRestartRecovery}>Sign out and restart recovery</button>:null}
 </section>;
}
