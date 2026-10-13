import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
let db:PGlite;
const user='00000000-0000-4000-8000-000000000951',sid='00000000-0000-4000-8000-000000000952';
const id=(prefix:string,n:number)=>`${prefix}_${String(n).padStart(26,'0')}`;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);');
  for(const name of ['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox',
    '20261004061853_paddle_simulation_receipts','20261004064105_shared_usage_reservations','20261004070733_sandbox_checkout_intents',
    '20261004072754_sandbox_pack_allowances','20261004081006_sandbox_billing_jobs'])
    await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
},60000);
beforeEach(async()=>{
  await db.exec('truncate public.customer_accounts,auth.sessions,auth.users,public.paddle_sandbox_events,public.paddle_sandbox_simulations cascade');
  await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic-jobs@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null)',[sid,user]);
});
afterAll(async()=>db?.close());
async function call(sql:string,args:unknown[]=[]){return (await db.query<{r:any}>(sql,args)).rows[0].r;}
async function event(n:number){await call('select public.paddle_sandbox_receive($1,$2,now(),$3,$4) r',[id('evt',n),'transaction.completed',id('txn',n),'a'.repeat(64)]);}
const claim=()=>call('select public.customer_billing_claim() r');
const finish=(job:any,result='RETRY')=>call('select public.customer_billing_finish($1,$2,$3) r',[job.eventId,job.claimId,result]);
async function bound(n:number){
  const i=await call('select public.customer_checkout_prepare($1,$2,$3,$4) r',[user,sid,randomUUID(),'pro_3_hours']);
  await call('select public.customer_checkout_complete($1,$2,$3,$4) r',[i.intentId,i.attemptId,id('txn',n),'BOUND']);return i.intentId;
}
const apply=(job:any,intent:string)=>call('select public.customer_billing_apply_pack($1,$2,$3,$4,$5,$6,$7,null) r',
  [job.eventId,job.claimId,job.eventDigest,intent,job.resourceId,id('ctm',1),'GRANT']);

describe('durable sandbox billing jobs and outbox',()=>{
  it('atomically enqueues normal events once, never simulator receipts',async()=>{
    await event(1);
    const row=(await db.query('select occurred_at from public.paddle_sandbox_events')).rows[0];
    await call('select public.paddle_sandbox_receive($1,$2,$3,$4,$5) r',[id('evt',1),'transaction.completed',row.occurred_at,id('txn',1),'a'.repeat(64)]);
    await call('select public.paddle_sandbox_receive_simulation($1,$2,now(),$3,$4) r',[id('ntfsimevt',2),'transaction.completed',id('txn',2),'a'.repeat(64)]);
    expect((await db.query('select count(*)::int n from public.customer_billing_jobs')).rows[0].n).toBe(1);
    expect((await claim()).code).toBe('CLAIMED');expect((await claim()).code).toBe('EMPTY');
  });
  it('reclaims expired work with a new token and rejects the stale writer',async()=>{
    const intent=await bound(1);await event(1);const old=await claim();
    await db.exec("update public.customer_billing_jobs set claimed_until=now()-interval '1 second',available_at=now()-interval '1 second'");
    const fresh=await claim();expect(fresh.claimId).not.toBe(old.claimId);
    expect((await apply(old,intent)).code).toBe('STALE');
    expect(await finish(old)).toBe('STALE');
    expect((await apply(fresh,intent)).code).toBe('ACTIVE');
    expect((await apply(fresh,intent)).code).toBe('STALE');
    expect((await db.query('select state,result_code from public.customer_billing_jobs')).rows[0]).toEqual({state:'DONE',result_code:'APPLIED'});
    expect((await db.query('select count(*)::int n from public.customer_usage_grants')).rows[0].n).toBe(1);
  });
  it('persists bounded exponential backoff and sends exhausted jobs to review',async()=>{
    await event(1);
    for(let n=1;n<=12;n++){
      const job=await claim();expect(job.code).toBe('CLAIMED');expect(await finish(job)).toBe('SAVED');
      const state=(await db.query("select state,attempts,extract(epoch from available_at-updated_at)::int delay from public.customer_billing_jobs")).rows[0];
      expect(state).toEqual({state:n===12?'REVIEW':'READY',attempts:n,delay:Math.min(3600,15*2**Math.min(n-1,8))});
      expect((await claim()).code).toBe('EMPTY');
      await db.exec("update public.customer_billing_jobs set available_at=now()-interval '1 second'");
    }
    expect((await claim()).code).toBe('EMPTY');
  });
  it('checks digest/conflict again immediately before a financial write',async()=>{
    const intent=await bound(1);await event(1);const job=await claim();
    expect((await apply({...job,eventDigest:'b'.repeat(64)},intent)).code).toBe('STALE');
    await db.exec("update public.paddle_sandbox_events set state='CONFLICT'");
    expect((await apply(job,intent)).code).toBe('STALE');expect(await finish(job,'APPLIED')).toBe('SAVED');
    expect((await db.query('select state,result_code from public.customer_billing_jobs')).rows[0]).toEqual({state:'REVIEW',result_code:'CONFLICT'});
    expect((await db.query('select count(*)::int n from public.customer_usage_grants')).rows[0].n).toBe(0);
  });
  it('rolls back job completion with failed financial write, and never trusts custom account input',async()=>{
    await bound(1);await event(1);const job=await claim();
    expect((await apply(job,randomUUID())).code).toBe('UNBOUND');
    expect((await db.query('select state from public.customer_billing_jobs')).rows[0].state).toBe('RUNNING');
    expect(await call('select public.customer_billing_bound_intent($1) r',[id('txn',2)])).toBe(null);
  });
  it('serializes outbox actions per subscription and requires current claims to acknowledge',async()=>{
    await call('select public.customer_authorize($1,$2) r',[user,sid]);
    for(let n=1;n<=2;n++)await db.query(`insert into public.customer_billing_outbox(user_id,subscription_id,action_key,action,created_at)
      values($1,$2,$3,'CANCEL_FUTURE',now()+$4*interval '1 millisecond')`,[user,id('sub',1),`test-${n}`,n]);
    const a=await call('select public.customer_billing_action_claim() r');
    expect(a.code).toBe('CLAIMED');expect((await call('select public.customer_billing_action_claim() r')).code).toBe('EMPTY');
    expect(await call('select public.customer_billing_action_finish($1,$2,$3) r',[a.actionId,randomUUID(),'CONFIRMED'])).toBe('STALE');
    expect(await call('select public.customer_billing_action_finish($1,$2,$3) r',[a.actionId,a.claimId,'RETRY'])).toBe('SAVED');
    expect((await call('select public.customer_billing_action_claim() r')).code).toBe('EMPTY');
    await db.exec("update public.customer_billing_outbox set available_at=now()-interval '1 second'");
    const retry=await call('select public.customer_billing_action_claim() r');expect(retry.actionId).toBe(a.actionId);
    await call('select public.customer_billing_action_finish($1,$2,$3) r',[retry.actionId,retry.claimId,'CONFIRMED']);
    expect((await call('select public.customer_billing_action_claim() r')).actionId).not.toBe(a.actionId);
  });
  it('keeps tables internal and removes service access to the unfenced financial writer',async()=>{
    for(const table of ['customer_billing_jobs','customer_billing_outbox']){
      expect((await db.query(`select relrowsecurity from pg_class where oid='public.${table}'::regclass`)).rows[0].relrowsecurity).toBe(true);
      for(const role of ['anon','authenticated','service_role'])expect(await call(`select has_table_privilege('${role}','public.${table}','SELECT,INSERT,UPDATE,DELETE') r`)).toBe(false);
    }
    expect(await call("select has_function_privilege('service_role','public.customer_pack_reconcile(text,uuid,text,text,text,text)','EXECUTE') r")).toBe(false);
    for(const role of ['anon','authenticated'])expect(await call(`select has_function_privilege('${role}','public.customer_billing_claim(text)','EXECUTE') r`)).toBe(false);
  });
});
