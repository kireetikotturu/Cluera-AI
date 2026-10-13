import {expect,it} from 'vitest';
import {assertPaymentStaging,razorpayCheckoutAllowed,razorpayCheckoutEnabled,razorpayConfig} from '../lib/payments/core/config';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

const canonical={...paymentTestEnvironment,SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ENABLED:undefined};
it('uses the existing canonical Account flag with the exact staging boundary',()=>{
 expect(()=>assertPaymentStaging(canonical)).not.toThrow();
 expect(razorpayConfig(canonical).keyId).toBe(paymentTestEnvironment.RAZORPAY_TEST_KEY_ID);
 expect(razorpayCheckoutAllowed(canonical.SIGMAROUND_PAYMENT_TESTER_IDS,canonical)).toBe(true);
});
it.each([undefined,'false','TRUE'])('the obsolete singular flag cannot replace canonical enablement (%s)',value=>{
 const env={...canonical,SIGMAROUND_ACCOUNTS_ENABLED:value,SIGMAROUND_ACCOUNT_ENABLED:'true'};
 expect(()=>assertPaymentStaging(env)).toThrow();expect(razorpayCheckoutEnabled(env)).toBe(false);
});
it.each([
 {SIGMAROUND_ACCOUNT_ORIGIN:'https://another.vercel.app'},
 {NEXT_PUBLIC_SUPABASE_URL:'https://another.supabase.co'},
 {SIGMAROUND_RAZORPAY_TEST_PROJECT_REF:'another'},
 {RAZORPAY_ENVIRONMENT:'live'},
 {RAZORPAY_TEST_KEY_ID:'rzp_live_synthetic123456'},
 {RAZORPAY_TEST_WEBHOOK_SECRET:'short'}
])('canonical enablement never bypasses staging/Test credential policy: %j',override=>{
 expect(()=>razorpayConfig({...canonical,...override})).toThrow();
 expect(razorpayCheckoutEnabled({...canonical,...override})).toBe(false);
});
it('valid private configuration does not activate disabled checkout',()=>{
 const env={...canonical,SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false'};
 expect(()=>razorpayConfig(env)).not.toThrow();expect(razorpayCheckoutEnabled(env)).toBe(false);
 expect(razorpayCheckoutAllowed(env.SIGMAROUND_PAYMENT_TESTER_IDS,env)).toBe(false);
});
