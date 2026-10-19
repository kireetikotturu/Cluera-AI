import {afterEach,expect,it,vi} from 'vitest';
import {readProviderUsage} from '../lib/aiProviders/readUsage';
const report={code:'ACTIVE',scope:'LATEST_REQUESTS',limit:50,costStatus:'UNAVAILABLE',rows:[]};
const headers={'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
it('uses a fixed same-origin no-store GET, validates report metadata and clears its deadline',async()=>{
 const request=vi.fn(async()=>Response.json(report,{headers}));vi.stubGlobal('fetch',request);
 expect(await readProviderUsage(new AbortController())).toEqual({status:200,report});
 const [url,options]=request.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('/api/account/admin/ai-usage');
 expect(options).toMatchObject({method:'GET',credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});
});
it.each(['fetch','body'])('bounds an abort-ignoring %s and non-settling cleanup to eight seconds',async mode=>{
 vi.useFakeTimers();const never=()=>new Promise<never>(()=>{}),cancel=vi.fn(never);
 const request=vi.fn(()=>mode==='fetch'?never():Promise.resolve(new Response(new ReadableStream<Uint8Array>({pull:never,cancel}),{headers})));vi.stubGlobal('fetch',request);
 const controller=new AbortController();const result=expect(readProviderUsage(controller)).rejects.toThrow('Unavailable');
 await vi.advanceTimersByTimeAsync(8000);await result;expect(controller.signal.aborted).toBe(true);expect(request).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
 if(mode==='body')expect(cancel).toHaveBeenCalledOnce();
});
it.each(['declared-size','actual-size','content-type','cache','headers','dto'])('fails closed for untrusted %s without raw error content',async failure=>{
 const h={...headers};let body=JSON.stringify(report);
 if(failure==='declared-size')Object.assign(h,{'Content-Length':'131073'});
 if(failure==='actual-size')body='x'.repeat(131073);
 if(failure==='content-type')h['Content-Type']='text/html';
 if(failure==='cache')h['Cache-Control']='public';
 if(failure==='headers')h['X-Content-Type-Options']='';
 if(failure==='dto')body=JSON.stringify({...report,secret:'private'});
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(body,{headers:h})));
 await expect(readProviderUsage(new AbortController())).rejects.toThrow();
});
it('does not read or echo a denial response body',async()=>{
 const cancel=vi.fn(async()=>{});vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(){},cancel}),{status:403})));
 expect(await readProviderUsage(new AbortController())).toEqual({status:403});
 expect(cancel).toHaveBeenCalledOnce();
});
