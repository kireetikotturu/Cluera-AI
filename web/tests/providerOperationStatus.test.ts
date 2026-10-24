import {expect,it,vi} from 'vitest';
import {verifyProviderOperation} from '../lib/aiProviders/operationStatus';
const operationId='00000000-0000-4000-8000-000000000004';
const context={provider:'gemini' as const,revision:2};
const row=(revision:number)=>({provider:'gemini',revision,credentialPresent:true,enabled:false,defaultModel:null,probeStatus:'VERIFIED',probeAt:'2026-10-24T06:22:15Z',models:[{id:'gemini-3.5-flash',runtimeCompatible:true}],complete:true,updatedAt:'2026-10-24T06:22:15Z'});
function fixture(audits:unknown[],current:unknown=row(3)){
 const rpc=vi.fn(async(_name:string,args:Record<string,unknown>)=>args.p_operation?audits.shift():{code:'ACTIVE',providers:current?[current]:[]});
 return {rpc,read:()=>verifyProviderOperation(rpc,'actor','session',operationId,context)};
}
it('confirms an immutable audit while returning current settings, not the historical snapshot',async()=>{
 const f=fixture([{code:'APPLIED',provider:'gemini',metadata:row(3)}],row(5));
 expect(await f.read()).toEqual({code:'APPLIED',operationId,metadata:row(5)});
 expect(f.rpc.mock.calls.every(([name])=>name==='cluera_provider_admin_read')).toBe(true);
});
it('describes absence as not recorded without claiming failure or permitting replacement',async()=>{
 const f=fixture([{code:'NOT_FOUND'}],row(2));
 expect(await f.read()).toEqual({code:'NOT_RECORDED',operationId,metadata:row(2)});expect(f.rpc).toHaveBeenCalledTimes(2);
});
it('rechecks the audit after observing an advanced revision to resolve a racing application',async()=>{
 const f=fixture([{code:'NOT_FOUND'},{code:'APPLIED',provider:'gemini',metadata:row(3)}]);
 expect((await f.read()).code).toBe('APPLIED');expect(f.rpc).toHaveBeenCalledTimes(3);
});
it('only reports superseded when the revision advanced and a second audit read is absent',async()=>{
 const f=fixture([{code:'NOT_FOUND'},{code:'NOT_FOUND'}]);expect((await f.read()).code).toBe('SUPERSEDED');
});
it.each([{code:'FORBIDDEN'},{code:'unknown'},{code:'APPLIED',provider:'deepgram',metadata:row(3)},{code:'APPLIED',provider:'gemini',metadata:{...row(3),apiKey:'synthetic-private'}}])('fails closed for unauthorized, malformed or mismatched audit data',async audit=>{
 await expect(fixture([audit]).read()).rejects.toThrow();
});
it('does not infer completion for a legacy UUID-only lookup with no audit',async()=>{
 const rpc=vi.fn(async()=>({code:'NOT_FOUND'}));
 expect(await verifyProviderOperation(rpc,'actor','session',operationId)).toEqual({code:'NOT_RECORDED',operationId,metadata:null});expect(rpc).toHaveBeenCalledOnce();
});
it('rejects a current revision older than the submitted request or its applied audit',async()=>{
 await expect(fixture([{code:'NOT_FOUND'}],row(1)).read()).rejects.toThrow();
 await expect(fixture([{code:'APPLIED',provider:'gemini',metadata:row(4)}],row(3)).read()).rejects.toThrow();
});
