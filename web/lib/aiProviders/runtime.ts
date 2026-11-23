import {vaultKeyring,type ProviderId} from './vault';
import {readSealed,type Rpc,type Stored} from './repository';

/** Ciphertext read using server service-role auth. Never a browser endpoint.
 * One shared in-flight read per provider, max 10s cache; failure destroys stale
 * eligibility rather than using a legacy key or another paid provider. */
export function providerRuntime(rpc:Rpc,env:NodeJS.ProcessEnv=process.env,clock=()=>performance.now()){
 const vault=vaultKeyring(env),cache=new Map<ProviderId,{row:Stored;until:number}>(),pending=new Map<ProviderId,Promise<Stored>>();
 const read=async(provider:ProviderId):Promise<Stored>=>{
  const hit=cache.get(provider);if(hit&&clock()<hit.until)return hit.row;
  const active=pending.get(provider);if(active)return active;
  const loading=(async()=>{
   try{const row=await readSealed(rpc,provider);cache.set(provider,{row,until:clock()+10000});return row;}
   catch{cache.delete(provider);throw Error('Provider unavailable.');}
  })().finally(()=>{pending.delete(provider);});pending.set(provider,loading);return loading;
 };
 // The Admin model list is the authority for WHICH model runs; the vault only proves a
 // working, enabled key for the provider. Any model the Admin approved may use it.
 return {async resolve(provider:ProviderId,requested?:string,fresh=false){
  if(fresh)cache.delete(provider);
  const row=await read(provider),model=requested??row.default_model;
  if(!row.enabled||row.probe_status!=='VERIFIED'||!model||!/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(model))throw Error('Provider unavailable.');
  return {provider,model,revision:row.revision,credentialId:row.credential_id,
   key:vault.open(row.sealed,{provider,credentialId:row.credential_id})};
 }};
}
