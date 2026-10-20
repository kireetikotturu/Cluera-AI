import { expect, it, vi } from 'vitest';
import { approvedPurchaseCatalog } from '../lib/payments/cluera/purchaseAvailability';
import { createClueraCheckout } from '../lib/payments/cluera/checkout';
import { merchantDigest } from '../lib/payments/cluera/config';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import type { Revision } from '../lib/payments/cluera/contracts';
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_RECURRING_SCHEDULE_ENABLED:'true',
 CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true'};
const offers=['cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2']as const;
const catalog:Revision[]=offers.map((offerCode,i)=>({offerCode,revisionId:`00000000-0000-4000-8000-00000000000${i}`,name:`Synthetic plan ${i}`,version:1,
 amountPaise:[54900,549900,959900,1954900][i],currency:'INR',allowanceSeconds:[10800,144000,360000,720000][i],
 kind:i?'RECURRING':'PACK',interval:i?'MONTH':null,totalCount:i?120:null,razorpayPlanId:i?`plan_synthetic000${i}`:null,enabled:true,testPlanValidated:true}));
it.each(['CLUERA_RECURRING_SCHEDULE_ENABLED','CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED','CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED','SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED'])('monthly sales require %s independently of enabled catalog rows',key=>{
 const result=approvedPurchaseCatalog(catalog,{...env,[key]:'false'});
 expect(result.map(row=>row.enabled)).toEqual([true,false,false,false]);expect(catalog.every(row=>row.enabled)).toBe(true);
});
it('Enterprise requires separate acceptance while both Pro tiers use the accepted first-subscription facility',()=>{
 expect(approvedPurchaseCatalog(catalog,env).map(row=>row.enabled)).toEqual([true,true,true,false]);
 expect(approvedPurchaseCatalog(catalog,{...env,CLUERA_ENTERPRISE_CHECKOUT_APPROVED:'true'}).every(row=>row.enabled)).toBe(true);
});
it.each([1,2,3])('blocked offer %s causes no intent, provider request, mandate or grant even with a crafted POST',async index=>{
 const accountDigest=merchantDigest(env);
 const rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>({data:name==='cluera_billing_owner'
  ?args.p_account_digest===accountDigest?{code:'ACTIVE',owner:'cluera',epoch:1}:{code:'CONFLICT'}
  :name==='cluera_billing_catalog'?catalog:null,error:null}));
 const request=vi.fn();
 await expect(createClueraCheckout(rpc,{userId:env.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:'00000000-0000-4000-8000-000000000010'},
  '00000000-0000-4000-8000-000000000011',catalog[index].revisionId,{...env,CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:'false'},clueraRazorpayAdapter(env,request))).rejects.toThrow();
 expect(request).not.toHaveBeenCalled();expect(rpc.mock.calls.map(([name])=>name)).toEqual(['cluera_billing_owner','cluera_billing_owner','cluera_billing_catalog']);
});
