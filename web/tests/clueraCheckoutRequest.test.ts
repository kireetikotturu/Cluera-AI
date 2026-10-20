// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { checkoutRequest } from '../lib/payments/cluera/checkoutRequest';
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it.each(['fetch','body'])('settles a stalled %s even if abort is ignored, without retrying',async kind=>{
 vi.useFakeTimers();
 const request=vi.fn(async()=>kind==='fetch'?await new Promise<Response>(()=>{}):new Response(
  new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),
  {headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',request);
 const result=checkoutRequest('/api/account/payments/cluera/checkout',{method:'POST',body:'{}'}).catch(error=>error);
 await vi.advanceTimersByTimeAsync(15000);
 expect(await result).toBeInstanceOf(Error);expect(request).toHaveBeenCalledOnce();
 expect(request.mock.calls[0][1].signal.aborted).toBe(true);
});
it.each([
 ()=>new Response('x'.repeat(131073),{headers:{'content-type':'application/json'}}),
 ()=>new Response('{}',{headers:{'content-type':'text/html'}}),
 ()=>new Response('{}',{headers:{'content-type':'application/json','content-length':'131073'}}),
 ()=>new Response(new Uint8Array([255]),{headers:{'content-type':'application/json'}}),
])('rejects malformed or oversized success bodies without retry',async response=>{
 const request=vi.fn(async()=>response());vi.stubGlobal('fetch',request);
 await expect(checkoutRequest('/api/account/credits',{})).rejects.toThrow();expect(request).toHaveBeenCalledOnce();
});
it('retains denial and throttling status without rendering or parsing the provider error body',async()=>{
 for(const status of [401,403,429,503]){
  vi.stubGlobal('fetch',vi.fn(async()=>new Response('PRIVATE_PROVIDER_ERROR',{status})));
  const result=await checkoutRequest('/api/account/credits',{});expect(result.status).toBe(status);expect(result.ok).toBe(false);expect(await result.json()).toBeNull();
 }
});
it('returns a valid bounded JSON response and closes cleanup without hanging',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({payment:{code:'PENDING'}})));
 expect(await (await checkoutRequest('/api/account/payments/cluera/checkout',{})).json()).toEqual({payment:{code:'PENDING'}});
});
