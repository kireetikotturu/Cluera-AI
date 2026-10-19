import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { readClueraBillingHistory } from '../lib/payments/cluera/history';
import { clueraBillingHistorySchema } from '../lib/payments/cluera/historyContracts';
import { paymentTestEnvironment } from './helpers/paymentTestMode';
import type { PaymentRpc } from '../lib/payments/core/types';

// Exact applied-clean source plus tracked read-only history migration, in-memory only.
// No hosted Auth, customer, provider, financial or schema request is made.
const proposal = readFileSync('../supabase/migrations/20261019085323_cluera_customer_billing_history.sql', 'utf8');
const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true',
  CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false', SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED: 'true',
  SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED: 'false', SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED: 'false' };
const account = { userId: randomUUID(), sessionId: randomUUID() }, foreign = { userId: randomUUID(), sessionId: randomUUID() };
const digest = 'a'.repeat(64);
let db: PGlite;
let pack: string, monthly: string;
async function call(user: string | null = account.userId, session: string | null = account.sessionId): Promise<any> {
  return (await db.query<{value: unknown}>('select public.cluera_billing_history($1,$2) value', [user, session])).rows[0].value;
}
async function user(value = account) {
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [value.userId, `${value.userId}@example.invalid`]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [value.sessionId, value.userId]);
  await db.query('select public.customer_authorize($1,$2)', [value.userId, value.sessionId]);
}
async function packPayment(index: number, owner = account.userId, state = 'VERIFIED') {
  const intent = randomUUID(), id = String(index).padStart(8, '0');
  await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,order_id) values($1,$2,$3,$4,$5,1,$6,$7)",
    [intent, owner, randomUUID(), pack, digest, state, `order_history${id}`]);
  await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,amount_paise,revision_id,state) values($1,$2,$3,$4,54900,$5,$6)",
    [`pay_history${id}`, `order_history${id}`, intent, owner, pack, state]);
}
async function recurring(index: number, owner = account.userId) {
  const intent = randomUUID(), id = String(index).padStart(8, '0'), subscription = `sub_history${id}`;
  await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id) values($1,$2,$3,$4,$5,1,'VERIFIED',$6)",
    [intent, owner, randomUUID(), monthly, digest, subscription]);
  await db.query("insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at,paid_through) values($1,$2,$3,$4,$5,'ACTIVE',now(),now()+interval '30 days')",
    [subscription, owner, intent, monthly, digest]);
  await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,state,period_start,period_end,paid_at) values($1,$2,$3,$4,$5,$6,549900,$7,'VERIFIED',now(),now()+interval '30 days',now())",
    [`pay_recurring${id}`, `order_recurring${id}`, intent, owner, `inv_history${id}`, subscription, monthly]);
}
async function preservation() {
  const result: Record<string, unknown> = {};
  for (const relation of ['auth.users', 'auth.sessions', 'public.customer_accounts', 'public.customer_trial_grants',
    'public.customer_usage_grants', 'cluera_billing_private.intents', 'cluera_billing_private.payments',
    'cluera_billing_private.subscriptions', 'cluera_billing_private.events', 'cluera_billing_private.applications']) {
    result[relation] = (await db.query(`select coalesce(jsonb_agg(row_value order by row_value::text),'[]') value from (select to_jsonb(t) row_value from ${relation} t) q`)).rows[0].value;
  }
  return result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,
      deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
    create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
    create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
  await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql', 'utf8'));
  await db.exec(proposal);
  const catalog = (await db.query<{value: Array<{revisionId: string; kind: string}>}>('select public.cluera_billing_catalog() value')).rows[0].value;
  pack = catalog.find(row => row.kind === 'PACK')!.revisionId;
  monthly = catalog.find(row => row.kind === 'RECURRING')!.revisionId;
}, 60_000);
beforeEach(async () => { await db.exec('begin'); });
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => { await db?.close(); });

it('proposal creates only two indexes and one service-only bounded stable SELECT RPC; no table, policy or financial mutation', async () => {
  const body = proposal.split('as $$')[1].split('end$$;')[0];
  expect(body).not.toMatch(/\b(insert|update|delete|truncate|perform|execute|customer_authorize|refresh|wake_worker)\b/i);
  expect(proposal).not.toMatch(/create\s+(?:table|policy|trigger)|grant\s+(?:all|select|insert|update|delete)/i);
  expect((await db.query("select p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') browser,has_function_privilege('service_role',p.oid,'EXECUTE') service from pg_proc p where p.oid='public.cluera_billing_history(uuid,uuid)'::regprocedure")).rows[0])
    .toEqual({ prosecdef: true, provolatile: 's', proconfig: ['search_path=""', 'TimeZone=UTC', 'lock_timeout=2s', 'statement_timeout=5s'], anon: false, browser: false, service: true });
});
it('null, absent, foreign, expired or removed session and unverified email cannot read or bootstrap account/trial rows', async () => {
  expect(await call(null, null)).toEqual({code: 'UNAUTHENTICATED'});
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())', [account.userId, 'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [account.sessionId, account.userId]);
  expect(await call()).toEqual({code: 'FORBIDDEN'});
  expect((await db.query('select count(*) n from public.customer_accounts')).rows[0].n).toBe(0);
  expect((await db.query('select count(*) n from public.customer_trial_grants')).rows[0].n).toBe(0);
  await db.query('select public.customer_authorize($1,$2)', [account.userId, account.sessionId]);
  expect(await call(account.userId, foreign.sessionId)).toEqual({code: 'UNAUTHENTICATED'});
  await db.exec("update auth.sessions set not_after=now()-interval '1 second'");
  expect(await call()).toEqual({code: 'UNAUTHENTICATED'});
  await db.exec('update auth.sessions set not_after=null;update auth.users set email_confirmed_at=null');
  expect(await call()).toEqual({code: 'UNAUTHENTICATED'});
  await db.exec('delete from auth.sessions');
  expect(await call()).toEqual({code: 'UNAUTHENTICATED'});
});
it('suspended customer is denied; verified owner receives empty history with zero Auth/trial/ledger mutations', async () => {
  await user(); const before = await preservation();
  const history = clueraBillingHistorySchema.parse(await call());
  expect(history).toEqual({code: 'ACTIVE', userId: account.userId, payments: [], subscriptions: [], hasMorePayments: false, hasMoreSubscriptions: false});
  expect(await preservation()).toEqual(before);
  await db.query("update public.customer_accounts set state='SUSPENDED' where user_id=$1", [account.userId]);
  expect(await call()).toEqual({code: 'FORBIDDEN'});
});
it('independently denies banned, deleted and anonymous users even with an existing live session and customer row', async () => {
  await user();
  for (const mutation of ["banned_until=now()+interval '1 day'", 'deleted_at=now()', 'is_anonymous=true']) {
    await db.exec(`update auth.users set ${mutation}`);
    const before = await preservation();
    expect(await call()).toEqual({code: 'UNAUTHENTICATED'});
    expect(await preservation()).toEqual(before);
    await db.exec('update auth.users set banned_until=null,deleted_at=null,is_anonymous=false');
  }
});
it('returns immutable paid/refunded pack and monthly subscription snapshots, excludes all foreign-owner records and secrets', async () => {
  await user(); await user(foreign); await packPayment(1); await packPayment(2, account.userId, 'REFUNDED');
  await packPayment(3, foreign.userId); await recurring(1); await recurring(2, foreign.userId);
  const before = await preservation(), history = clueraBillingHistorySchema.parse(await call());
  expect(history.payments).toHaveLength(3); expect(history.subscriptions).toHaveLength(1);
  expect(history.payments.filter(row => row.revision.kind === 'PACK').map(row => row.state).sort()).toEqual(['REFUNDED', 'VERIFIED']);
  expect(history.payments.find(row => row.revision.kind === 'RECURRING')?.revision.amountPaise).toBe(549900);
  expect(JSON.stringify(history)).not.toMatch(/accountDigest|account_digest|planId|razorpay_plan|evidence|receipt|secret|customer_id|@|https?:/i);
  expect(JSON.stringify(history)).not.toContain('history00000003');
  expect(await preservation()).toEqual(before);
});
it('caps each independently ordered collection at50 with explicit truncation rather than claiming complete history', async () => {
  await user(); await user(foreign);
  for (let index = 1; index <= 51; index++) await recurring(index);
  await packPayment(100, foreign.userId);
  const history = clueraBillingHistorySchema.parse(await call());
  expect(history.payments).toHaveLength(50); expect(history.subscriptions).toHaveLength(50);
  expect(history.hasMorePayments).toBe(true); expect(history.hasMoreSubscriptions).toBe(true);
  expect(history.payments[0].paymentId).toBe('pay_recurring00000051');
  expect(history.subscriptions[0].subscriptionId).toBe('sub_history00000051');
});
it('guarded service read remains available while all checkout/intake flags are disabled, and makes exactly one bound RPC', async () => {
  await user(); const value = await call(); const rpc = vi.fn(async () => ({data: value, error: null}));
  expect(await readClueraBillingHistory(rpc, account, env)).toEqual(value);
  expect(rpc).toHaveBeenCalledExactlyOnceWith('cluera_billing_history', {p_user: account.userId, p_session: account.sessionId});
  for (const patch of [{CLUERA_BILLING_V2_ENABLED: 'false'}, {NEXT_PUBLIC_SUPABASE_URL: 'https://foreign.supabase.co'}, {RAZORPAY_ENVIRONMENT: 'live'}]) {
    const denied = vi.fn(); await expect(readClueraBillingHistory(denied, account, {...env, ...patch})).rejects.toThrow(); expect(denied).not.toHaveBeenCalled();
  }
});
it('rejects wrong-owner, raw provider/secret-bearing, malformed, duplicate or excessive history responses without echoing them', async () => {
  await user(); await recurring(1); const value = await call();
  const cases = [{...value, userId: foreign.userId}, {...value, secret: 'never-return-provider-secret'},
    {...value, payments: [...value.payments, value.payments[0]]}, {...value, subscriptions: Array(51).fill(value.subscriptions[0])},
    {...value, payments: [{...value.payments[0], invoiceUrl: 'https://provider.invalid/private'}]},
    {...value, payments: [{...value.payments[0], periodEnd: value.payments[0].periodStart}]},
    {...value, hasMorePayments: true}, {code: 'FORBIDDEN'}, null];
  for (const data of cases) {
    const rpc: PaymentRpc = async () => ({data, error: null});
    await expect(readClueraBillingHistory(rpc, account, env)).rejects.toThrow();
  }
  const bad: PaymentRpc = async () => ({data: null, error: {code: 'PRIVATE_PROVIDER_BODY'}});
  await expect(readClueraBillingHistory(bad, account, env)).rejects.toThrow('Billing verification is unavailable.');
});
it('clean owner still needs a separate audited merchant-bootstrap design; a same-owner cutover cannot bind it', async () => {
  expect((await db.query('select owner,epoch,account_digest from cluera_billing_private.processing_owner')).rows[0])
    .toEqual({owner: 'cluera', epoch: 1, account_digest: null});
  const result = (await db.query<{value: unknown}>('select public.cluera_billing_cutover($1,$2,$3,$4,$5,$6) value',
    [randomUUID(), 'cluera', 1, 'cluera', digest, 'Synthetic merchant bootstrap must not fake a handoff'])).rows[0].value;
  expect(result).toEqual({code: 'CONFLICT'});
  expect((await db.query('select account_digest from cluera_billing_private.processing_owner')).rows[0].account_digest).toBeNull();
  expect((await db.query('select count(*) n from cluera_billing_private.cutover_audit')).rows[0].n).toBe(0);
});
