import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
let db:PGlite;
const user='00000000-0000-4000-8000-000000000961',sid='00000000-0000-4000-8000-000000000962';
const id=(p:string,n:number)=>`${p}_${String(n).padStart(26,'0')}`,day=86400000;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);');
  for(const name of ['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox',
    '20261004064105_shared_usage_reservations','20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances',
    '20261004081006_sandbox_billing_jobs','20261004081025_sandbox_recurring_lifecycle','20261004081416_sandbox_refund_schedule_boundaries'])
    await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
},60000);
beforeEach(async()=>{
  await db.exec('truncate public.customer_accounts,auth.sessions,auth.users,public.paddle_sandbox_events cascade');
  await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic-recurring@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null)',[sid,user]);
});
afterAll(async()=>db?.close());
async function call(sql:string,args:unknown[]=[]){return (await db.query<{r:any}>(sql,args)).rows[0].r;}
async function prepare(n:number,offer:string){
  const i=await call('select public.customer_checkout_prepare($1,$2,$3,$4) r',[user,sid,randomUUID(),offer]);
  expect(await call('select public.customer_checkout_complete($1,$2,$3,$4) r',[i.intentId,i.attemptId,id('txn',n),'BOUND'])).toBe('BOUND');
}
const evidence=(n:number,offer='pro_40_hours',at=Date.now()-1000)=>({action:'GRANT',transactionId:id('txn',n),subscriptionId:id('sub',n),
  customerId:id('ctm',1),offerCode:offer,state:'ACTIVE',cancelFuture:false,observedAt:new Date().toISOString(),
  periodStart:new Date(at).toISOString(),periodEnd:new Date(at+(offer==='enterprise_weekly'?7:30)*day).toISOString()});
async function apply(n:number,value:ReturnType<typeof evidence>&{adjustmentId?:string}){
  const type=value.action==='GRANT'?'transaction.completed':value.action==='REFUND'?'adjustment.updated':'subscription.updated';
  const resource=value.action==='GRANT'?value.transactionId:value.action==='REFUND'?value.adjustmentId!:value.subscriptionId;
  await call('select public.paddle_sandbox_receive($1,$2,now(),$3,$4) r',[id('evt',n),type,resource,'a'.repeat(64)]);
  const job=await call('select public.customer_billing_claim() r');expect(job.code).toBe('CLAIMED');
  const result=await call('select public.customer_billing_apply_recurring($1,$2,$3,$4) r',[job.eventId,job.claimId,job.eventDigest,value]);
  return {result,job};
}
const terms=async()=> (await db.query<any>('select t.*,s.tier,g.granted_ms::text,g.spent_ms::text,g.state grant_state from public.customer_recurring_terms t join public.customer_recurring_subscriptions s using(subscription_id) left join public.customer_usage_grants g on g.id=t.grant_id order by t.created_at,t.transaction_id')).rows;

describe('transactional recurring lifecycle',()=>{
  it('maps first paid term through server binding and deduplicates different delivery IDs',async()=>{
    const p=evidence(1);await prepare(1,p.offerCode);expect((await apply(1,p)).result.code).toBe('APPLIED');
    expect((await apply(2,p)).result.code).toBe('APPLIED');
    const rows=await terms();expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'ACTIVE',granted_ms:'144000000',grant_state:'ACTIVE'});
  });
  it('queues same-tier term and transactionally creates cancel/reschedule outbox actions',async()=>{
    const a=evidence(1),b=evidence(2);await prepare(1,a.offerCode);await prepare(2,b.offerCode);
    await apply(1,a);await apply(2,b);
    expect((await terms()).map(t=>t.state)).toEqual(['ACTIVE','QUEUED']);
    expect((await db.query('select action from public.customer_billing_outbox order by action')).rows.map(r=>r.action)).toEqual(['CANCEL_FUTURE','RESCHEDULE']);
    const row=(await db.query<any>('select effective_at from public.customer_billing_outbox where action=\'RESCHEDULE\'')).rows[0];
    expect(new Date(row.effective_at).getTime()).toBe(Date.parse(a.periodEnd)+30*day);
    expect((await call('select public.customer_usage_command($1,$2,$3,0,$4) r',[user,sid,randomUUID(),'START'])).allocation).toBe('RECURRING');
  });
  it('Enterprise pauses exact Pro time/minutes, stops old funded work and preserves one grant',async()=>{
    const pro=evidence(1);await prepare(1,pro.offerCode);await apply(1,pro);
    await db.exec("update public.customer_usage_grants set spent_ms=1234567");
    const run=randomUUID();await call('select public.customer_usage_command($1,$2,$3,0,$4) r',[user,sid,run,'START']);
    const ent=evidence(2,'enterprise_weekly');await prepare(2,ent.offerCode);await apply(2,ent);
    const rows=await terms();expect(rows.map(t=>t.state)).toEqual(['PAUSED','ACTIVE']);
    expect(Number(rows[0].spent_ms)).toBeGreaterThanOrEqual(1234567);
    expect(Number(rows[0].remaining_ms)).toBeGreaterThan(29.99*day);
    expect(rows[0].grant_state).toBe('PAUSED');
    expect((await db.query('select reserved_ms::text r from public.customer_usage_grants where id=$1',[rows[0].grant_id])).rows[0].r).toBe('0');
    expect((await call('select public.customer_usage_command($1,$2,$3,1,$4) r',[user,sid,run,'CHECKPOINT'])).code).toBe('DENIED');
    expect((await db.query('select action from public.customer_billing_outbox')).rows).toEqual([{action:'CANCEL_FUTURE'}]);
  });
  it('refund removes unused Enterprise and resumes exact Pro remainder without creating a grant',async()=>{
    const pro=evidence(1),ent=evidence(2,'enterprise_weekly');await prepare(1,pro.offerCode);await prepare(2,ent.offerCode);
    await apply(1,pro);await apply(2,ent);const paused=(await terms())[0];
    await db.query('update public.customer_usage_grants set spent_ms=1000 where id=$1',[(await terms())[1].grant_id]);
    expect((await apply(3,{...ent,action:'REFUND',adjustmentId:id('adj',3)})).result.code).toBe('APPLIED');
    const rows=await terms();expect(rows.map(t=>t.state)).toEqual(['ACTIVE','REFUNDED']);
    expect(rows[0].grant_id).toBe(paused.grant_id);
    expect(new Date(rows[0].ends_at).getTime()-new Date(rows[0].starts_at).getTime()).toBe(Number(paused.remaining_ms));
    expect((await db.query("select removed_ms::text n from public.customer_recurring_applications where action='REFUND'")).rows[0].n).toBe('107999000');
    expect((await apply(4,ent)).result.code).toBe('APPLIED');expect((await terms())[1].state).toBe('REFUNDED');
  });
  it('expired active Enterprise waits for authoritative renewal/cancellation before resuming Pro',async()=>{
    const pro=evidence(1),ent=evidence(2,'enterprise_weekly');await prepare(1,pro.offerCode);await prepare(2,ent.offerCode);
    await apply(1,pro);await apply(2,ent);
    await db.exec("update public.customer_recurring_terms set starts_at=now()-interval '8 days',ends_at=now()-interval '1 day' where state='ACTIVE'");
    await call('select public.customer_recurring_refresh($1,clock_timestamp()) r',[user]);
    expect((await terms()).map(t=>t.state)).toEqual(['PAUSED','ENDED']);
    await apply(3,{...ent,action:'STATUS',state:'CANCELED',cancelFuture:true,observedAt:new Date(Date.now()+1000).toISOString()});
    expect((await terms())[0].state).toBe('ACTIVE');
  });
  it('renewal creates one fresh allowance without rollover and keeps Pro paused',async()=>{
    const pro=evidence(1),ent=evidence(2,'enterprise_weekly',Date.now()-7*day-1000);
    await prepare(1,pro.offerCode);await prepare(2,ent.offerCode);await apply(1,pro);await apply(2,ent);
    const renew={...evidence(3,'enterprise_weekly',Date.parse(ent.periodEnd)),subscriptionId:ent.subscriptionId};
    expect((await apply(3,renew)).result.code).toBe('APPLIED');
    const rows=await terms();expect(rows.map(t=>t.state)).toEqual(['PAUSED','ENDED','ACTIVE']);
    expect(rows[2].granted_ms).toBe('108000000');expect(rows[1].grant_state).toBe('REVOKED');
  });
  it('grace has fixed one-day boundary and duplicate failure never extends or grants minutes',async()=>{
    const pro=evidence(1);await prepare(1,pro.offerCode);await apply(1,pro);
    const failed={...pro,action:'STATUS',state:'PAST_DUE',observedAt:new Date(Date.now()+1000).toISOString()};
    await apply(2,failed);await apply(3,{...failed,observedAt:new Date(Date.now()+2000).toISOString()});
    const s=(await db.query<any>('select grace_until from public.customer_recurring_subscriptions')).rows[0];
    expect(new Date(s.grace_until).getTime()).toBe(Date.parse(pro.periodEnd)+day);
    expect(await terms()).toHaveLength(1);
  });
  it('cancellation leaves current paid grant intact and stale observations cannot uncancel',async()=>{
    const pro=evidence(1);await prepare(1,pro.offerCode);await apply(1,pro);
    await apply(2,{...pro,action:'STATUS',state:'CANCELED',cancelFuture:true,observedAt:new Date(Date.now()+1000).toISOString()});
    await apply(3,{...pro,action:'STATUS'});
    expect((await terms())[0].state).toBe('ACTIVE');
    expect((await db.query('select state,cancel_future from public.customer_recurring_subscriptions')).rows[0]).toEqual({state:'CANCELED',cancel_future:true});
  });
  it('late failure revives only the old unused grant during a fixed grace, not a fresh allowance',async()=>{
    const pro=evidence(1,'pro_40_hours',Date.now()-30*day-1000);await prepare(1,pro.offerCode);await apply(1,pro);
    expect((await terms())[0].state).toBe('ENDED');
    await db.exec('update public.customer_usage_grants set spent_ms=9876');
    await apply(2,{...pro,action:'STATUS',state:'PAST_DUE',observedAt:new Date(Date.now()+1000).toISOString()});
    const row=(await terms())[0];expect(row).toMatchObject({state:'ACTIVE',grant_state:'ACTIVE',spent_ms:'9876'});
    expect(new Date(row.ends_at).getTime()).toBe(Date.parse(pro.periodEnd)+day);
  });
  it('upgrade during Pro grace does not preserve free grace as prepaid Pro time',async()=>{
    const pro=evidence(1,'pro_40_hours',Date.now()-30*day-1000);await prepare(1,pro.offerCode);await apply(1,pro);
    await apply(2,{...pro,action:'STATUS',state:'PAST_DUE',observedAt:new Date(Date.now()+1000).toISOString()});
    const ent=evidence(2,'enterprise_weekly');await prepare(2,ent.offerCode);await apply(3,ent);
    expect((await terms()).map(t=>t.state)).toEqual(['ENDED','ACTIVE']);
  });
  it('refund-before-completion leaves a tombstone; unmatched accounts do not get grants',async()=>{
    const pro=evidence(1);await prepare(1,pro.offerCode);
    await apply(1,{...pro,action:'REFUND',adjustmentId:id('adj',1)});await apply(2,pro);
    expect((await terms())[0]).toMatchObject({state:'REFUNDED',grant_id:null});
    expect((await apply(3,evidence(3))).result.code).toBe('UNBOUND');
  });
  it('requires fenced claims, exact offer/period and private RPCs',async()=>{
    const pro=evidence(1);await prepare(1,pro.offerCode);
    const invalid={...pro,periodEnd:new Date(Date.parse(pro.periodStart)+day).toISOString()};
    expect((await apply(1,invalid)).result.code).toBe('INVALID');
    for(const name of ['customer_recurring_subscriptions','customer_recurring_terms','customer_recurring_applications'])
      for(const role of ['anon','authenticated','service_role'])
        expect(await call(`select has_table_privilege('${role}','public.${name}','SELECT,INSERT,UPDATE,DELETE') r`)).toBe(false);
    for(const role of ['anon','authenticated','service_role'])
      expect(await call(`select has_function_privilege('${role}','public.customer_recurring_refresh(uuid,timestamptz)','EXECUTE') r`)).toBe(false);
  });
  it('refund after an Enterprise renewal resumes Pro at refund time, not the older period end',async()=>{
    const pro=evidence(1),ent=evidence(2,'enterprise_weekly',Date.now()-7*day-10000);
    await prepare(1,pro.offerCode);await prepare(2,ent.offerCode);await apply(1,pro);await apply(2,ent);
    const renew={...evidence(3,'enterprise_weekly',Date.parse(ent.periodEnd)),subscriptionId:ent.subscriptionId};
    await apply(3,renew);const paused=(await terms())[0];const before=Date.now();
    await apply(4,{...renew,action:'REFUND',adjustmentId:id('adj',4)});
    const resumed=(await terms())[0];expect(new Date(resumed.starts_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(resumed.ends_at).getTime()-new Date(resumed.starts_at).getTime()).toBe(Number(paused.remaining_ms));
  });
  it('refund that advances a queued plan creates a corrected billing-date outbox entry',async()=>{
    const a=evidence(1),b=evidence(2);await prepare(1,a.offerCode);await prepare(2,b.offerCode);await apply(1,a);await apply(2,b);
    await apply(3,{...a,action:'REFUND',adjustmentId:id('adj',3)});
    const active=(await terms())[1];expect(active.state).toBe('ACTIVE');
    const actions=(await db.query<any>("select effective_at from public.customer_billing_outbox where action='RESCHEDULE' order by created_at")).rows;
    expect(actions).toHaveLength(2);expect(new Date(actions[1].effective_at).getTime()).toBe(new Date(active.ends_at).getTime());
    expect(new Date(actions[1].effective_at).getTime()).toBeLessThan(new Date(actions[0].effective_at).getTime());
  });
});
