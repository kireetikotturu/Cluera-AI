import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll,afterAll,beforeEach,describe,it,expect } from 'vitest';
let db:PGlite;
const user='00000000-0000-4000-8000-000000000801',sid='00000000-0000-4000-8000-000000000802';
const txn=`txn_${'a'.repeat(26)}`;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);');
  for(const name of ['20261004024730_customer_account_foundation','20261004070733_sandbox_checkout_intents'])
    await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
},60000);
beforeEach(async()=>{
  await db.exec('truncate public.customer_checkout_intents,public.customer_trial_grants,public.customer_accounts,auth.sessions,auth.users cascade');
  await db.query('insert into auth.users values($1,$2,now());',[user,'synthetic-checkout@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null)',[sid,user]);
});
afterAll(async()=>db?.close());
async function prepare(request=randomUUID(),offer='pro_3_hours',session=sid){
  return (await db.query<{r:any}>('select public.customer_checkout_prepare($1,$2,$3,$4) as r',[user,session,request,offer])).rows[0].r;
}
async function complete(claim:any,state='BOUND',transaction:string|null=txn,attempt=claim.attemptId){
  return (await db.query<{r:string}>('select public.customer_checkout_complete($1,$2,$3,$4) as r',[claim.intentId,attempt,transaction,state])).rows[0].r;
}
describe('durable sandbox checkout claims',()=>{
  it('issues one server intent and create capability, never repeats that capability',async()=>{
    const request=randomUUID(),first=await prepare(request);
    expect(first.code).toBe('CLAIMED');expect(first.attemptId).toBeTruthy();
    expect(await prepare(request)).toEqual({code:'PENDING',intentId:first.intentId,transactionId:null});
    expect((await prepare()).code).toBe('PENDING');
    expect((await prepare(request,'pro_40_hours')).code).toBe('CONFLICT');
  });
  it('binds a transaction once and returns only that binding on retries',async()=>{
    const request=randomUUID(),claim=await prepare(request);
    expect(await complete(claim)).toBe('BOUND');expect(await complete(claim)).toBe('BOUND');
    expect(await complete(claim,'BOUND',`txn_${'b'.repeat(26)}`)).toBe('CONFLICT');
    expect(await prepare(request)).toEqual({code:'BOUND',intentId:claim.intentId,transactionId:txn});
    expect((await prepare()).code).toBe('CLAIMED'); // Repeat purchases are separate intents.
  });
  it('does not retry an unknown create after timeout, age or a new browser request ID',async()=>{
    const claim=await prepare();expect(await complete(claim,'UNCERTAIN',null)).toBe('UNCERTAIN');
    await db.exec("update public.customer_checkout_intents set created_at=now()-interval '2 days'");
    expect((await prepare()).code).toBe('PENDING');
    expect(await complete(claim,'REJECTED',null)).toBe('CONFLICT');
    expect(await complete(claim)).toBe('BOUND');
  });
  it('retains a rejected attempt while allowing exactly one fresh authenticated claim',async()=>{
    const request=randomUUID(),claim=await prepare(request);
    expect(await complete(claim,'REJECTED',null)).toBe('REJECTED');
    expect((await prepare(request)).code).toBe('REJECTED');
    const nextRequest=randomUUID(),next=await prepare(nextRequest);
    expect(next.code).toBe('CLAIMED');expect(next.intentId).not.toBe(claim.intentId);
    expect((await prepare(nextRequest)).code).toBe('PENDING');
    expect((await prepare()).code).toBe('PENDING');
    expect((await db.query('select count(*)::int as n from public.customer_checkout_intents')).rows[0].n).toBe(2);
    expect((await db.query('select count(*)::int as n from public.customer_checkout_intents where transaction_id is not null')).rows[0].n).toBe(0);
  });
  it('rejects forged capability, unavailable identities, removed sessions and unsupported offers',async()=>{
    expect((await prepare(randomUUID(),'pro_100')).code).toBe('INVALID');
    expect((await prepare(randomUUID(),'pro_3_hours',randomUUID())).code).toBe('UNAUTHENTICATED');
    const claim=await prepare();expect(await complete(claim,'BOUND',txn,randomUUID())).toBe('FORBIDDEN');
    await db.exec('delete from auth.sessions');expect((await prepare()).code).toBe('UNAUTHENTICATED');
  });
  it('prevents the same Paddle transaction from being attached to two intents',async()=>{
    const first=await prepare();await complete(first);
    const second=await prepare();expect(await complete(second)).toBe('CONFLICT');
    expect((await db.query('select count(*)::int as n from public.customer_checkout_intents where transaction_id is not null')).rows[0].n).toBe(1);
  });
  it('bounds new attempts and never grants usage or creates payment records',async()=>{
    for(let i=0;i<12;i++){const claim=await prepare();expect(claim.code).toBe('CLAIMED');await complete(claim,'REJECTED',null);}
    expect((await prepare()).code).toBe('RATE_LIMITED');
    expect((await db.query('select count(*)::int as n from public.customer_trial_grants')).rows[0].n).toBe(1);
  });
  it('keeps table private and only two narrow RPCs service-callable',async()=>{
    expect((await db.query("select relrowsecurity from pg_class where oid='public.customer_checkout_intents'::regclass")).rows[0].relrowsecurity).toBe(true);
    for(const role of ['anon','authenticated','service_role']){
      expect((await db.query("select has_table_privilege($1,'public.customer_checkout_intents','SELECT,INSERT,UPDATE,DELETE') as ok",[role])).rows[0].ok).toBe(false);
      for(const signature of ['customer_checkout_prepare(uuid,uuid,uuid,text)','customer_checkout_complete(uuid,uuid,text,text)'])
        expect((await db.query("select has_function_privilege($1,$2,'EXECUTE') as ok",[role,`public.${signature}`])).rows[0].ok).toBe(role==='service_role');
    }
    await db.exec('set role service_role');expect((await prepare()).code).toBe('CLAIMED');await db.exec('reset role');
  });
});
