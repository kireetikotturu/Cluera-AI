import {describe,it,expect,vi} from 'vitest';
import {inspectBoundSandboxTransaction,inspectSandboxFullRefund} from '../lib/billing/reconciliation/transaction';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'synthetic-not-a-real-provider-key',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg'};
const txn=`txn_${'a'.repeat(26)}`,ctm=`ctm_${'a'.repeat(26)}`,sub=`sub_${'a'.repeat(26)}`,adj=`adj_${'a'.repeat(26)}`;
const bound={intentId:'00000000-0000-4000-8000-000000000811',userId:'00000000-0000-4000-8000-000000000812',transactionId:txn,offerCode:'pro_3_hours'};
function fixtures(index=0){
  const offer=sandboxOffers[index];const price={id:offer.priceId,product_id:'pro_'+'a'.repeat(26),unit_price:{amount:offer.amount,currency_code:'INR'},
    tax_mode:'external',trial_period:null,billing_cycle:offer.interval?{interval:offer.interval,frequency:1}:null};
  return {tx:{id:txn,status:'completed',customer_id:ctm,subscription_id:offer.interval?sub:null,collection_mode:'automatic',currency_code:'INR',discount_id:null,
    custom_data:{sigma_checkout_intent:bound.intentId,userId:'attacker-supplied-ignored'},updated_at:'2026-10-04T00:00:00Z',
    billing_period:offer.interval?{starts_at:'2026-10-04T00:00:00Z',ends_at:'2026-11-04T00:00:00Z'}:null,
    items:[{quantity:1,price,proration:null}],details:{totals:{balance:'0',discount:'0',total:offer.amount,grand_total:offer.amount,
      subtotal:offer.amount,tax:'0',credit:'0',credit_to_balance:'0',currency_code:'INR'},line_items:[{price_id:offer.priceId,quantity:1}]}},
    customer:{id:ctm,status:'active',email:'never-return@example.invalid'},
    subscription:{id:sub,customer_id:ctm,status:'active',collection_mode:'automatic',currency_code:'INR',scheduled_change:null,
      next_billed_at:'2026-11-04T00:00:00Z',items:[{quantity:1,price}],updated_at:'2026-10-04T00:00:00Z'}};
}
function requester(f:ReturnType<typeof fixtures>){return vi.fn(async(url:any)=>Response.json({data:String(url).includes('/transactions/')?f.tx:String(url).includes('/customers/')?f.customer:String(url).includes('/prices/')?{
 ...f.tx.items[0].price,product_id:'pro_'+'a'.repeat(26),status:'active',type:'standard',product:{id:'pro_'+'a'.repeat(26),status:'active'},unit_price_overrides:[],quantity:{minimum:1,maximum:1}}:f.subscription}));}
describe('authoritative read-only financial evidence boundary',()=>{
  it('uses durable transaction binding and never mutable customer metadata/email to choose account',async()=>{
    const request=requester(fixtures()),result=await inspectBoundSandboxTransaction(bound,env,request);
    expect(result).toMatchObject({userId:bound.userId,allowanceMilliseconds:10800000,recurring:null,financiallyReconciled:false});
    expect(JSON.stringify(result)).not.toContain('never-return');expect(JSON.stringify(result)).not.toContain('attacker');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('reads related subscription and validates same customer and catalog',async()=>{
    const f=fixtures(1),request=requester(f);
    expect((await inspectBoundSandboxTransaction({...bound,offerCode:'pro_40_hours'},env,request)).recurring?.subscriptionId).toBe(sub);
    f.subscription.customer_id=`ctm_${'b'.repeat(26)}`;
    await expect(inspectBoundSandboxTransaction({...bound,offerCode:'pro_40_hours'},env,request)).rejects.toThrow();
  });
  it('rejects non-completed, underpaid, altered-price, extra-item and wrong binding transactions',async()=>{
    for(const change of [(f:any)=>f.tx.status='paid',(f:any)=>f.tx.details.totals.balance='1',
      (f:any)=>f.tx.items[0].price.unit_price.amount='1',(f:any)=>f.tx.items.push(f.tx.items[0]),
      (f:any)=>f.tx.details.totals.total='1',(f:any)=>f.tx.details.totals.credit='100',
      (f:any)=>f.tx.items[0].proration={rate:'0.5'},
      (f:any)=>f.tx.items[0].price.product_id='pro_'+'b'.repeat(26),
      (f:any)=>f.tx.custom_data.sigma_checkout_intent=bound.userId,(f:any)=>f.tx.id=`txn_${'b'.repeat(26)}`]){
      const f=fixtures();change(f);await expect(inspectBoundSandboxTransaction(bound,env,requester(f))).rejects.toThrow();
    }
  });
  it('does not accept simulator IDs, arbitrary paths, live mode or provider failure',async()=>{
    const request=vi.fn();
    await expect(inspectBoundSandboxTransaction({...bound,transactionId:'ntfsimevt_'+'a'.repeat(26)},env,request)).rejects.toThrow();expect(request).not.toHaveBeenCalled();
    await expect(inspectBoundSandboxTransaction(bound,{...env,PADDLE_ENVIRONMENT:'live'},request)).rejects.toThrow();
    await expect(inspectBoundSandboxTransaction(bound,env,async()=>new Response('sensitive',{status:403}))).rejects.toThrow('Paddle sandbox request could not be verified');
  });
  it('attributes full refund evidence only to the expected transaction/customer without granting or reversing anything',async()=>{
    const value={id:adj,action:'refund',type:'full',status:'approved',transaction_id:txn,customer_id:ctm,currency_code:'INR',updated_at:'2026-10-04T00:00:00Z'};
    const request=async()=>Response.json({data:value});
    expect((await inspectSandboxFullRefund(adj,{transactionId:txn,customerId:ctm},env,request)).status).toBe('approved');
    value.status='pending_approval';expect((await inspectSandboxFullRefund(adj,{transactionId:txn,customerId:ctm},env,request)).status).toBe('pending_approval');
    value.customer_id=`ctm_${'b'.repeat(26)}`;await expect(inspectSandboxFullRefund(adj,{transactionId:txn,customerId:ctm},env,request)).rejects.toThrow();
  });
});
