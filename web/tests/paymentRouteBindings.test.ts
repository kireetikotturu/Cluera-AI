import { beforeEach,afterEach,it,expect,vi } from 'vitest';
import { handlePaymentCheckout } from '../lib/payments/checkout/handler';
import { handleRazorpayWebhook } from '../lib/payments/webhooks/razorpay';
import { handlePaymentTick } from '../lib/payments/reconciliation/worker';
import { handleBillingTick } from '../lib/billing/reconciliation/runner';
import { POST as webhookPost } from '../app/api/payments/razorpay/test/webhook/route';
import { POST as tickPost } from '../app/api/payments/reconcile/route';
import config from '../next.config.ts';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import {renderToStaticMarkup} from 'react-dom/server';
import {AccountPricing} from '../app/AccountPricing';
beforeEach(()=>{vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED','false');vi.stubEnv('SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED','false');});
afterEach(()=>vi.unstubAllEnvs());
it('unconfigured checkout/intake/reconciliation are precise404/no-store without secrets or new operations',async()=>{
 const request=new Request('https://cluera-ai-staging.vercel.app/api/payments/reconcile',{method:'POST',body:'{}'});
 for(const handler of [handlePaymentCheckout,handleRazorpayWebhook,handlePaymentTick]){
  const response=await handler(request.clone());expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toBe('no-store');
 }
});
it('Next route context is never accidentally passed as gateway env/dependencies',async()=>{
 const request=new Request('https://cluera-ai-staging.vercel.app/api/payments/reconcile',{method:'POST',body:'{}'});
 for(const handler of [webhookPost,tickPost]){
  const call=handler as (request:Request,context:unknown)=>Promise<Response>;
  const response=await call(request.clone(),{params:Promise.resolve({})});expect(response.status).toBe(404);
 }
});
it('Razorpay resources are allowed only on enabled Account checkout; no Paddle or general wildcard added',async()=>{
 for(const [key,value] of Object.entries(paymentTestEnvironment))vi.stubEnv(key,value);
 vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','false');
 const headers=await config.headers!();const policies=headers.flatMap(h=>h.headers.filter(x=>x.key==='Content-Security-Policy').map(x=>({source:h.source,value:x.value})));
 const specific=policies.find(x=>x.source==='/account/checkout')!;expect(specific.value).toContain('https://checkout.razorpay.com');
 expect(specific.value).toContain('frame-src https://api.razorpay.com');expect(specific.value).not.toContain('*.razorpay');
 expect(specific.value).not.toContain('paddle.com');expect(policies.find(x=>x.source==='/(.*)')!.value).not.toContain('razorpay');
});
it('missing keys/Live mode do not grant checkout SDK permissions',async()=>{
 vi.stubEnv('SIGMAROUND_PAYMENT_PROVIDER','razorpay');vi.stubEnv('RAZORPAY_ENVIRONMENT','live');
 const headers=await config.headers!();expect(headers.some(h=>h.source==='/account/checkout')).toBe(false);
});
const schedulerSecret='synthetic-worker-secret-not-a-real-key-0000';
const schedulerRequest=()=>new Request('https://cluera-ai-staging.vercel.app/api/internal/billing/tick',
 {method:'POST',headers:{authorization:`Bearer ${schedulerSecret}`},body:'{}'});
it('Razorpay scheduler work is independent of absent/disabled Paddle configuration',async()=>{
 const payment=vi.fn(async()=> 'EMPTY'),reconcile=vi.fn(),action=vi.fn(),rpc=vi.fn();
 const response=await handleBillingTick(schedulerRequest(),{...paymentTestEnvironment,SIGMAROUND_BILLING_WORKER_SECRET:schedulerSecret},
  {payment,reconcile,action,rpc});
 expect(response.status).toBe(200);expect(payment).toHaveBeenCalledTimes(1);expect(reconcile).not.toHaveBeenCalled();expect(action).not.toHaveBeenCalled();
});
it('invalid legacy provider cannot block a valid Razorpay lease or run legacy financial work',async()=>{
 const payment=vi.fn(async()=> 'EMPTY'),reconcile=vi.fn(),action=vi.fn(),rpc=vi.fn();
 const response=await handleBillingTick(schedulerRequest(),{...paymentTestEnvironment,SIGMAROUND_BILLING_WORKER_SECRET:schedulerSecret,
  SIGMAROUND_PADDLE_SANDBOX_RECONCILIATION_ENABLED:'true',PADDLE_ENVIRONMENT:'live',SIGMAROUND_PADDLE_SANDBOX_BILLING_ACTIONS_ENABLED:'true'},
  {payment,reconcile,action,rpc});
 expect(response.status).toBe(200);expect(payment).toHaveBeenCalledTimes(1);expect(reconcile).not.toHaveBeenCalled();expect(action).not.toHaveBeenCalled();
});
it('disabled or wrong-target Razorpay cannot claim events when no valid provider is enabled',async()=>{
 for(const override of [{SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'},{RAZORPAY_ENVIRONMENT:'live'},
  {NEXT_PUBLIC_SUPABASE_URL:'https://another-project.supabase.co'}]){
  const payment=vi.fn(),reconcile=vi.fn(),rpc=vi.fn();
  expect((await handleBillingTick(schedulerRequest(),{...paymentTestEnvironment,...override,SIGMAROUND_BILLING_WORKER_SECRET:schedulerSecret},
   {payment,reconcile,rpc})).status).toBe(404);
  expect(payment).not.toHaveBeenCalled();expect(reconcile).not.toHaveBeenCalled();expect(rpc).not.toHaveBeenCalled();
 }
});
it('Cluera target pricing is explicitly unavailable and never loads a payment SDK',()=>{
 const html=renderToStaticMarkup(AccountPricing());
 for(const price of ['₹549','₹5,499','₹9,599','₹19,549'])expect(html).toContain(price);
 expect(html).toContain('100 hours per month');expect(html).toContain('not active payment offers');
 expect(html).toContain('No card, UPI or QR method is claimed accepted yet');
 expect(html).not.toMatch(/<script|<iframe|<form|SigmaEnterprise Weekly/);
 for(const code of ['cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2']){
  expect(html).toContain(`href="/account/checkout?offer=${code}"`);
 }
});
it('Cluera presentation is independent of old provider selection and does not alter financial policies',()=>{
 vi.stubEnv('SIGMAROUND_PAYMENT_PROVIDER','razorpay');const first=renderToStaticMarkup(AccountPricing());
 vi.stubEnv('SIGMAROUND_PAYMENT_PROVIDER','paddle');expect(renderToStaticMarkup(AccountPricing())).toBe(first);
});
