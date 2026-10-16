import {describe,it,expect,vi} from 'vitest';
import {resumeSandboxCheckout} from '../lib/billing/checkout/resume';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'sb_secret_synthetic-server-key-not-real',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg'};
const who={userId:'00000000-0000-4000-8000-000000000941',sessionId:'00000000-0000-4000-8000-000000000942'};
const intentId='00000000-0000-4000-8000-000000000943',transactionId='txn_'+'a'.repeat(26),productId='pro_'+'b'.repeat(26),offer=sandboxOffers[0];
const canonical={code:'BOUND',intentId,transactionId,offerCode:offer.code};
const data={id:transactionId,status:'draft',collection_mode:'automatic',currency_code:'INR',custom_data:{sigma_checkout_intent:intentId},
  subscription_id:null,billed_at:null,discount_id:null,payments:[],checkout:{url:env.SIGMAROUND_ACCOUNT_ORIGIN+'/account/checkout?_ptxn='+transactionId},
  items:[{quantity:1,price:{id:offer.priceId,product_id:productId,unit_price:{amount:offer.amount,currency_code:'INR'}}}],customer_email:'private@example.invalid'};
const price=async()=>({offer,productId});
describe('owned existing checkout read-only resume',()=>{
  it('uses only canonical owned IDs, verifies unpaid provider binding and rechecks under account lock',async()=>{
    const rpc=vi.fn(async()=>({data:canonical,error:null})),read=vi.fn(async()=>data);
    const result=await resumeSandboxCheckout(rpc,who,env,{price,read});
    expect(result).toEqual({code:'RESUMABLE',offerCode:offer.code,transactionId});
    expect(rpc).toHaveBeenCalledTimes(2);expect(rpc).toHaveBeenCalledWith('customer_checkout_resume_read',{p_user_id:who.userId,p_session_id:who.sessionId});
    expect(read).toHaveBeenCalledExactlyOnceWith('transactions',transactionId,env);
    expect(JSON.stringify(result)).not.toMatch(/intentId|private|checkout.url|customer/);
  });
  it('never contacts Paddle for unknown/creating/uncertain/ambiguous or absent canonical checkout',async()=>{
    for(const code of ['PENDING','NOT_FOUND']){
      const read=vi.fn(),verify=vi.fn();expect(await resumeSandboxCheckout(async()=>({data:{code},error:null}),who,env,{read,price:verify})).toEqual({code});
      expect(read).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
    }
  });
  it('accepts ready unpaid checkout and denies a session revoked during provider verification',async()=>{
    const rpc=vi.fn(async()=>({data:canonical,error:null}));
    expect(await resumeSandboxCheckout(rpc,who,env,{price,read:async()=>({...data,status:'ready'})})).toEqual({code:'RESUMABLE',offerCode:offer.code,transactionId});
    for(const [code,status]of [['UNAUTHENTICATED',401],['SUSPENDED',403]] as const){
      const changed=vi.fn().mockResolvedValueOnce({data:canonical,error:null}).mockResolvedValueOnce({data:{code},error:null});
      await expect(resumeSandboxCheckout(changed,who,env,{price,read:async()=>data})).rejects.toMatchObject({status});
      expect(changed).toHaveBeenCalledTimes(2);
    }
  });
  it('fails closed on provider paid/completed/canceled, attempts, wrong identity, product, amount and host',async()=>{
    const variations=[{status:'paid'},{status:'completed'},{status:'billed'},{status:'canceled'},{status:'past_due'},
      {payments:[{status:'captured'}]},{subscription_id:'sub_'+'c'.repeat(26)},{discount_id:'dsc_'+'d'.repeat(26)},
      {id:'txn_'+'e'.repeat(26)},{custom_data:{sigma_checkout_intent:who.userId}},
      {items:[{...data.items[0],quantity:2}]},{items:[{quantity:1,price:{...data.items[0].price,product_id:'pro_'+'c'.repeat(26)}}]},
      {items:[{quantity:1,price:{...data.items[0].price,unit_price:{amount:'1',currency_code:'INR'}}}]},
      ...['https://attacker.invalid/account/checkout','https://cluera-ai-staging.vercel.app.evil.invalid/account/checkout',
        env.SIGMAROUND_ACCOUNT_ORIGIN+'/other',env.SIGMAROUND_ACCOUNT_ORIGIN+'/account/checkout?other=1',
        env.SIGMAROUND_ACCOUNT_ORIGIN+'/account/checkout?_ptxn=txn_'+'c'.repeat(26),env.SIGMAROUND_ACCOUNT_ORIGIN+'/account/checkout#private'].map(url=>({checkout:{url}}))];
    for(const change of variations){const rpc=vi.fn(async()=>({data:canonical,error:null}));
      expect(await resumeSandboxCheckout(rpc,who,env,{price,read:async()=>({...data,...change})})).toEqual({code:'PENDING'});expect(rpc).toHaveBeenCalledOnce();}
  });
  it('fences settlement, owner/session rejection and changed binding during provider reads',async()=>{
    for(const last of [{code:'NOT_FOUND'},{code:'PENDING'},{...canonical,intentId:who.userId},{...canonical,transactionId:'txn_'+'c'.repeat(26)}]){
      const rpc=vi.fn().mockResolvedValueOnce({data:canonical,error:null}).mockResolvedValueOnce({data:last,error:null});
      expect(await resumeSandboxCheckout(rpc,who,env,{price,read:async()=>data})).toEqual({code:'PENDING'});
    }
    for(const [code,status]of [['UNAUTHENTICATED',401],['SUSPENDED',403]] as const){
      await expect(resumeSandboxCheckout(async()=>({data:{code},error:null}),who,env)).rejects.toMatchObject({status});
    }
  });
  it('fails closed on stale/malformed RPC or provider outage without any completion/writer RPC',async()=>{
    for(const bad of [null,{...canonical,extra:'private'},{code:'VERIFIED'}])await expect(resumeSandboxCheckout(async()=>({data:bad,error:null}),who,env)).rejects.toMatchObject({status:503});
    const rpc=vi.fn(async()=>({data:canonical,error:null}));
    expect(await resumeSandboxCheckout(rpc,who,env,{price,read:async()=>{throw new Error('private-response');}})).toEqual({code:'PENDING'});
    expect(rpc.mock.calls.map(x=>x[0])).toEqual(['customer_checkout_resume_read']);
    await expect(resumeSandboxCheckout(rpc,who,{...env,PADDLE_ENVIRONMENT:'live'})).rejects.toMatchObject({status:503});
  });
});
