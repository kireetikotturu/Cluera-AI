import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {clueraRazorpayTransport} from '../lib/payments/cluera/transport';
import {readClueraRawBody} from '../lib/payments/cluera/events';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

function outcome(promise:Promise<unknown>){
 const result:{state:'pending'|'resolved'|'rejected';value?:unknown;error?:unknown}={state:'pending'};
 void promise.then(value=>{result.state='resolved';result.value=value;},error=>{result.state='rejected';result.error=error;});
 return result;
}
const requestBody=(body:ReadableStream<Uint8Array>)=>({body,headers:new Headers()} as Request);
beforeEach(()=>{vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});

it('aborts rejected upstream headers even when its body was never read; no retry',async()=>{
 let signal:AbortSignal|null|undefined;
 const request=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
  signal=init?.signal;return new Response(new ReadableStream<Uint8Array>({start(){},cancel(){return new Promise<void>(()=>{});}}),{status:503});
 });
 await expect(clueraRazorpayTransport(paymentTestEnvironment,request as typeof fetch)('/orders')).rejects.toMatchObject({code:'UNAVAILABLE'});
 expect(signal?.aborted).toBe(true);expect(request).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it('provider overflow rejects without awaiting an uncooperative cancellation',async()=>{
 const cancel=vi.fn(()=>new Promise<void>(()=>{}));let signal:AbortSignal|null|undefined;
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(256*1024+1));},cancel});
 const request=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{signal=init?.signal;return new Response(body,{headers:{'content-type':'application/json'}});});
 const result=outcome(clueraRazorpayTransport(paymentTestEnvironment,request as typeof fetch)('/orders'));
 await vi.advanceTimersByTimeAsync(0);
 expect(result.state).toBe('rejected');expect(result.error).toMatchObject({code:'UNAVAILABLE'});
 expect(cancel).toHaveBeenCalledOnce();expect(signal?.aborted).toBe(true);expect(request).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it('provider body timeout retains its10s bound despite a never-settled cancel',async()=>{
 const cancel=vi.fn(()=>new Promise<void>(()=>{}));let signal:AbortSignal|null|undefined;
 const request=vi.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>{
  signal=init?.signal;return new Response(new ReadableStream<Uint8Array>({start(){},cancel}),{headers:{'content-type':'application/json'}});
 });
 const result=outcome(clueraRazorpayTransport(paymentTestEnvironment,request as typeof fetch)('/orders'));
 await vi.advanceTimersByTimeAsync(9999);expect(result.state).toBe('pending');
 await vi.advanceTimersByTimeAsync(1);
 expect(result.state).toBe('rejected');expect(result.error).toMatchObject({code:'UNAVAILABLE'});
 expect(cancel).toHaveBeenCalledOnce();expect(signal?.aborted).toBe(true);expect(request).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it.each([{'content-type':'text/html'},{'content-type':'application/json','content-length':'262145'},
 {'content-type':'application/json','content-length':'-1'}])('rejects invalid upstream headers without reading or retrying %j',async headers=>{
 const pull=vi.fn(),request=vi.fn(async()=>new Response(new ReadableStream<Uint8Array>({pull},{highWaterMark:0}),{headers}));
 await expect(clueraRazorpayTransport(paymentTestEnvironment,request)('/orders')).rejects.toMatchObject({code:'UNAVAILABLE'});
 expect(pull).not.toHaveBeenCalled();expect(request).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it('raw body overflow rejects without waiting for hostile cancellation',async()=>{
 const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array(3));},cancel});
 const result=outcome(readClueraRawBody(requestBody(body),2));await vi.advanceTimersByTimeAsync(0);
 expect(result.state).toBe('rejected');expect(result.error).toMatchObject({code:'INVALID'});expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it('raw unfinished body retains its2s rejection even if cancellation never settles',async()=>{
 const cancel=vi.fn(()=>new Promise<void>(()=>{}));
 const result=outcome(readClueraRawBody(requestBody(new ReadableStream<Uint8Array>({start(){},cancel})),2));
 await vi.advanceTimersByTimeAsync(2000);
 expect(result.state).toBe('rejected');expect(result.error).toMatchObject({code:'INVALID'});expect(cancel).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
});

it('successful byte/JSON reads and clean-project history provenance remain honest',async()=>{
 const request=vi.fn(async()=>Response.json({ok:true}));
 await expect(clueraRazorpayTransport(paymentTestEnvironment,request as typeof fetch)('/orders')).resolves.toEqual({ok:true});
 const bytes=Buffer.from('{}');await expect(readClueraRawBody(new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',{method:'POST',body:bytes}),2)).resolves.toEqual(bytes);
 const source=readFileSync(new URL('../app/account/checkout/ClueraCheckoutClient.tsx',import.meta.url),'utf8');
 expect(source).toContain('Earlier Account and Paddle database history was not imported');expect(source).toContain('provider-side obligations remain subject to independent reconciliation');
 expect(source).not.toContain('Existing Account and Paddle financial history remains intact');expect(vi.getTimerCount()).toBe(0);
});
