import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
  await db.exec(readFileSync('../supabase/migrations/20261004025407_paddle_sandbox_inbox.sql', 'utf8'));
  await db.exec(readFileSync('../supabase/migrations/20261004061853_paddle_simulation_receipts.sql', 'utf8'));
}, 60000);
afterAll(async () => db?.close());
const at = '2026-10-04T01:00:00Z';
const id = (char: string) => 'evt_' + char.repeat(26);
async function receive(eventId: string, digest = 'a'.repeat(64), occurred = at, type = 'transaction.completed', resource = 'txn_' + 'a'.repeat(26)) {
  return (await db.query<{ result: string }>('select public.paddle_sandbox_receive($1,$2,$3,$4,$5) as result',
    [eventId, type, occurred, resource, digest])).rows[0].result;
}
describe('durable Paddle sandbox event SQL', () => {
  it('stores simulator receipts separately, deduplicates and quarantines without billing work', async () => {
    const eventId = 'ntfsimevt_' + 'a'.repeat(26);
    const call = async (digest = 'a'.repeat(64)) => (await db.query<{ result: string }>(
      'select public.paddle_sandbox_receive_simulation($1,$2,$3,$4,$5) as result',
      [eventId, 'transaction.completed', at, 'txn_' + 'a'.repeat(26), digest])).rows[0].result;
    expect(await call()).toBe('STORED');
    const before = (await db.query('select xmin,* from public.paddle_sandbox_simulations')).rows;
    expect(before[0].state).toBe('RECEIVED');
    expect(await call()).toBe('DUPLICATE');
    expect((await db.query('select xmin,* from public.paddle_sandbox_simulations')).rows).toEqual(before);
    expect(await call('b'.repeat(64))).toBe('CONFLICT');
    expect(await call()).toBe('CONFLICT');
    expect((await db.query('select * from public.paddle_sandbox_events where event_id=$1', [eventId])).rows).toHaveLength(0);
    await expect(receive(eventId)).rejects.toThrow('Invalid billing event envelope');
    await expect(db.query('select public.paddle_sandbox_receive_simulation($1,$2,$3,$4,$5)',
      [id('a'), 'transaction.completed', at, 'txn_' + 'a'.repeat(26), 'a'.repeat(64)])).rejects.toThrow('Invalid billing event envelope');
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'public.paddle_sandbox_simulations','SELECT,INSERT,UPDATE,DELETE') as allowed", [role])).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.paddle_sandbox_receive_simulation(text,text,timestamptz,text,text)','EXECUTE') as allowed", [role])).rows[0].allowed).toBe(role === 'service_role');
    }
    expect((await db.query("select prosecdef,proconfig from pg_proc where oid='public.paddle_sandbox_receive_simulation(text,text,timestamptz,text,text)'::regprocedure")).rows[0])
      .toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
    expect((await db.query("select relrowsecurity from pg_class where oid='public.paddle_sandbox_simulations'::regclass")).rows[0]).toEqual({ relrowsecurity: true });
  });
  it('stores once and makes retries no-op writes', async () => {
    expect(await receive(id('a'))).toBe('STORED');
    const before = (await db.query('select xmin,* from public.paddle_sandbox_events')).rows;
    expect(await receive(id('a'))).toBe('DUPLICATE');
    expect((await db.query('select xmin,* from public.paddle_sandbox_events')).rows).toEqual(before);
  });
  it('permanently quarantines conflicting events without overwriting the original', async () => {
    expect(await receive(id('b'))).toBe('STORED');
    expect(await receive(id('b'), 'b'.repeat(64))).toBe('CONFLICT');
    expect(await receive(id('b'))).toBe('CONFLICT');
    expect((await db.query('select state,event_digest from public.paddle_sandbox_events where event_id=$1', [id('b')])).rows[0])
      .toEqual({ state: 'CONFLICT', event_digest: 'a'.repeat(64) });
  });
  it('retains out-of-order events without changing customer balances', async () => {
    expect(await receive(id('c'), undefined, '2026-10-03T00:00:00Z')).toBe('STORED');
    expect((await db.query('select state from public.paddle_sandbox_events where event_id=$1', [id('c')])).rows[0])
      .toEqual({ state: 'PENDING' });
    const columns = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name='paddle_sandbox_events' order by ordinal_position")).rows;
    expect(columns.map(row => row.column_name)).toEqual(['event_id', 'event_type', 'occurred_at', 'resource_id', 'event_digest', 'received_at', 'state']);
  });
  it('rejects invalid values even at the service RPC boundary', async () => {
    for (const value of [() => receive('not-event'), () => receive(id('d'), 'bad'),
      () => receive(id('d'), undefined, 'infinity'), () => receive(id('d'), undefined, at, 'transaction.completed', 'sub_' + 'a'.repeat(26))]) {
      await expect(value()).rejects.toThrow('Invalid billing event envelope');
    }
    expect((await db.query('select * from public.paddle_sandbox_events where event_id=$1', [id('d')])).rows).toHaveLength(0);
  });
  it('denies browser execution and direct reads/writes including service-role table bypass', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,'public.paddle_sandbox_events','SELECT,INSERT,UPDATE,DELETE') as allowed", [role])).rows[0].allowed).toBe(false);
      expect((await db.query<{ allowed: boolean }>("select has_function_privilege($1,'public.paddle_sandbox_receive(text,text,timestamptz,text,text)','EXECUTE') as allowed", [role])).rows[0].allowed).toBe(role === 'service_role');
    }
    expect((await db.query("select prosecdef,proconfig from pg_proc where oid='public.paddle_sandbox_receive(text,text,timestamptz,text,text)'::regprocedure")).rows[0])
      .toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
    expect((await db.query("select relrowsecurity from pg_class where oid='public.paddle_sandbox_events'::regclass")).rows[0]).toEqual({ relrowsecurity: true });
    await db.exec('set role anon');
    await expect(receive(id('z'))).rejects.toThrow('permission denied');
    await db.exec('reset role');
  });
});
