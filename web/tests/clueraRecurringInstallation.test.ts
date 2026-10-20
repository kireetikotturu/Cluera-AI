import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it } from 'vitest';
const { prepare } = createRequire(import.meta.url)('../../scripts/prepare-cluera-recurring-schema.cjs');
let db: PGlite;
const user = randomUUID(), session = randomUUID(), request = randomUUID(), merchant = 'a'.repeat(64);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
    create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
    create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
  for (const file of ['20261016014532_cluera_clean_foundation', '20261019085323_cluera_customer_billing_history'])
    await db.exec(readFileSync('../supabase/migrations/' + file + '.sql', 'utf8'));
  await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())', [user, 'synthetic@example.invalid']);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')", [session, user]);
  await db.query('select public.customer_authorize($1,$2)', [user, session]);
  await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton', [merchant]);
  await db.exec("update cluera_billing_private.catalog_heads set enabled=true where offer_code='cluera_pack_3h_v2'");
  await db.query(`insert into cluera_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state,order_id)
    select $1,$2,revision_id,$3,1,'BOUND','order_syntheticretained1'from cluera_billing_private.catalog_heads where offer_code='cluera_pack_3h_v2'`,
    [user, request, merchant]);
}, 60000);
afterAll(async () => db?.close());
it('installs the complete ordered dependency set atomically, preserving every existing row and function body', async () => {
  await db.exec(prepare());
  expect((await db.query('select enabled from cluera_billing_private.native_config')).rows).toEqual([{ enabled: false }]);
  expect((await db.query('select state,order_id from cluera_billing_private.intents')).rows).toEqual([
    { state: 'BOUND', order_id: 'order_syntheticretained1' },
  ]);
  expect((await db.query('select count(*)::int n from public.customer_trial_grants')).rows[0].n).toBe(1);
  const state = (await db.query<{ value: { pending: { orderId: string } } }>(
    'select public.cluera_billing_status($1,$2)value', [user, session])).rows[0].value;
  expect(state.pending.orderId).toBe('order_syntheticretained1');
  expect((await db.query(`select count(*)::int n from pg_trigger where tgname='cluera_native_cancel_guard'`)).rows[0].n).toBe(1);
}, 30000);
it('does not enable monthly purchase or grant direct table access', async () => {
  const row = (await db.query<{ value: string }>(`select public.cluera_billing_native_purchase_policy($1,$2,
    (select revision_id from cluera_billing_private.catalog_heads where offer_code='cluera_monthly_40h_v2'),$3,1)value`,
    [user, session, merchant])).rows[0];
  expect(row.value).toBe('UNAVAILABLE');
  expect((await db.query(`select has_table_privilege('service_role','cluera_billing_private.native_schedules','SELECT') allowed`)).rows[0].allowed).toBe(false);
  expect((await db.query(`select has_function_privilege('anon','public.cluera_billing_cancel_prepare(uuid,uuid,uuid,text,text,bigint)','EXECUTE') allowed`)).rows[0].allowed).toBe(false);
});
it('refuses a repeated installation before changing data', async () => {
  await expect(db.exec(prepare())).rejects.toThrow('Recurring installation precondition requires review');
  await db.exec('rollback');
  expect((await db.query('select enabled from cluera_billing_private.native_config')).rows[0].enabled).toBe(false);
});
