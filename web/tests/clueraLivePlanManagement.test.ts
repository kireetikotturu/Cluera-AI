import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { paymentLiveEnvironment as input } from './helpers/paymentLiveMode';

// The proposal is reviewed but never applied by tooling; this fixture proves it on a disposable in-memory copy.
const { prepare } = createRequire(import.meta.url)('../../scripts/prepare-cluera-live-schema.cjs');
const digest = input.CLUERA_LIVE_MERCHANT_DIGEST;
const admin = randomUUID(), adminSession = randomUUID(), basicSession = randomUUID(), basicAdmin = randomUUID();
const outsider = randomUUID(), outsiderSession = randomUUID();
const buyerA = randomUUID(), sessionA = randomUUID(), buyerB = randomUUID(), sessionB = randomUUID();
let db: PGlite, catalogBefore: Array<{ offerCode: string; testPlanValidated: boolean }>;
type Plan = { planId: string; revisionId: string; name: string; amountPaise: number; allowanceSeconds: number; enabled: boolean;
  archived: boolean; version: number; openCheckouts: number; offerCode: string };
type Result = { code: string; plan?: Plan; plans?: Plan[] };
const change = async (action: string, plan: string | null, expected: string | null, body: object, reason: string | null = null,
  operation = randomUUID(), actor = admin, session = adminSession): Promise<Result> =>
  (await db.query<{ v: Result }>('select public.cluera_live_billing_plan_change($1,$2,$3,$4,$5,$6,$7,$8::jsonb)v',
    [actor, session, operation, action, plan, expected, reason, JSON.stringify(body)])).rows[0].v;
const read = async (): Promise<Plan[]> => (await db.query<{ v: Result }>('select public.cluera_live_billing_plans_read($1,$2)v', [admin, adminSession])).rows[0].v.plans!;
const publicCatalog = async () => (await db.query<{ v: Array<Plan & { revisionId: string; testPlanValidated: boolean }> }>('select public.cluera_live_billing_catalog()v')).rows[0].v;
const prepareFor = async (user: string, session: string, revision: string) => (await db.query<{ v: { code: string; revision?: { amountPaise: number } } }>(
  'select public.cluera_live_billing_prepare($1,$2,$3,$4,$5,$6)v', [user, session, randomUUID(), revision, digest, 2])).rows[0].v;
const create = (name: string, price: number, hours: number, enabled = true) =>
  change('CREATE', null, null, { name, amountPaise: price * 100, allowanceSeconds: hours * 3600, enabled });

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
  catalogBefore = (await db.query<{ v: typeof catalogBefore }>('select public.cluera_live_billing_catalog()v')).rows[0].v;
  await db.exec(readFileSync('../docs/proposals/cluera-live-plan-management.sql', 'utf8'));
  for (const [user, session, aal] of [[admin, adminSession, 'aal2'], [basicAdmin, basicSession, 'aal1'], [outsider, outsiderSession, 'aal2'],
    [buyerA, sessionA, 'aal1'], [buyerB, sessionB, 'aal1']]) {
    await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())', [user, user + '@example.invalid']);
    await db.query('insert into auth.sessions values($1,$2,null,$3)', [session, user, aal]);
  }
  await db.query('insert into public.account_admin_profiles(user_id)values($1),($2)', [admin, basicAdmin]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [randomUUID(), admin]);
  for (const [user, session] of [[buyerA, sessionA], [buyerB, sessionB]]) await db.query('select public.customer_authorize($1,$2)', [user, session]);
}, 60000);
beforeEach(async () => {
  await db.exec('begin');
  await db.query("update cluera_live_billing_private.processing_owner set owner='cluera',account_digest=$1,epoch=2", [digest]);
  await db.query(`update cluera_billing_runtime_private.live_profile set account_digest=$1,origin=$2,
    acceptance_digest=$3,checkout_enabled=true,intake_enabled=true`, [digest, input.CLUERA_LIVE_ACCOUNT_ORIGIN, 'd'.repeat(64)]);
  await db.exec("update cluera_billing_runtime_private.active_bank set mode='live'");
});
afterEach(async () => { await db.exec('rollback'); });
afterAll(async () => db?.close());

it('documents the original Live defect: the pack was reported as not validated, and the proposal repairs it', async () => {
  expect(catalogBefore.find(row => row.offerCode === 'cluera_pack_3h_v2')!.testPlanValidated).toBe(false);
  const rows = await publicCatalog();
  expect(rows).toHaveLength(4);
  expect(rows.filter(row => row.offerCode === 'cluera_pack_3h_v2').every(row => row.testPlanValidated)).toBe(true);
  expect(rows.filter(row => row.offerCode !== 'cluera_pack_3h_v2').every(row => !row.testPlanValidated)).toBe(true);
});

it('lists only one-time packs for the owner, with the monthly plans left alone', async () => {
  const plans = await read();
  expect(plans.map(plan => [plan.name, plan.amountPaise, plan.allowanceSeconds, plan.enabled, plan.archived]))
    .toEqual([['Cluera 3 Hours', 54900, 10800, false, false]]);
  const heads = await db.query<{ offer_code: string; enabled: boolean }>('select offer_code,enabled from cluera_live_billing_private.catalog_heads order by 1');
  expect(heads.rows.filter(row => row.offer_code !== 'cluera_pack_3h_v2').every(row => !row.enabled)).toBe(true);
});

it('requires the existing MFA Admin session inside the database for every action', async () => {
  const [pack] = await read();
  for (const [actor, session] of [[outsider, outsiderSession], [basicAdmin, basicSession], [admin, basicSession], [randomUUID(), adminSession]])
    expect(await change('SET_ENABLED', pack.planId, pack.revisionId, { enabled: true }, null, randomUUID(), actor, session)).toEqual({ code: 'FORBIDDEN' });
  expect((await db.query<{ v: Result }>('select public.cluera_live_billing_plans_read($1,$2)v', [outsider, outsiderSession])).rows[0].v.code).toBe('FORBIDDEN');
  expect((await db.query<{ n: number }>('select count(*)::int n from cluera_live_billing_private.admin_audit')).rows[0].n).toBe(0);
});

it('adds a plan, audits who/when/what, and needs no fresh authenticator code', async () => {
  const operation = randomUUID();
  const made = await change('CREATE', null, null, { name: '  Cluera 10 Hours  ', amountPaise: 149900, allowanceSeconds: 36000, enabled: true },
    'Launch offer', operation);
  expect(made.code).toBe('APPLIED');
  expect(made.plan).toMatchObject({ name: 'Cluera 10 Hours', amountPaise: 149900, allowanceSeconds: 36000, enabled: true, archived: false,
    offerCode: 'cluera_pack_3h_v2', version: 2 });
  const audit = (await db.query<{ actor_id: string; session_id: string; action: string; reason: string; before_row: object; after_row: Plan; created_at: Date }>(
    'select * from cluera_live_billing_private.admin_audit where operation_id=$1', [operation])).rows[0];
  expect(audit).toMatchObject({ actor_id: admin, session_id: adminSession, action: 'PLAN_CREATE', reason: 'Reason given: Launch offer', before_row: {} });
  expect(audit.after_row.name).toBe('Cluera 10 Hours');
  expect(audit.created_at).toBeInstanceOf(Date);
  const blank = await change('CREATE', null, null, { name: 'Cluera 20 Hours', amountPaise: 249900, allowanceSeconds: 72000, enabled: false });
  expect((await db.query<{ reason: string }>("select reason from cluera_live_billing_private.admin_audit where after_row->>'planId'=$1", [blank.plan!.planId])).rows[0].reason)
    .toBe('No reason given');
});

it('shows the owner who changed what and when, newest first, from the immutable audit table', async () => {
  const made = (await create('History check', 100, 1)).plan!;
  await change('EDIT', made.planId, made.revisionId, { name: 'History check', amountPaise: 15000, allowanceSeconds: 7200 }, 'Fixing the price');
  const history = (await db.query<{ v: { history: Array<{ by: string; action: string; reason: string; at: string; before: Plan; after: Plan }> } }>(
    'select public.cluera_live_billing_plans_read($1,$2)v', [admin, adminSession])).rows[0].v.history;
  expect(history.map(entry => entry.action)).toEqual(['PLAN_EDIT', 'PLAN_CREATE']);
  expect(history[0]).toMatchObject({ by: admin + '@example.invalid', reason: 'Reason given: Fixing the price' });
  expect([history[0].before.amountPaise, history[0].after.amountPaise]).toEqual([10000, 15000]);
  expect(Number.isNaN(Date.parse(history[0].at))).toBe(false);
  for (let i = 0; i < 25; i++) await change('SET_ENABLED', made.planId, (await read()).find(row => row.planId === made.planId)!.revisionId, { enabled: i % 2 === 1 });
  const capped = (await db.query<{ v: { history: unknown[] } }>('select public.cluera_live_billing_plans_read($1,$2)v', [admin, adminSession])).rows[0].v.history;
  expect(capped).toHaveLength(20);
});

it('rejects invalid prices, hours, names, reasons and unknown fields without writing anything', async () => {
  const bad = [
    { name: 'x', amountPaise: 10000, allowanceSeconds: 3600, enabled: true },
    { name: 'Fine name', amountPaise: 50, allowanceSeconds: 3600, enabled: true },
    { name: 'Fine name', amountPaise: 10000001, allowanceSeconds: 3600, enabled: true },
    { name: 'Fine name', amountPaise: 12345.5, allowanceSeconds: 3600, enabled: true },
    { name: 'Fine name', amountPaise: 10000, allowanceSeconds: 59, enabled: true },
    { name: 'Fine name', amountPaise: 10000, allowanceSeconds: 3600001, enabled: true },
    { name: 'Fine name', amountPaise: 10000, allowanceSeconds: 3600 },
    { name: 'Fine name', amountPaise: 10000, allowanceSeconds: 3600, enabled: true, extra: 1 },
  ];
  for (const body of bad) expect((await change('CREATE', null, null, body)).code).toBe('INVALID');
  expect((await change('CREATE', null, null, { name: 'Fine name', amountPaise: 10000, allowanceSeconds: 3600, enabled: true }, 'x'.repeat(401))).code).toBe('INVALID');
  expect((await change('CREATE', null, null, { name: 'cluera 3 hours', amountPaise: 10000, allowanceSeconds: 3600, enabled: true })).code).toBe('DUPLICATE_NAME');
  expect((await db.query<{ n: number }>('select count(*)::int n from cluera_live_billing_private.catalog_revisions')).rows[0].n).toBe(4);
});

it('edits through a new immutable revision: old revision, old orders and their amount never change', async () => {
  const { plan } = await create('Starter', 100, 1);
  const first = await prepareFor(buyerA, sessionA, plan!.revisionId);
  expect(first.code).toBe('CLAIMED');
  expect(first.revision!.amountPaise).toBe(10000);
  const edited = await change('EDIT', plan!.planId, plan!.revisionId, { name: 'Starter Plus', amountPaise: 19900, allowanceSeconds: 7200 }, 'Better value');
  expect(edited.code).toBe('APPLIED');
  expect(edited.plan).toMatchObject({ name: 'Starter Plus', amountPaise: 19900, allowanceSeconds: 7200, enabled: true, version: 3, planId: plan!.planId });
  expect(edited.plan!.revisionId).not.toBe(plan!.revisionId);
  const old = (await db.query<{ name: string; amount_paise: number; allowance_seconds: number }>(
    'select name,amount_paise,allowance_seconds from cluera_live_billing_private.catalog_revisions where id=$1', [plan!.revisionId])).rows[0];
  expect(old).toEqual({ name: 'Starter', amount_paise: 10000, allowance_seconds: 3600 });
  const intent = (await db.query<{ revision_id: string }>('select revision_id from cluera_live_billing_private.intents where user_id=$1', [buyerA])).rows[0];
  expect(intent.revision_id).toBe(plan!.revisionId);
  // The superseded revision can no longer start a purchase; the new one can.
  expect((await prepareFor(buyerB, sessionB, plan!.revisionId)).code).toBe('DISABLED');
  const next = await prepareFor(buyerB, sessionB, edited.plan!.revisionId);
  expect(next.code).toBe('CLAIMED');
  expect(next.revision!.amountPaise).toBe(19900);
  const audit = (await db.query<{ before_row: Plan; after_row: Plan }>(
    "select before_row,after_row from cluera_live_billing_private.admin_audit where action='PLAN_EDIT'")).rows[0];
  expect([audit.before_row.amountPaise, audit.after_row.amountPaise]).toEqual([10000, 19900]);
  expect(audit.before_row.openCheckouts).toBe(1);
});

it('refuses a stale edit, an unchanged edit and an unknown plan', async () => {
  const { plan } = await create('Stale test', 100, 1);
  const body = { name: 'Stale test', amountPaise: 12000, allowanceSeconds: 3600 };
  expect((await change('EDIT', plan!.planId, randomUUID(), body)).code).toBe('CONFLICT');
  expect((await change('EDIT', plan!.planId, plan!.revisionId, { name: 'Stale test', amountPaise: 10000, allowanceSeconds: 3600 })).code).toBe('NO_CHANGE');
  expect((await change('EDIT', randomUUID(), plan!.revisionId, body)).code).toBe('NOT_FOUND');
});

it('turns a plan Off and On; the database refuses to sell a plan that is Off', async () => {
  const { plan } = await create('Switch me', 100, 1);
  expect((await change('SET_ENABLED', plan!.planId, plan!.revisionId, { enabled: false })).plan!.enabled).toBe(false);
  expect((await prepareFor(buyerA, sessionA, plan!.revisionId)).code).toBe('DISABLED');
  expect((await change('SET_ENABLED', plan!.planId, plan!.revisionId, { enabled: true })).plan!.enabled).toBe(true);
  expect((await prepareFor(buyerA, sessionA, plan!.revisionId)).code).toBe('CLAIMED');
});

it('removing hides a plan (Off + archived), never deletes it, and it can be restored Off', async () => {
  const { plan } = await create('Remove me', 100, 1);
  const removed = await change('ARCHIVE', plan!.planId, plan!.revisionId, {});
  expect(removed.plan).toMatchObject({ enabled: false, archived: true });
  expect((await publicCatalog()).some(row => row.revisionId === plan!.revisionId)).toBe(false);
  expect((await prepareFor(buyerA, sessionA, plan!.revisionId)).code).toBe('DISABLED');
  expect((await read()).find(row => row.planId === plan!.planId)!.archived).toBe(true);
  expect((await change('SET_ENABLED', plan!.planId, plan!.revisionId, { enabled: true })).code).toBe('ARCHIVED');
  expect((await change('EDIT', plan!.planId, plan!.revisionId, { name: 'Remove me', amountPaise: 20000, allowanceSeconds: 3600 })).code).toBe('ARCHIVED');
  expect((await db.query<{ n: number }>('select count(*)::int n from cluera_live_billing_private.catalog_revisions where id=$1', [plan!.revisionId])).rows[0].n).toBe(1);
  expect((await change('RESTORE', plan!.planId, plan!.revisionId, {})).plan).toMatchObject({ enabled: false, archived: false });
  expect((await change('RESTORE', plan!.planId, plan!.revisionId, {})).code).toBe('NO_CHANGE');
});

it('shows only On plans to customers and keeps a plan\'s price-based ordering', async () => {
  const cheap = (await create('Cheap', 100, 1)).plan!, dear = (await create('Dear', 900, 5, false)).plan!;
  const rows = await publicCatalog();
  expect(rows.find(row => row.revisionId === cheap.revisionId)!.enabled).toBe(true);
  expect(rows.find(row => row.revisionId === dear.revisionId)!.enabled).toBe(false);
  expect(rows.map(row => row.amountPaise)).toEqual([...rows.map(row => row.amountPaise)].sort((a, b) => a - b));
});

it('is idempotent for the same operation and conflicts when the same id carries different input', async () => {
  const operation = randomUUID();
  const body = { name: 'Once only', amountPaise: 30000, allowanceSeconds: 7200, enabled: true };
  const first = await change('CREATE', null, null, body, null, operation);
  const again = await change('CREATE', null, null, body, null, operation);
  expect(again).toEqual(first);
  expect((await change('CREATE', null, null, { ...body, amountPaise: 31000 }, null, operation)).code).toBe('CONFLICT');
  expect((await db.query<{ n: number }>("select count(*)::int n from cluera_live_billing_private.catalog_revisions where name='Once only'")).rows[0].n).toBe(1);
  const verified = (await db.query<{ v: Result }>('select public.cluera_live_billing_plans_read($1,$2,$3)v', [admin, adminSession, operation])).rows[0].v;
  expect(verified).toEqual({ code: 'APPLIED', plan: first.plan });
  expect((await db.query<{ v: Result }>('select public.cluera_live_billing_plans_read($1,$2,$3)v', [admin, adminSession, randomUUID()])).rows[0].v.code).toBe('NOT_FOUND');
});

it('caps the number of visible plans', async () => {
  for (let i = 0; i < 19; i++) expect((await create('Plan number ' + i, 100 + i, 1, false)).code).toBe('APPLIED');
  expect((await create('One too many', 500, 1)).code).toBe('TOO_MANY_PLANS');
});

it('stops the old offer-code mutation from touching a pack, while monthly rows keep working as before', async () => {
  const old = async (offer: string) => (await db.query<{ v: { code: string } }>(
    'select public.cluera_live_billing_admin_mutate($1,$2,$3,$4,$5,$6,now(),$7,$8::jsonb)v',
    [admin, adminSession, randomUUID(), 'SET_ENABLED', offer, randomUUID(), 'Reason long enough', JSON.stringify({ enabled: true })])).rows[0].v.code;
  expect(await old('cluera_pack_3h_v2')).toBe('INVALID');
  expect(await old('cluera_monthly_40h_v2')).toBe('CONFLICT');
  const reachable = (await db.query<{ ok: boolean }>(
    "select has_function_privilege('service_role','public.cluera_live_billing_admin_mutate_pre_plans(uuid,uuid,uuid,text,text,uuid,timestamptz,text,jsonb)','execute') ok")).rows[0].ok;
  expect(reachable).toBe(false);
});
