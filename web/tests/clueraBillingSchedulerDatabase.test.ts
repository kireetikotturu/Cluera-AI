import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
import { CLUERA_WORKER_URL, workerProofMessage } from '../lib/payments/cluera/scheduler';

const proposal = readFileSync('../docs/proposals/cluera-billing-scheduler.sql', 'utf8');
const syntheticBody = "begin insert into billing_private.old_calls values(1);end";
const expectedPin = '16b84964784d66febb352cd646903404';
// This fixture substitutes only the fake old function's checksum. A separate
// assertion retains the exact production preflight pin; no hosted SQL is run.
const fixtureProposal = proposal.replace(expectedPin, createHash('md5').update(syntheticBody).digest('hex'));
async function fixture() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema billing_private;create schema cluera_billing_private;create schema vault;create schema extensions;create schema net;
    create table billing_private.old_calls(value integer);
    create table billing_private.worker_config(singleton boolean primary key,secret_id uuid,enabled boolean,last_sent_at timestamptz,last_request_id bigint);
    create table cluera_billing_private.processing_owner(singleton boolean primary key,owner text,epoch bigint,account_digest text);
    create table vault.decrypted_secrets(id uuid primary key,decrypted_secret text);
    create table net.requests(url text,body jsonb,params jsonb,headers jsonb,timeout_ms integer);
    create table extensions.proofs(message text,secret text);
    create function extensions.digest(text,text) returns bytea language sql as $$select decode('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a','hex')$$;
    create function extensions.hmac(message text,secret text,algorithm text) returns bytea language plpgsql as $$begin
      insert into extensions.proofs values(message,secret);return decode(repeat('a',64),'hex');end$$;
    create function net.http_post(url text,body jsonb,params jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language plpgsql as $$begin
      insert into net.requests values(url,body,params,headers,timeout_milliseconds);return 11;end$$;
    create function billing_private.wake_worker() returns void language plpgsql as $$${syntheticBody}$$;
    insert into billing_private.worker_config values(true,'00000000-0000-4000-8000-000000000900',true,null,null);
    insert into cluera_billing_private.processing_owner values(true,'account',1,null);
    insert into vault.decrypted_secrets values('00000000-0000-4000-8000-000000000900','synthetic-worker-key-00000000000000000');`);
  return db;
}
it('requires the exact reviewed old function pin and cannot schedule or switch ownership on apply', async () => {
  expect(proposal).toContain(expectedPin); expect(proposal).not.toMatch(/select\s+cron\.(schedule|unschedule)|select\s+public\.cluera_billing_cutover/i);
  const db = await fixture();
  try { await expect(db.exec(proposal)).rejects.toThrow(/scheduler body changed/); }
  finally { await db.close(); }
});
it('passive installation keeps only the existing Account dispatch until separately approved CAS', async () => {
  const db = await fixture();
  try {
    await db.exec(fixtureProposal);await db.exec('select billing_private.wake_worker()');
    expect((await db.query('select * from billing_private.old_calls')).rows).toHaveLength(1);
    expect((await db.query('select * from net.requests')).rows).toHaveLength(0);
    expect((await db.query<{owner:string}>('select owner from cluera_billing_private.processing_owner')).rows[0].owner).toBe('account');
    for (const role of ['anon','authenticated','service_role']) {
      const result = await db.query<{allowed:boolean}>("select has_function_privilege($1,'billing_private.wake_worker()','execute') allowed",[role]);
      expect(result.rows[0].allowed).toBe(false);
    }
  } finally { await db.close(); }
});
it('the approved Cluera branch queues only an exact short-lived proof, never a bearer or Vault credential', async () => {
  const db = await fixture();
  try {
    await db.exec(fixtureProposal);
    await db.exec("update cluera_billing_private.processing_owner set owner='cluera',epoch=2,account_digest=repeat('b',64);select billing_private.wake_worker();select billing_private.wake_worker();");
    const requests = (await db.query<{url:string;body:unknown;params:unknown;headers:Record<string,string>;timeout_ms:number}>('select * from net.requests')).rows;
    expect(requests).toHaveLength(1); const request=requests[0];
    expect(request).toMatchObject({url:CLUERA_WORKER_URL,body:{},params:{},timeout_ms:170000});
    expect(Object.keys(request.headers).sort()).toEqual(['Content-Type','X-Cluera-Billing-Epoch','X-Cluera-Billing-Nonce','X-Cluera-Billing-Proof','X-Cluera-Billing-Time'].sort());
    expect(JSON.stringify(request)).not.toMatch(/Bearer|synthetic-worker-key|SUPABASE/);
    const input=(await db.query<{message:string;secret:string}>('select * from extensions.proofs')).rows[0];
    expect(input.message).toBe(workerProofMessage(2,Number(request.headers['X-Cluera-Billing-Time']),request.headers['X-Cluera-Billing-Nonce'],'b'.repeat(64)));
    expect(input.secret).toBe('synthetic-worker-key-00000000000000000');
  } finally { await db.close(); }
});
it.each(["account_digest=null", "account_digest=repeat('b',64)"])('fails closed for missing merchant pin, disabled dispatch or malformed Vault key (%s)', async change => {
    const db=await fixture();try {
      await db.exec(fixtureProposal);await db.exec(`update cluera_billing_private.processing_owner set owner='cluera',${change}`);
      if (change.includes('repeat')) await db.exec("update vault.decrypted_secrets set decrypted_secret='short'");
      await db.exec('select billing_private.wake_worker()');expect((await db.query('select * from net.requests')).rows).toHaveLength(0);
      await db.exec("update cluera_billing_private.processing_owner set account_digest=repeat('b',64);update billing_private.worker_config set enabled=false;select billing_private.wake_worker()");
      expect((await db.query('select * from net.requests')).rows).toHaveLength(0);
    } finally {await db.close();}
});
