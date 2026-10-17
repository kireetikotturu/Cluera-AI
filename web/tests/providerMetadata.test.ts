import {once} from 'node:events';
import {afterEach,expect,it,vi} from 'vitest';
import {providerStatusRequest,verifyProviderStatusRequest,providerStatusResponse,verifyProviderStatusResponse,PROVIDER_METADATA_PATH,STAGING_RELAY_ORIGIN} from '../lib/accountRelay/providerMetadata';
import {readProviderStatus} from '../lib/accounts/providerStatus';
import {accountModelPolicy} from '../lib/accounts/modelPolicy';
import {createRelayServer} from '../lib/accountRelay/server';
import {STAGING_DATABASE,STAGING_SITE,type RelayConfig} from '../lib/accountRelay/config';
import type {AccountConfig} from '../lib/accounts/config';

const key=Buffer.alloc(32,7),now=1780000000000;
const config:RelayConfig={database:STAGING_DATABASE,site:STAGING_SITE,port:8080,rateKey:key.toString('base64'),
 serviceKey:'sb_secret_synthetic-service-secret-only',geminiKey:'synthetic-gemini-secret-only',deepgramKey:'synthetic-deepgram-secret-only'};
const webConfig:AccountConfig={origin:STAGING_SITE,url:STAGING_DATABASE,secure:true,anonKey:'synthetic-public-key',serviceKey:config.serviceKey,rateKey:key,cookieKey:Buffer.alloc(32,8)};
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

it('authenticates a bounded time, unique nonce and operation, never plain shared secrets',()=>{
 const proof=providerStatusRequest(key,now);expect(verifyProviderStatusRequest(key,proof,now)).toBe(true);
 expect(providerStatusRequest(key,now).nonce).not.toBe(proof.nonce);
 for(const changed of [{...proof,timestamp:String(now-30001)},{...proof,nonce:'bad'}, {...proof,signature:'bad'},
  {...proof,nonce:'0'.repeat(48)}])expect(verifyProviderStatusRequest(key,changed,now)).toBe(false);
 expect(verifyProviderStatusRequest(Buffer.alloc(32,8),proof,now)).toBe(false);
 expect(JSON.stringify(proof)).not.toContain(config.rateKey);
});
it('emits only safe runtime metadata, honest health/rotation, with a key-dependent fingerprint',()=>{
 const proof=providerStatusRequest(key,now),response=providerStatusResponse(config,proof.nonce,now);
 const data=verifyProviderStatusResponse(key,proof.nonce,response.body,response.signature,now);
 expect(data.providers).toHaveLength(2);expect(data.providers[0]).toMatchObject({configured:true,enabled:true,health:'UNVERIFIED',lastRotatedAt:null,rotationAvailable:false});
 for(const secret of [config.geminiKey,config.deepgramKey,config.serviceKey,config.rateKey])expect(response.body).not.toContain(secret);
 const changed=JSON.parse(providerStatusResponse({...config,geminiKey:'synthetic-rotated-key'},proof.nonce,now).body);
 expect(changed.providers[0].fingerprint).not.toBe(data.providers[0].fingerprint);
 expect(changed.providers[1].fingerprint).toBe(data.providers[1].fingerprint);
});
it('rejects modified, stale, mismatched nonce and wrong-key metadata responses',()=>{
 const proof=providerStatusRequest(key,now),response=providerStatusResponse(config,proof.nonce,now);
 expect(()=>verifyProviderStatusResponse(key,proof.nonce,response.body.replace('true','false'),response.signature,now)).toThrow();
 expect(()=>verifyProviderStatusResponse(key,'different',response.body,response.signature,now)).toThrow();
 expect(()=>verifyProviderStatusResponse(key,proof.nonce,response.body,response.signature,now+30001)).toThrow();
 expect(()=>verifyProviderStatusResponse(Buffer.alloc(32,8),proof.nonce,response.body,response.signature,now)).toThrow();
});
it.each(['auth-only','admin-vault'])('reports %s bootstrap providers disabled, even if stale legacy keys are supplied',providerMode=>{
 const proof=providerStatusRequest(key,now),response=providerStatusResponse({...config,providerMode},proof.nonce,now);
 const value=verifyProviderStatusResponse(key,proof.nonce,response.body,response.signature,now);
 expect(value.bootstrapMode).toBe(providerMode);expect(value.providers.every(p=>p.enabled===false)).toBe(true);
});
it('uses only the fixed staging TLS endpoint, rejects redirects, limits time and forwards no browser or provider credentials',async()=>{
 const request=vi.fn(async(url:any,init:any)=>{
  expect(url).toBe(`${STAGING_RELAY_ORIGIN}${PROVIDER_METADATA_PATH}`);expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.body).toBeUndefined();const requestText=JSON.stringify(init.headers);
  for(const secret of [config.geminiKey,config.deepgramKey,config.serviceKey,config.rateKey])expect(requestText).not.toContain(secret);
  expect(Object.keys(init.headers)).toEqual(['X-Cluera-Time','X-Cluera-Nonce','X-Cluera-Proof']);
  const response=providerStatusResponse(config,init.headers['X-Cluera-Nonce']);
  return new Response(response.body,{headers:{'X-Cluera-Proof':response.signature}});
 });
 expect((await readProviderStatus(webConfig,request)).providers[1].provider).toBe('deepgram');
 await expect(readProviderStatus({...webConfig,url:'https://other.invalid'},request)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
});
it('does not return configuration on failed, oversized or unsigned relay responses',async()=>{
 for(const response of [new Response('{}',{status:503}),new Response('x'.repeat(8193)),new Response('{}')])
  await expect(readProviderStatus(webConfig,vi.fn(async()=>response))).rejects.toThrow();
});
it.each(['request','body'] as const)('keeps7s total bound when relay %s ignores abort and cancellation hangs',async failure=>{
 vi.useFakeTimers();
 const never=()=>new Promise<never>(()=>{}),cancel=vi.fn(never);
 const request=vi.fn((_url:unknown,_init?:RequestInit):Promise<Response>=>failure==='request'?never():Promise.resolve(new Response(new ReadableStream<Uint8Array>({pull:never,cancel}))));
 let finished=false;const pending=readProviderStatus(webConfig,request).then(()=>{finished=true;return null;},error=>{finished=true;return error;});
 await vi.advanceTimersByTimeAsync(6999);expect(finished).toBe(false);await vi.advanceTimersByTimeAsync(1);expect(finished).toBe(true);
 expect(await pending).toMatchObject({message:'Provider status unavailable.'});expect(request).toHaveBeenCalledOnce();
 expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);if(failure==='body')expect(cancel).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
});
it('rejects unavailable responses without awaiting non-settling body cancellation',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const request=vi.fn(async(_url:unknown,_init?:RequestInit)=>new Response(new ReadableStream<Uint8Array>({start(){},cancel}),{status:503}));
 let finished=false;const pending=readProviderStatus(webConfig,request).then(()=>{finished=true;return null;},error=>{finished=true;return error;});
 await vi.advanceTimersByTimeAsync(0);expect(finished).toBe(true);expect(await pending).toMatchObject({message:'Provider status unavailable.'});
 expect(cancel).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('still verifies signed metadata when cleanup cancellation never resolves',async()=>{
 vi.useFakeTimers();const cancel=vi.fn(()=>new Promise<void>(()=>{})),releaseLock=vi.fn();
 const request=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const proof=providerStatusResponse(config,new Headers(init?.headers).get('X-Cluera-Nonce')!);
  const response=new Response(proof.body,{headers:{'X-Cluera-Proof':proof.signature}});let part=0;
  Object.defineProperty(response,'body',{value:{getReader:()=>({read:()=>Promise.resolve(part++===0?{done:false,value:Buffer.from(proof.body)}:{done:true,value:undefined}),cancel,releaseLock})}});return response;
 });
 let finished=false;const pending=readProviderStatus(webConfig,request).then(value=>{finished=true;return value;});
 await vi.advanceTimersByTimeAsync(0);expect(finished).toBe(true);expect((await pending).providers[0]).toMatchObject({provider:'gemini',configured:true,enabled:true,health:'UNVERIFIED'});
 expect(cancel).toHaveBeenCalledOnce();expect(releaseLock).toHaveBeenCalledOnce();expect(request).toHaveBeenCalledOnce();expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);expect(vi.getTimerCount()).toBe(0);
});
it('never reflects transport exceptions or retries a failed snapshot',async()=>{
 const request=vi.fn(async()=>{throw Error('SYNTHETIC_PRIVATE_RELAY_ERROR');});
 await expect(readProviderStatus(webConfig,request)).rejects.toThrow('Provider status unavailable.');expect(request).toHaveBeenCalledOnce();
});
it('real local HTTP status rejects unauthenticated/browser requests and never opens provider work',async()=>{
 const authorize=vi.fn(),generate=vi.fn(),audio=vi.fn();
 const relay=createRelayServer({authorize,providers:{generate,audio}},undefined,config);
 relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
 const address=relay.server.address();if(!address||typeof address==='string')throw new Error('No test port.');
 const url=`http://127.0.0.1:${address.port}${PROVIDER_METADATA_PATH}`;
 try{
  expect((await fetch(url)).status).toBe(403);
  const proof=providerStatusRequest(key),headers={'X-Cluera-Time':proof.timestamp,'X-Cluera-Nonce':proof.nonce,'X-Cluera-Proof':proof.signature};
  expect((await fetch(url,{headers:{...headers,Origin:STAGING_SITE}})).status).toBe(403);
  expect((await fetch(url,{headers:{...headers,Cookie:'synthetic=1'}})).status).toBe(403);
  expect((await fetch(url,{headers,method:'POST'})).status).toBe(403);
  const response=await fetch(url,{headers});expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
  expect(verifyProviderStatusResponse(key,proof.nonce,await response.text(),response.headers.get('X-Cluera-Proof')!).providers[0].configured).toBe(true);
  expect(authorize).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();expect(audio).not.toHaveBeenCalled();
 }finally{relay.server.closeIdleConnections();await relay.stop();}
});
const model={modelId:'gemini-3.5-flash',displayName:'Gemini Flash',provider:'gemini',enabled:true,isDefault:true,priority:100,capabilities:['text','image'],health:'UNVERIFIED'};
it('accepts supported Gemini and internal Flux policies, with explicit capability choices',()=>{
 expect(accountModelPolicy.parse(model)).toEqual(model);
 expect(accountModelPolicy.parse({...model,provider:'deepgram',modelId:'flux-general-en',capabilities:['audio']})).toBeTruthy();
});
it.each([
 {...model,capabilities:['image']},{...model,capabilities:['text','audio']},{...model,capabilities:['text','text']},
 {...model,enabled:false},{...model,health:'UNAVAILABLE'},
 {...model,provider:'deepgram',modelId:'unsupported-flux',capabilities:['audio']},
 {...model,provider:'deepgram',modelId:'flux-general-en',capabilities:['audio','image']},
 {...model,apiKey:'synthetic-secret'},
])('rejects unsupported or secret-bearing model metadata %#',input=>expect(accountModelPolicy.safeParse(input).success).toBe(false));
