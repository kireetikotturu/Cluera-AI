import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';

// Proves the reviewed close-out proposal on a disposable in-memory copy. It is never run on a real database by tooling.
const proposal = readFileSync('../docs/proposals/cluera-test-intent-closeout.sql', 'utf8');
const digest = 'a'.repeat(64);
const stuck = [
  { id: 'f103baee-119c-49f9-b218-ee8e2fcc3a60', order: 'order_TpRplT79SeFnTp', user: randomUUID(), session: randomUUID() },
  { id: '4952c441-894e-4055-801d-3c8a702bc4e4', order: 'order_Trd46ZnYqCmuLp', user: randomUUID(), session: randomUUID() },
];
const other = { user: randomUUID(), session: randomUUID() };
let db: PGlite;
const pack = "(select id from cluera_billing_private.catalog_revisions where offer_code='cluera_pack_3h_v2')";
const bound = (id: string, user: string, order: string) => db.query(
  `insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,order_id)
   values($1,$2,gen_random_uuid(),${pack},$3,1,'BOUND',$4)`, [id, user, digest, order]);
const states = async () => (await db.query<{ id: string; state: string }>('select id,state from cluera_billing_private.intents order by order_id')).rows;
const promoteBlockers = async () => (await db.query<{ n: number }>(
  "select count(*)::int n from cluera_billing_private.intents where state in('CREATING','BOUND','UNCERTAIN')")).rows[0].n;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
    create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
    create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
  for (const name of ['20261016014532_cluera_clean_foundation', '20261019085323_cluera_customer_billing_history',
    '20261020080539_cluera_recurring_dependencies_disabled'])
    await db.exec(readFileSync('../supabase/migrations/' + name + '.sql', 'utf8'));
  for (const { user, session } of [...stuck, other]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())', [user, user + '@example.invalid']);
    await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [session, user]);
    await db.query('select public.customer_authorize($1,$2)', [user, session]);
  }
}, 60000);
afterEach(async () => db?.close());

it('targets exactly what the unchanged promote SQL checks', async () => {
  const { sql } = (await import('node:module')).createRequire(import.meta.url)('../../scripts/payments/razorpay-go-live.cjs');
  const promote: string = sql({ phase: 'promote', 'key-id': 'rzp_live_abcdefgh12', 'account-id': 'acc_abcdefgh12', epoch: '2' });
  expect(promote).toContain("state in('CREATING','BOUND','UNCERTAIN')");
  expect(promote).toContain("state='PENDING'");
});

it('has no existing way to close a BOUND intent: the ledger only allows the five original states', async () => {
  await bound(stuck[0].id, stuck[0].user, stuck[0].order);
  await expect(db.query("update cluera_billing_private.intents set state='REJECTED'")).rejects.toThrow();

});

it('closes exactly the two reviewed intents, leaves immutable audit rows and satisfies the promote check', async () => {
  for (const item of stuck) await bound(item.id, item.user, item.order);
  await db.query(`insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,order_id)
    values(gen_random_uuid(),$1,gen_random_uuid(),${pack},$2,1,'VERIFIED','order_otherverified01')`, [other.user, digest]);
  expect(await promoteBlockers()).toBe(2);
  await db.exec(proposal);
  expect(await promoteBlockers()).toBe(0);
  expect((await states()).map(row => row.state).sort()).toEqual(['REJECTED', 'REJECTED', 'VERIFIED']);
  const audit = (await db.query<{ operation_id: string; reason: string; before_row: { state: string; kind: string }; after_row: { state: string; id: string } }>(
    "select * from cluera_billing_private.cutover_audit where before_row->>'kind'='TEST_INTENT_CLOSEOUT' order by operation_id")).rows;
  expect(audit).toHaveLength(2);
  expect(audit.map(row => row.operation_id).sort()).toEqual(['388f2053-2a12-437a-a6f3-e8687cbf3ac8', '6e550de3-9cf3-4127-bbdd-0eed0d707047']);
  expect(audit.every(row => row.before_row.state === 'BOUND' && row.after_row.state === 'REJECTED' && row.reason.length >= 10)).toBe(true);
  expect(audit.map(row => row.after_row.id).sort()).toEqual(stuck.map(item => item.id).sort());
  await expect(db.query("delete from cluera_billing_private.cutover_audit where before_row->>'kind'='TEST_INTENT_CLOSEOUT'")).rejects.toThrow();

});

it('changes no payment, grant, balance or other row, and lets the customer buy again', async () => {
  for (const item of stuck) await bound(item.id, item.user, item.order);
  const count = async () => (await db.query<{ v: string }>(
    `select (select count(*) from cluera_billing_private.payments)||'/'||(select count(*) from cluera_billing_private.applications)||'/'||
     (select count(*) from cluera_billing_private.events)||'/'||(select count(*) from public.customer_usage_grants)||'/'||
     (select count(*) from cluera_billing_private.catalog_revisions)||'/'||(select count(*) from cluera_billing_private.catalog_heads) v`)).rows[0].v;
  const before = await count();
  const status = async (item: typeof stuck[number]) => (await db.query<{ v: { code: string } }>(
    'select public.cluera_billing_status($1,$2)v', [item.user, item.session])).rows[0].v.code;
  expect(await status(stuck[0])).toBe('PENDING');
  await db.exec(proposal);
  expect(await count()).toBe(before);
  expect(await status(stuck[0])).toBe('AVAILABLE');
  const credits = (await db.query<{ v: { payments: Array<{ state: string }> } }>('select public.cluera_credits_read($1,$2)v', [stuck[0].user, stuck[0].session])).rows[0].v;
  expect(credits.payments.map(payment => payment.state)).toEqual(['REJECTED']);
  // The website and the installed Windows app both accept this state in their strict schemas.
  for (const file of ['../lib/accounts/credits.ts', '../../desktop/src/main/accounts/AccountApi.ts'])
    expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toContain("'CREATING','BOUND','UNCERTAIN','REJECTED','VERIFIED','REFUNDED'");

});

it.each([
  ['an intent that has payment evidence', async () => db.query(
    "insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,order_id,digest,occurred_at,state) values('evt_processed0001',$1,'order.paid',$2,$2,$3,now(),'PROCESSED')",
    [digest, stuck[0].order, 'b'.repeat(64)])],
  ['a receipt that is still pending', async () => db.query(
    "insert into cluera_billing_private.events(event_id,account_digest,event_type,resource_id,order_id,digest,occurred_at) values('evt_pending00001',$1,'order.paid','order_unrelated0001','order_unrelated0001',$2,now())",
    [digest, 'b'.repeat(64)])],
  ['another unresolved Test intent', async () => bound(randomUUID(), other.user, 'order_anotherbound01')],
])('changes nothing when it finds %s', async (_name, arrange) => {
  for (const item of stuck) await bound(item.id, item.user, item.order);
  await arrange();
  await expect(db.exec(proposal)).rejects.toThrow();
  await db.exec('rollback');
  expect((await states()).filter(row => stuck.some(item => item.id === row.id)).every(row => row.state === 'BOUND')).toBe(true);
  expect((await db.query<{ n: number }>('select count(*)::int n from cluera_billing_private.cutover_audit')).rows[0].n).toBe(0);
});

it('refuses when an intent is not the exact reviewed BOUND pack order', async () => {
  await bound(stuck[0].id, stuck[0].user, 'order_differentorder1');
  await bound(stuck[1].id, stuck[1].user, stuck[1].order);
  await expect(db.exec(proposal)).rejects.toThrow();
  await db.exec('rollback');
  expect((await states()).every(row => row.state === 'BOUND')).toBe(true);
  expect((await db.query<{ n: number }>('select count(*)::int n from cluera_billing_private.cutover_audit')).rows[0].n).toBe(0);
});
