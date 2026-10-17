import {expect,it,vi} from 'vitest';
import {beginClueraReconciliationObservation} from '../lib/payments/cluera/reconciliationObservation';

it('emits only fixed outcome categories and integer duration without claiming a newly granted credit',()=>{
 for(const outcome of ['EMPTY','PENDING','VERIFIED','REFUNDED','STATUS','APPLIED','NO_GRANT','DUPLICATE','UNAVAILABLE','UNKNOWN']){
  const clock=vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(142.9),sink=vi.fn();
  beginClueraReconciliationObservation(clock,sink)(outcome);
  expect(sink).toHaveBeenCalledExactlyOnceWith({component:'cluera-billing-reconciliation',outcome,elapsedMs:42,creditEffect:'NOT_INFERRED'});
 }
});
it('unknown values and hostile objects are never reflected or coerced',()=>{
 const privateValue='SYNTHETIC_PRIVATE_BODY_TOKEN_ID_DIGEST',getter=vi.fn(()=>privateValue);
 const hostile=Object.create(null);Object.defineProperty(hostile,'toString',{get:getter});
 for(const result of [privateValue,'verified',new Error(privateValue),{code:'VERIFIED',secret:privateValue},hostile,null,undefined,1]){
  const sink=vi.fn();beginClueraReconciliationObservation(()=>10,sink)(result);
  expect(sink.mock.calls[0][0]).toEqual({component:'cluera-billing-reconciliation',outcome:'UNKNOWN',elapsedMs:0,creditEffect:'NOT_INFERRED'});
  expect(JSON.stringify(sink.mock.calls)).not.toContain(privateValue);
 }
 expect(getter).not.toHaveBeenCalled();
});
it('caps finite duration without inventing a timeout or changing the outcome',()=>{
 const sink=vi.fn(),clock=vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(999999999);
 beginClueraReconciliationObservation(clock,sink)('PENDING');
 expect(sink.mock.calls[0][0]).toMatchObject({outcome:'PENDING',elapsedMs:120000,creditEffect:'NOT_INFERRED'});
});
it('represents invalid or backwards clock readings as unknown duration, not a fabricated zero',()=>{
 for(const [start,end]of [[NaN,20],[0,Infinity],[20,19],[-1,20],['0',20]]){
  const sink=vi.fn(),clock=vi.fn().mockReturnValueOnce(start).mockReturnValueOnce(end);
  beginClueraReconciliationObservation(clock,sink)('EMPTY');expect(sink.mock.calls[0][0]["elapsedMs"]).toBeNull();
 }
});
it('swallows clock and logging failures and attempts only one observation',()=>{
 const privateValue='SYNTHETIC_PRIVATE_LOG_ERROR',sink=vi.fn(()=>{throw Error(privateValue);});
 const observe=beginClueraReconciliationObservation(()=>{throw Error(privateValue);},sink);
 expect(()=>observe('VERIFIED')).not.toThrow();expect(()=>observe('UNAVAILABLE')).not.toThrow();
 expect(sink).toHaveBeenCalledExactlyOnceWith({component:'cluera-billing-reconciliation',outcome:'VERIFIED',elapsedMs:null,creditEffect:'NOT_INFERRED'});
});
it('observes an async sink rejection without waiting or leaking an unhandled failure',async()=>{
 const sink=vi.fn(async()=>{throw Error('SYNTHETIC_PRIVATE_ASYNC_LOG_ERROR');});
 const observe=beginClueraReconciliationObservation(()=>10,sink);
 expect(observe('EMPTY')).toBeUndefined();observe('UNAVAILABLE');
 await Promise.resolve();await Promise.resolve();expect(sink).toHaveBeenCalledOnce();
});
