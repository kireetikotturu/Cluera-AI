import {expect,it,vi} from 'vitest';
import {modelRegistry} from '../lib/accountRelay/models';
const gemini={modelId:'gemini-3.5-flash',displayName:'Fast answers',provider:'gemini',enabled:true,isDefault:true,priority:100,capabilities:['text','image'],health:'UNVERIFIED'};
const deepgram={...gemini,modelId:'flux-general-en',provider:'deepgram',capabilities:['audio']};
it('uses only approved models/capabilities and never silently substitutes a disabled selection',async()=>{
 const registry=modelRegistry(async()=>[gemini,deepgram,{...gemini,modelId:'gemini-disabled',enabled:false,isDefault:false}]);
 expect(await registry.resolve('gemini')).toBe('gemini-3.5-flash');expect(await registry.resolve('deepgram')).toBe('flux-general-en');
 await expect(registry.resolve('gemini','gemini-disabled')).rejects.toThrow();await expect(registry.resolve('gemini','../../bad')).rejects.toThrow();
 await expect(registry.resolve('deepgram','gemini-3.5-flash')).rejects.toThrow();
});
it('deduplicates reads, expires policy cache, and fails closed during registry outage',async()=>{
 let time=0;const load=vi.fn(async()=>[gemini,deepgram]);const registry=modelRegistry(load,()=>time);
 await Promise.all([registry.resolve('gemini'),registry.resolve('deepgram')]);expect(load).toHaveBeenCalledOnce();
 time=9999;await registry.resolve('gemini');expect(load).toHaveBeenCalledOnce();time=10001;
 load.mockRejectedValueOnce(new Error('unavailable'));await expect(registry.resolve('gemini')).rejects.toThrow();expect(load).toHaveBeenCalledTimes(2);
});
it('cannot use unknown provider metadata or an unavailable model',async()=>{
 await expect(modelRegistry(async()=>[{...gemini,health:'UNAVAILABLE'}]).resolve('gemini')).rejects.toThrow();
 await expect(modelRegistry(async()=>[{...gemini,capabilities:['text']}]).resolve('gemini',undefined,true)).rejects.toThrow();
 await expect(modelRegistry(async()=>[{...gemini,apiKey:'never-allowed'}]).list()).rejects.toThrow();
});
