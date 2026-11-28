import {readFileSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {readCredits} from '../lib/accounts/credits';
import {usageService} from '../lib/usage/service';
import {CLUERA_SUPABASE_URL} from '../lib/supabase/target';

// Entirely synthetic, in-memory PostgreSQL, built from the same scripts as the live database, with Live billing on.
const NEW='20261128120000_cluera_admin_time_and_unlimited.sql';
const HOUR=3_600_000,TRIAL=900_000,FOREVER=35_996_400_000;
let db:PGlite;let bugBalance:any,bugAdminView:any;
const people:Record<string,{id:string;session:string;second:string}>={};
const admin=()=>people.admin;
const call=async(sql:string,args:unknown[]=[])=>(await db.query<{value:any}>(sql,args)).rows[0]?.value;
const rpc=async(name:string,args:Record<string,unknown>)=>{
 const entries=Object.entries(args);
 try{return {data:await call(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')}) value`,entries.map(([,value])=>value)),error:null};}
 catch(error){return {data:null,error};}
};
const usageEnv={SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://www.clueraai.in',NEXT_PUBLIC_SUPABASE_URL:CLUERA_SUPABASE_URL} as unknown as NodeJS.ProcessEnv;
/** The exact adapter the deployed relay and website use, so their strict reply shapes are checked too. */
const usage=()=>usageService(rpc,usageEnv);
const who=(name:string,device:'session'|'second'='session')=>({userId:people[name].id,sessionId:people[name][device]});
const balance=(name:string)=>usage().balance(who(name));
const run=async(name:string,action:'START'|'CHECKPOINT'|'STOP',runId:string,sequence:number,device:'session'|'second'='session')=>
 usage().command(who(name,device),{runId,sequence,action});
const adjust=async(action:string,subject:string,input:object,operation=randomUUID())=>call(
 'select public.account_admin_adjust($1,$2,$3,$4,$5,$6,$7) value',[admin().id,admin().session,operation,people[subject].id,action,'Synthetic admin change for a test',input]);
const mutate=async(action:string,subject:string,input:object={},operation=randomUUID())=>call(
 'select public.account_admin_mutate($1,$2,$3,$4,$5,$6,$7) value',[admin().id,admin().session,operation,people[subject].id,action,'Synthetic admin change for a test',input]);
const adminRead=(subject:string)=>call('select public.account_admin_read_v2($1,$2,$3) value',[admin().id,admin().session,people[subject].id]);
const grants=async(name:string)=>(await db.query<any>('select * from public.customer_usage_grants where user_id=$1 order by starts_at,id',[people[name].id])).rows;
const unlimited=async(name:string)=>call('select public.cluera_unlimited_status($1) value',[people[name].id]);
/** Time passing for running slices: moves them into the past by this much. */
const passTime=(milliseconds:number)=>db.query(`update public.customer_usage_windows set starts_at=starts_at-$1::int*interval '1 millisecond',
 expires_at=expires_at-$1::int*interval '1 millisecond' where expires_at>now()-interval '1 second'`,[milliseconds]);
const windowGrant=async(runId:string)=>(await db.query<any>(`select g.kind,g.source_key,w.reserved_ms from public.customer_usage_windows w
 join public.customer_usage_grants g on g.id=w.grant_id where w.run_id=$1 order by w.sequence desc limit 1`,[runId])).rows[0];
async function person(name:string){
 const entry={id:randomUUID(),session:randomUUID(),second:randomUUID()};people[name]=entry;
 await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[entry.id,`${name}@example.invalid`]);
 for(const session of [entry.session,entry.second])await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,entry.id]);
 expect((await call('select public.customer_authorize($1,$2) value',[entry.id,entry.session])).code).toBe('ACTIVE');
}

beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
  create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
  create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
  create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
 const chain=readdirSync('../supabase/migrations').filter(name=>name>='20261016014532'&&name<NEW).sort();
 for(const name of chain)await db.exec(readFileSync(`../supabase/migrations/${name}`,'utf8'));
 await db.exec(`alter table cluera_billing_runtime_private.active_bank disable trigger cluera_bank_change;
  update cluera_billing_runtime_private.active_bank set mode='live';
  alter table cluera_billing_runtime_private.active_bank enable trigger cluera_bank_change;`);
 for(const name of ['admin','alice','bob','carol','dave','erin'])await person(name);
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[admin().id]);
 // The reported problem, on the live database as it is today: Admin adds an hour and the customer never gets it.
 expect((await adjust('ADD_MINUTES','alice',{minutes:60})).code).toBe('APPLIED');
 bugBalance=await balance('alice');bugAdminView=await adminRead('alice');
 await db.exec(readFileSync(`../supabase/migrations/${NEW}`,'utf8'));
},120000);
afterAll(async()=>db?.close());

describe('Admin-added time',()=>{
 it('was shown to the Admin but never reached the customer before this change',()=>{
  expect(bugBalance.availableMilliseconds).toBe(TRIAL);
  expect(bugAdminView.balances.PACK).toBe(HOUR);
 });
 it('now counts, including time added before this change, and sessions use it before the free trial',async()=>{
  expect((await balance('alice')).availableMilliseconds).toBe(TRIAL+HOUR);
  const id=randomUUID();expect((await run('alice','START',id,0)).code).toBe('ACTIVE');
  expect((await windowGrant(id)).source_key).toMatch(/^admin-adjustment:/);
  await passTime(20_000);await run('alice','STOP',id,1);
  expect((await balance('alice')).availableMilliseconds).toBeGreaterThanOrEqual(TRIAL+HOUR-21_000);
  expect((await balance('alice')).availableMilliseconds).toBeLessThanOrEqual(TRIAL+HOUR-20_000);
 });
 it('reduces only time that counts, never a test purchase',async()=>{
  await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,starts_at) values($1,'razorpay-test:synthetic','PACK',$2,now())",[people.bob.id,10*HOUR]);
  await adjust('ADD_MINUTES','bob',{minutes:90});
  expect((await adminRead('bob')).balances.PACK).toBe(90*60_000);
  expect((await adjust('REDUCE_MINUTES','bob',{minutes:30})).code).toBe('APPLIED');
  const rows=await grants('bob');
  expect(rows.find(row=>row.source_key==='razorpay-test:synthetic')).toMatchObject({spent_ms:0});
  expect((await balance('bob')).availableMilliseconds).toBe(TRIAL+60*60_000);
  expect((await adjust('REDUCE_MINUTES','bob',{minutes:61})).code).toBe('INSUFFICIENT_UNUSED');
  const read=await adminRead('bob');
  expect(read.grants.find((grant:any)=>grant.counted===false)).toBeTruthy();
  const added=read.grants.find((grant:any)=>grant.adminAdjustment);expect(added.counted).toBe(true);
  expect((await adjust('REMOVE_MINUTES','bob',{minutes:10,grantId:added.id})).code).toBe('APPLIED');
  expect((await balance('bob')).availableMilliseconds).toBe(TRIAL+50*60_000);
  const workspace=await call("select public.customer_workspace($1,$2,'READ') value",[people.bob.id,people.bob.session]);
  expect(workspace.balances.PACK).toBe(50*60_000);
 });
});

describe('Unlimited access (Admin only)',()=>{
 it('is given for each chosen period, replaces the earlier one, and shows its end',async()=>{
  const periods:[string,string|null][]=[['DAY','1 day'],['WEEK','7 days'],['MONTH','1 month'],['QUARTER','3 months'],['YEAR','1 year'],['FOREVER',null]];
  for(const [duration,interval] of periods){
   expect((await mutate('GRANT_UNLIMITED','carol',{duration})).code).toBe('APPLIED');
   const status=await unlimited('carol');
   if(interval===null){expect(status.endsAt).toBeNull();expect(status.compatibleMilliseconds).toBe(FOREVER);}
   else{
    expect(await call(`select abs(extract(epoch from ($1::timestamptz-(now()+$2::interval))))<60 value`,[status.endsAt,interval])).toBe(true);
    expect(status.compatibleMilliseconds).toBeGreaterThan(80_000_000);
   }
   expect((await grants('carol')).filter(row=>row.kind==='UNLIMITED'&&row.state==='ACTIVE')).toHaveLength(1);
  }
  expect((await mutate('GRANT_UNLIMITED','carol',{duration:'FORTNIGHT'})).code).toBe('INVALID');
  expect((await mutate('GRANT_UNLIMITED','carol',{duration:'DAY',minutes:5})).code).toBe('INVALID');
 });
 it('is used first so bought time stays saved, and older apps and the relay read replies they already understand',async()=>{
  await adjust('ADD_MINUTES','carol',{minutes:30});
  const view=await balance('carol');
  expect(view.availableMilliseconds).toBe(TRIAL+30*60_000+FOREVER);
  const credits=await readCredits(rpc,{userId:people.carol.id,sessionId:people.carol.session});
  expect(credits.buckets.map(bucket=>bucket.kind).sort()).toEqual(['MANUAL','TRIAL']);
  const id=randomUUID();const started=await run('carol','START',id,0);
  expect(started).toMatchObject({code:'ACTIVE',allocation:'PACK',reservedMilliseconds:30_000});
  expect((await windowGrant(id)).kind).toBe('UNLIMITED');
  await passTime(20_000);expect(await run('carol','CHECKPOINT',id,1)).toMatchObject({code:'ACTIVE'});
  await passTime(20_000);await run('carol','STOP',id,2);
  const after=await balance('carol');
  expect(after.availableMilliseconds).toBe(TRIAL+30*60_000+FOREVER);
  expect(after.spentMilliseconds).toBeGreaterThanOrEqual(40_000);
  expect((await adjust('REDUCE_MINUTES','carol',{minutes:31})).code).toBe('INSUFFICIENT_UNUSED');
  const forever=(await grants('carol')).find(row=>row.kind==='UNLIMITED'&&row.state==='ACTIVE');
  expect((await adjust('REMOVE_MINUTES','carol',{minutes:1,grantId:forever.id})).code).toBe('INVALID');
 });
 it('moves a running session onto saved time when Admin removes it, and ends it only when nothing is left',async()=>{
  const id=randomUUID();await run('carol','START',id,0);expect((await windowGrant(id)).kind).toBe('UNLIMITED');
  expect((await mutate('REVOKE_UNLIMITED','carol')).code).toBe('APPLIED');
  expect((await mutate('REVOKE_UNLIMITED','carol')).code).toBe('NOT_FOUND');
  expect(await unlimited('carol')).toBeNull();
  await passTime(20_000);expect(await run('carol','CHECKPOINT',id,1)).toMatchObject({code:'ACTIVE'});
  expect((await windowGrant(id)).source_key).toMatch(/^admin-adjustment:/);
  await run('carol','STOP',id,2);
  await db.query("update public.customer_usage_grants set spent_ms=granted_ms-reserved_ms where user_id=$1 and kind<>'UNLIMITED'",[people.carol.id]);
  await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,spent_ms,starts_at) values($1,'lifetime-trial','TRIAL',900000,900000,now()) on conflict(user_id,source_key) do update set spent_ms=900000",[people.carol.id]);
  await mutate('GRANT_UNLIMITED','carol',{duration:'DAY'});
  const next=randomUUID();expect((await run('carol','START',next,0)).code).toBe('ACTIVE');
  await mutate('REVOKE_UNLIMITED','carol');
  await passTime(20_000);expect((await run('carol','CHECKPOINT',next,1)).code).toBe('EXHAUSTED');
 });
 it('hands over to saved time in its last seconds, and is still used when it is all there is',async()=>{
  await mutate('GRANT_UNLIMITED','dave',{duration:'DAY'});
  const expiring=()=>db.query("update public.customer_usage_grants set expires_at=now()+interval '4 seconds' where user_id=$1 and kind='UNLIMITED' and state='ACTIVE'",[people.dave.id]);
  await expiring();
  const first=randomUUID();await run('dave','START',first,0);
  expect((await windowGrant(first)).kind).toBe('TRIAL');await run('dave','STOP',first,1);
  await db.query("update public.customer_usage_grants set spent_ms=granted_ms-reserved_ms where user_id=$1 and kind='TRIAL'",[people.dave.id]);
  await expiring();
  const last=randomUUID();const reply=await run('dave','START',last,0);
  expect((await windowGrant(last)).kind).toBe('UNLIMITED');expect((reply as {reservedMilliseconds:number}).reservedMilliseconds).toBeLessThanOrEqual(4_000);
  await db.query("update public.customer_usage_grants set expires_at=starts_at+interval '1 millisecond' where user_id=$1 and kind='UNLIMITED'",[people.dave.id]);
  expect(await unlimited('dave')).toBeNull();
  expect((await balance('dave')).availableMilliseconds).toBe(0);
 });
 it('marks the customer in Admin, and only the server may read the status',async()=>{
  await mutate('GRANT_UNLIMITED','bob',{duration:'MONTH'});
  const read=await adminRead('bob');
  expect(read.users[0].unlimited.endsAt).toBeTruthy();
  expect(read.balances.UNLIMITED).toBeUndefined();
  expect(read.grants.find((grant:any)=>grant.kind==='UNLIMITED')).toMatchObject({state:'ACTIVE',counted:true});
  for(const role of ['anon','authenticated'])expect(await call(`select has_function_privilege($1,'public.cluera_unlimited_status(uuid)','execute') value`,[role])).toBe(false);
  expect(await call(`select has_function_privilege('service_role','public.cluera_unlimited_status(uuid)','execute') value`)).toBe(true);
 });
});

describe('Blocking',()=>{
 it('ends running sessions on every device at once, refuses new ones, and unblocking restores them',async()=>{
  await mutate('GRANT_UNLIMITED','erin',{duration:'WEEK'});
  const phone=randomUUID(),laptop=randomUUID();
  await run('erin','START',phone,0);await run('erin','START',laptop,0,'second');
  expect((await mutate('SUSPEND','erin')).code).toBe('APPLIED');
  const runs=(await db.query<any>('select state from public.customer_usage_runs where user_id=$1',[people.erin.id])).rows;
  expect(runs.map(row=>row.state)).toEqual(['DENIED','DENIED']);
  await expect(run('erin','CHECKPOINT',phone,1)).rejects.toMatchObject({status:403});
  await expect(run('erin','START',randomUUID(),0)).rejects.toMatchObject({status:403});
  await expect(balance('erin')).rejects.toMatchObject({status:403});
  expect((await mutate('REACTIVATE','erin')).code).toBe('APPLIED');
  expect((await run('erin','START',randomUUID(),0)).code).toBe('ACTIVE');
 });
 it('never lets an administrator block their own account',async()=>{
  expect((await mutate('SUSPEND','admin')).code).toBe('INVALID');
  expect((await call('select public.customer_authorize($1,$2) value',[admin().id,admin().session])).code).toBe('ACTIVE');
 });
});

describe('One account on several devices',()=>{
 it('each device runs on its own while both draw from one balance',async()=>{
  await person('twin');
  await db.query("insert into public.customer_usage_grants(user_id,source_key,kind,granted_ms,spent_ms,starts_at) values($1,'lifetime-trial','TRIAL',900000,900000,now()) on conflict(user_id,source_key) do update set spent_ms=900000",[people.twin.id]);
  await adjust('ADD_MINUTES','twin',{minutes:1});
  const a=randomUUID(),b=randomUUID();
  expect((await run('twin','START',a,0)).code).toBe('ACTIVE');
  expect((await run('twin','START',b,0,'second')).code).toBe('ACTIVE');
  expect((await run('twin','START',randomUUID(),0)).code).toBe('EXHAUSTED');
  await passTime(20_000);
  // Each device gets back what it did not use and the next slice is all that is left (a few ms under 10 s).
  for(const [runId,device] of [[a,'session'],[b,'second']] as const){
   const next=await run('twin','CHECKPOINT',runId,1,device) as {code:string;reservedMilliseconds:number};
   expect(next.code).toBe('ACTIVE');expect(next.reservedMilliseconds).toBeGreaterThan(9_000);expect(next.reservedMilliseconds).toBeLessThanOrEqual(10_000);
  }
  await passTime(10_000);
  await run('twin','STOP',a,2);await run('twin','STOP',b,2,'second');
  const used=(await grants('twin')).find(row=>row.source_key.startsWith('admin-'));
  expect(used.spent_ms+used.reserved_ms).toBe(60_000);
  expect(await balance('twin')).toMatchObject({availableMilliseconds:0,reservedMilliseconds:0});
 });
 it('lets request limits go above the old ceiling of 120, for devices sharing one network',async()=>{
  const bucket='b'.repeat(64);
  for(let i=0;i<130;i++)expect(await call('select public.customer_auth_rate_limit($1,600) value',[bucket])).toBe(true);
  expect(await call('select public.customer_auth_rate_limit($1,120) value',[bucket])).toBe(false);
  expect(await call('select public.customer_auth_rate_limit($1,6000) value',['c'.repeat(64)])).toBe(false);
 });
});
