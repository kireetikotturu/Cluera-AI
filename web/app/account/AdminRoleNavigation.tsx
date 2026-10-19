'use client';
import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import {z} from 'zod';

export const ACCOUNT_SESSION_STORAGE_KEY='cluera-account-session-change-v1';
const changedEvent='cluera-account-session-changed',endpoint='/api/account/admin/access';
const roleSchema=z.object({admin:z.literal(true),mfaVerified:z.boolean(),navigationSession:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Access={admin:boolean;navigationSession:string|null;checking:boolean;result:'unresolved'|'allowed'|'denied'|'signin'|'unavailable';recheck:()=>void};
const RoleContext=createContext<Access>({admin:false,navigationSession:null,checking:true,result:'unresolved',recheck:()=>{}});

/** Opaque invalidation only. Never persist identity, role, tokens or credentials. */
export function notifyAccountSessionChanged():void{
 if(typeof window==='undefined')return;
 window.dispatchEvent(new Event(changedEvent));
 try{window.localStorage.setItem(ACCOUNT_SESSION_STORAGE_KEY,crypto.randomUUID());}catch{/* Focus revalidation remains available. */}
}
async function readRole(controller:AbortController):Promise<Pick<Access,'admin'|'navigationSession'|'result'>>{
 let timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const expired=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('UNAVAILABLE'));},8000);});
 try{
  const response=await Promise.race([fetch(endpoint,{credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',signal:controller.signal}),expired]);
  if(response.redirected||response.url&&response.url!==new URL(endpoint,window.location.origin).href)throw Error('UNAVAILABLE');
  if(response.status===401)return {admin:false,navigationSession:null,result:'signin'};
  if(response.status===403)return {admin:false,navigationSession:null,result:'denied'};
  if(response.status!==200||response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'
   ||response.headers.get('cache-control')!=='no-store'||response.headers.get('x-content-type-options')!=='nosniff'||!response.body)throw Error('UNAVAILABLE');
  const length=response.headers.get('content-length');
  if(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>512))throw Error('UNAVAILABLE');
  reader=response.body.getReader();const parts:Uint8Array[]=[];let size=0;
  for(;;){const part=await Promise.race([reader.read(),expired]);if(part.done)break;
   size+=part.value.byteLength;if(size>512)throw Error('UNAVAILABLE');parts.push(part.value);}
  const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}
  const role=roleSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  return {admin:true,navigationSession:role.navigationSession,result:'allowed'};
 }catch{return {admin:false,navigationSession:null,result:'unavailable'};}
 finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{/* Never await cancellation. */}}
}
export function AdminRoleProvider({children}:{children:ReactNode}){
 const [state,setState]=useState<Omit<Access,'recheck'>>({admin:false,navigationSession:null,checking:true,result:'unresolved'});
 const refreshRef=useRef<()=>void>(()=>{});
 useEffect(()=>{
  let alive=true,generation=0,request:AbortController|null=null;
  const check=(invalidate=false)=>{
   if(!alive||request&&!invalidate)return;
   request?.abort();const current=++generation;
   setState(previous=>invalidate?{admin:false,navigationSession:null,checking:true,result:'unresolved'}:{...previous,checking:true,result:'unresolved'});
   if(document.visibilityState==='hidden'){request=null;return;}
   const controller=new AbortController();request=controller;
   void readRole(controller).then(value=>{
    if(alive&&generation===current&&request===controller)setState(previous=>
     !invalidate&&value.result==='unavailable'&&previous.admin&&previous.navigationSession
      ?{...previous,checking:false,result:'unavailable'}:{...value,checking:false});
   }).finally(()=>{if(request===controller)request=null;});
  };
  const invalidate=()=>check(true),focus=()=>check(),storage=(event:StorageEvent)=>{if(event.key===ACCOUNT_SESSION_STORAGE_KEY)check(true);};
  const visibility=()=>{if(document.visibilityState!=='hidden'){check();return;}
   ++generation;request?.abort();request=null;setState(previous=>({...previous,checking:true,result:'unresolved'}));};
  refreshRef.current=()=>check();
  window.addEventListener(changedEvent,invalidate);window.addEventListener('storage',storage);
  window.addEventListener('focus',focus);window.addEventListener('pageshow',focus);document.addEventListener('visibilitychange',visibility);
  check();
  return()=>{alive=false;++generation;request?.abort();refreshRef.current=()=>{};
   window.removeEventListener(changedEvent,invalidate);window.removeEventListener('storage',storage);
   window.removeEventListener('focus',focus);window.removeEventListener('pageshow',focus);document.removeEventListener('visibilitychange',visibility);};
 },[]);
 return <RoleContext.Provider value={{...state,recheck:()=>refreshRef.current()}}>{children}</RoleContext.Provider>;
}
export function AdminRoleLink({children='Admin',className,onClick}:{children?:ReactNode;className?:string;onClick?:()=>void}){
 const access=useContext(RoleContext);
 return access.admin&&!access.checking&&access.result==='allowed'?<Link href="/account/admin" prefetch={false} className={className} onClick={onClick}>{children}</Link>:null;
}
export function AdminAccessGate(){
 const access=useContext(RoleContext),router=useRouter(),refreshed=useRef(false);
 useEffect(()=>{
  if(!access.admin){refreshed.current=false;return;}
  if(!access.checking&&!refreshed.current){refreshed.current=true;router.refresh();}
 },[access.admin,access.checking,router]);
 return <section className="account-card" aria-busy={access.checking}><h1>Verify access to continue</h1>
  <p role="status" aria-live="polite">{access.checking?'Checking your current session...':access.result==='denied'?'This account does not have access to this page.':access.result==='signin'?'Sign in to your account to continue.':access.admin?'Session verified. Opening your workspace...':'Access could not be verified. Sign in or try again when online.'}</p>
  <a href="/account#login">Go to your account</a>{!access.checking?<button type="button" onClick={access.recheck}>Check access again</button>:null}
 </section>;
}
export function AdminProtectedContent({children}:{children:ReactNode}){
 const access=useContext(RoleContext);
 if(!access.admin||!access.navigationSession)return <AdminAccessGate/>;
 const hidden=access.checking||access.result!=='allowed';
 return <><div key={access.navigationSession} hidden={hidden} inert={hidden} aria-hidden={hidden||undefined}>{children}</div>
  {hidden?<section aria-busy={access.checking}><p role="status">{access.checking?'Verifying current access...':'Access could not be verified. Existing operations remain locked until access is restored.'}</p>
   {!access.checking?<button type="button" onClick={access.recheck}>Check access again</button>:null}</section>:null}</>;
}
