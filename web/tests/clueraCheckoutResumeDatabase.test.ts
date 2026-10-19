import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { resumeClueraCheckout } from '../lib/payments/cluera/checkoutResume';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import type { PaymentRpc } from '../lib/payments/core/types';

// Real applied-clean PostgreSQL RPCs, in-memory only. The provider never sees
// a request; the synthetic order below models an existing untouched binding.
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'},digest=merchantDigest(env);
const account={userId:env.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:randomUUID()},admin={userId:randomUUID(),sessionId:randomUUID()};
const orderId='order_realrpcresume0001';let db:PGlite,intentId:string,revisionId:string;
const calls:string[]=[];
const rpc:PaymentRpc=async(name,args)=>{
 if(!/^cluera_billing_[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Unexpected synthetic RPC');
 calls.push(name);const entries=Object.entries(args);
 try{return {data:(await db.query<{value:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value,error:null};}
 catch(error){return {data:null,error};}
};
async function sql(name:string,args:unknown[]=[]):Promise<any>{return (await db.query<{value:unknown}>(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).rows[0].value;}
async function financialRows(){const values:Record<string,unknown>={};for(const relation of ['cluera_billing_private.intents','cluera_billing_private.events','cluera_billing_private.payments','cluera_billing_private.applications','public.customer_trial_grants','public.customer_usage_grants'])
 values[relation]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${relation} t`)).rows[0].value;return values;}
function provider(patch:Record<string,unknown>={},beforeReturn?:()=>Promise<void>){return vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
 expect(init?.method).toBe('GET');
 if(String(url).endsWith('/payments')){await beforeReturn?.();return Response.json({entity:'collection',count:0,items:[]});}
 return Response.json({id:orderId,entity:'order',amount:54900,currency:'INR',status:'created',amount_paid:0,amount_due:54900,attempts:0,receipt:intentId,
  notes:{cluera_intent:intentId,cluera_revision:revisionId,cluera_environment:'test'},offer_id:null,partial_payment:false,...patch});
});}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
},60_000);
beforeEach(async()=>{
 await db.exec('begin');calls.length=0;vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected real-network fallback');}));
 for(const value of [account,admin]){await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[value.userId,value.userId+'@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null,$3)',[value.sessionId,value.userId,value===admin?'aal2':'aal1']);await sql('customer_authorize',[value.userId,value.sessionId]);}
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[admin.userId]);await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);
 revisionId=(await sql('cluera_billing_catalog')).find((value:{offerCode:string})=>value.offerCode==='cluera_pack_3h_v2').revisionId;
 expect((await sql('cluera_billing_admin_mutate',[admin.userId,admin.sessionId,randomUUID(),'SET_ENABLED','cluera_pack_3h_v2',revisionId,new Date().toISOString(),'Synthetic existing-order recovery fixture',{enabled:true}])).code).toBe('APPLIED');
 const prepared=await sql('cluera_billing_prepare',[account.userId,account.sessionId,randomUUID(),revisionId,digest,1]);expect(prepared.code).toBe('CLAIMED');intentId=prepared.intentId;
 expect(await sql('cluera_billing_bind',[intentId,prepared.attemptId,digest,1,{orderId,subscriptionId:null}])).toBe('BOUND');
});
afterEach(async()=>{await db.exec('rollback');vi.unstubAllGlobals();});
afterAll(async()=>{await db?.close();});

it('actual clean binding PACK plan-verification=false is safely continued by exact GETs without touching financial rows',async()=>{
 const binding=await sql('cluera_billing_binding',[orderId,digest]);expect(binding.revision.testPlanValidated).toBe(false);
 const before=await financialRows(),request=provider();
 expect((await resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).orderId).toBe(orderId);
 expect(request).toHaveBeenCalledTimes(2);expect(await financialRows()).toEqual(before);
 expect(calls.every(name=>['cluera_billing_owner','cluera_billing_status','cluera_billing_binding'].includes(name))).toBe(true);expect(fetch).not.toHaveBeenCalled();
});
it('the actual existing-order flow rejects a numeric string warning without altering or replacing its BOUND record',async()=>{
 const before=await financialRows(),request=provider({amount_paid:'0'});
 await expect(resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).rejects.toThrow();expect(await financialRows()).toEqual(before);
 expect((await sql('cluera_billing_status',[account.userId,account.sessionId])).pending).toMatchObject({state:'BOUND',orderId,intentId});
});
it('a session revoked during provider reads cannot receive continuation metadata from real session-checking RPCs',async()=>{
 const before=await financialRows(),request=provider({},async()=>{await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1",[account.sessionId]);});
 await expect(resumeClueraCheckout(rpc,account,env,clueraRazorpayAdapter(env,request))).rejects.toThrow();expect(await financialRows()).toEqual(before);
});
