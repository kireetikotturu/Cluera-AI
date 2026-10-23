import {expect,it,vi} from 'vitest';
import {rateLimit} from '../lib/accounts/handler';
import type {AccountConfig} from '../lib/accounts/config';

it('billing polling has separate durable account/IP limits and cannot consume or raise login/write limits',async()=>{
 const counts=new Map<string,number>(),calls:Array<Record<string,unknown>>=[];
 const clients={service:{rpc:vi.fn(async(_name:string,args:Record<string,unknown>)=>{
  calls.push(args);const key=String(args.p_bucket_hash),hits=(counts.get(key)??0)+1;counts.set(key,hits);
  return {data:hits<=Number(args.p_maximum),error:null};
 })}} as unknown as Parameters<typeof rateLimit>[2];
 const config={rateKey:Buffer.alloc(32,5)} as AccountConfig;
 const request=new Request('https://cluera-ai-staging.vercel.app/api/account/credits',{headers:{'x-forwarded-for':'192.0.2.1'}});
 for(let i=0;i<90;i++)await rateLimit(request,config,clients,'synthetic@example.invalid','billing-read');
 await expect(rateLimit(request,config,clients,'synthetic@example.invalid','billing-read')).rejects.toMatchObject({status:429});
 expect(new Set(calls.map(row=>row.p_maximum))).toEqual(new Set([120,90]));
 const readBuckets=new Set(counts.keys());calls.length=0;
 for(let i=0;i<15;i++)await rateLimit(request,config,clients,'synthetic@example.invalid');
 await expect(rateLimit(request,config,clients,'synthetic@example.invalid')).rejects.toMatchObject({status:429});
 expect(new Set(calls.map(row=>row.p_maximum))).toEqual(new Set([60,15]));
 expect(calls.every(row=>!readBuckets.has(String(row.p_bucket_hash)))).toBe(true);
});
it('billing read limiter requires a verified account identifier and fails closed on RPC failure',async()=>{
 const config={rateKey:Buffer.alloc(32,5)} as AccountConfig;
 const rpc=vi.fn().mockResolvedValue({data:null,error:{code:'UNAVAILABLE'},status:503});
 const clients={service:{rpc}} as unknown as Parameters<typeof rateLimit>[2];
 const request=new Request('https://cluera-ai-staging.vercel.app/api/account/credits');
 await expect(rateLimit(request,config,clients,undefined,'billing-read')).rejects.toMatchObject({status:503});expect(rpc).not.toHaveBeenCalled();
 await expect(rateLimit(request,config,clients,'synthetic@example.invalid','billing-read')).rejects.toThrow();
 expect(rpc).toHaveBeenCalledOnce();
});
