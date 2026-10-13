import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const user = '00000000-0000-4000-8000-000000000701';
const session = '00000000-0000-4000-8000-000000000702';
const secondSession = '00000000-0000-4000-8000-000000000703';
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);`);
  for (const name of ['20261004024730_customer_account_foundation','20261004064105_shared_usage_reservations']) {
    await db.exec(readFileSync(`../supabase/migrations/${name}.sql`, 'utf8'));
  }
}, 60000);
beforeEach(async () => {
  await db.exec('truncate public.customer_usage_settlements, public.customer_usage_windows, public.customer_usage_runs, public.customer_usage_grants, public.customer_trial_grants, public.customer_accounts, auth.sessions, auth.users cascade');
  await db.query('insert into auth.users values($1,$2,now())', [user, 'synthetic-usage@example.invalid']);
  await db.query('insert into auth.sessions values($1,$2,null),($3,$2,null)', [session,user,secondSession]);
});
afterAll(async () => db?.close());
async function command(run: string, sequence=0, action='START', sid=session, uid=user) {
  return (await db.query<{ result: any }>('select public.customer_usage_command($1,$2,$3,$4,$5) as result',
    [uid,sid,run,sequence,action])).rows[0].result;
}
async function age(run: string, seconds: number) {
  await db.query("update public.customer_usage_windows set starts_at=starts_at-$2*interval '1 second',expires_at=expires_at-$2*interval '1 second' where run_id=$1", [run,seconds]);
}
async function totals() {
  return (await db.query<{ spent: number; reserved: number; available: number }>(`select sum(spent_ms)::int as spent,
    sum(reserved_ms)::int as reserved,sum(granted_ms-spent_ms-reserved_ms)::int as available from public.customer_usage_grants`)).rows[0];
}
describe('shared server-authoritative usage SQL', () => {
  it('reports the trial without charging or materializing usage windows on balance reads', async () => {
    const read=async()=> (await db.query<{result:any}>('select public.customer_usage_balance($1,$2) as result',[user,session])).rows[0].result;
    expect(await read()).toEqual({code:'ACTIVE',availableMilliseconds:900000,spentMilliseconds:0,reservedMilliseconds:0});
    expect(await read()).toEqual({code:'ACTIVE',availableMilliseconds:900000,spentMilliseconds:0,reservedMilliseconds:0});
    expect((await db.query('select * from public.customer_usage_grants')).rows).toHaveLength(0);
    const run=randomUUID(); await command(run); await age(run,4); await command(run,1,'STOP');
    const result=await read(); expect(result.spentMilliseconds).toBeGreaterThanOrEqual(4000);
    expect(result.availableMilliseconds+result.spentMilliseconds).toBe(900000);
  });
  it('materializes one trial across Auth sessions and reserves a shared rather than per-device balance', async () => {
    const first = await command(randomUUID()); const second = await command(randomUUID(),0,'START',secondSession);
    expect(first).toMatchObject({ code:'ACTIVE',reservedMilliseconds:30000,allocation:'TRIAL' });
    expect(second.code).toBe('ACTIVE');
    expect(await totals()).toEqual({spent:0,reserved:60000,available:840000});
    expect((await db.query('select * from public.customer_usage_grants')).rows).toHaveLength(1);
    expect((await db.query('select * from public.customer_trial_grants')).rows).toHaveLength(1);
  });
  it('returns identical start/checkpoint retries without extending time or charging twice', async () => {
    const run=randomUUID(), first=await command(run);
    expect(await command(run)).toMatchObject({code:first.code,expiresAt:first.expiresAt,sequence:first.sequence});
    expect((await db.query('select * from public.customer_usage_windows')).rows).toHaveLength(1);
    await age(run,12);
    const next=await command(run,1,'CHECKPOINT');
    expect(next.code).toBe('ACTIVE');
    const before=await totals();
    expect(before.spent).toBeGreaterThanOrEqual(12000); expect(before.spent).toBeLessThan(12500);
    expect(await command(run,1,'CHECKPOINT')).toMatchObject({code:next.code,expiresAt:next.expiresAt,sequence:next.sequence});
    expect(await totals()).toEqual(before);
    expect((await command(run,0)).code).toBe('STALE');
    expect((await command(run,1,'STOP')).code).toBe('STALE');
  });
  it('settles only server elapsed time on stop and releases unused reservation once', async () => {
    const run=randomUUID(); await command(run); await age(run,5);
    const closed=await command(run,1,'STOP');
    expect(closed.code).toBe('CLOSED');
    const before=await totals(); expect(before.reserved).toBe(0);
    expect(before.spent).toBeGreaterThanOrEqual(5000); expect(before.spent).toBeLessThan(5500);
    expect(await command(run,1,'STOP')).toEqual(closed); expect(await totals()).toEqual(before);
    expect((await command(run,2,'CHECKPOINT')).code).toBe('STALE');
  });
  it('bounds crash charge to the reserved window and never resurrects an expired run', async () => {
    const run=randomUUID(); await command(run); await age(run,300);
    expect((await command(run,1,'CHECKPOINT')).code).toBe('EXPIRED');
    expect(await totals()).toEqual({spent:30000,reserved:0,available:870000});
    expect((await command(run)).code).toBe('EXPIRED');
    expect((await command(randomUUID())).code).toBe('ACTIVE');
  });
  it('denies unsigned ownership, another session, revoked sessions and suspended accounts', async () => {
    const run=randomUUID(); await command(run);
    expect((await command(run,1,'STOP',secondSession)).code).toBe('FORBIDDEN');
    expect((await command(randomUUID(),0,'START',session,randomUUID())).code).toBe('UNAUTHENTICATED');
    await db.query("update public.customer_accounts set state='SUSPENDED' where user_id=$1",[user]);
    expect((await command(run,1,'CHECKPOINT')).code).toBe('SUSPENDED');
    await db.query("update public.customer_accounts set state='ACTIVE' where user_id=$1",[user]);
    await db.query('delete from auth.sessions where id=$1',[session]);
    expect((await command(run,1,'CHECKPOINT')).code).toBe('UNAUTHENTICATED');
    expect((await totals()).reserved).toBe(30000);
  });
  it('cannot overspend a final balance across multiple sessions; spent trial never regenerates', async () => {
    const run=randomUUID(); await command(run); await age(run,31); await command(run);
    await db.exec("update public.customer_usage_grants set spent_ms=885000"); // Privileged fixture, not a public grant API.
    const last=await command(randomUUID()); expect(last.reservedMilliseconds).toBe(15000);
    expect((await command(randomUUID(),0,'START',secondSession)).code).toBe('EXHAUSTED');
    await age(last.runId,16); await command(last.runId);
    expect(await totals()).toEqual({spent:900000,reserved:0,available:0});
    expect((await command(randomUUID())).code).toBe('EXHAUSTED');
    expect((await db.query('select * from public.customer_usage_grants')).rows).toHaveLength(1);
  });
  it('consumes eligible recurring before pack and trial and never authorizes past term expiry', async () => {
    await db.query('select public.customer_authorize($1,$2)',[user,session]);
    await db.query(`insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,expires_at)
      values($1,'synthetic-pack','PACK',10800000,null),($1,'synthetic-term','RECURRING',144000000,now()+interval '7 seconds')`,[user]);
    const run=randomUUID(), first=await command(run);
    expect(first.allocation).toBe('RECURRING'); expect(first.reservedMilliseconds).toBeLessThanOrEqual(7000);
    expect(first.reservedMilliseconds).toBeGreaterThan(5000);
    // A short bucket permits an early checkpoint; no normal 10-second threshold dead end.
    expect((await command(run,1,'CHECKPOINT')).code).toBe('ACTIVE');
    await db.exec("update public.customer_usage_grants set state='PAUSED' where kind='RECURRING'");
    expect((await command(run,2,'CHECKPOINT')).code).toBe('DENIED');
    expect((await command(randomUUID())).allocation).toBe('PACK');
  });
  it('rejects excessive checkpoint frequency without extra ledger writes', async () => {
    const run=randomUUID(); await command(run);
    const before=await totals();
    expect((await command(run,1,'CHECKPOINT')).code).toBe('TOO_EARLY');
    expect(await totals()).toEqual(before);
    expect((await db.query('select * from public.customer_usage_settlements')).rows).toHaveLength(0);
  });
  it('bounds simultaneous windows without limiting total lifetime sessions', async () => {
    await db.query('select public.customer_authorize($1,$2)',[user,session]);
    await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms) values($1,'synthetic-pack','PACK',10800000)",[user]);
    const runs=Array.from({length:32},()=>randomUUID());
    for(const run of runs) expect((await command(run)).code).toBe('ACTIVE');
    expect((await command(randomUUID())).code).toBe('CAPACITY');
    await command(runs[0],1,'STOP');
    expect((await command(randomUUID())).code).toBe('ACTIVE');
  });
  it('restricts all direct access and internal helpers, retaining service-only command execution', async () => {
    for(const table of ['grants','runs','windows','settlements']) {
      const name=`public.customer_usage_${table}`;
      expect((await db.query('select relrowsecurity from pg_class where oid=$1::regclass',[name])).rows[0].relrowsecurity).toBe(true);
      for(const role of ['anon','authenticated','service_role']) {
        expect((await db.query('select has_table_privilege($1,$2,\'SELECT,INSERT,UPDATE,DELETE\') as allowed',[role,name])).rows[0].allowed).toBe(false);
      }
    }
    for(const role of ['anon','authenticated','service_role']) {
      expect((await db.query("select has_function_privilege($1,'public.customer_usage_settle(uuid,uuid,integer,timestamptz,text)','EXECUTE') as allowed",[role])).rows[0].allowed).toBe(false);
      expect((await db.query("select has_function_privilege($1,'public.customer_usage_command(uuid,uuid,uuid,integer,text)','EXECUTE') as allowed",[role])).rows[0].allowed).toBe(role==='service_role');
      expect((await db.query("select has_function_privilege($1,'public.customer_usage_balance(uuid,uuid)','EXECUTE') as allowed",[role])).rows[0].allowed).toBe(role==='service_role');
    }
    await db.exec('set role service_role');
    expect((await command(randomUUID())).code).toBe('ACTIVE');
    await db.exec('reset role');
  });
});
