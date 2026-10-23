// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { checkoutRequest } from '../lib/payments/cluera/checkoutRequest';
import { checkoutWindowSeconds } from '../lib/payments/cluera/checkoutWindow';

it.each([[undefined,600],['600',600],['60',60],['1800',1800],['0',600],['59',600],['1801',600],['NaN',600],['1e3',600]])('bounds checkout presentation window %s', (value,seconds)=>{
 expect(checkoutWindowSeconds(value)).toBe(seconds);
});
it.each([['7',7],['999',300],['0',1],['bad',60]])('bounds Retry-After %s without parsing provider details',async(value,seconds)=>{
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(null,{status:429,headers:{'Retry-After':value}})));
 expect((await checkoutRequest('/api/account/credits',{})).retryAfterSeconds).toBe(seconds);
});
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
it('retains a bounded application error code so eligibility is distinguishable from authentication',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({code:'TEST_PURCHASER_REQUIRED'},{status:403})));
 const response=await checkoutRequest('/api/account/payments/cluera/checkout',{});
 expect(response.ok).toBe(false);expect(response.status).toBe(403);expect(await response.json()).toEqual({code:'TEST_PURCHASER_REQUIRED'});
});
it.each(['oversized','stalled'])('preserves403 without trusting an %s error body or repeating the request',async kind=>{
 vi.useFakeTimers();const request=vi.fn(async()=>new Response(kind==='oversized'?'x'.repeat(131073)
  :new ReadableStream({pull(){return new Promise(()=>{});},cancel(){return new Promise(()=>{});}}),{status:403,headers:{'content-type':'application/json'}}));
 vi.stubGlobal('fetch',request);const result=checkoutRequest('/api/account/payments/cluera/checkout',{});
 await vi.advanceTimersByTimeAsync(15000);const response=await result;
 expect(response.status).toBe(403);expect(await response.json()).toBeNull();expect(request).toHaveBeenCalledOnce();
});
