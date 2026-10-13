import {describe,it,expect,vi} from 'vitest';
import {checkoutService} from '../lib/billing/checkout/service';
import {createSandboxCheckout} from '../lib/billing/checkout/transport';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
import {CheckoutTransportError,logCheckoutFailure} from '../lib/billing/checkout/diagnostics';
const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',PADDLE_API_KEY:'synthetic-key-not-a-real-credential',
  SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co',
  SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'dwqltsqumiwsxtkzdoaa'};
const user={userId:'00000000-0000-4000-8000-000000000801',sessionId:'00000000-0000-4000-8000-000000000802'};
const input={requestId:'00000000-0000-4000-8000-000000000803',offerCode:'pro_3_hours' as const};
const claim={code:'CLAIMED',intentId:input.requestId,attemptId:'00000000-0000-4000-8000-000000000804'};
const txn=`txn_${'a'.repeat(26)}`,offer=sandboxOffers[0];
describe('sandbox checkout orchestration',()=>{
  it('binds only a server-created transaction and does not return the claim capability',async()=>{
    const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:'BOUND',error:null});
    const create=vi.fn(async()=>({transactionId:txn}));
    expect(await checkoutService(rpc,env,{offer:async()=>offer,create}).prepare(user,input))
      .toEqual({code:'BOUND',intentId:claim.intentId,transactionId:txn});
    expect(create).toHaveBeenCalledOnce();
    expect(rpc.mock.calls[0][1].p_user_id).toBe(user.userId);
    expect(rpc.mock.calls.map(c=>c[0])).toEqual(['customer_checkout_prepare','customer_checkout_complete']);
  });
  it('never repeats create for pending/bound/rejected/replayed claims',async()=>{
    for(const data of [{code:'PENDING'},{code:'REJECTED'},{code:'CONFLICT'},{code:'BOUND',intentId:claim.intentId,transactionId:txn}]){
      const create=vi.fn();await checkoutService(async()=>({data,error:null}),env,{offer:async()=>offer,create}).prepare(user,input);
      expect(create).not.toHaveBeenCalled();
    }
  });
  it('persists unknown outcome after provider failure and never guesses payment success',async()=>{
    const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:'UNCERTAIN',error:null});
    const create=vi.fn(async()=>{throw new Error('sensitive-provider-response');});
    expect(await checkoutService(rpc,env,{offer:async()=>offer,create}).prepare(user,input)).toEqual({code:'PENDING',failure:{stage:'request'}});
    expect(create).toHaveBeenCalledOnce();expect(rpc.mock.calls[1][1].p_state).toBe('UNCERTAIN');
  });
  it('rejects another target, user/amount injection, unsupported product and DB errors',async()=>{
    expect(()=>checkoutService(vi.fn(),{...env,PADDLE_ENVIRONMENT:'live'})).toThrow();
    const rpc=vi.fn();const service=checkoutService(rpc,env,{offer:async()=>offer});
    await expect(service.prepare(user,{...input,userId:user.userId,amount:1} as never)).rejects.toThrow();expect(rpc).not.toHaveBeenCalled();
    await expect(checkoutService(async()=>({data:null,error:{message:'secret'}}),env,{offer:async()=>offer}).prepare(user,input)).rejects.toThrow('Supabase operation failed');
  });
  it('returns only safe diagnostic categories after persisting UNCERTAIN, never changes rejection or paid state',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try{
      const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:'UNCERTAIN',error:null});
      const failure=new CheckoutTransportError('http',403,'forbidden','aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
      Object.assign(failure,{detail:'synthetic-private-token',body:'synthetic-provider-secret'});
      const create=vi.fn(async()=>{throw failure;});
      const result=await checkoutService(rpc,env,{offer:async()=>offer,create}).prepare(user,input);
      expect(result).toEqual({code:'PENDING',failure:{stage:'http',httpStatus:403,providerCode:'forbidden',providerRequestId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}});
      expect(JSON.stringify(result)).not.toMatch(/private|secret|attemptId/);
      expect(rpc.mock.calls.map(c=>c[0])).toEqual(['customer_checkout_prepare','customer_checkout_complete']);
      expect(rpc.mock.calls[1][1]).toEqual({p_intent_id:claim.intentId,p_attempt_id:claim.attemptId,p_transaction_id:null,p_state:'UNCERTAIN'});
      expect(create).toHaveBeenCalledOnce();
    }finally{log.mockRestore();}
  });
  it('keeps a documented validation denial UNCERTAIN with only its safe category and no provider retry',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try{
      const rpc=vi.fn().mockResolvedValueOnce({data:claim,error:null}).mockResolvedValueOnce({data:'UNCERTAIN',error:null});
      const request=vi.fn(async()=>Response.json({error:{code:'invalid_field',detail:'synthetic-private-detail',errors:[{field:'custom_data',value:'synthetic-private-value'}]},
        meta:{request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}},{status:400}));
      const result=await checkoutService(rpc,env,{offer:async()=>offer,create:(selected,id)=>createSandboxCheckout(selected,id,env,request)}).prepare(user,input);
      const failure={stage:'http',httpStatus:400,providerCode:'invalid_field',providerRequestId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};
      expect(result).toEqual({code:'PENDING',failure});
      expect(log).toHaveBeenCalledExactlyOnceWith('[billing-checkout] create unresolved',failure);
      expect(JSON.stringify([result,log.mock.calls])).not.toMatch(/synthetic-private|custom_data|detail|errors|attemptId/);
      expect(request).toHaveBeenCalledOnce();
      expect(rpc.mock.calls.map(c=>c[0])).toEqual(['customer_checkout_prepare','customer_checkout_complete']);
      expect(rpc.mock.calls[1][1]).toEqual({p_intent_id:claim.intentId,p_attempt_id:claim.attemptId,p_transaction_id:null,p_state:'UNCERTAIN'});
    }finally{log.mockRestore();}
  });
});
describe('Paddle sandbox create transport',()=>{
  const data={id:txn,status:'draft',collection_mode:'automatic',currency_code:'INR',custom_data:{sigma_checkout_intent:claim.intentId},
    items:[{quantity:1,price:{id:offer.priceId}}],customer_email:'private@example.invalid'};
  it('sends one fixed-price draft, no account identity/card/amount and forwards only transaction ID',async()=>{
    const request=vi.fn(async()=>Response.json({data}));
    expect(await createSandboxCheckout(offer,claim.intentId,env,request)).toEqual({transactionId:txn});
    const [url,init]=request.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('https://sandbox-api.paddle.com/transactions');expect(init.redirect).toBe('error');
    const body=JSON.parse(String(init.body));expect(body).not.toHaveProperty('status');expect(body).not.toHaveProperty('customer_id');
    expect(body.items).toEqual([{price_id:offer.priceId,quantity:1}]);
    expect(JSON.stringify(body)).not.toContain(sandboxOffers[1].priceId);
    expect(JSON.stringify(body)).not.toContain(sandboxOffers[2].priceId);
    expect(JSON.stringify(body)).not.toContain(sandboxOffers[3].priceId);
  });
  it('maps each offer independently to exactly one canonical price',async()=>{
    for(const selected of sandboxOffers){
      const request=vi.fn(async()=>Response.json({data:{...data,items:[{quantity:1,price:{id:selected.priceId}}]}}));
      await createSandboxCheckout(selected,claim.intentId,env,request);
      expect(request).toHaveBeenCalledOnce();
      const init=(request.mock.calls[0] as unknown as [string,RequestInit])[1];
      expect(JSON.parse(String(init.body)).items).toEqual([{price_id:selected.priceId,quantity:1}]);
    }
  });
  it('fails closed on unknown outcomes, wrong binding/price, paid response and excessive body',async()=>{
    for(const response of [Response.json({}, {status:403}),Response.json({data:{...data,status:'completed'}}),
      Response.json({data:{...data,custom_data:{sigma_checkout_intent:user.userId}}}),
      Response.json({data:{...data,items:[{quantity:2,price:{id:offer.priceId}}]}}),new Response('x'.repeat(262145))]){
      const request=vi.fn(async()=>response);
      await expect(createSandboxCheckout(offer,claim.intentId,env,request)).rejects.toThrow('Paddle sandbox request could not be verified');
      expect(request).toHaveBeenCalledOnce();
    }
  });
  it('retains only bounded diagnostic categories, not Paddle bodies or exception details',async()=>{
    const log=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    try {
      for(const [response,expected] of [
        [Response.json({error:{code:'forbidden',detail:'private-token'},meta:{request_id:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}},{status:403}),{stage:'http',httpStatus:403,providerCode:'forbidden',providerRequestId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'}],
        [Response.json({error:{code:'forbidden'},meta:{request_id:'Bearer private-token'}},{status:403}),{stage:'http',httpStatus:403,providerCode:'forbidden'}],
        [Response.json({error:{code:'forbidden',detail:'private-customer-token',errors:[{value:'secret'}]}},{status:403}),{stage:'http',httpStatus:403,providerCode:'forbidden'}],
        [Response.json({error:{code:'secret-key-customer-data'}},{status:400}),{stage:'http',httpStatus:400}],
        [Response.json({data:{...data,currency_code:null}}),{stage:'schema',httpStatus:200}],
        [Response.json({data:{...data,custom_data:{sigma_checkout_intent:user.userId}}}),{stage:'binding',httpStatus:200}],
        [new Response('private-token-not-json',{status:502}),{stage:'http',httpStatus:502}],
      ] as const){
        let failure:unknown;
        const request=vi.fn(async()=>response);
        try {await createSandboxCheckout(offer,claim.intentId,env,request);}catch(error){failure=error;}
        expect(failure).toBeInstanceOf(CheckoutTransportError);
        logCheckoutFailure(failure);
        expect(log).toHaveBeenLastCalledWith('[billing-checkout] create unresolved',expected);
        expect(request).toHaveBeenCalledOnce();
      }
      logCheckoutFailure(new Error('private-token'));
      expect(log).toHaveBeenLastCalledWith('[billing-checkout] create unresolved',{stage:'request'});
      const malicious=new CheckoutTransportError('http',403,'forbidden');
      Object.assign(malicious,{stage:'secret',httpStatus:'private',providerCode:'private-token',providerRequestId:'private-token'});
      logCheckoutFailure(malicious);
      expect(log).toHaveBeenLastCalledWith('[billing-checkout] create unresolved',{stage:'request'});
      expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret|customer|Authorization|Bearer/);
    } finally {log.mockRestore();}
  });
});
