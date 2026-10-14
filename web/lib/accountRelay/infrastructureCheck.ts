import {createClient} from '@supabase/supabase-js';
import {STAGING_DATABASE,STAGING_SITE,type RelayConfig} from './config';

/** Operator-only positive authentication. One Auth GET, never a ledger, rate,
 * session, provider or financial writer. Discard identities and raw errors. */
export async function relayDatabaseAuthenticated(config:RelayConfig,request:typeof fetch=fetch):Promise<boolean>{
 if(config.database!==STAGING_DATABASE||config.site!==STAGING_SITE)return false;
 try{
  const client=createClient(config.database,config.serviceKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,debug:false},
   global:{fetch:async(input,init)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
    if(url.origin!==STAGING_DATABASE||url.pathname!=='/auth/v1/admin/users'||url.username||url.password||url.hash
     ||(init?.method??'GET')!=='GET'||init?.body!=null
     ||url.searchParams.get('page')!=='1'||url.searchParams.get('per_page')!=='1'
     ||[...url.searchParams].length!==2)throw Error('Infrastructure status unavailable.');
    const response=await request(input,{...init,redirect:'error',signal:AbortSignal.timeout(5000)});
    if(!response.ok||!response.body)throw Error('Infrastructure status unavailable.');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
    try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>65536)throw Error('Infrastructure status unavailable.');chunks.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    return new Response(Buffer.concat(chunks),{status:response.status,headers:{'Content-Type':'application/json'}});
   }}});
  const {data,error}=await client.auth.admin.listUsers({page:1,perPage:1});
  return !error&&Array.isArray(data?.users);
 }catch{return false;}
}
