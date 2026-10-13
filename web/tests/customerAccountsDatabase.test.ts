import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
let db: PGlite;
const a = '00000000-0000-4000-8000-000000000101', b = '00000000-0000-4000-8000-000000000102';
const sa = '00000000-0000-4000-8000-000000000201', sb = '00000000-0000-4000-8000-000000000202';
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);`);
  await db.exec(readFileSync('../supabase/migrations/20261004024730_customer_account_foundation.sql', 'utf8'));
  await db.query('insert into auth.users values ($1,$2,now()),($3,$4,null)', [a, 'verified@example.invalid', b, 'unverified@example.invalid']);
  await db.query('insert into auth.sessions values ($1,$2,null),($3,$4,null)', [sa, a, sb, b]);
}, 60000);
afterAll(async () => db?.close());
async function authorize(user: string, session: string) {
  return (await db.query<{ result: { code: string; trialSecondsGranted?: number; remoteDesktop?: boolean } }>(
    'select public.customer_authorize($1,$2) as result', [user, session])).rows[0].result;
}
describe('customer account SQL boundary', () => {
  it('grants one lifetime trial per verified account, not per sign-in/device', async () => {
    expect(await authorize(a, sa)).toMatchObject({ code: 'ACTIVE', trialSecondsGranted: 900, remoteDesktop: false });
    const before = (await db.query('select xmin,created_at from public.customer_trial_grants')).rows;
    for (let i = 0; i < 3; i++) expect((await authorize(a, sa)).code).toBe('ACTIVE');
    expect((await db.query('select xmin,created_at from public.customer_trial_grants')).rows).toEqual(before);
    const newSession = '00000000-0000-4000-8000-000000000203';
    await db.query('insert into auth.sessions values($1,$2,null)', [newSession, a]);
    expect((await authorize(a, newSession)).code).toBe('ACTIVE');
    expect((await db.query('select * from public.customer_trial_grants')).rows).toHaveLength(1);
  });
  it('denies unverified emails, cross-account session IDs and missing/revoked sessions', async () => {
    expect((await authorize(b, sb)).code).toBe('UNAUTHENTICATED');
    expect((await authorize(a, sb)).code).toBe('UNAUTHENTICATED');
    expect((await authorize(a, b)).code).toBe('UNAUTHENTICATED');
    expect((await db.query('select * from public.customer_accounts where user_id=$1', [b])).rows).toHaveLength(0);
  });
  it('denies server-expired and suspended accounts without granting a fresh trial', async () => {
    await db.query("update auth.sessions set not_after=now()-interval '1 second' where id=$1", [sa]);
    expect((await authorize(a, sa)).code).toBe('UNAUTHENTICATED');
    await db.query('update auth.sessions set not_after=null where id=$1', [sa]);
    await db.query("update public.customer_accounts set state='SUSPENDED' where user_id=$1", [a]);
    expect((await authorize(a, sa)).code).toBe('SUSPENDED');
    await db.query("update public.customer_accounts set state='ACTIVE' where user_id=$1", [a]);
  });
  it('allows only service RPCs and no browser or direct service table writes', async () => {
    for (const table of ['customer_accounts', 'customer_trial_grants', 'customer_request_limits']) {
      expect((await db.query<{ relrowsecurity: boolean }>('select relrowsecurity from pg_class where oid=$1::regclass', [`public.${table}`])).rows[0].relrowsecurity).toBe(true);
      for (const role of ['anon', 'authenticated', 'service_role']) {
        expect((await db.query<{ allowed: boolean }>("select has_table_privilege($1,$2,'INSERT,UPDATE,DELETE') as allowed", [role, `public.${table}`])).rows[0].allowed).toBe(false);
      }
    }
    for (const signature of ['customer_authorize(uuid,uuid)', 'customer_auth_rate_limit(text,integer)']) {
      const permissions = await db.query<{ role: string; allowed: boolean }>(`select role,has_function_privilege(role,$1,'EXECUTE') as allowed
        from (values ('anon'),('authenticated'),('service_role')) r(role)`, [`public.${signature}`]);
      expect(permissions.rows.map(row => row.allowed)).toEqual([false, false, true]);
      expect((await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure', [`public.${signature}`])).rows[0])
        .toEqual({ prosecdef: true, proconfig: ['search_path=""'] });
    }
  });
  it('enforces atomic bounded rate counts and expiry', async () => {
    const bucket = 'c'.repeat(64);
    const take = () => db.query<{ allowed: boolean }>('select public.customer_auth_rate_limit($1,2) as allowed', [bucket]);
    expect((await take()).rows[0].allowed).toBe(true);
    expect((await take()).rows[0].allowed).toBe(true);
    expect((await take()).rows[0].allowed).toBe(false);
    await db.query("update public.customer_request_limits set expires_at=now()-interval '1 second'");
    expect((await take()).rows[0].allowed).toBe(true);
  });
});
