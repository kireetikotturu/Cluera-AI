import {once} from 'node:events';
import {expect,it,vi} from 'vitest';
import {INFRASTRUCTURE_STATUS_PATH,infrastructureStatusRequest,verifyInfrastructureStatusRequest,infrastructureStatusResponse,verifyInfrastructureStatusResponse} from '../lib/accountRelay/infrastructureMetadata';
import {providerStatusRequest,STAGING_RELAY_ORIGIN} from '../lib/accountRelay/providerMetadata';
import {relayDatabaseAuthenticated} from '../lib/accountRelay/infrastructureCheck';
import {readRelayInfrastructureStatus} from '../lib/accounts/relayInfrastructureStatus';
import {createRelayServer} from '../lib/accountRelay/server';
import {STAGING_DATABASE,STAGING_SITE,type RelayConfig} from '../lib/accountRelay/config';
import type {AccountConfig} from '../lib/accounts/config';
const key=Buffer.alloc(32,7),now=1780000000000;
const config:RelayConfig={database:STAGING_DATABASE,site:STAGING_SITE,port:8080,rateKey:key.toString('base64'),serviceKey:'synthetic-service-key-only',providerMode:'auth-only'};
const web:AccountConfig={origin:STAGING_SITE,url:STAGING_DATABASE,secure:true,anonKey:'synthetic-public-key',serviceKey:config.serviceKey,rateKey:key,cookieKey:Buffer.alloc(32,8)};
it('domain-separates operation proofs and rejects wrong key, nonce, stale time and modified responses',()=>{
 const proof=infrastructureStatusRequest(key,now);expect(verifyInfrastructureStatusRequest(key,proof,now)).toBe(true);
 expect(verifyInfrastructureStatusRequest(key,providerStatusRequest(key,now),now)).toBe(false);
 for(const altered of [{...proof,timestamp:String(now-30001)},{...proof,signature:'x'}, {...proof,nonce:'0'.repeat(48)}])expect(verifyInfrastructureStatusRequest(key,altered,now)).toBe(false);
 expect(verifyInfrastructureStatusRequest(Buffer.alloc(32,8),proof,now)).toBe(false);
 const response=infrastructureStatusResponse(key,proof.nonce,true,now);
 expect(verifyInfrastructureStatusResponse(key,proof.nonce,response.body,response.signature,now)).toEqual({observedAt:new Date(now).toISOString(),databaseAuthenticated:true});
 for(const changed of [{body:response.body.replace('true','false'),nonce:proof.nonce,at:now},{body:response.body,nonce:'bad',at:now},{body:response.body,nonce:proof.nonce,at:now+30001}])expect(()=>verifyInfrastructureStatusResponse(key,changed.nonce,changed.body,response.signature,changed.at)).toThrow();
 expect(response.body).not.toContain(config.serviceKey);expect(response.body).not.toContain(config.rateKey);
});
it('relay authenticates its own fixed SDK key through exactly one bounded GET, never returns identities',async()=>{
 const request=vi.fn(async(input:any,init:any)=>{const url=new URL(String(input));expect(url.origin).toBe(STAGING_DATABASE);expect(url.pathname).toBe('/auth/v1/admin/users');expect([...url.searchParams]).toHaveLength(2);expect(url.searchParams.get('page')).toBe('1');expect(url.searchParams.get('per_page')).toBe('1');expect(init.method).toBe('GET');expect(init.body).toBeUndefined();expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);return new Response(JSON.stringify({users:[{id:'private-synthetic-identity',email:'private-synthetic-email'}]}));});
 const result=await relayDatabaseAuthenticated(config,request);expect(result).toBe(true);expect(request).toHaveBeenCalledOnce();expect(JSON.stringify(result)).not.toContain('private');
 await expect(relayDatabaseAuthenticated({...config,database:'https://other.invalid'},request)).resolves.toBe(false);expect(request).toHaveBeenCalledOnce();
});
it.each(['denial','transport','oversized','malformed'])('fails closed without raw %s output',async mode=>{
 const request=vi.fn(async()=>{if(mode==='transport')throw Error('synthetic-secret-raw-error');return mode==='denial'?new Response('synthetic-private-body',{status:401}):mode==='oversized'?new Response('x'.repeat(65537)):new Response('malformed');});
 expect(await relayDatabaseAuthenticated(config,request)).toBe(false);expect(request).toHaveBeenCalledOnce();
});
it('web client sends only one fresh proof to fixed origin and validates the signed bounded response',async()=>{
 const request=vi.fn(async(url:any,init:any)=>{expect(url).toBe(STAGING_RELAY_ORIGIN+INFRASTRUCTURE_STATUS_PATH);expect(init.body).toBeUndefined();expect(init.redirect).toBe('error');expect(init.signal).toBeInstanceOf(AbortSignal);expect(Object.keys(init.headers)).toEqual(['X-Cluera-Time','X-Cluera-Nonce','X-Cluera-Proof']);expect(JSON.stringify(init.headers)).not.toContain(config.serviceKey);const value=infrastructureStatusResponse(key,init.headers['X-Cluera-Nonce'],true);return new Response(value.body,{headers:{'X-Cluera-Proof':value.signature}});});
 expect((await readRelayInfrastructureStatus(web,request)).databaseAuthenticated).toBe(true);expect(request).toHaveBeenCalledOnce();
 await expect(readRelayInfrastructureStatus({...web,origin:'https://other.invalid'},request)).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
 for(const response of [new Response('{}',{status:403}),new Response('x'.repeat(1025)),new Response('{}')])await expect(readRelayInfrastructureStatus(web,vi.fn(async()=>response))).rejects.toThrow();
});
it('actual local HTTP denies ambient credentials, wrong methods/proofs and replay before any DB work',async()=>{
 const database=vi.fn(async()=>true),authorize=vi.fn(),generate=vi.fn(),audio=vi.fn();
 const relay=createRelayServer({authorize,providers:{generate,audio}},undefined,config,database);
 relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');const addr=relay.server.address();if(!addr||typeof addr==='string')throw Error('No port');
 const url=`http://127.0.0.1:${addr.port}${INFRASTRUCTURE_STATUS_PATH}`;
 const proof=infrastructureStatusRequest(key),headers={'X-Cluera-Time':proof.timestamp,'X-Cluera-Nonce':proof.nonce,'X-Cluera-Proof':proof.signature};
 try{
  expect((await fetch(url)).status).toBe(403);
  for(const extra of [{Origin:STAGING_SITE},{Cookie:'synthetic=1'},{Authorization:'synthetic'}])expect((await fetch(url,{headers:{...headers,...extra}})).status).toBe(403);
  expect((await fetch(url,{headers,method:'POST'})).status).toBe(403);
  expect((await fetch(url+'?extra=1',{headers})).status).toBe(404);expect(database).not.toHaveBeenCalled();
  const result=await fetch(url,{headers});expect(result.status).toBe(200);expect(result.headers.get('cache-control')).toBe('no-store');expect(result.headers.get('x-content-type-options')).toBe('nosniff');
  expect(verifyInfrastructureStatusResponse(key,proof.nonce,await result.text(),result.headers.get('X-Cluera-Proof')!).databaseAuthenticated).toBe(true);
  expect((await fetch(url,{headers})).status).toBe(403);expect(database).toHaveBeenCalledOnce();
  expect(authorize).not.toHaveBeenCalled();expect(generate).not.toHaveBeenCalled();expect(audio).not.toHaveBeenCalled();
 }finally{relay.server.closeIdleConnections();await relay.stop();}
});
it('rejects concurrent probes and caps accepted machine requests without affecting public health',async()=>{
 let release!:(value:boolean)=>void;const database=vi.fn(()=>new Promise<boolean>(r=>{release=r;}));
 const relay=createRelayServer({authorize:vi.fn(),providers:{generate:vi.fn(),audio:vi.fn()}},undefined,config,database);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
 const addr=relay.server.address();if(!addr||typeof addr==='string')throw Error('No port');const base=`http://127.0.0.1:${addr.port}`;
 const headers=()=>{const proof=infrastructureStatusRequest(key);return{'X-Cluera-Time':proof.timestamp,'X-Cluera-Nonce':proof.nonce,'X-Cluera-Proof':proof.signature};};
 try{const first=fetch(base+INFRASTRUCTURE_STATUS_PATH,{headers:headers()});await vi.waitFor(()=>expect(database).toHaveBeenCalledOnce());expect((await fetch(base+INFRASTRUCTURE_STATUS_PATH,{headers:headers()})).status).toBe(403);release(true);expect((await first).status).toBe(200);
  database.mockImplementation(async()=>true);for(let n=0;n<11;n++)expect((await fetch(base+INFRASTRUCTURE_STATUS_PATH,{headers:headers()})).status).toBe(200);
  expect((await fetch(base+INFRASTRUCTURE_STATUS_PATH,{headers:headers()})).status).toBe(403);expect((await fetch(base+'/healthz')).status).toBe(200);expect(database).toHaveBeenCalledTimes(12);
 }finally{relay.server.closeIdleConnections();await relay.stop();}
});
