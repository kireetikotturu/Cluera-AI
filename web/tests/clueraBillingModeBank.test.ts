import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
const { prepare } = createRequire(import.meta.url)('../../scripts/prepare-cluera-live-schema.cjs');
const user = randomUUID(), session = randomUUID(), testDigest = 'a'.repeat(64), liveDigest = 'b'.repeat(64);
let db: PGlite;
async function call(name: string, args: unknown[] = []): Promise<any> {
  return (await db.query<{ v: unknown }>(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')})v`, args)).rows[0].v;
}
async function expectSqlFailure(sql: string, args: unknown[] = []) {
  await db.exec('savepoint expected_denial');
  await expect(db.query(sql, args)).rejects.toThrow();
  await db.exec('rollback to savepoint expected_denial;release savepoint expected_denial');
}
async function approveFixture() {
  await db.query(`update cluera_billing_runtime_private.live_profile set account_digest=$1,origin='https://cluera-ai-staging.vercel.app',
    acceptance_digest=$2,checkout_enabled=true,intake_enabled=true`, [liveDigest, 'c'.repeat(64)]);
  await db.query("update cluera_live_billing_private.processing_owner set owner='cluera',account_digest=$1", [liveDigest]);
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
    create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
    create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
  for (const name of ['20261016014532_cluera_clean_foundation', '20261019085323_cluera_customer_billing_history',
    '20261020080539_cluera_recurring_dependencies_disabled'])
    await db.exec(readFileSync('../supabase/migrations/' + name + '.sql', 'utf8'));
  await db.exec(prepare());
}, 60000);
beforeEach(async () => {
  await db.exec('begin');
  await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())', [user, 'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [session, user]);
  await call('customer_authorize', [user, session]);
  await db.query('update cluera_billing_private.processing_owner set account_digest=$1', [testDigest]);
  await db.query(`insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms)
    values($1,'razorpay-test:order_syntheticbank01','PACK',60000),($1,'razorpay-live:order_syntheticbank01','PACK',540000)`, [user]);
});
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => db?.close());

it('installs isolated financial tables and disabled Live gates while retaining Test as the spending bank', async () => {
  expect(readFileSync('../docs/proposals/cluera-live-billing.sql', 'utf8')).toBe(prepare());
  expect((await db.query('select mode from cluera_billing_runtime_private.active_bank')).rows).toEqual([{ mode: 'test' }]);
  expect((await call('cluera_live_billing_catalog')).every((r: { enabled: boolean }) => !r.enabled)).toBe(true);
  expect(await call('cluera_live_billing_profile', [liveDigest])).toEqual({ code: 'UNAVAILABLE' });
  const revision = (await call('cluera_live_billing_catalog'))[0].revisionId;
  expect(await call('cluera_live_billing_prepare', [user, session, randomUUID(), revision, liveDigest, 1])).toEqual({ code: 'DISABLED' });
  expect((await call('customer_usage_balance', [user, session])).availableMilliseconds).toBe(960000);
  const credits = await call('cluera_credits_read', [user, session]);
  expect(credits.availableMilliseconds).toBe(960000);
  expect(credits.buckets.find((b: { kind: string }) => b.kind === 'PACK').grantedMilliseconds).toBe(60000);
});
it('cannot promote without acceptance or while a provider authorization is active', async () => {
  await expectSqlFailure("update cluera_billing_runtime_private.active_bank set mode='live'");
  const run = randomUUID();
  expect((await call('customer_usage_command', [user, session, run, 0, 'START'])).code).toBe('ACTIVE');
  await approveFixture();
  await expectSqlFailure("update cluera_billing_runtime_private.active_bank set mode='live'");
  expect((await call('customer_usage_command', [user, session, run, 1, 'STOP'])).code).toBe('CLOSED');
  await db.exec("update cluera_billing_runtime_private.active_bank set mode='live'");
  const fresh = randomUUID();
  expect((await call('customer_usage_command', [user, session, fresh, 0, 'START'])).code).toBe('ACTIVE');
  const bank = (await db.query(`select g.billing_mode from public.customer_usage_windows w
    join public.customer_usage_grants g on g.id=w.grant_id where w.run_id=$1`, [fresh])).rows[0].billing_mode;
  expect(bank).toBe('live');
  const credits = await call('cluera_credits_read', [user, session]);
  expect(credits.buckets.find((b: { kind: string }) => b.kind === 'PACK').grantedMilliseconds).toBe(540000);
  expect(credits.payments).toEqual([]);
  expect((await db.query("select count(*)::int n from public.customer_usage_grants where source_key='lifetime-trial'")).rows[0].n).toBe(1);
  const testRevision = (await call('cluera_billing_catalog'))[0].revisionId;
  expect(await call('cluera_billing_prepare', [user, session, randomUUID(), testRevision, testDigest, 1])).toEqual({ code: 'DISABLED' });
});
it('keeps trial spending shared across mode changes and never reissues the lifetime trial', async () => {
  await db.query("update public.customer_usage_grants set state='REVOKED'where user_id=$1", [user]);
  const run = randomUUID();
  const started = await call('customer_usage_command', [user, session, run, 0, 'START']);
  expect(started.allocation).toBe('TRIAL');
  await call('customer_usage_command', [user, session, run, 1, 'STOP']);
  await db.query("update public.customer_usage_grants set spent_ms=400000 where user_id=$1 and source_key='lifetime-trial'", [user]);
  await approveFixture(); await db.exec("update cluera_billing_runtime_private.active_bank set mode='live'");
  expect((await call('customer_usage_balance', [user, session])).availableMilliseconds).toBe(500000);
  await call('customer_usage_command', [user, session, randomUUID(), 0, 'START']);
  expect((await db.query('select count(*)::int n from public.customer_trial_grants where user_id=$1', [user])).rows[0].n).toBe(1);
});
it('enforces session ownership, immutable grant provenance and service-only access', async () => {
  expect((await call('customer_usage_balance', [user, randomUUID()])).code).toBe('UNAUTHENTICATED');
  await expectSqlFailure("update public.customer_usage_grants set source_key='razorpay-live:order_reclassified1'where source_key='razorpay-test:order_syntheticbank01'");
  expect((await db.query(`select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in('cluera_live_billing_private','cluera_billing_runtime_private')and c.relkind='r'
    and(not c.relrowsecurity or has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE'))`)).rows[0].n).toBe(0);
  expect((await db.query(`select has_function_privilege('anon','public.cluera_live_billing_prepare(uuid,uuid,uuid,uuid,text,bigint)','EXECUTE')allowed`)).rows[0].allowed).toBe(false);
  expect((await db.query(`select has_function_privilege('service_role','public.cluera_live_billing_prepare_pre_modes(uuid,uuid,uuid,uuid,text,bigint)','EXECUTE')allowed`)).rows[0].allowed).toBe(false);
});

it('the review-only provisioning generator separates profile, intake and promotion with retained-order guards', async () => {
  const { prepare: profileSql } = createRequire(import.meta.url)('../../scripts/payments/prepare-cluera-live-profile.cjs');
  const config = { phase: 'profile', merchantDigest: liveDigest, origin: 'https://cluera-ai-staging.vercel.app',
    acceptanceDigest: 'd'.repeat(64), operationId: randomUUID(), expectedEpoch: 1 };
  // Remove only transaction framing inside this synthetic rollback fixture.
  const apply = (phase: string, expectedEpoch: number) => db.exec(profileSql({ ...config, phase, expectedEpoch })
    .replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  await apply('profile', 1);
  expect((await call('cluera_live_billing_profile', [liveDigest])).checkoutEnabled).toBe(false);
  await apply('intake', 2);
  expect((await call('cluera_live_billing_profile', [liveDigest])).intakeEnabled).toBe(true);
  expect((await call('cluera_live_billing_profile', [liveDigest])).checkoutEnabled).toBe(false);
  const revision = (await call('cluera_billing_catalog'))[0].revisionId;
  await db.query(`insert into cluera_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state,order_id)
    values($1,$2,$3,$4,1,'BOUND','order_syntheticretained01')`, [user, randomUUID(), revision, testDigest]);
  await expectSqlFailure(profileSql({ ...config, phase: 'promote', expectedEpoch: 2 }).replace(/^begin;$/m, '').replace(/^commit;$/m, ''));
  expect((await db.query('select mode from cluera_billing_runtime_private.active_bank')).rows).toEqual([{ mode: 'test' }]);
  expect(() => profileSql({ ...config, merchantDigest: "x';drop schema public;--" })).toThrow();
});
