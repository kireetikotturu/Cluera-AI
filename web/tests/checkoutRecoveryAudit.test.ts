import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db:PGlite;
const id='11111111-1111-4111-8111-111111111111';
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
  create schema billing_private;revoke all on schema billing_private from public,anon,authenticated,service_role;
  create table public.customer_checkout_intents(id uuid primary key,state text);
  insert into public.customer_checkout_intents values('${id}','UNCERTAIN');`);
  await db.exec(readFileSync('../supabase/migrations/20261004093908_checkout_recovery_audit.sql','utf8'));
},60000);
afterAll(async()=>db?.close());
it('rolls back the state change if the audit reason is invalid',async()=>{
  await expect(db.transaction(async tx=>{await tx.exec(`update public.customer_checkout_intents set state='REJECTED' where id='${id}'`);
    await tx.query(`insert into billing_private.checkout_recovery_audit(intent_id,reason,authorization_reason,evidence,before_row,after_row)
    values($1,'bad','Owner explicitly authorized recovery','{}',$2,$3)`,[id,{id,state:'UNCERTAIN'},{id,state:'REJECTED'}]);
  })).rejects.toThrow();
  expect((await db.query<{state:string}>('select state from public.customer_checkout_intents')).rows[0].state).toBe('UNCERTAIN');
});
it('atomically records a reason with the exact before/after state, and refuses duplicates',async()=>{
  await db.transaction(async tx=>{await tx.exec(`update public.customer_checkout_intents set state='REJECTED' where id='${id}'`);
    await tx.query(`insert into billing_private.checkout_recovery_audit(intent_id,reason,authorization_reason,evidence,before_row,after_row)
    values($1,'Authoritative GET found no transaction','Owner explicitly authorized recovery','{"transactions":0}',$2,$3)`,[id,{id,state:'UNCERTAIN'},{id,state:'REJECTED'}]);});
  expect((await db.query('select * from billing_private.checkout_recovery_audit')).rows).toHaveLength(1);
  await expect(db.exec('insert into billing_private.checkout_recovery_audit select * from billing_private.checkout_recovery_audit')).rejects.toThrow();
});
it('rejects UPDATE, DELETE and TRUNCATE even for the normal table owner',async()=>{
  for(const sql of ["update billing_private.checkout_recovery_audit set reason='replacement audit reason'",'delete from billing_private.checkout_recovery_audit','truncate billing_private.checkout_recovery_audit']){
    await expect(db.exec(sql)).rejects.toThrow('append-only');
  }
  expect((await db.query('select * from billing_private.checkout_recovery_audit')).rows).toHaveLength(1);
});
it('denies browser and service roles every table privilege and trigger execution',async()=>{
  for(const role of ['anon','authenticated','service_role']){
    for(const privilege of ['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'])expect((await db.query<{ok:boolean}>("select has_table_privilege($1,'billing_private.checkout_recovery_audit',$2) ok",[role,privilege])).rows[0].ok).toBe(false);
    expect((await db.query<{ok:boolean}>("select has_function_privilege($1,'billing_private.reject_checkout_audit_mutation()','EXECUTE') ok",[role])).rows[0].ok).toBe(false);
  }
});
