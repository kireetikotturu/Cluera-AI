import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { readClueraRecurringSnapshot } from '../lib/payments/cluera/recurringSnapshot';
import { advanceClueraRecurringSchedule, clueraRecurringAvailableMs } from '../lib/payments/cluera/recurringSchedule';
import { merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import type { PaymentRpc } from '../lib/payments/core/types';

// Internal READ projection only; native schedule writing/dispatch is not wired.
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true'},digest=merchantDigest(env);
const account={userId:randomUUID(),sessionId:randomUUID()},foreign={userId:randomUUID(),sessionId:randomUUID()};
const subscriptionId='sub_snapshotreal0001',intentId=randomUUID(),grantId=randomUUID();let db:PGlite,revisionId:string;
const proposal=readFileSync('../docs/proposals/cluera-recurring-snapshot.sql','utf8');
const rpc:PaymentRpc=async(name,args)=>{
 if(!/^cluera_billing_[a-z_]+$/.test(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Unexpected synthetic RPC');
 const entries=Object.entries(args);try{return {data:(await db.query<{value:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value,error:null};}
 catch(error){return {data:null,error};}
};
async function read(owner=account,merchant=digest,epoch=1):Promise<any>{return (await db.query<{value:unknown}>('select public.cluera_billing_recurring_snapshot($1,$2,$3,$4) value',[owner.userId,owner.sessionId,merchant,epoch])).rows[0].value;}
async function rows(){const result:Record<string,unknown>={};for(const table of ['public.customer_accounts','public.customer_trial_grants','public.customer_usage_grants','cluera_billing_private.intents','cluera_billing_private.subscriptions','cluera_billing_private.payments','cluera_billing_private.terms','cluera_billing_private.events','cluera_billing_private.applications'])
 result[table]=(await db.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]') value from ${table} t`)).rows[0].value;return result;}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));await db.exec(proposal);
 revisionId=((await db.query<{value:any[]}>('select public.cluera_billing_catalog() value')).rows[0].value).find(value=>value.offerCode==='cluera_monthly_40h_v2').revisionId;
},60_000);
beforeEach(async()=>{
 await db.exec('begin');for(const value of [account,foreign]){await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[value.userId,value.userId+'@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[value.sessionId,value.userId]);await db.query('select public.customer_authorize($1,$2)',[value.userId,value.sessionId]);}
 await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id) values($1,$2,$3,$4,$5,1,'VERIFIED',$6)",[intentId,account.userId,randomUUID(),revisionId,digest,subscriptionId]);
 await db.query("insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at,paid_through) values($1,$2,$3,$4,$5,'ACTIVE',now(),now()+interval '30 days')",[subscriptionId,account.userId,intentId,revisionId,digest]);
 await db.query("insert into public.customer_usage_grants(id,user_id,source_key,kind,granted_ms,spent_ms,reserved_ms,starts_at,expires_at,state) values($1,$2,'synthetic-monthly-snapshot','RECURRING',144000000,1000,500,now(),now()+interval '30 days','ACTIVE')",[grantId,account.userId]);
 await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,grant_id,state,period_start,period_end,paid_at) values('pay_snapshotreal0001','order_snapshotreal0001',$1,$2,'inv_snapshotreal0001',$3,549900,$4,$5,'VERIFIED',now(),now()+interval '30 days',now())",[intentId,account.userId,subscriptionId,revisionId,grantId]);
 await db.query("insert into cluera_billing_private.terms values('inv_snapshotreal0001',$1,$2,$3,'ACTIVE',now(),now()+interval '30 days',now()+interval '30 days')",[account.userId,subscriptionId,grantId]);
});
afterEach(async()=>{await db.exec('rollback');});afterAll(async()=>{await db?.close();});

it('actual clean term/grant rows project into the native engine with original price, allowance, spend and live reservations',async()=>{
 const before=await rows(),snapshot=await readClueraRecurringSnapshot(rpc,account,env);
 expect(snapshot.schedule.terms[0]).toMatchObject({invoiceId:'inv_snapshotreal0001',subscriptionId,revisionId,amountPaise:549900,grantedMs:144000000,spentMs:1000,reservedMs:500,state:'ACTIVE'});
 expect(clueraRecurringAvailableMs(snapshot.schedule)).toBe(143998500);expect(snapshot.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);expect(await rows()).toEqual(before);
});
it('snapshot digest ignores clock-only changes but changes when trusted usage attribution changes',async()=>{
 const first=await read();expect((await read()).snapshotDigest).toBe(first.snapshotDigest);
 await db.query('update public.customer_usage_grants set spent_ms=spent_ms+1 where id=$1',[grantId]);expect((await read()).snapshotDigest).not.toBe(first.snapshotDigest);
});
it('expired raw database rows cannot display spendable hours, and computing advancement still makes no financial write',async()=>{
 await db.query("update public.customer_usage_grants set starts_at=now()-interval '31 days',expires_at=now()-interval '1 day',reserved_ms=0 where id=$1",[grantId]);
 await db.exec("update cluera_billing_private.terms set period_start=now()-interval '31 days',period_end=now()-interval '1 day',ends_at=now()-interval '1 day'");
 const before=await rows(),snapshot=await readClueraRecurringSnapshot(rpc,account,env);expect(clueraRecurringAvailableMs(snapshot.schedule)).toBe(0);
 expect(advanceClueraRecurringSchedule(snapshot.schedule,snapshot.schedule.at).terms[0].state).toBe('ENDED');expect(await rows()).toEqual(before);
});
it('foreign accounts see only their empty schedule; wrong sessions, digest and epoch cannot read owner records',async()=>{
 expect((await read(foreign)).schedule.terms).toEqual([]);expect((await read({...account,sessionId:foreign.sessionId})).code).toBe('UNAUTHENTICATED');
 expect((await read(account,'b'.repeat(64))).code).toBe('UNAVAILABLE');expect((await read(account,digest,2)).code).toBe('UNAVAILABLE');
});
it('untrusted/incomplete refund provenance is not reinterpreted into a resumable Pro schedule',async()=>{
 await db.exec("update cluera_billing_private.terms set state='REFUNDED';update cluera_billing_private.payments set state='REFUNDED';update public.customer_usage_grants set state='REVOKED',reserved_ms=0");
 await expect(readClueraRecurringSnapshot(rpc,account,env)).rejects.toThrow();
});
it('proposal is SELECT-only stable/service-only with fixed search path and no runtime write/activation',async()=>{
 const body=proposal.split('as $$')[1].split('end$$;')[0];expect(body).not.toMatch(/\b(insert|update|delete|truncate|perform|execute|customer_authorize|refresh|wake_worker)\b/i);
 const metadata=(await db.query("select p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') browser,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p where p.oid='public.cluera_billing_recurring_snapshot(uuid,uuid,text,bigint)'::regprocedure")).rows[0];
 expect(metadata).toMatchObject({provolatile:'s',anon:false,browser:false,service:true});expect(metadata.proconfig).toContain('search_path=""');
});
