import {readFileSync}from'node:fs';
import {randomUUID}from'node:crypto';
import {PGlite}from'@electric-sql/pglite';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi}from'vitest';
import {applyClueraNativeRecurringEvent}from'../lib/payments/cluera/nativeRecurring';
import {readClueraBillingHistory}from'../lib/payments/cluera/history';
import {clueraBillingHistorySchema}from'../lib/payments/cluera/historyContracts';
import {merchantDigest}from'../lib/payments/cluera/config';
import type{Binding,BillingEvidence}from'../lib/payments/cluera/contracts';
import type{PaymentRpc}from'../lib/payments/core/types';
import {paymentTestEnvironment}from'./helpers/paymentTestMode';

const day=86400000,account={userId:paymentTestEnvironment.SIGMAROUND_PAYMENT_TESTER_IDS,sessionId:randomUUID()},foreign={userId:randomUUID(),sessionId:randomUUID()};
const env={...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_RECURRING_SCHEDULE_ENABLED:'true',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'true'};
const readEnv={...env,CLUERA_NATIVE_RECURRING_HISTORY_ENABLED:'true',CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED:'false'};
const digest=merchantDigest(env),proposal=readFileSync('../docs/proposals/cluera-native-recurring-history.sql','utf8');
let db:PGlite,catalog:Binding['revision'][];
const rpc:PaymentRpc=async(name,args)=>{const entries=Object.entries(args);return{data:(await db.query<{v:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')})v`,entries.map(([,value])=>value))).rows[0].v,error:null};};
async function call(owner=account,d=digest,epoch=1){return(await db.query<{v:any}>('select public.cluera_billing_native_history($1,$2,$3,$4)v',[owner.userId,owner.sessionId,d,epoch])).rows[0].v;}
async function rows(table:string){return(await db.query(`select to_jsonb(t)v from ${table} t order by to_jsonb(t)::text`)).rows.map(row=>row.v);}
async function preservedRows(){const result:Record<string,unknown>={};for(const name of['auth.users','auth.sessions','public.customer_accounts','public.customer_trial_grants','public.customer_usage_grants','public.customer_usage_runs','public.customer_usage_windows','public.customer_usage_settlements','cluera_billing_private.intents','cluera_billing_private.payments','cluera_billing_private.subscriptions','cluera_billing_private.terms','cluera_billing_private.events','cluera_billing_private.applications','cluera_billing_private.native_config','cluera_billing_private.native_schedules','cluera_billing_private.native_outbox','cluera_billing_private.native_audit'])result[name]=await rows(name);return result;}
async function funded(n:number,offer='cluera_monthly_40h_v2',start=Date.now()-10*day,owner=account,refund=false){
 const revision=catalog.find(row=>row.offerCode===offer)!,intentId=randomUUID(),subscriptionId=`sub_nativehistory${String(n).padStart(8,'0')}`,invoiceId=`inv_nativehistory${String(n).padStart(8,'0')}`;
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id)values($1,$2,$3,$4,$5,1,'BOUND',$6)",[intentId,owner.userId,randomUUID(),revision.revisionId,digest,subscriptionId]);
 const binding:Binding={code:'BOUND',intentId,userId:owner.userId,orderId:null,subscriptionId,revision};
 const evidence:BillingEvidence={action:refund?'REFUND':'GRANT',intentId,subscriptionId,invoiceId,paymentId:`pay_nativehistory${String(n).padStart(8,'0')}`,orderId:`order_nativehistory${String(n).padStart(8,'0')}`,amountPaise:revision.amountPaise,currency:'INR',observedAt:new Date().toISOString(),periodStart:new Date(start).toISOString(),periodEnd:new Date(start+30*day).toISOString(),paidAt:new Date(start).toISOString(),subscriptionState:'ACTIVE',cancellationAt:null,refundId:refund?`rfnd_nativehistory${String(n).padStart(8,'0')}`:null};
 const receipt={eventId:`evt_${randomUUID().replaceAll('-','')}`,claimId:randomUUID(),digest:'b'.repeat(64)};
 await db.query("insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,payment_id,order_id,subscription_id,invoice_id,digest,occurred_at,claim_id,lease_until)values($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),$10,clock_timestamp()+interval '90 seconds')",[receipt.eventId,digest,refund?'refund.processed':'subscription.charged',evidence.refundId??subscriptionId,evidence.paymentId,evidence.orderId,subscriptionId,invoiceId,receipt.digest,receipt.claimId]);
 await applyClueraNativeRecurringEvent(rpc,receipt,binding,evidence,{...env,SIGMAROUND_PAYMENT_TESTER_IDS:owner.userId});return{binding,evidence};
}
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
 for(const path of['supabase/migrations/20261016014532_cluera_clean_foundation.sql','supabase/migrations/20261019085323_cluera_customer_billing_history.sql','docs/proposals/cluera-native-recurring.sql','docs/proposals/cluera-native-recurring-refresh.sql','docs/proposals/cluera-native-recurring-history.sql'])await db.exec(readFileSync('../'+path,'utf8'));
 catalog=(await db.query<{v:Binding['revision'][]}>('select public.cluera_billing_catalog()v')).rows[0].v;
},60000);
beforeEach(async()=>{vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No hosted request permitted');}));await db.exec('begin');for(const owner of[account,foreign]){await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())',[owner.userId,owner.userId+'@example.invalid']);await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[owner.sessionId,owner.userId]);await db.query('select public.customer_authorize($1,$2)',[owner.userId,owner.sessionId]);}await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);await db.exec('update cluera_billing_private.native_config set enabled=true');});
afterEach(async()=>{await db.exec('rollback');vi.unstubAllGlobals();});afterAll(async()=>{await db?.close();});

it('actual paid Pro→Enterprise→queued Pro projection exposes saved calendar window separately from spendable allowance without refreshing or mutating any row',async()=>{
 await funded(1);await db.exec("update public.customer_usage_grants set spent_ms=3600000 where kind='RECURRING'");await funded(2,'cluera_monthly_200h_v2',Date.now());await funded(3,'cluera_monthly_100h_v2',Date.now());
 expect((await rows('cluera_billing_private.terms')).find(x=>(x as any).invoice_id==='inv_nativehistory00000001')).toMatchObject({state:'ENDED'});
 const before=await preservedRows(),history=await readClueraBillingHistory(rpc,account,readEnv),terms=history.nativeSchedule!.terms;
 expect(terms.map(row=>row.state)).toEqual(['QUEUED','ACTIVE','PRESERVED']);
 const saved=terms.find(row=>row.state==='PRESERVED')!;expect(saved).toMatchObject({spendableMilliseconds:0,remainingAllowanceMilliseconds:39*3600000,spentMilliseconds:3600000,reservedMilliseconds:0,startsAt:null,endsAt:null});expect(saved.savedWallMilliseconds).toBeGreaterThan(19*day);expect(saved.savedWallMilliseconds).toBeLessThanOrEqual(20*day);
 expect(terms[0]).toMatchObject({spendableMilliseconds:0,savedWallMilliseconds:30*day,remainingAllowanceMilliseconds:100*3600000});expect(terms[1].spendableMilliseconds).toBe(200*3600000);
 expect(await preservedRows()).toEqual(before);expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(history.nativeSchedule)).not.toMatch(/claim|account_digest|plan_|secret|evidence|action_key|customer_id|https?:/i);
});
it('separate presentation gate defaults off and leaves the current history RPC and DTO unchanged',async()=>{
 await funded(1);const tracked=vi.fn(rpc),history=await readClueraBillingHistory(tracked,account,env);expect(history.nativeSchedule).toBeUndefined();expect(tracked).toHaveBeenCalledExactlyOnceWith('cluera_billing_history',{p_user:account.userId,p_session:account.sessionId});
});
it('live grant counters override stale stored JSON while an expired recorded active window contributes zero and makes no expiry refresh',async()=>{
 await funded(1);await db.exec('update public.customer_usage_grants set spent_ms=1234,reserved_ms=500');const before=await preservedRows(),value=clueraBillingHistorySchema.parse(await call());expect(value.nativeSchedule!.terms[0]).toMatchObject({spentMilliseconds:1234,reservedMilliseconds:500,spendableMilliseconds:144000000-1734});expect(await preservedRows()).toEqual(before);
 await db.exec("update public.customer_usage_grants set starts_at=now()-interval '31 days',expires_at=now()-interval '1 day'");const expiredBefore=await preservedRows();expect((await call()).nativeSchedule.terms[0].spendableMilliseconds).toBe(0);expect(await preservedRows()).toEqual(expiredBefore);
});
it('verified session, active customer, pinned merchant and current epoch independently fence the projection, with no foreign owner rows',async()=>{
 await funded(1);await funded(2,'cluera_monthly_100h_v2',Date.now(),foreign);const own=await call(),other=await call(foreign);expect(own.nativeSchedule.terms).toHaveLength(1);expect(other.nativeSchedule.terms).toHaveLength(1);expect(JSON.stringify(own)).not.toContain('00000002');
 expect((await call({...account,sessionId:foreign.sessionId})).code).toBe('UNAUTHENTICATED');expect((await call(account,'f'.repeat(64))).code).toBe('UNAVAILABLE');expect((await call(account,digest,2)).code).toBe('UNAVAILABLE');
 await db.query("update public.customer_accounts set state='SUSPENDED'where user_id=$1",[account.userId]);expect((await call()).code).toBe('FORBIDDEN');
});
it('malformed spendable/saved/allowance/duplicate or secret-bearing native DTOs cannot reach the customer',async()=>{
 await funded(1);await funded(2,'cluera_monthly_200h_v2',Date.now());const value=await call(),saved=value.nativeSchedule.terms.find((x:any)=>x.state==='PRESERVED');
 for(const patch of[{spendableMilliseconds:1},{savedWallMilliseconds:0},{remainingAllowanceMilliseconds:999},{secret:'private'},{state:'ENDED',reservedMilliseconds:1}]){
 const changed=structuredClone(value);changed.nativeSchedule.terms=[{...saved,...patch}];expect(clueraBillingHistorySchema.safeParse(changed).success).toBe(false);}
 expect(clueraBillingHistorySchema.safeParse({...value,nativeSchedule:{...value.nativeSchedule,terms:[saved,saved]}}).success).toBe(false);
});
it('missing native-to-physical provenance fails closed instead of silently hiding a saved invoice',async()=>{
 await funded(1);await db.exec("update cluera_billing_private.native_schedules set schedule=jsonb_set(schedule,'{terms,0,paymentId}','\"pay_untrustedrelation01\"')");expect((await call()).code).toBe('UNAVAILABLE');
});
it('bounds customer native periods at50 with explicit truncation and permanently zero-spendable refunded tombstones',async()=>{
 const p=await funded(1,'cluera_monthly_40h_v2',Date.now()-10*day,account,true),native=(await rows('cluera_billing_private.native_schedules'))[0]as any,schedule=structuredClone(native.schedule),first=schedule.terms[0];
 for(let n=2;n<=52;n++){
 const suffix=String(n).padStart(8,'0'),term={...first,invoiceId:`inv_nativehistory${suffix}`,paymentId:`pay_nativehistory${suffix}`,orderId:`order_nativehistory${suffix}`,sequence:n,periodStart:first.periodStart-n*30*day,periodEnd:first.periodEnd-n*30*day,paidAt:first.paidAt-n*30*day};
 await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,state,period_start,period_end,paid_at)values($1,$2,$3,$4,$5,$6,549900,$7,'REFUNDED',$8,$9,$8)",[term.paymentId,term.orderId,p.binding.intentId,account.userId,term.invoiceId,p.binding.subscriptionId,p.binding.revision.revisionId,new Date(term.periodStart).toISOString(),new Date(term.periodEnd).toISOString()]);
 await db.query("insert into cluera_billing_private.terms values($1,$2,$3,null,'REFUNDED',$4,$5,$5)",[term.invoiceId,account.userId,p.binding.subscriptionId,new Date(term.periodStart).toISOString(),new Date(term.periodEnd).toISOString()]);schedule.terms.push(term);}
 await db.query('update cluera_billing_private.native_schedules set schedule=$1 where user_id=$2',[schedule,account.userId]);
 const before=await preservedRows(),history=clueraBillingHistorySchema.parse(await call());expect(history.nativeSchedule!.terms).toHaveLength(50);expect(history.nativeSchedule!.hasMoreTerms).toBe(true);expect(history.nativeSchedule!.terms[0].invoiceId).toBe('inv_nativehistory00000052');expect(history.nativeSchedule!.terms.every(row=>row.state==='REFUNDED'&&row.spendableMilliseconds===0&&row.remainingAllowanceMilliseconds===0)).toBe(true);expect(await preservedRows()).toEqual(before);
});
it('proposal is SELECT-only STABLE and service-only; it cannot bootstrap, settle, refresh, claim commands or write financial state',async()=>{
 const body=proposal.split('as $$')[1].split('end$$;')[0].replace(/--[^\n]*/g,'');expect(body).not.toMatch(/\b(insert|update|delete|truncate|perform|execute|customer_authorize|native_live|native_refresh|customer_usage_settle)\b/i);
 expect((await db.query("select p.provolatile,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE')anon,has_function_privilege('authenticated',p.oid,'EXECUTE')browser,has_function_privilege('service_role',p.oid,'EXECUTE')service from pg_proc p where p.oid='public.cluera_billing_native_history(uuid,uuid,text,bigint)'::regprocedure")).rows[0]).toMatchObject({provolatile:'s',prosecdef:true,anon:false,browser:false,service:true});
});
