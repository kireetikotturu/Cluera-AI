import {it,expect,vi} from 'vitest';
import {razorpayCheckoutEnabled} from '../lib/payments/core/config';
import {handleRazorpayWebhook} from '../lib/payments/webhooks/razorpay';
import {handleBillingTick} from '../lib/billing/reconciliation/runner';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
it.each([undefined,'false','TRUE'])('copied old enabled payment flags never approve Cluera rollout (%s)',async value=>{
 const env={...paymentTestEnvironment,CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:value};
 expect(razorpayCheckoutEnabled(env)).toBe(false);
 const rpc=vi.fn();
 expect((await handleRazorpayWebhook(new Request('https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook',{method:'POST',body:'{}'}),env,rpc)).status).toBe(404);
 expect((await handleBillingTick(new Request('https://cluera-ai-staging.vercel.app/api/internal/billing/tick',{method:'POST'}),env,{rpc})).status).toBe(404);
 expect(rpc).not.toHaveBeenCalled();
});
