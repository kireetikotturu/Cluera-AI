import {describe,it,expect,vi} from 'vitest';
import {reconcileNextSandboxEvent} from '../lib/billing/reconciliation/worker';
import {executeNextSandboxBillingAction} from '../lib/billing/reconciliation/outbox';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
const uid='00000000-0000-4000-8000-000000000981',claimId='00000000-0000-4000-8000-000000000982';
const id=(p:string,n=1)=>`${p}_${String(n).padStart(26,'0')}`;
const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'synthetic-server-key-no-real-secret',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co',
  SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'dwqltsqumiwsxtkzdoaa'};
function fixture(index=0){
  const offer=sandboxOffers[index],now=Date.now(),end=new Date(now+(offer.interval==='week'?7:30)*86400000).toISOString();
  const price={id:offer.priceId,product_id:id('pro'),unit_price:{amount:offer.amount,currency_code:'INR'},tax_mode:'external',trial_period:null,
    billing_cycle:offer.interval?{interval:offer.interval,frequency:1}:null};
  const bound={intentId:claimId,userId:uid,transactionId:id('txn'),offerCode:offer.code};
  const sub={id:id('sub'),customer_id:id('ctm'),status:'active',collection_mode:'automatic',currency_code:'INR',
    scheduled_change:null as null|{action:string;effective_at:string},next_billed_at:end,items:[{quantity:1,price}],updated_at:new Date(now).toISOString()};
  const tx={id:id('txn'),status:'completed',customer_id:id('ctm'),subscription_id:offer.interval?id('sub'):null,
    collection_mode:'automatic',currency_code:'INR',discount_id:null,custom_data:{sigma_checkout_intent:claimId},
    billing_period:offer.interval?{starts_at:new Date(now).toISOString(),ends_at:end}:null,updated_at:new Date(now).toISOString(),
    items:[{quantity:1,price,proration:null}],details:{totals:{balance:'0',discount:'0',credit:'0',credit_to_balance:'0',
      total:offer.amount,grand_total:offer.amount,subtotal:offer.amount,tax:'0',currency_code:'INR'},line_items:[{price_id:offer.priceId,quantity:1}]}};
  const adjustments:any[]=[];
  const job={code:'CLAIMED',eventId:id('evt'),eventType:'transaction.completed',resourceId:id('txn'),eventDigest:'a'.repeat(64),claimId};
  const sb={userId:uid,subscriptionId:id('sub'),customerId:id('ctm'),offerCode:offer.code};
  const rpc=vi.fn(async(name:string,_args:Record<string,unknown>)=>({error:null,data:
    name==='customer_billing_claim'?job:name==='customer_billing_bound_intent'?bound:name==='customer_billing_subscription'?sb:
    name==='customer_billing_finish'||name==='customer_billing_action_finish'?'SAVED':
    name==='customer_billing_action_authorize'?true:{code:'APPLIED'}}));
  const request=vi.fn(async(url:any,init?:RequestInit)=>{
    const path=new URL(String(url)).pathname;
    if(init?.method==='POST')sub.scheduled_change={action:'cancel',effective_at:end};
    if(init?.method==='PATCH')sub.next_billed_at=JSON.parse(String(init.body)).next_billed_at;
    return Response.json(path==='/adjustments'?{data:adjustments,meta:{pagination:{has_more:false}}}:
      {data:path.startsWith('/prices/')?{...price,status:'active',type:'standard',product:{id:id('pro'),status:'active'},quantity:{minimum:1,maximum:1},unit_price_overrides:[]}:path.startsWith('/transactions/')?tx:path.startsWith('/customers/')?{id:id('ctm'),status:'active'}:
        path.startsWith('/adjustments/')?adjustments[0]:sub});
  });
  return {offer,bound,sub,tx,adjustments,job,sb,rpc,request};
}
describe('authoritative durable billing worker',()=>{
  it('requires sandbox target before any database/provider operation',async()=>{
    const f=fixture();await expect(reconcileNextSandboxEvent(f.rpc,{...env,PADDLE_ENVIRONMENT:'live'},f.request)).rejects.toThrow();
    expect(f.rpc).not.toHaveBeenCalled();expect(f.request).not.toHaveBeenCalled();
  });
  it('applies verified pack and recurring transactions through fenced RPCs only',async()=>{
    for(const index of [0,1,2,3]){
      const f=fixture(index);expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe('APPLIED');
      expect(f.rpc.mock.calls.some(([name])=>name===(index?'customer_billing_apply_recurring':'customer_billing_apply_pack'))).toBe(true);
      expect(f.rpc.mock.calls.some(([name])=>name==='customer_pack_reconcile')).toBe(false);
      expect(f.request.mock.calls.every(([,init])=>!init?.method)).toBe(true);
    }
  });
  it('out-of-order renewal maps through bound subscription, never custom account data',async()=>{
    const f=fixture(2),original=f.rpc.getMockImplementation()!;
    f.rpc.mockImplementation(async(name,args)=>name==='customer_billing_bound_intent'?{data:null,error:null}:original(name,args));
    f.tx.custom_data.sigma_checkout_intent=uid;
    expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe('APPLIED');
    expect(f.request.mock.calls.filter(([u])=>String(u).includes('/transactions/'))).toHaveLength(1);
  });
  it('subscription events re-read authoritative current state and do not grant',async()=>{
    const f=fixture(2);f.job.eventType='subscription.past_due';f.job.resourceId=id('sub');f.sub.status='past_due';
    expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe('APPLIED');
    const args=f.rpc.mock.calls.find(([name])=>name==='customer_billing_apply_recurring')![1];
    expect(args.p_evidence).toMatchObject({action:'STATUS',state:'PAST_DUE'});
  });
  it('missing mapping/upstream failure retries and cannot grant',async()=>{
    const f=fixture();f.request.mockResolvedValue(new Response(null,{status:503}));
    expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe('RETRY');
    expect(f.rpc.mock.calls.some(([name])=>name.startsWith('customer_billing_apply'))).toBe(false);
  });
  it('late completion with an existing refund cannot resurrect allowance',async()=>{
    const f=fixture();f.adjustments.push({id:id('adj'),transaction_id:id('txn'),customer_id:id('ctm'),currency_code:'INR',action:'refund',type:'full',status:'approved'});
    expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe('UNSUPPORTED');
    expect(f.rpc.mock.calls.some(([name])=>name.startsWith('customer_billing_apply'))).toBe(false);
  });
  it('approved full refund applies; pending retries, rejected ignores and partial/reversed reviews',async()=>{
    for(const [status,type,expected] of [['approved','full','APPLIED'],['pending_approval','full','RETRY'],['rejected','full','IGNORED'],['approved','partial','UNSUPPORTED'],['reversed','full','UNSUPPORTED']]){
      const f=fixture();f.job.eventType='adjustment.updated';f.job.resourceId=id('adj');
      f.adjustments.push({id:id('adj'),transaction_id:id('txn'),customer_id:id('ctm'),currency_code:'INR',action:'refund',type,status});
      expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe(expected);
    }
  });
  it('simulator IDs are rejected before provider/financial calls',async()=>{
    const f=fixture();f.job.eventId=id('ntfsimevt');await expect(reconcileNextSandboxEvent(f.rpc,env,f.request)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });
  it('does not follow adjustment pagination URLs or silently accept incomplete history',async()=>{
    const f=fixture(),original=f.request.getMockImplementation()!;
    f.request.mockImplementation(async(u,i)=>String(u).includes('/adjustments?')?Response.json({data:[],meta:{pagination:{has_more:true,next:'https://attacker.invalid'}}}):original(u,i));
    expect(await reconcileNextSandboxEvent(f.rpc,env,f.request)).toBe('RETRY');
    expect(f.request.mock.calls.every(([u])=>String(u).startsWith('https://sandbox-api.paddle.com/'))).toBe(true);
  });
});
describe('durable Paddle action executor',()=>{
  function outbox(action='CANCEL_FUTURE'){
    const f=fixture(1),original=f.rpc.getMockImplementation()!;
    const job={code:'CLAIMED',actionId:uid,claimId,userId:uid,subscriptionId:id('sub'),action,
      effectiveAt:action==='RESCHEDULE'?new Date(Date.now()+60*86400000).toISOString():null};
    f.rpc.mockImplementation(async(name,args)=>name==='customer_billing_action_claim'?{data:job,error:null}:original(name,args));
    return {...f,actionJob:job};
  }
  const enabled={...env,SIGMAROUND_PADDLE_SANDBOX_BILLING_ACTIONS_ENABLED:'true'};
  it('is disabled by default, including when API key exists',async()=>{
    const f=outbox();await expect(executeNextSandboxBillingAction(f.rpc,env,f.request)).rejects.toThrow();expect(f.rpc).not.toHaveBeenCalled();
  });
  it('cancels future renewal only, then verifies actual state',async()=>{
    const f=outbox();expect(await executeNextSandboxBillingAction(f.rpc,enabled,f.request)).toBe('CONFIRMED');
    const mutation=f.request.mock.calls.find(([,i])=>i?.method==='POST')!;
    expect(JSON.parse(String(mutation[1]!.body))).toEqual({effective_from:'next_billing_period'});
    expect(f.request).toHaveBeenCalledTimes(3);
  });
  it('after a lost response, confirms already-applied cancellation without a second POST',async()=>{
    const f=outbox();f.sub.scheduled_change={action:'cancel',effective_at:f.sub.next_billed_at};
    expect(await executeNextSandboxBillingAction(f.rpc,enabled,f.request)).toBe('CONFIRMED');
    expect(f.request.mock.calls.some(([,i])=>i?.method)).toBe(false);
  });
  it('reschedules without proration charge, never changes price/customer/items',async()=>{
    const f=outbox('RESCHEDULE');expect(await executeNextSandboxBillingAction(f.rpc,enabled,f.request)).toBe('CONFIRMED');
    expect(JSON.parse(String(f.request.mock.calls.find(([,i])=>i?.method==='PATCH')![1]!.body)))
      .toEqual({next_billed_at:f.actionJob.effectiveAt,proration_billing_mode:'do_not_bill'});
  });
});
