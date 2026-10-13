import {describe,it,expect} from 'vitest';
import {sandboxCheckoutAllowed,sandboxCheckoutEnabled} from '../lib/billing/checkout/gate';
const uid='00000000-0000-4000-8000-000000000001';
const env={CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
 NEXT_PUBLIC_SUPABASE_URL:'https://dwqltsqumiwsxtkzdoaa.supabase.co',SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'dwqltsqumiwsxtkzdoaa',
 SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'true',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'false',NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'test_syntheticpublic000000',
 SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:uid};
describe('fail-closed designated Sandbox tester gate',()=>{
 it('requires exact verified UUID, never email or arbitrary account metadata',()=>{
  expect(sandboxCheckoutAllowed(uid,env)).toBe(true);
  for(const identity of ['tester@example.invalid','admin','00000000-0000-4000-8000-000000000002','*'])expect(sandboxCheckoutAllowed(identity,env)).toBe(false);
 });
 it('rejects empty/malformed/oversized/wildcard lists rather than partially permitting valid entries',()=>{
  for(const list of ['',`${uid},*`,`${uid},`,`${uid},tester@example.invalid`,'a'.repeat(4097),Array(51).fill(uid).join(',')]){
   expect(sandboxCheckoutEnabled({...env,SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:list})).toBe(false);
  }
  expect(sandboxCheckoutAllowed(uid,{...env,SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS:` ${uid}, ${uid} `})).toBe(true);
 });
 it('preserves the global kill switch, explicit opt-in, Sandbox token and exact staging boundaries',()=>{
  for(const change of [{SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true'},{SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:undefined},
   {SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:'false'},{NEXT_PUBLIC_PADDLE_CLIENT_TOKEN:'live_syntheticpublic000000'},
   {PADDLE_ENVIRONMENT:'live'},{NEXT_PUBLIC_SUPABASE_URL:'https://bzccuqforilpifhiysjk.supabase.co'}])expect(sandboxCheckoutAllowed(uid,{...env,...change})).toBe(false);
 });
});
