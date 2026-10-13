import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,beforeEach,describe,it,expect} from 'vitest';
let db:PGlite;
const user='00000000-0000-4000-8000-000000000901',sid='00000000-0000-4000-8000-000000000902';
const id=(prefix:string,n:number)=>`${prefix}_${String(n).padStart(26,'0')}`;
const hash='a'.repeat(64);
beforeAll(async()=>{
  db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);');
  for(const name of ['20261004024730_customer_account_foundation','20261004025407_paddle_sandbox_inbox',
    '20261004064105_shared_usage_reservations','20261004070733_sandbox_checkout_intents','20261004072754_sandbox_pack_allowances'])
    await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
},60000);
beforeEach(async()=>{
  await db.exec('truncate public.customer_accounts,auth.sessions,auth.users,public.paddle_sandbox_events cascade');
  await db.query('insert into auth.users values($1,$2,now())',[user,'synthetic-pack@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null)',[sid,user]);
});
afterAll(async()=>db?.close());
async function call(sql:string,args:unknown[]=[]){return (await db.query<{r:any}>(sql,args)).rows[0].r;}
async function intent(n:number,offer='pro_3_hours',who=user,session=sid){
  const claim=await call('select public.customer_checkout_prepare($1,$2,$3,$4) r',[who,session,randomUUID(),offer]);
  expect(claim.code).toBe('CLAIMED');
  expect(await call('select public.customer_checkout_complete($1,$2,$3,$4) r',[claim.intentId,claim.attemptId,id('txn',n),'BOUND'])).toBe('BOUND');
  return claim.intentId as string;
}
async function event(n:number,type='transaction.completed',resource=id('txn',n)){
  return call('select public.paddle_sandbox_receive($1,$2,now(),$3,$4) r',[id('evt',n),type,resource,hash]);
}
async function apply(intentId:string,n:number,action='GRANT',eventN=n,customer=id('ctm',1)){
  return call('select public.customer_pack_reconcile($1,$2,$3,$4,$5,$6) r',
    [id('evt',eventN),intentId,id('txn',n),customer,action,action==='REFUND'?id('adj',eventN):null]);
}
describe('transactional non-expiring pack grants/refunds',()=>{
  it('grants precisely 3 hours once, stacks separate purchases and never expires',async()=>{
    const a=await intent(1);await event(1);expect((await apply(a,1)).code).toBe('ACTIVE');
    expect((await apply(a,1)).code).toBe('DUPLICATE');
    await event(3,'transaction.completed',id('txn',1));expect((await apply(a,1,'GRANT',3)).code).toBe('ACTIVE');
    const b=await intent(2);await event(2);await apply(b,2);
    expect((await db.query('select count(*)::int n,sum(granted_ms)::text total,bool_and(expires_at is null) forever from public.customer_usage_grants')).rows[0])
      .toEqual({n:2,total:'21600000',forever:true});
  });
  it('requires bound pack offer and a normal non-conflicted completed event',async()=>{
    const a=await intent(1);expect((await apply(a,1)).code).toBe('UNVERIFIED_EVENT');
    await event(1,'transaction.paid');expect((await apply(a,1)).code).toBe('UNVERIFIED_EVENT');
    const b=await intent(2,'pro_40_hours');await event(2);expect((await apply(b,2)).code).toBe('UNBOUND');
    expect((await call('select public.customer_pack_reconcile($1,$2,$3,$4,$5,null) r',['ntfsimevt_'+'a'.repeat(26),a,id('txn',1),id('ctm',1),'GRANT'])).code).toBe('INVALID');
    await db.exec("update public.paddle_sandbox_events set state='CONFLICT'");
    expect((await apply(a,1)).code).toBe('UNVERIFIED_EVENT');
    expect((await db.query('select count(*)::int n from public.customer_usage_grants')).rows[0].n).toBe(0);
  });
  it('rejects altered transaction/customer replay without another grant',async()=>{
    const a=await intent(1);await event(1);await apply(a,1);
    expect((await apply(a,1,'GRANT',1,id('ctm',2))).code).toBe('CONFLICT');
    expect((await apply(a,2)).code).toBe('UNBOUND');
  });
  it('a full refund removes only unused attributable balance and preserves spent evidence',async()=>{
    const a=await intent(1),b=await intent(2);await event(1);await event(2);await apply(a,1);await apply(b,2);
    await db.query('update public.customer_usage_grants set spent_ms=123456 where source_key=$1',['paddle-sandbox:'+id('txn',1)]);
    await event(3,'adjustment.updated',id('adj',3));expect((await apply(a,1,'REFUND',3)).code).toBe('REFUNDED');
    expect((await apply(a,1,'REFUND',3)).code).toBe('DUPLICATE');
    expect((await db.query('select state,spent_ms::text spent from public.customer_usage_grants where source_key=$1',['paddle-sandbox:'+id('txn',1)])).rows[0])
      .toEqual({state:'REVOKED',spent:'123456'});
    expect((await db.query('select removed_ms::text amount from public.customer_pack_applications where event_id=$1',[id('evt',3)])).rows[0].amount).toBe('10676544');
    expect((await db.query("select sum(granted_ms-spent_ms)::text balance from public.customer_usage_grants where state='ACTIVE'")).rows[0].balance).toBe('10800000');
  });
  it('refund arriving before grant prevents resurrection from late completion',async()=>{
    const a=await intent(1);await event(2,'adjustment.created',id('adj',2));
    expect((await apply(a,1,'REFUND',2)).code).toBe('REFUNDED');
    await event(1);expect((await apply(a,1)).code).toBe('REFUNDED');
    expect((await db.query('select count(*)::int n from public.customer_usage_grants')).rows[0].n).toBe(0);
  });
  it('settles/denies active funded windows before refund and cannot reuse old authorization',async()=>{
    const a=await intent(1);await event(1);await apply(a,1);
    const run=randomUUID();const first=await call('select public.customer_usage_command($1,$2,$3,0,$4) r',[user,sid,run,'START']);
    expect(first.allocation).toBe('PACK');
    await event(2,'adjustment.updated',id('adj',2));await apply(a,1,'REFUND',2);
    expect((await call('select public.customer_usage_command($1,$2,$3,0,$4) r',[user,sid,run,'START'])).code).toBe('DENIED');
    expect((await db.query("select reserved_ms::text reserved,spent_ms>=0 and spent_ms<=30000 bounded from public.customer_usage_grants where kind='PACK'")).rows[0])
      .toEqual({reserved:'0',bounded:true});
    expect((await db.query('select count(*)::int n from public.customer_usage_settlements')).rows[0].n).toBe(1);
  });
  it('binds a Paddle customer to only one verified Sigma account',async()=>{
    const a=await intent(1);await event(1);await apply(a,1);
    const other=randomUUID(),session=randomUUID();
    await db.query('insert into auth.users values($1,$2,now())',[other,'other@example.invalid']);
    await db.query('insert into auth.sessions values($1,$2,null)',[session,other]);
    const b=await intent(2,'pro_3_hours',other,session);await event(2);
    expect((await apply(b,2)).code).toBe('CONFLICT');
    expect((await db.query('select count(*)::int n from public.customer_usage_grants where user_id=$1',[other])).rows[0].n).toBe(0);
  });
  it('preserves existing recurring-before-pack allocation',async()=>{
    const a=await intent(1);await event(1);await apply(a,1);
    await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,expires_at) values($1,'synthetic-recurring','RECURRING',60000,now()+interval '1 day')",[user]);
    expect((await call('select public.customer_usage_command($1,$2,$3,0,$4) r',[user,sid,randomUUID(),'START'])).allocation).toBe('RECURRING');
  });
  it('keeps immutable application audit and tables private; only reconciliation RPC is service-callable',async()=>{
    for(const name of ['customer_paddle_bindings','customer_pack_purchases','customer_pack_applications']){
      expect((await db.query(`select relrowsecurity from pg_class where oid='public.${name}'::regclass`)).rows[0].relrowsecurity).toBe(true);
      for(const role of ['anon','authenticated','service_role'])expect(await call(`select has_table_privilege('${role}','public.${name}','SELECT,INSERT,UPDATE,DELETE') r`)).toBe(false);
    }
    for(const role of ['anon','authenticated'])expect(await call(`select has_function_privilege('${role}','public.customer_pack_reconcile(text,uuid,text,text,text,text)','EXECUTE') r`)).toBe(false);
    expect(await call("select has_function_privilege('service_role','public.customer_pack_reconcile(text,uuid,text,text,text,text)','EXECUTE') r")).toBe(true);
  });
});
