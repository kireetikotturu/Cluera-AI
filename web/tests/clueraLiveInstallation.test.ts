import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, expect, it } from 'vitest';
const { prepare } = createRequire(import.meta.url)('../../scripts/prepare-cluera-live-installation.cjs');
let db: PGlite; const user = randomUUID(), session = randomUUID(), digest = 'a'.repeat(64);
beforeEach(async () => {
 db = new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
 for(const name of ['20261016014532_cluera_clean_foundation','20261019085323_cluera_customer_billing_history','20261020080539_cluera_recurring_dependencies_disabled'])
  await db.exec(readFileSync('../supabase/migrations/'+name+'.sql','utf8'));
 await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())',[user,'synthetic-install@example.invalid']);
 await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[session,user]);
 await db.query('select public.customer_authorize($1,$2)',[user,session]);
 await db.query('update cluera_billing_private.processing_owner set account_digest=$1',[digest]);
 await db.query(`insert into cluera_billing_private.intents(user_id,request_id,revision_id,account_digest,epoch,state,order_id)
 select $1,$2,id,$3,1,'BOUND','order_syntheticretained01'from cluera_billing_private.catalog_revisions where offer_code='cluera_pack_3h_v2'limit 1`,[user,randomUUID(),digest]);
},60000);
afterEach(async()=>db?.close());
it('installs once with existing trial/order preserved, all Live gates off and Test still spendable',async()=>{
 const migrations=readdirSync('../supabase/migrations').filter(name=>name.endsWith('_cluera_live_infrastructure_disabled.sql'));
 expect(migrations).toHaveLength(1);expect(readFileSync('../supabase/migrations/'+migrations[0],'utf8')).toBe(prepare());
 const before=(await db.query("select public.cluera_credits_read($1,$2)-'serverTime'v",[user,session])).rows[0].v;
 await db.exec(prepare());
 expect((await db.query("select public.cluera_credits_read($1,$2)-'serverTime'v",[user,session])).rows[0].v).toEqual(before);
 expect((await db.query('select state,order_id from cluera_billing_private.intents')).rows).toEqual([{state:'BOUND',order_id:'order_syntheticretained01'}]);
 expect((await db.query('select public.cluera_live_billing_operations_health()v')).rows[0].v).toMatchObject({activeBank:'test',intakeEnabled:false,checkoutEnabled:false,pendingCount:0});
 await expect(db.exec(prepare())).rejects.toThrow('precondition'); await db.exec('rollback');
 expect((await db.query('select count(*)::int n from public.customer_trial_grants')).rows[0].n).toBe(1);
});
it('rolls back all DDL if an unexpected existing implementation would be overwritten',async()=>{
 await db.exec("create or replace function public.customer_usage_balance_base(p_user_id uuid,p_session_id uuid)returns jsonb language plpgsql security definer set search_path=''as $$begin return '{}'::jsonb;end$$;");
 await expect(db.exec(prepare())).rejects.toThrow('Existing function implementation was not preserved'); await db.exec('rollback');
 expect((await db.query("select to_regnamespace('cluera_live_billing_private')is null absent")).rows[0].absent).toBe(true);
 expect((await db.query('select count(*)::int n from cluera_billing_private.intents')).rows[0].n).toBe(1);
});
it('refuses installation during active usage and leaves the trial reservation intact',async()=>{
 const run=randomUUID();await db.query("select public.customer_usage_command($1,$2,$3,0,'START')",[user,session,run]);
 const before=(await db.query('select to_jsonb(g)v from public.customer_usage_grants g')).rows;
 await expect(db.exec(prepare())).rejects.toThrow('Usage must drain');await db.exec('rollback');
 expect((await db.query('select to_jsonb(g)v from public.customer_usage_grants g')).rows).toEqual(before);
 expect((await db.query("select to_regnamespace('cluera_live_billing_private')is null absent")).rows[0].absent).toBe(true);
});
