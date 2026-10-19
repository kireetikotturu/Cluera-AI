import {randomUUID,createHash} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {providerTelemetry,providerReceiptMetadata} from '../lib/aiProviders/telemetry';
import {vaultProviders} from '../lib/accountRelay/vaultProviders';
import {vaultKeyring} from '../lib/aiProviders/vault';
import type {RelayConfig} from '../lib/accountRelay/config';
import {providerUsageReportSchema} from '../lib/aiProviders/usageMetadata';
const scope={runId:randomUUID(),provider:'gemini' as const,credentialId:randomUUID(),revision:2,model:'gemini-3.5-flash'};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('does no telemetry RPC when disabled and never enables itself',async()=>{
 const rpc=vi.fn();const receipt=await providerTelemetry(rpc,{}).start(scope);receipt.observe({totalTokens:4});await receipt.finish('SUCCEEDED');expect(rpc).not.toHaveBeenCalled();
});
it('durably starts once, sanitizes receipt fields and records one exact terminal result without secrets or guessed cost',async()=>{
 let clock=100;const rpc=vi.fn(async(_name:string,args:Record<string,unknown>)=>({code:'RECORDED',operationId:args.p_operation}));
 const receipt=await providerTelemetry(rpc,{CLUERA_PROVIDER_TELEMETRY_ENABLED:'true'},()=>clock).start(scope);
 receipt.observe({inputTokens:8,totalTokens:11});receipt.observe({totalTokens:11,apiKey:'private'} as never);clock=125;
 const first=receipt.finish('SUCCEEDED'),second=receipt.finish('FAILED');expect(first).toBe(second);expect(await first).toBe(true);
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['cluera_provider_usage_start','cluera_provider_usage_finish']);
 expect(rpc.mock.calls[1][1]).toMatchObject({p_outcome:'SUCCEEDED',p_elapsed_ms:25,p_usage:{inputTokens:8,totalTokens:11}});
 expect(JSON.stringify(rpc.mock.calls)).not.toContain('private');expect(JSON.stringify(rpc.mock.calls)).not.toContain('cost');
});
it('rejects malformed run scope or START acknowledgment before provider work can proceed',async()=>{
 const rpc=vi.fn(async()=>({code:'DENIED'}));const recorder=providerTelemetry(rpc,{CLUERA_PROVIDER_TELEMETRY_ENABLED:'true'});
 await expect(recorder.start({...scope,runId:undefined})).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();
 await expect(recorder.start(scope)).rejects.toThrow('Provider telemetry unavailable.');expect(rpc).toHaveBeenCalledOnce();
});
it('keeps a missing terminal write unconfirmed instead of retrying or fabricating a receipt',async()=>{
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{if(name.endsWith('finish'))throw Error('private failure');return {code:'RECORDED',operationId:args.p_operation};});
 const receipt=await providerTelemetry(rpc,{CLUERA_PROVIDER_TELEMETRY_ENABLED:'true'}).start(scope);
 expect(await receipt.finish('FAILED')).toBe(false);expect(await receipt.finish('FAILED')).toBe(false);expect(rpc).toHaveBeenCalledTimes(2);
});
it('bounds a hanging metadata RPC without retry or provider request',async()=>{
 vi.useFakeTimers();const rpc=vi.fn(()=>new Promise<never>(()=>{}));
 const result=expect(providerTelemetry(rpc,{CLUERA_PROVIDER_TELEMETRY_ENABLED:'true'}).start(scope)).rejects.toThrow('Provider telemetry unavailable.');
 await vi.advanceTimersByTimeAsync(5000);await result;expect(rpc).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});
it('extracts documented counters only, hashes request IDs and rejects malformed metadata',()=>{
 const result=providerReceiptMetadata('gemini',{responseId:'provider-request-id',usageMetadata:{promptTokenCount:4,candidatesTokenCount:2,totalTokenCount:6},prompt:'private',apiKey:'private'});
 expect(result).toEqual({requestHash:createHash('sha256').update('provider-request-id').digest('hex'),inputTokens:4,outputTokens:2,totalTokens:6});
 expect(providerReceiptMetadata('gemini',{usageMetadata:{totalTokenCount:-1}})).toBeUndefined();
 expect(providerReceiptMetadata('deepgram',{request_id:'provider-request-id',audio_window_end:1.3,transcript:'private'})).toMatchObject({audioWindowMilliseconds:1300});
 expect(JSON.stringify(result)).not.toContain('provider-request-id');expect(JSON.stringify(result)).not.toContain('private');
});
it('rejects duplicate, contradictory or impossible report receipts instead of displaying false usage',()=>{
 const row={operationId:randomUUID(),provider:'gemini',model:'gemini-3.5-flash',startedAt:'2026-10-19T00:00:00Z',finishedAt:'2026-10-19T00:00:01Z',outcome:'SUCCEEDED',elapsedMilliseconds:1000,requestHash:null,inputTokens:null,outputTokens:null,cachedTokens:null,thinkingTokens:null,totalTokens:null,audioWindowMilliseconds:null,cost:null,costStatus:'UNAVAILABLE'};
 const report={code:'ACTIVE',scope:'LATEST_REQUESTS',limit:50,costStatus:'UNAVAILABLE',rows:[row]};expect(providerUsageReportSchema.safeParse(report).success).toBe(true);
 expect(providerUsageReportSchema.safeParse({...report,rows:[row,row]}).success).toBe(false);
 expect(providerUsageReportSchema.safeParse({...report,rows:[{...row,operationId:'abcdef00-1234-4234-8234-abcdef123456'},{...row,operationId:'ABCDEF00-1234-4234-8234-ABCDEF123456'}]}).success).toBe(false);
 for(const change of [{finishedAt:null},{elapsedMilliseconds:null},{elapsedMilliseconds:3600001},{finishedAt:'2026-10-18T00:00:00Z'},{outcome:'UNCONFIRMED'},{outcome:'UNCONFIRMED',finishedAt:null,elapsedMilliseconds:null,totalTokens:0}])expect(providerUsageReportSchema.safeParse({...report,rows:[{...row,...change}]}).success).toBe(false);
 expect(providerUsageReportSchema.safeParse({...report,rows:[{...row,outcome:'UNCONFIRMED',finishedAt:null,elapsedMilliseconds:null}]}).success).toBe(true);
});
it('requires durable START before Gemini transport, then persists provider-reported metadata without content',async()=>{
 const keyring={CLUERA_PROVIDER_TELEMETRY_ENABLED:'true',CLUERA_PROVIDER_VAULT_KEYRING_BASE64:Buffer.from(JSON.stringify({active:'synthetic',keys:{synthetic:Buffer.alloc(32,31).toString('base64')}})).toString('base64')};
 const secret='synthetic-provider-key-only',sealed=vaultKeyring(keyring).seal(secret,{provider:'gemini',credentialId:scope.credentialId});
 const events:string[]=[];
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(name==='cluera_provider_read')return {provider:'gemini',revision:scope.revision,credential_id:scope.credentialId,sealed,enabled:true,default_model:scope.model,probe_status:'VERIFIED',probe_at:'2026-10-19T00:00:00Z',models:[{id:scope.model,runtimeCompatible:true}],complete:true,updated_at:'2026-10-19T00:00:00Z'};
  if(name==='account_models_read')return [{modelId:scope.model,displayName:'Gemini',provider:'gemini',enabled:true,isDefault:true,priority:1,capabilities:['text'],health:'HEALTHY'}];
  events.push(name);return {code:'RECORDED',operationId:args.p_operation};
 });
 const request=vi.fn(async()=>{events.push('upstream');return new Response('data: {"responseId":"synthetic-receipt","candidates":[{"content":{"parts":[{"text":"synthetic answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":6}}\n\n');});vi.stubGlobal('fetch',request);
 const config={serviceKey:'synthetic-service-key',rateKey:'synthetic-rate-key',providerMode:'admin-vault'} as RelayConfig;
 await vaultProviders(config,rpc,keyring).generate({type:'generate',id:'synthetic',prompt:'private prompt'}, {runId:scope.runId,signal:new AbortController().signal,assertActive(){}},()=>{});
 expect(events).toEqual(['cluera_provider_usage_start','upstream','cluera_provider_usage_finish']);
 const recorded=rpc.mock.calls.filter(([name])=>name.startsWith('cluera_provider_usage'));
 expect(JSON.stringify(recorded)).not.toMatch(/private prompt|synthetic answer|synthetic-provider-key-only|synthetic-receipt/);
 expect(recorded[1][1]).toMatchObject({p_outcome:'SUCCEEDED',p_usage:{inputTokens:4,outputTokens:2,totalTokens:6}});
 rpc.mockImplementation(async(name:string)=>name==='cluera_provider_usage_start'?{code:'DENIED'}:name==='account_models_read'?[{modelId:scope.model,displayName:'Gemini',provider:'gemini',enabled:true,isDefault:true,priority:1,capabilities:['text'],health:'HEALTHY'}]:{provider:'gemini',revision:scope.revision,credential_id:scope.credentialId,sealed,enabled:true,default_model:scope.model,probe_status:'VERIFIED',probe_at:'2026-10-19T00:00:00Z',models:[{id:scope.model,runtimeCompatible:true}],complete:true,updated_at:'2026-10-19T00:00:00Z'});
 await expect(vaultProviders(config,rpc,keyring).generate({type:'generate',id:'denied',prompt:'private'}, {runId:scope.runId,signal:new AbortController().signal,assertActive(){}},()=>{})).rejects.toThrow();
 expect(request).toHaveBeenCalledOnce();
});
