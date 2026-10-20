import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { applyClueraNativeRecurringEvent, clueraNativeRecurringEnabled } from '../lib/payments/cluera/nativeRecurring';
import { dispatchClueraNativeRecurringCommand, observeClueraNativeRecurringCommand } from '../lib/payments/cluera/nativeRecurringOutbox';
import { advanceClueraRecurringSchedule } from '../lib/payments/cluera/recurringSchedule';
import { createClueraCheckout } from '../lib/payments/cluera/checkout';
import { seedHistoricalClueraCheckout } from './helpers/historicalClueraCheckout';
import { clueraRazorpayAdapter } from '../lib/payments/cluera/adapter';
import { handleClueraWebhook } from '../lib/payments/cluera/events';
import { reconcileClueraPayment } from '../lib/payments/cluera/reconciliation';
import { CLUERA_WORKER_URL, handleClueraBillingTick, workerProofMessage } from '../lib/payments/cluera/scheduler';
import { merchantDigest } from '../lib/payments/cluera/config';
import type { Binding, BillingEvidence } from '../lib/payments/cluera/contracts';
import type { PaymentRpc } from '../lib/payments/core/types';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_RECURRING_SCHEDULE_ENABLED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true',CLUERA_SUBSCRIPTION_CANCELLATION_ENABLED:'true'};
const userId=paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId=randomUUID(),digest=merchantDigest(env),day=86400000;
let db:PGlite,catalog:Binding['revision'][];
const rpc:PaymentRpc=async(name,args)=>{const entries=Object.entries(args);await db.exec('savepoint synthetic_rpc');try{const data=(await db.query<{v:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) v`,entries.map(([,value])=>value))).rows[0].v;await db.exec('release savepoint synthetic_rpc');return {data,error:null};}catch(error){await db.exec('rollback to savepoint synthetic_rpc');await db.exec('release savepoint synthetic_rpc');throw Error(`${(error as Error).message}\n${(error as {where?:string}).where??''}`);}};
async function call(name:string,args:Record<string,unknown>){const r=await rpc(name,args);if(r.error)throw r.error;return r.data as any;}
async function rows(table:string){return(await db.query(`select to_jsonb(t) v from ${table} t order by to_jsonb(t)::text`)).rows.map(x=>x.v);}
async function paid(n:number,offer='cluera_monthly_40h_v2',action:BillingEvidence['action']='GRANT'){
 const at=Date.now(),revision=catalog.find(x=>x.offerCode===offer)!,intentId=randomUUID(),subscriptionId=`sub_native${String(n).padStart(10,'0')}`;
 const binding:Binding={code:'BOUND',intentId,userId,orderId:null,subscriptionId,revision};
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id)values($1,$2,$3,$4,$5,1,'BOUND',$6)",[intentId,userId,randomUUID(),revision.revisionId,digest,subscriptionId]);
 const evidence:BillingEvidence={action,intentId,subscriptionId,invoiceId:`inv_native${String(n).padStart(10,'0')}`,orderId:`order_native${String(n).padStart(10,'0')}`,paymentId:`pay_native${String(n).padStart(10,'0')}`,
 amountPaise:revision.amountPaise,currency:'INR',periodStart:new Date(at).toISOString(),periodEnd:new Date(at+30*day).toISOString(),paidAt:new Date(at).toISOString(),observedAt:new Date(at).toISOString(),subscriptionState:'ACTIVE',cancellationAt:null,refundId:action==='REFUND'?`rfnd_native${String(n).padStart(10,'0')}`:null};
 return {binding,evidence};
}
async function receipt(e:BillingEvidence){const eventId=`evt_${randomUUID().replaceAll('-','')}`,claimId=randomUUID(),receiptDigest='a'.repeat(64);
 await db.query("insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,payment_id,order_id,subscription_id,invoice_id,digest,occurred_at,claim_id,lease_until)values($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,clock_timestamp()+interval '90 seconds')",
 [eventId,digest,e.action==='REFUND'?'refund.processed':e.action==='STATUS'?'subscription.pending':'subscription.charged',e.refundId??(e.action==='STATUS'?e.subscriptionId:e.invoiceId),e.paymentId,e.orderId,e.subscriptionId,e.invoiceId,receiptDigest,claimId]);
 return {eventId,claimId,digest:receiptDigest};}
const args=(r:{eventId:string;claimId:string;digest:string},e:BillingEvidence)=>({p_event:r.eventId,p_claim:r.claimId,p_digest:r.digest,p_account_digest:digest,p_epoch:1,p_evidence:e});
async function apply(p:Awaited<ReturnType<typeof paid>>){return applyClueraNativeRecurringEvent(rpc,await receipt(p.evidence),p.binding,p.evidence,env);}
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 await db.exec(readFileSync('../docs/proposals/cluera-subscription-cancellation.sql','utf8'));
 await db.exec(readFileSync('../docs/proposals/cluera-native-recurring.sql','utf8'));
 await db.exec(readFileSync('../docs/proposals/cluera-native-recurring-refresh.sql','utf8'));
 catalog=(await db.query<{v:Binding['revision'][]}>('select public.cluera_billing_catalog()v')).rows[0].v;
},60_000);
beforeEach(async()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No network permitted');}));await db.exec('begin');
 await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())',[userId,'native@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[sessionId,userId]);await db.query('select public.customer_authorize($1,$2)',[userId,sessionId]);
 await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);await db.exec('update cluera_billing_private.native_config set enabled=true');
});
afterEach(async()=>{await db.exec('rollback');vi.unstubAllGlobals();});afterAll(async()=>{await db?.close();});

it('environment gate and database gate both fail before initializing any native schedule or granting time',async()=>{
 expect(clueraNativeRecurringEnabled({...env,CLUERA_RECURRING_SCHEDULE_ENABLED:'false'})).toBe(false);
 const p=await paid(1),r=await receipt(p.evidence);await expect(applyClueraNativeRecurringEvent(rpc,r,p.binding,p.evidence,{...env,CLUERA_RECURRING_SCHEDULE_ENABLED:'false'})).rejects.toThrow();
 await db.exec('update cluera_billing_private.native_config set enabled=false');await expect(call('cluera_billing_native_snapshot',args(r,p.evidence))).rejects.toThrow();
 expect(await rows('cluera_billing_private.native_schedules')).toEqual([]);expect(await rows('cluera_billing_private.payments')).toEqual([]);
});
it('canonical invoice is persisted transactionally into one shared metering grant and immutable native audit',async()=>{
 const p=await paid(1);expect(await apply(p)).toBe('VERIFIED');
 expect(await rows('cluera_billing_private.payments')).toHaveLength(1);expect((await rows('public.customer_usage_grants'))[0]).toMatchObject({kind:'RECURRING',granted_ms:144000000,state:'ACTIVE'});
 expect((await rows('cluera_billing_private.native_schedules'))[0]).toMatchObject({version:1});expect(await rows('cluera_billing_private.native_audit')).toHaveLength(1);
 await expect(db.exec('delete from cluera_billing_private.native_audit')).rejects.toThrow('immutable');
});
it('same-tier funded queue retains current allowance and records unsupported reschedule REVIEW without HTTP',async()=>{
 await apply(await paid(1));const second=await paid(2,'cluera_monthly_100h_v2');expect(await apply(second)).toBe('VERIFIED');
 const grants=await rows('public.customer_usage_grants');expect(grants.map(x=>(x as any).state).sort()).toEqual(['ACTIVE','PAUSED']);
 const outbox=await rows('cluera_billing_private.native_outbox');expect(outbox).toEqual(expect.arrayContaining([expect.objectContaining({kind:'CANCEL_FUTURE',state:'PENDING'}),expect.objectContaining({kind:'RESCHEDULE',state:'REVIEW'})]));
 expect(fetch).not.toHaveBeenCalled();
});
it('Enterprise preservation keeps original allowance/spend and never rewrites trial or pack grants',async()=>{
 await apply(await paid(1));await db.exec("update public.customer_usage_grants set spent_ms=1234567 where kind='RECURRING'");
 await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,spent_ms)values($1,'synthetic-pack','PACK',7200000,1234)",[userId]);
 const pack=(await rows('public.customer_usage_grants')).find(x=>(x as any).kind==='PACK');await apply(await paid(2,'cluera_monthly_200h_v2'));
 const schedule=(await rows('cluera_billing_private.native_schedules'))[0] as any;expect(schedule.schedule.terms[0]).toMatchObject({state:'PRESERVED',spentMs:1234567,grantedMs:144000000});
 expect((await rows('public.customer_usage_grants')).find(x=>(x as any).kind==='PACK')).toEqual(pack);
});
it('active reservation is settled and reread before Enterprise preserves Pro time and immutable usage attribution',async()=>{
 await apply(await paid(1));const grant=(await rows('public.customer_usage_grants'))[0] as any,run=randomUUID();
 await db.query("insert into public.customer_usage_runs(user_id,run_id,auth_session_id,state,sequence,last_action,last_result)values($1,$2,$3,'ACTIVE',1,'START','{}')",[userId,run,sessionId]);
 await db.query("with fixture as materialized(select clock_timestamp()-interval '1 second' as fixture_at)insert into public.customer_usage_windows select $1,$2,1,$3,30000,fixture_at,fixture_at+interval '30 seconds'from fixture",[userId,run,grant.id]);
 await db.query('update public.customer_usage_grants set reserved_ms=30000 where id=$1',[grant.id]);
 expect(await apply(await paid(2,'cluera_monthly_200h_v2'))).toBe('VERIFIED');
 const preserved=(await rows('cluera_billing_private.native_schedules'))[0] as any;expect(preserved.schedule.terms[0]).toMatchObject({state:'PRESERVED',reservedMs:0});expect(preserved.schedule.terms[0].spentMs).toBeGreaterThanOrEqual(1000);
 const settlements=await rows('public.customer_usage_settlements');expect(settlements).toHaveLength(1);expect((settlements[0] as any).spent_ms+(settlements[0] as any).released_ms).toBe(30000);
});
it('verified pause/resume changes eligibility without restarting or extending the paid month',async()=>{
 const p=await paid(1);await apply(p);const initial=(await rows('public.customer_usage_grants'))[0] as any;
 for(const state of ['PAUSED','ACTIVE'] as const){const event={...p,evidence:{...p.evidence,action:'STATUS' as const,invoiceId:null,paymentId:null,orderId:null,periodStart:null,periodEnd:null,paidAt:null,subscriptionState:state,observedAt:new Date().toISOString()}};expect(await apply(event)).toBe('STATUS');
 const grant=(await rows('public.customer_usage_grants'))[0] as any;expect(grant).toMatchObject({starts_at:initial.starts_at,expires_at:initial.expires_at,granted_ms:initial.granted_ms,state:state==='PAUSED'?'PAUSED':'ACTIVE'});}
});
it('a future paid renewal is funded once, stays paused until the original next boundary and creates no provider reschedule',async()=>{
 const p=await paid(1);await apply(p);const periodStart=p.evidence.periodEnd!,periodEnd=new Date(Date.parse(periodStart)+30*day).toISOString();
 const renewal={...p,evidence:{...p.evidence,invoiceId:'inv_nativerenewal0001',paymentId:'pay_nativerenewal0001',orderId:'order_nativerenewal0001',periodStart,periodEnd,observedAt:new Date().toISOString()}};
 expect(await apply(renewal)).toBe('VERIFIED');expect((await rows('public.customer_usage_grants')).map(x=>(x as any).state).sort()).toEqual(['ACTIVE','PAUSED']);expect(await rows('cluera_billing_private.native_outbox')).toEqual([]);
});
it('a delayed expired first Enterprise invoice records revoked paid history without preempting current Pro or issuing cancellation commands',async()=>{
 await apply(await paid(1));const late=await paid(2,'cluera_monthly_200h_v2'),now=Date.now();late.evidence.periodStart=new Date(now-40*day).toISOString();late.evidence.periodEnd=new Date(now-10*day).toISOString();late.evidence.paidAt=late.evidence.periodStart;
 expect(await apply(late)).toBe('VERIFIED');const schedule=(await rows('cluera_billing_private.native_schedules'))[0] as any;expect(schedule.schedule.terms.map((x:any)=>x.state)).toEqual(['ACTIVE','ENDED']);expect(await rows('cluera_billing_private.native_outbox')).toEqual([]);
 expect((await rows('public.customer_usage_grants')).find(x=>(x as any).granted_ms===720000000)).toMatchObject({state:'REVOKED',spent_ms:0});
});
it('a funded first future invoice remains paused at its immutable original period and cannot open budget early',async()=>{
 const future=await paid(1),now=Date.now();future.evidence.periodStart=new Date(now+day).toISOString();future.evidence.periodEnd=new Date(now+31*day).toISOString();
 expect(await apply(future)).toBe('VERIFIED');expect((await rows('public.customer_usage_grants'))[0]).toMatchObject({state:'PAUSED'});expect(((await rows('cluera_billing_private.native_schedules'))[0] as any).schedule.terms[0].state).toBe('QUEUED');expect(await rows('cluera_billing_private.native_outbox')).toEqual([]);
});
it('immutable audit failure rolls back grant, payment, subscription, command and receipt application together',async()=>{
 const p=await paid(1),r=await receipt(p.evidence);await db.exec("create function cluera_billing_private.synthetic_native_audit_failure()returns trigger language plpgsql as $$begin raise exception 'Synthetic native audit failure';end$$;create trigger synthetic_native_audit_failure before insert on cluera_billing_private.native_audit for each row execute function cluera_billing_private.synthetic_native_audit_failure()");
 await expect(applyClueraNativeRecurringEvent(rpc,r,p.binding,p.evidence,env)).rejects.toThrow('Synthetic native audit failure');
 for(const name of ['public.customer_usage_grants','cluera_billing_private.payments','cluera_billing_private.subscriptions','cluera_billing_private.terms','cluera_billing_private.applications','cluera_billing_private.native_outbox'])expect(await rows(name)).toEqual([]);
 expect((await rows('cluera_billing_private.events'))[0]).toMatchObject({state:'PENDING'});expect((await rows('cluera_billing_private.intents'))[0]).toMatchObject({state:'BOUND'});
});
it('refund before capture creates a grantless tombstone and later captured receipt cannot mint or preempt time',async()=>{
 const p=await paid(1,'cluera_monthly_40h_v2','REFUND');expect(await apply(p)).toBe('REFUNDED');expect(await rows('public.customer_usage_grants')).toEqual([]);
 const capture={...p,evidence:{...p.evidence,action:'GRANT' as const,refundId:null,observedAt:new Date().toISOString()}};
 expect(await apply(capture)).toBe('VERIFIED');expect(await rows('public.customer_usage_grants')).toEqual([]);expect((await rows('cluera_billing_private.payments'))[0]).toMatchObject({state:'REFUNDED',grant_id:null});
});
it('live spend/reservation races invalidate optimistic plans, and stale merchant/epoch/receipt claims cannot commit',async()=>{
 const p=await paid(1);await apply(p);const r=await receipt(p.evidence),a=args(r,p.evidence),snap=await call('cluera_billing_native_snapshot',a);
 await db.exec('update public.customer_usage_grants set spent_ms=1000');
 expect(await call('cluera_billing_native_commit',{...a,p_expected_version:snap.version,p_expected_digest:snap.snapshotDigest,p_plan:snap.schedule})).toEqual({code:'CONFLICT'});
 for(const altered of [{p_epoch:2},{p_account_digest:'b'.repeat(64)},{p_claim:randomUUID()}])await expect(call('cluera_billing_native_snapshot',{...a,...altered})).rejects.toThrow();
});
it('a real STATUS receipt cannot extend paid expiry/paidThrough, invent a refund or alter preserved entitlement duration',async()=>{
 const p=await paid(1);await apply(p);
 const evidence:BillingEvidence={...p.evidence,action:'STATUS',invoiceId:null,paymentId:null,orderId:null,periodStart:null,periodEnd:null,paidAt:null,subscriptionState:'ACTIVE',observedAt:new Date().toISOString()};
 const r=await receipt(evidence),a=args(r,evidence),snapshot=await call('cluera_billing_native_snapshot',a),before=await rows('public.customer_usage_grants');
 for(const mutate of [(plan:any)=>{plan.terms[0].endsAt+=365*day;plan.subscriptions[0].paidThrough+=365*day;},(plan:any)=>{plan.terms[0].state='REFUNDED';plan.terms[0].closedAt=plan.at;},(plan:any)=>{plan.terms[0].grantedMs+=1000;}]){
 const plan=structuredClone(snapshot.schedule);mutate(plan);await expect(call('cluera_billing_native_commit',{...a,p_expected_version:snapshot.version,p_expected_digest:snapshot.snapshotDigest,p_plan:plan})).rejects.toThrow();}
 expect(await rows('public.customer_usage_grants')).toEqual(before);expect((await rows('cluera_billing_private.payments'))[0]).toMatchObject({state:'VERIFIED'});
});
it('later duplicate GRANT and existing-invoice full refund preserve exactly-once grant identity and spent attribution',async()=>{
 const p=await paid(1);await apply(p);await db.exec('update public.customer_usage_grants set spent_ms=1234');
 const later={...p,evidence:{...p.evidence,observedAt:new Date().toISOString()}};expect(await apply(later)).toBe('VERIFIED');expect(await rows('public.customer_usage_grants')).toHaveLength(1);
 const refund={...later,evidence:{...later.evidence,action:'REFUND' as const,refundId:'rfnd_nativeexisting01',observedAt:new Date().toISOString()}};expect(await apply(refund)).toBe('REFUNDED');
 expect((await rows('public.customer_usage_grants'))[0]).toMatchObject({spent_ms:1234,granted_ms:144000000,state:'REVOKED'});
});
it('feature-disable after unknown retains cross-protocol cancellation fence',async()=>{
 await apply(await paid(1));await apply(await paid(2));const claim=await call('cluera_billing_native_command_claim',{p_account_digest:digest,p_epoch:1});
 await call('cluera_billing_native_command_finish',{p_id:claim.commandId,p_claim:claim.claimId,p_account_digest:digest,p_epoch:1,p_evidence:null});
 await db.exec('update cluera_billing_private.native_config set enabled=false');
 await expect(call('cluera_billing_cancel_prepare',{p_user:userId,p_session:sessionId,p_operation:randomUUID(),p_subscription:claim.subscriptionId,p_account_digest:digest,p_epoch:1})).rejects.toThrow('already retained');
});
it('expired command leases become UNCERTAIN forever and reschedule REVIEW never becomes dispatchable',async()=>{
 await apply(await paid(1));await apply(await paid(2));const a={p_account_digest:digest,p_epoch:1},claim=await call('cluera_billing_native_command_claim',a);expect(claim.code).toBe('CLAIMED');
 await db.exec("update cluera_billing_private.native_outbox set lease_until=clock_timestamp()-interval '1 second'where state='CLAIMED'");
 expect(await call('cluera_billing_native_command_claim',a)).toEqual({code:'EMPTY'});expect((await rows('cluera_billing_private.native_outbox')).some(x=>(x as any).state==='UNCERTAIN')).toBe(true);
});
it('command acknowledgement and terminal observation never change paid grants or invoice periods',async()=>{
 await apply(await paid(1));await apply(await paid(2));const before=await rows('public.customer_usage_grants'),a={p_account_digest:digest,p_epoch:1},claim=await call('cluera_billing_native_command_claim',a);
 const finish={...a,p_id:claim.commandId,p_claim:claim.claimId};expect(await call('cluera_billing_native_command_finish',{...finish,p_evidence:{subscriptionId:claim.subscriptionId,providerState:'active',observedAt:new Date().toISOString()}})).toBe('ACCEPTED');
 expect(await call('cluera_billing_native_command_finish',{...finish,p_evidence:{subscriptionId:claim.subscriptionId,providerState:'cancelled',observedAt:new Date().toISOString()}})).toBe('DONE');expect(await rows('public.customer_usage_grants')).toEqual(before);
});
it('prepared outbox caller makes one supported mutation, refuses unknown replay, and reconciles by GET only',async()=>{
 await apply(await paid(1));await apply(await paid(2));const before=await rows('public.customer_usage_grants');
 const gateway={cancelFuture:vi.fn(async()=>{throw Error('Synthetic unknown POST');}),cancellationStatus:vi.fn(async(binding:Binding)=>({subscriptionId:binding.subscriptionId!,providerState:'cancelled' as const,observedAt:new Date().toISOString()}))};
 expect(await dispatchClueraNativeRecurringCommand(rpc,env,gateway)).toBe('UNCERTAIN');expect(await dispatchClueraNativeRecurringCommand(rpc,env,gateway)).toBe('EMPTY');
 expect(await observeClueraNativeRecurringCommand(rpc,env,gateway)).toBe('DONE');expect(gateway.cancelFuture).toHaveBeenCalledTimes(1);expect(gateway.cancellationStatus).toHaveBeenCalledTimes(1);expect(await rows('public.customer_usage_grants')).toEqual(before);
});
it('unknown physical recurring terms inserted outside the native writer are rejected before any projection',async()=>{
 const p=await paid(1);await apply(p);const fresh=await paid(2);
 await db.query("insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at)values($1,$2,$3,$4,$5,'ACTIVE',now())",[fresh.binding.subscriptionId,userId,fresh.binding.intentId,fresh.binding.revision.revisionId,digest]);
 await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,state,period_start,period_end,paid_at)values('pay_foreignwriter01','order_foreignwriter01',$1,$2,'inv_foreignwriter01',$3,549900,$4,'REFUNDED',now(),now()+interval '30 days',now())",[fresh.binding.intentId,userId,fresh.binding.subscriptionId,fresh.binding.revision.revisionId]);
 // Even unknown paid metadata cannot be silently overwritten by the
 // native projection; existing source routing remains a pre-activation gate.
 await db.query("insert into cluera_billing_private.terms values('inv_foreignwriter01',$1,$2,null,'REFUNDED',now(),now()+interval '30 days',now()+interval '30 days')",[userId,fresh.binding.subscriptionId]);
 await expect(apply(fresh)).rejects.toThrow('routing requires review');
});
it('usage refresh activates a funded queue at the original historical boundary with unchanged allowance and spend',async()=>{
 await apply(await paid(1));await apply(await paid(2,'cluera_monthly_100h_v2'));
 const original=(await rows('cluera_billing_private.native_schedules'))[0] as any,shift=31*day;
 // Synthetic clock fixture moves all paid resources together. No hosted data
 // or provider clock is modified; the usage RPC then uses actual database now.
 const schedule=structuredClone(original.schedule);schedule.at-=shift;
 for(const term of schedule.terms)for(const key of ['periodStart','periodEnd','paidAt','startsAt','endsAt','closedAt'])if(term[key]!==null)term[key]-=shift;
 for(const sub of schedule.subscriptions){sub.paidThrough-=shift;if(sub.graceUntil!==null)sub.graceUntil-=shift;if(sub.cancellationAt!==null)sub.cancellationAt-=shift;if(sub.stopRequestedAt!==null)sub.stopRequestedAt-=shift;}
 for(const action of schedule.actions)if(action.at!==null){action.at-=shift;action.key=`${action.subscriptionId}:${action.kind}:${action.at}`;}
 await db.query('update cluera_billing_private.native_schedules set schedule=$1 where user_id=$2',[schedule,userId]);
 await db.query("update cluera_billing_private.payments set period_start=period_start-$1::bigint*interval '1 millisecond',period_end=period_end-$1::bigint*interval '1 millisecond',paid_at=paid_at-$1::bigint*interval '1 millisecond'",[shift]);
 await db.query("update cluera_billing_private.terms set period_start=period_start-$1::bigint*interval '1 millisecond',period_end=period_end-$1::bigint*interval '1 millisecond',ends_at=ends_at-$1::bigint*interval '1 millisecond'",[shift]);
 await db.query("update public.customer_usage_grants set starts_at=starts_at-$1::bigint*interval '1 millisecond',expires_at=expires_at-$1::bigint*interval '1 millisecond',spent_ms=1234",[shift]);
 // Turn off new processing: already funded native usage must retain its policy.
 await db.exec('update cluera_billing_private.native_config set enabled=false');
 await db.query('select public.customer_usage_balance($1,$2)',[userId,sessionId]);
 const saved=(await rows('cluera_billing_private.native_schedules'))[0] as any,expected=advanceClueraRecurringSchedule({...schedule,terms:schedule.terms.map((x:any)=>({...x,spentMs:1234}))},saved.schedule.at);
 expect(saved.schedule).toEqual(expected);expect(saved.schedule.terms[1]).toMatchObject({state:'ACTIVE',spentMs:1234,startsAt:schedule.terms[0].endsAt,endsAt:schedule.terms[0].endsAt+30*day});
 expect((await rows('public.customer_usage_grants')).filter(x=>(x as any).state==='ACTIVE')).toHaveLength(1);
});
it('prepared service functions are unavailable to browser roles and all new relations have RLS with no direct service table writes',async()=>{
 const functions=await db.query<{anon:boolean;browser:boolean;service:boolean;proconfig:string[]}>("select has_function_privilege('anon',oid,'EXECUTE')anon,has_function_privilege('authenticated',oid,'EXECUTE')browser,has_function_privilege('service_role',oid,'EXECUTE')service,proconfig from pg_proc where pronamespace='public'::regnamespace and proname like 'cluera_billing_native_%'");
 expect(functions.rows).toHaveLength(7);for(const f of functions.rows){expect(f).toMatchObject({anon:false,browser:false,service:true});expect(f.proconfig).toContain('search_path=""');}
 expect((await db.query("select bool_and(relrowsecurity) v from pg_class where relnamespace='cluera_billing_private'::regnamespace and relkind='r'and relname like 'native_%'")).rows[0].v).toBe(true);
});

it.each([true,false])('actual checkout → signed webhook → signed worker retains the native=%s runtime boundary and blocks unsupported competing CREATE',async(native)=>{
 const revisionId=randomUUID(),planId='plan_nativeflow0001',subscriptionId='sub_nativeflow0001',invoiceId='inv_nativeflow0001',orderId='order_nativeflow0001',paymentId='pay_nativeflow0001';
 await db.query("insert into cluera_billing_private.catalog_revisions(id,offer_code,version,name,amount_paise,allowance_seconds,kind,interval_name,razorpay_plan_id,total_count)values($1,'cluera_monthly_40h_v2',2,'Synthetic native monthly',549900,144000,'RECURRING','MONTH',$2,120)",[revisionId,planId]);
 expect(await call('cluera_billing_plan_verify',{p_revision:revisionId,p_account_digest:digest,p_evidence:{planId,period:'monthly',interval:1,amountPaise:549900,currency:'INR',observedAt:new Date().toISOString()}})).toBe('VERIFIED');
 await db.query("update cluera_billing_private.catalog_heads set revision_id=$1,enabled=true where offer_code='cluera_monthly_40h_v2'",[revisionId]);
 if(!native)await db.exec('update cluera_billing_private.native_config set enabled=false');
 const seconds=Math.floor(Date.now()/1000),secret='synthetic-native-worker-secret-0000000000000000',testEnv={...env,CLUERA_RECURRING_SCHEDULE_ENABLED:native?'true':undefined,SIGMAROUND_BILLING_WORKER_SECRET:secret},flowRpc=vi.fn(rpc);
 let notes:Record<string,string>={},captured=false,terminal=false;
 const resource=()=>({id:subscriptionId,entity:'subscription',plan_id:planId,status:terminal?'cancelled':captured?'active':'created',quantity:1,total_count:120,notes,paid_count:captured?1:0,customer_id:captured?'cust_nativeflow0001':null,has_scheduled_changes:false,ended_at:terminal?Math.floor(Date.now()/1000):null});
 const provider=vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
 const url=new URL(String(input));expect(url.origin).toBe('https://api.razorpay.com');
 if(init?.method==='POST'){if(url.pathname.endsWith('/cancel')){expect(JSON.parse(String(init.body))).toEqual({cancel_at_cycle_end:true});return Response.json(resource());}
 expect(url.pathname).toBe('/v1/subscriptions');notes=JSON.parse(String(init.body)).notes;return Response.json(resource());}
 expect(init?.method).toBe('GET');
 if(url.pathname.startsWith('/v1/plans/'))return Response.json({id:planId,entity:'plan',period:'monthly',interval:1,item:{amount:549900,currency:'INR',active:true}});
 if(url.pathname.startsWith('/v1/subscriptions/'))return Response.json(resource());
 if(url.pathname.startsWith('/v1/orders/'))return Response.json({id:orderId,entity:'order',amount:549900,currency:'INR',status:'paid',amount_paid:549900,amount_due:0,attempts:1,receipt:null,notes,partial_payment:false,offer_id:null});
 if(url.pathname.startsWith('/v1/payments/'))return Response.json({id:paymentId,entity:'payment',order_id:orderId,invoice_id:invoiceId,amount:549900,currency:'INR',status:'captured',captured:true,amount_refunded:0,refund_status:null,international:false,method:'card',card:{network:'Visa'}});
 if(url.pathname==='/v1/invoices')return Response.json({entity:'collection',count:1,items:[{id:invoiceId,subscription_id:subscriptionId}]});
 if(url.pathname.startsWith('/v1/invoices/'))return Response.json({id:invoiceId,entity:'invoice',subscription_id:subscriptionId,order_id:orderId,payment_id:paymentId,customer_id:'cust_nativeflow0001',status:'paid',currency:'INR',amount:549900,amount_paid:549900,amount_due:0,gross_amount:549900,tax_amount:0,partial_payment:false,billing_start:seconds,billing_end:seconds+30*86400,paid_at:seconds,
 line_items:[{type:'plan',amount:549900,unit_amount:549900,gross_amount:549900,net_amount:549900,tax_amount:0,currency:'INR',quantity:1,taxes:[]}]});
 throw Error('Unexpected synthetic native provider path');}) as typeof fetch;
 vi.stubGlobal('fetch',provider);
 if(!native){
  await expect(createClueraCheckout(flowRpc,{userId,sessionId},randomUUID(),revisionId,testEnv,clueraRazorpayAdapter(testEnv,provider))).rejects.toThrow();
  expect(provider).not.toHaveBeenCalled();expect(await rows('cluera_billing_private.intents')).toEqual([]);
 }
 const bound=native?await createClueraCheckout(flowRpc,{userId,sessionId},randomUUID(),revisionId,testEnv,clueraRazorpayAdapter(testEnv,provider))
  :await seedHistoricalClueraCheckout(flowRpc,{userId,sessionId},randomUUID(),revisionId,testEnv,clueraRazorpayAdapter(testEnv,provider));
 expect(bound.code).toBe('BOUND');expect(await rows('public.customer_usage_grants')).toEqual([]);
 captured=true;const raw=Buffer.from(JSON.stringify({entity:'event',account_id:env.RAZORPAY_TEST_ACCOUNT_ID,event:'subscription.charged',created_at:seconds,payload:{subscription:{entity:{id:subscriptionId}},payment:{entity:{id:paymentId,order_id:orderId,invoice_id:invoiceId}}}}));
 const webhook=new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook',{method:'POST',headers:{'content-type':'application/json','x-razorpay-event-id':'evt_nativeactualflow01','x-razorpay-signature':createHmac('sha256',env.RAZORPAY_TEST_WEBHOOK_SECRET).update(raw).digest('hex')},body:raw});
 expect((await handleClueraWebhook(webhook,testEnv,flowRpc)).status).toBe(200);expect(await rows('public.customer_usage_grants')).toEqual([]);
 const tick=()=>{const at=Math.floor(Date.now()/1000),nonce=randomUUID(),proof=createHmac('sha256',secret).update(workerProofMessage(1,at,nonce,digest)).digest('hex');return handleClueraBillingTick(new Request(CLUERA_WORKER_URL,{method:'POST',headers:{'content-type':'application/json','x-cluera-billing-time':String(at),'x-cluera-billing-nonce':nonce,'x-cluera-billing-epoch':'1','x-cluera-billing-proof':proof},body:'{}'}),testEnv,{rpc:flowRpc,reconcile:(r,e)=>reconcileClueraPayment(r,e,provider)});};
 expect((await tick()).status).toBe(200);expect((await rows('public.customer_usage_grants'))[0]).toMatchObject({granted_ms:144000000,state:'ACTIVE'});
 if(!native){expect(await rows('cluera_billing_private.native_schedules')).toEqual([]);expect(flowRpc.mock.calls.some(([name])=>name.startsWith('cluera_billing_native_'))).toBe(false);return;}
 expect((await rows('cluera_billing_private.native_schedules'))[0]).toMatchObject({version:1});
 const posts=vi.mocked(provider).mock.calls.filter(([,init])=>init?.method==='POST').length,intents=await rows('cluera_billing_private.intents');
 await expect(createClueraCheckout(rpc,{userId,sessionId},randomUUID(),revisionId,testEnv,clueraRazorpayAdapter(testEnv,provider))).rejects.toThrow();
 expect(vi.mocked(provider).mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(posts);expect(await rows('cluera_billing_private.intents')).toEqual(intents);
 expect(await call('cluera_billing_prepare',{p_user:userId,p_session:sessionId,p_request:randomUUID(),p_revision:revisionId,p_account_digest:digest,p_epoch:1})).toEqual({code:'REVIEW'});
 // Already-funded conflicting evidence still conserves purchased time, while
 // unsupported new competing sales above are preblocked before provider CREATE.
 await apply(await paid(2,'cluera_monthly_100h_v2'));const finances=await rows('public.customer_usage_grants');expect((await tick()).status).toBe(200);
 expect((await rows('cluera_billing_private.native_outbox')).some(x=>(x as any).state==='ACCEPTED')).toBe(true);terminal=true;
 await db.exec("update cluera_billing_private.native_outbox set observed_at=clock_timestamp()-interval '2 minutes'where state='ACCEPTED'");expect((await tick()).status).toBe(200);
 expect((await rows('cluera_billing_private.native_outbox')).some(x=>(x as any).state==='DONE')).toBe(true);expect(vi.mocked(provider).mock.calls.filter(([url,init])=>String(url).endsWith('/cancel')&&init?.method==='POST')).toHaveLength(1);expect(await rows('public.customer_usage_grants')).toEqual(finances);
});
