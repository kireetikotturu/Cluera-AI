import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {vaultKeyring} from '../lib/aiProviders/vault';
import {discoverModels} from '../lib/aiProviders/discovery';
import {providerRuntime} from '../lib/aiProviders/runtime';
import {relayConfig,STAGING_DATABASE,STAGING_SITE} from '../lib/accountRelay/config';
import {approvedProviders} from '../lib/accountRelay/approvedProviders';
const secret='synthetic-private-provider-credential',key=Buffer.alloc(32,41).toString('base64');
const env={CLUERA_PROVIDER_VAULT_KEYRING_BASE64:Buffer.from(JSON.stringify({active:'test-1',keys:{'test-1':key}})).toString('base64')};
const binding={provider:'gemini' as const,credentialId:randomUUID()};
describe('encrypted Cluera provider vault',()=>{
 it('uses randomized envelope encryption, strict authenticated identity and fixed errors',()=>{
  const vault=vaultKeyring(env),a=vault.seal(secret,binding),b=vault.seal(secret,binding);
  expect(a).not.toEqual(b);expect(JSON.stringify(a)).not.toContain(secret);expect(vault.open(a,binding)).toBe(secret);
  for(const value of [{...a,tag:Buffer.alloc(16).toString('base64')},{...a,keyId:'missing'},{...a,extra:'private'}])expect(()=>vault.open(value,binding)).toThrow('Provider vault unavailable.');
  expect(()=>vault.open(a,{...binding,provider:'deepgram'})).toThrow();expect(()=>vault.open(a,{...binding,credentialId:randomUUID()})).toThrow();
 });
 it('retains explicit old decryption keys for rotation, never silently generates or reuses infra keys',()=>{
  const original=vaultKeyring(env).seal(secret,binding),next=Buffer.alloc(32,42).toString('base64');
  const rotated={CLUERA_PROVIDER_VAULT_KEYRING_BASE64:Buffer.from(JSON.stringify({active:'test-2',keys:{'test-1':key,'test-2':next}})).toString('base64')};
  expect(vaultKeyring(rotated).open(original,binding)).toBe(secret);expect(vaultKeyring(rotated).seal(secret,binding).keyId).toBe('test-2');
  for(const value of [{},{...env,SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:key},{...env,SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:key},{CLUERA_PROVIDER_VAULT_KEYRING_BASE64:'malformed'}])expect(()=>vaultKeyring(value)).toThrow('Provider vault unavailable.');
 });
 it.each(['gemini','deepgram','openai','anthropic'] as const)('does one fixed-host metadata GET for %s, never generation or raw error reflection',async provider=>{
  const request=vi.fn(async()=>new Response(JSON.stringify({error:secret}),{status:401}));
  const result=await discoverModels(provider,secret,request);
  expect(result).toEqual({status:'REJECTED',models:[],complete:false});expect(request).toHaveBeenCalledOnce();
  const [url,init]=request.mock.calls[0] as unknown as [string,RequestInit];expect(url).not.toContain(secret);expect(init.method).toBe('GET');expect(init.redirect).toBe('error');expect(init.body).toBeUndefined();
 });
 it('does not auto-approve discoveries or conflate partial listing with completeness',async()=>{
  const r=await discoverModels('gemini',secret,async()=>new Response(JSON.stringify({nextPageToken:'opaque',models:[{name:'models/gemini-3.5-flash',supportedGenerationMethods:['generateContent']},{name:'models/not-approved',supportedGenerationMethods:['generateContent']}]})));
  expect(r.status).toBe('VERIFIED');expect(r.complete).toBe(false);expect(r.models).toEqual([{id:'gemini-3.5-flash',runtimeCompatible:true},{id:'not-approved',runtimeCompatible:false}]);
  for(const body of [{data:[{id:secret}]},{data:[{id:'unsafe/host'}]},{data:[{id:'ok-model'}],error:secret}]){
   const result=await discoverModels('openai',secret,async()=>new Response(JSON.stringify(body)));
   expect(JSON.stringify(result)).not.toContain(secret);
  }
 });
 it('makes OpenAI/Claude discovery non-operational and preserves Flux-only audio compatibility',async()=>{
  const a=await discoverModels('anthropic',secret,async()=>new Response(JSON.stringify({data:[{id:'claude-synthetic'}],has_more:false})));
  expect(a.models[0].runtimeCompatible).toBe(false);
  const d=await discoverModels('deepgram',secret,async()=>new Response(JSON.stringify({stt:[{canonical_name:'flux-general-en',streaming:true},{canonical_name:'nova-3',streaming:true}]})));
  expect(d.models.map(m=>m.runtimeCompatible)).toEqual([true,false]);
 });
 it('bounds hostile response bodies, swallows raw provider exceptions and never retries',async()=>{
  const request=vi.fn(async()=>new Response('x'.repeat(256001)));expect((await discoverModels('gemini',secret,request)).status).toBe('UNAVAILABLE');expect(request).toHaveBeenCalledOnce();
  expect(await discoverModels('gemini',secret,async()=>{throw Error(secret);})).toEqual({status:'UNAVAILABLE',models:[],complete:false});
 });
 it('deduplicates cipher reads, expires cache, fails closed on disable/outage and cannot switch providers',async()=>{
  let now=0,enabled=true,failing=false;
  const sealed=vaultKeyring(env).seal(secret,binding);
  const rpc=vi.fn(async()=>{if(failing)throw Error(secret);return {provider:'gemini',revision:1,credential_id:binding.credentialId,sealed,enabled,default_model:'gemini-3.5-flash',probe_status:'VERIFIED',probe_at:'2026-10-13T00:00:00Z',models:[{id:'gemini-3.5-flash',runtimeCompatible:true}],complete:true,updated_at:'2026-10-13T00:00:00Z'};});
  const runtime=providerRuntime(rpc,env,()=>now);
  await Promise.all([runtime.resolve('gemini'),runtime.resolve('gemini')]);expect(rpc).toHaveBeenCalledOnce();
  enabled=false;now=10000;await expect(runtime.resolve('gemini')).rejects.toThrow('Provider unavailable.');
  enabled=true;failing=true;now=20000;await expect(runtime.resolve('gemini')).rejects.toThrow('Provider unavailable.');
  await expect(runtime.resolve('deepgram')).rejects.toThrow();
 });
 it('explicit auth-only bootstrap needs real infrastructure but no dummy provider keys or ledger/provider calls',async()=>{
  const base={SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_RELAY_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:STAGING_SITE,NEXT_PUBLIC_SUPABASE_URL:STAGING_DATABASE,SUPABASE_SERVICE_ROLE_KEY:'synthetic-infrastructure-service-key',SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,5).toString('base64'),CLUERA_AI_BOOTSTRAP_MODE:'auth-only'};
  const config=relayConfig(base);expect(config.geminiKey).toBeUndefined();expect(config.deepgramKey).toBeUndefined();
  for(const missing of ['SUPABASE_SERVICE_ROLE_KEY','SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64'])expect(()=>relayConfig({...base,[missing]:undefined})).toThrow();
  expect(()=>relayConfig({...base,SIGMAROUND_ACCOUNT_ORIGIN:'https://sigmaround-account-staging.vercel.app'})).toThrow();
  expect(()=>relayConfig({...base,CLUERA_AI_BOOTSTRAP_MODE:'admin-vault'})).toThrow();
  const providers=approvedProviders(config);await expect(providers.prepare!('gemini')).rejects.toThrow();
 });
});
