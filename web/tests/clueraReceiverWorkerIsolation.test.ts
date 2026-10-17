import {createHmac} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {handleRazorpayWebhook} from '../lib/payments/webhooks/razorpay';
import {handlePaymentTick} from '../lib/payments/reconciliation/worker';
import {handleBillingTick} from '../lib/billing/reconciliation/runner';
import {handleClueraWebhook} from '../lib/payments/cluera/events';
import {handleClueraBillingTick,CLUERA_WORKER_URL} from '../lib/payments/cluera/scheduler';
import {handleClueraExternalDispatch} from '../lib/payments/cluera/externalScheduler';
import {wakeClueraBillingRelay} from '../lib/payments/cluera/wakeRelay';
import {WEB_DISPATCH_URL} from '../../shared/billingDispatch';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

const site='https://cluera-ai-staging.vercel.app';
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false',
 SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',
 SIGMAROUND_PADDLE_SANDBOX_INTAKE_ENABLED:'false',SIGMAROUND_PADDLE_SANDBOX_RECONCILIATION_ENABLED:'false',
 SIGMAROUND_PADDLE_SANDBOX_BILLING_ACTIONS_ENABLED:'false',SIGMAROUND_BILLING_WORKER_SECRET:'synthetic-isolation-worker-secret-00000000000'};
const request=(url:string)=>new Request(url,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('V2 closes legacy Cluera Razorpay receiver and workers before any RPC or provider request',async()=>{
 const rpc=vi.fn(),payment=vi.fn(),reconcile=vi.fn(),action=vi.fn(),network=vi.fn(()=>{throw Error('Unexpected real network');});vi.stubGlobal('fetch',network);
 const responses=[await handleRazorpayWebhook(request(site+'/api/payments/razorpay/test/webhook'),env,rpc),
  await handlePaymentTick(request(site+'/api/payments/reconcile'),env,rpc),
  await handleBillingTick(request(site+'/api/internal/billing/tick'),env,{rpc,payment,reconcile,action})];
 for(const response of responses){expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toBe('no-store');}
 for(const mock of [rpc,payment,reconcile,action,network])expect(mock).not.toHaveBeenCalled();
});
it.each([undefined,'false','TRUE','1'])('receiver-only phase keeps direct worker, dispatch and wake inactive (%s)',async gate=>{
 const disabled={...env,CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:gate},rpc=vi.fn(),reconcile=vi.fn(),network=vi.fn(()=>{throw Error('Unexpected network');});vi.stubGlobal('fetch',network);
 expect((await handleClueraBillingTick(request(CLUERA_WORKER_URL),disabled,{rpc,reconcile})).status).toBe(404);
 expect((await handleClueraExternalDispatch(request(WEB_DISPATCH_URL),disabled,{rpc,reconcile})).status).toBe(404);
 expect(await wakeClueraBillingRelay(disabled,network as typeof fetch)).toBe('DISABLED');
 expect(rpc).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
});
it('paused checkout permits signed durable V2 intake without dispatch or a credit writer',async()=>{
 const raw=Buffer.from(JSON.stringify({entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event:'payment.captured',created_at:Math.floor(Date.now()/1000),
  payload:{payment:{entity:{id:'pay_syntheticisolation01',order_id:'order_syntheticisolation01',invoice_id:null}}}}));
 const signature=createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex');
 const rpc=vi.fn(async()=>({data:'STORED',error:null})),stored=vi.fn(),network=vi.fn(()=>{throw Error('Unexpected network');});vi.stubGlobal('fetch',network);
 const response=await handleClueraWebhook(new Request(site+'/api/account/payments/cluera/webhook',{method:'POST',body:raw,
  headers:{'content-type':'application/json','x-razorpay-event-id':'evt_syntheticisolation01','x-razorpay-signature':signature}}),env,rpc,stored);
 expect(response.status).toBe(200);expect(await response.json()).toEqual({received:true});expect(stored).toHaveBeenCalledOnce();
 expect(rpc).toHaveBeenCalledExactlyOnceWith('cluera_billing_event_accept',expect.any(Object));
 expect(await wakeClueraBillingRelay(env,network as typeof fetch)).toBe('DISABLED');expect(network).not.toHaveBeenCalled();
});
it('V2 false retains the legacy handlers original validation and authentication',async()=>{
 const legacy={...env,CLUERA_BILLING_V2_ENABLED:'false'},rpc=vi.fn(),payment=vi.fn(),reconcile=vi.fn(),action=vi.fn();
 expect((await handleRazorpayWebhook(request(site+'/api/payments/razorpay/test/webhook'),legacy,rpc)).status).toBe(400);
 expect((await handlePaymentTick(request(site+'/api/payments/reconcile'),legacy,rpc)).status).toBe(401);
 expect((await handleBillingTick(request(site+'/api/internal/billing/tick'),legacy,{rpc,payment,reconcile,action})).status).toBe(401);
 for(const mock of [rpc,payment,reconcile,action])expect(mock).not.toHaveBeenCalled();
});
