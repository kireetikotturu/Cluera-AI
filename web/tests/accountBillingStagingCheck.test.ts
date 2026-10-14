import {createRequire} from 'node:module';
import {it,expect,vi} from 'vitest';
const {ORIGIN,checks,inspect,run}=createRequire(import.meta.url)('../../scripts/verify-cluera-staging.cjs');
const headers={'cache-control':'no-store','x-content-type-options':'nosniff'};
const pricing='Cluera 3 Hours Cluera Pro 40 Hours Cluera Pro 100 Hours Cluera Enterprise 200 Hours ₹549 ₹5,499 ₹9,599 ₹19,549 100 hours per month not active payment offers no expiry do not roll over';
it('requires exact reviewed pricing, paused controls and no third-party SDK',()=>{
 const response=new Response(null,{status:200,headers});
 expect(inspect(checks[1],response,pricing).pass).toBe(true);
 expect(inspect(checks[1],response,'Only one plan').pass).toBe(false);
 expect(inspect(checks[2],response,'Test payments are paused Checkout unavailable').pass).toBe(true);
 expect(inspect(checks[2],response,'Test payments are paused Checkout unavailable<script src="https://checkout.razorpay.com/v1/checkout.js"></script>').pass).toBe(false);
});
it('accepts separated visible price/allowance markup and case-styled expiry without changing policy',()=>{
 const response=new Response(null,{status:200,headers});
 const split=pricing.replace('100 hours per month','<span>100</span> hours<!-- --> per month').replace('no expiry','No expiry');
 expect(inspect(checks[1],response,split).pass).toBe(true);
 expect(inspect(checks[1],response,split.replace('\u20b9549','\u20b9550')).pass).toBe(false);
});
it('never accepts plan evidence hidden only in script, style or comments',()=>{
 const response=new Response(null,{status:200,headers});
 for(const hidden of [`<script>${pricing}</script>`,`<style>${pricing}</style>`,`<!--${pricing}-->`])expect(inspect(checks[1],response,hidden).pass).toBe(false);
});
it('checks the raw response for secrets even when they are in excluded markup',()=>{
 const response=new Response(null,{status:200,headers});
 expect(inspect(checks[1],response,pricing+'<script>synthetic-secret</script>',[{type:'synthetic',value:'synthetic-secret'}]).pass).toBe(false);
});
it('fails closed on redirect, wrong status, cacheable response or known secret',()=>{
 expect(inspect(checks[3],new Response(null,{status:404,headers}),'{}').pass).toBe(true);
 expect(inspect(checks[3],new Response(null,{status:200,headers}),'{}').pass).toBe(false);
 expect(inspect(checks[3],new Response(null,{status:404,headers:{...headers,location:'https://untrusted.invalid'}}),'{}').pass).toBe(false);
 expect(inspect(checks[3],new Response(null,{status:404}),'{}').pass).toBe(false);
 const report=inspect(checks[3],new Response(null,{status:404,headers}),'synthetic-secret',[{type:'synthetic',value:'synthetic-secret'}]);
 expect(report.pass).toBe(false);expect(JSON.stringify(report)).not.toContain('synthetic-secret');
});
it('uses only fixed credential-free bounded requests, with no retries or real checkout body',async()=>{
 const fetcher=vi.fn(async(url:string,options:RequestInit)=>{
  expect(url.startsWith(ORIGIN+'/')).toBe(true);expect(options.redirect).toBe('manual');
  expect(options.headers).not.toHaveProperty('Authorization');expect(options.headers).not.toHaveProperty('Cookie');
  if(options.method==='POST')expect(options.body).toBe('{}');
  const check=checks.find((c:string[])=>ORIGIN+c[2]===url&&c[1]===options.method)!;
  const body=check[0]==='checkout-page'?'Test payments are paused Checkout unavailable':pricing;
  return new Response(body,{status:check[3],headers});
 });
 const report=await run(fetcher);expect(report.failed).toBe(0);expect(fetcher).toHaveBeenCalledTimes(checks.length);
});
