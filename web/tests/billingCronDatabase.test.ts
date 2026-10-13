import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;
    create schema vault;create table vault.decrypted_secrets(id uuid primary key default gen_random_uuid(),name text,decrypted_secret text);
    create function vault.create_secret(text,text,text) returns uuid language sql as $$insert into vault.decrypted_secrets(decrypted_secret,name) values($1,$2) returning id$$;
    create schema net;create table net.http_request_queue(id bigserial,url text,headers jsonb);create table net._http_response(id bigint);
    create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$insert into net.http_request_queue(url,headers) values($1,$2) returning id$$;
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    create table public.customer_billing_jobs(state text,available_at timestamptz);
    create table public.customer_billing_outbox(state text,available_at timestamptz);`);
  // Only unavailable external transport extensions are stubbed. Actual function SQL runs.
  await db.exec(readFileSync('../supabase/migrations/20261004082931_staging_billing_cron.sql','utf8').replace(/^create extension .*;$/gm,''));
},60000);
afterAll(async()=>db?.close());
describe('staging-only cron provisioning and bounded wake-up SQL',()=>{
  it('provisions once without enabling and accepts no other project',async()=>{
    const secret='a'.repeat(64);
    const call=async(s:string,p:string)=>(await db.query<{ok:boolean}>('select public.customer_billing_provision_worker($1,$2) ok',[s,p])).rows[0].ok;
    expect(await call(secret,'bzccuqforilpifhiysjk')).toBe(false);expect(await call('invalid','dwqltsqumiwsxtkzdoaa')).toBe(false);
    expect(await call(secret,'dwqltsqumiwsxtkzdoaa')).toBe(true);expect(await call('b'.repeat(64),'dwqltsqumiwsxtkzdoaa')).toBe(false);
    await db.exec('select billing_private.wake_worker()');
    expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(0);
  });
  it('uses only fixed HTTPS target and throttles idle checks; due retries wake it',async()=>{
    await db.exec('update billing_private.worker_config set enabled=true;select billing_private.wake_worker();select billing_private.wake_worker();');
    const rows=(await db.query<{url:string;headers:any}>('select url,headers from net.http_request_queue')).rows;
    expect(rows).toHaveLength(1);expect(rows[0].url).toBe('https://sigmaround-account-staging.vercel.app/api/internal/billing/tick');
    expect(rows[0].headers.Authorization).toBe('Bearer '+'a'.repeat(64));
    await db.exec("update billing_private.worker_config set last_sent_at=now()-interval '2 minutes';select billing_private.wake_worker();");
    expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(1);
    await db.exec("insert into public.customer_billing_jobs values('READY',now());select billing_private.wake_worker();");
    expect((await db.query('select * from net.http_request_queue')).rows).toHaveLength(2);
  });
  it('denies browser provisioning and all non-owner access to wake-up/config',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      expect((await db.query<{ok:boolean}>("select has_schema_privilege($1,'billing_private','USAGE') ok",[role])).rows[0].ok).toBe(false);
      expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'billing_private.wake_worker()','EXECUTE') ok",[role])).rows[0].ok).toBe(false);
    }
    for(const role of ['anon','authenticated'])expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'public.customer_billing_provision_worker(text,text)','EXECUTE') ok",[role])).rows[0].ok).toBe(false);
  });
  it('closes the service provisioning bridge after configuration',async()=>{
    await db.exec(readFileSync('../supabase/migrations/20261004083145_seal_staging_billing_provisioning.sql','utf8'));
    expect((await db.query<{ok:boolean}>("select has_function_privilege('service_role','public.customer_billing_provision_worker(text,text)','EXECUTE') ok")).rows[0].ok).toBe(false);
  });
});
