import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,beforeAll,expect,it} from 'vitest';

let db:PGlite;
const admin=randomUUID(),adminSession=randomUUID(),alice=randomUUID(),aliceSession=randomUUID(),bob=randomUUID(),bobSession=randomUUID();
const credential=randomUUID();
const one=async(sql:string,args:unknown[]=[])=>(await db.query<any>(sql,args)).rows[0];
const value=async(sql:string,args:unknown[]=[])=>(await one(sql,args)).value;

async function startRun(user:string,session:string){
 const run=randomUUID();
 const reply=await value("select public.customer_usage_command($1,$2,$3,0,'START') value",[user,session,run]);
 expect(reply.code).toBe('ACTIVE');return run;
}
const stopRun=async(user:string,session:string,run:string)=>value("select public.customer_usage_command($1,$2,$3,1,'STOP') value",[user,session,run]);
/** Records a request the way the relay does. */
async function record(run:string,provider:string,model:string,usage:object|null,options:{device?:string|null;ref?:string|null;outcome?:string}={}){
 const operation=randomUUID();
 const started=await value('select public.cluera_provider_usage_start($1,$2,$3,$4,$5,1,$6,$7,0) value',
  [operation,run,provider,model,credential,options.device===undefined?'windows':options.device,options.ref??null]);
 expect(started.code).toBe('RECORDED');
 if(usage)expect((await value('select public.cluera_provider_usage_finish($1,$2,100,$3) value',[operation,options.outcome??'SUCCEEDED',usage])).code).toBe('RECORDED');
 return operation;
}
const cost=async(operation:string)=>{const row=await one('select cost_usd,unpriced from (select c.*,(c.cost_usd is null) unpriced from cluera_private.ai_usage_costed c) c where operation_id=$1',[operation]);return row.cost_usd===null?null:Number(row.cost_usd);};
const costs=async(from:string|null=null,to:string|null=null,actor=admin,session=adminSession)=>value('select public.cluera_admin_ai_costs($1,$2,$3,$4,$5) value',[actor,session,from,to,'Asia/Kolkata']);

beforeAll(async()=>{
 db=new PGlite();
 await db.exec('create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);');
 for(const name of ['20261016014532_cluera_clean_foundation','20261016015041_cluera_clean_provider_vault','20261019095939_cluera_provider_usage_metadata',
  '20261124120000_cluera_simple_ai_models','20261124190000_cluera_admin_usage_report','20261124191500_cluera_admin_reduce_time_fix',
  '20261124200000_provider_usage_all_answer_models',
  '20261126090000_cluera_ai_cost_tracking'])
  await db.exec(readFileSync(`../supabase/migrations/${name}.sql`,'utf8'));
 for(const [user,session,email] of [[admin,adminSession,'admin@example.invalid'],[alice,aliceSession,'alice@example.invalid'],[bob,bobSession,'bob@example.invalid']]){
  await db.query('insert into auth.users values($1,$2,now())',[user,email]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[session,user]);
 }
 await db.query('insert into public.account_admin_profiles(user_id) values($1)',[admin]);
},90000);
afterAll(async()=>db?.close());

it('prices each provider from its own reported usage',async()=>{
 const run=await startRun(alice,aliceSession);
 const gemini=await record(run,'gemini','gemini-3.5-flash',{servedModel:'gemini-3.6-flash',inputTokens:10_000,cachedTokens:4_000,outputTokens:500,thinkingTokens:100,totalTokens:10_600});
 // (6000×0.75 + 4000×0.075 + 600×3.75) per million
 expect(await cost(gemini)).toBeCloseTo(0.00705,8);
 const long=await record(run,'openai','gpt-6-luna',{servedModel:'gpt-6-luna-2026-09-15',inputTokens:300_000,cachedTokens:0,cacheWriteTokens:1_000,outputTokens:800,thinkingTokens:200});
 expect(await cost(long)).toBeCloseTo((299_000*0.20+1_000*0.25+1_000*0.75)/1e6,8);
 const claude=await record(run,'anthropic','claude-haiku-5-5',{inputTokens:1_000,cachedTokens:200,cacheWriteTokens:300,cacheWrite1hTokens:100,outputTokens:100,thinkingTokens:50,region:'us'});
 expect(await cost(claude)).toBeCloseTo((500*0.10+200*0.01+200*0.125+100*0.20+150*0.50)/1e6*1.1,8);
 const audio=await record(run,'deepgram','flux-general-en',{audioSentMilliseconds:600_000,audioWindowMilliseconds:590_000});
 expect(await cost(audio)).toBeCloseTo(10*0.0065,8);
 // A cheaper model whose name starts the same is never priced as the other one.
 const lite=await record(run,'gemini','gemini-3.5-flash-lite',{inputTokens:1_000_000,outputTokens:0});
 expect(await cost(lite)).toBeCloseTo(0.30,8);
 const unknown=await record(run,'gemini','gemini-9-ultra',{inputTokens:10,outputTokens:10});
 expect(await cost(unknown)).toBeNull();
 // Older receipts have only a total: the rest of the total is thinking.
 const derived=await record(run,'gemini','gemini-3.6-flash',{inputTokens:100,outputTokens:20,totalTokens:150});
 expect(await cost(derived)).toBeCloseTo((100*0.75+50*3.75)/1e6,8);
 await stopRun(alice,aliceSession,run);
});

it('keeps each day at that day’s price',async()=>{
 const run=await startRun(alice,aliceSession);
 const operation=randomUUID();
 await db.query("insert into cluera_private.ai_provider_usage_starts(operation_id,user_id,run_id,provider,credential_id,revision,model,device,started_at) values($1,$2,$3,'gemini',$4,1,'gemini-4-argon','windows','2026-12-02T00:00:00Z')",[operation,alice,run,credential]);
 await db.query("insert into cluera_private.ai_provider_usage_finishes(operation_id,outcome,elapsed_ms,usage_metadata,finished_at) values($1,'SUCCEEDED',1,'{\"inputTokens\":1000000,\"outputTokens\":0}','2026-12-02T00:00:01Z')",[operation]);
 expect(await cost(operation)).toBeCloseTo(4,8);
 await db.exec('alter table cluera_private.ai_provider_usage_finishes disable trigger ai_provider_usage_finishes_immutable;alter table cluera_private.ai_provider_usage_starts disable trigger ai_provider_usage_starts_immutable');
 await db.query('delete from cluera_private.ai_provider_usage_finishes where operation_id=$1',[operation]);
 await db.query('delete from cluera_private.ai_provider_usage_starts where operation_id=$1',[operation]);
 await db.exec('alter table cluera_private.ai_provider_usage_finishes enable always trigger ai_provider_usage_finishes_immutable;alter table cluera_private.ai_provider_usage_starts enable always trigger ai_provider_usage_starts_immutable');
 await stopRun(alice,aliceSession,run);
});

it('counts a running audio stream from its saved progress, and ignores rows from the old relay',async()=>{
 const run=await startRun(bob,bobSession);
 // Stopped at the end, so it does not count as a live session later.
 const live=await record(run,'deepgram','flux-general-en',null,{device:'web'});
 expect((await value('select public.cluera_provider_usage_progress($1,60000) value',[live])).code).toBe('RECORDED');
 expect((await value('select public.cluera_provider_usage_progress($1,30000) value',[live])).code).toBe('RECORDED');
 expect(await cost(live)).toBeCloseTo(0.0065,8);
 const old=await record(run,'gemini','gemini-3.6-flash',{inputTokens:5},{device:null});
 expect((await db.query('select 1 from cluera_private.ai_usage_costed where operation_id=$1',[old])).rows).toHaveLength(0);
 const text=await record(run,'gemini','gemini-3.6-flash',null,{device:'web'});
 expect((await value('select public.cluera_provider_usage_progress($1,1) value',[text])).code).toBe('NOT_FOUND');
 expect((await value('select public.cluera_provider_usage_finish($1,\'SUCCEEDED\',1,\'{"audioSentMilliseconds":120000}\') value',[live])).code).toBe('RECORDED');
 expect((await value('select public.cluera_provider_usage_progress($1,90000) value',[live])).code).toBe('FINISHED');
 expect(await cost(live)).toBeCloseTo(0.013,8);
 await stopRun(bob,bobSession,run);
});

it('accepts only the known receipt fields, as numbers and short names',async()=>{
 const run=await startRun(bob,bobSession);
 const operation=await record(run,'openai','gpt-6-luna',null);
 for(const bad of [{prompt:'x'},{servedModel:'has space'},{estimated:'yes'},{region:'x'.repeat(41)},{cacheWriteTokens:-1},{serviceTier:5}])
  expect((await value('select public.cluera_provider_usage_finish($1,\'FAILED\',1,$2) value',[operation,bad])).code).toBe('INVALID');
 expect((await value('select public.cluera_provider_usage_finish($1,\'CANCELLED\',1,$2) value',[operation,{estimated:true,inputTokens:40,outputTokens:5,serviceTier:'default'}])).code).toBe('RECORDED');
 expect((await value('select public.cluera_provider_usage_start($1,$2,\'openai\',\'gpt-6-luna\',$3,1,\'tablet\',null,0) value',[randomUUID(),run,credential])).code).toBe('INVALID');
 expect((await value('select public.cluera_provider_usage_start($1,$2,\'openai\',\'gpt-6-luna\',$3,1,\'windows\',null,0) value',[randomUUID(),randomUUID(),credential])).code).toBe('DENIED');
 await stopRun(bob,bobSession,run);
});

it('groups connections into sessions with start, end and running state',async()=>{
 await db.exec('alter table cluera_private.ai_provider_usage_finishes disable trigger all;alter table cluera_private.ai_provider_usage_starts disable trigger all;delete from cluera_private.ai_provider_usage_progress;delete from cluera_private.ai_provider_usage_finishes;delete from cluera_private.ai_provider_usage_starts');
 await db.exec('alter table cluera_private.ai_provider_usage_finishes enable trigger all;alter table cluera_private.ai_provider_usage_starts enable trigger all');
 const refA=randomUUID(),refB=randomUUID();
 const base=Date.parse((await one("select (now()-interval '5 hours')::text t")).t);
 const at=(minutes:number)=>new Date(base+minutes*60_000).toISOString();
 const user=randomUUID(),userSession=randomUUID();
 await db.query('insert into auth.users values($1,$2,now())',[user,'carol@example.invalid']);
 await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[userSession,user]);
 async function pastRun(minute:number,length:number,device:string,ref:string|null,audioMs:number,live=false){
  const run=await startRun(user,userSession);
  if(!live)await stopRun(user,userSession,run);
  await db.query('update public.customer_usage_runs set created_at=$2 where run_id=$1',[run,at(minute)]);
  if(!live){
   await db.query('update public.customer_usage_windows set starts_at=$2::timestamptz,expires_at=$2::timestamptz+reserved_ms*interval \'1 millisecond\' where run_id=$1',[run,at(minute)]);
   await db.query('update public.customer_usage_settlements set created_at=$2,spent_ms=$3,released_ms=30000-$3 where run_id=$1',[run,at(minute+length),Math.min(29_000,length*1000)]);
  }
  const operation=randomUUID();
  await db.query("insert into cluera_private.ai_provider_usage_starts(operation_id,user_id,run_id,provider,credential_id,revision,model,device,session_ref,started_at) values($1,$2,$3,'deepgram',$4,1,'flux-general-en',$5,$6,$7)",[operation,user,run,credential,device,ref,at(minute)]);
  if(!live)await db.query("insert into cluera_private.ai_provider_usage_finishes(operation_id,outcome,elapsed_ms,usage_metadata,finished_at) values($1,'STOPPED',1,$2,$3)",[operation,{audioSentMilliseconds:audioMs},at(minute+length)]);
 }
 await pastRun(0,2,'windows',null,60_000);
 await pastRun(4,2,'windows',null,60_000);      // a reconnect two minutes later: same session
 await pastRun(20,2,'windows',null,60_000);     // 14 quiet minutes: a new session
 await pastRun(5,2,'web',null,60_000);          // the phone is its own session
 await pastRun(100,2,'windows',refA,60_000);
 await pastRun(120,2,'windows',refA,60_000);    // same app session, 18 minute pause: still the same
 await pastRun(123,2,'windows',refB,60_000);    // a different app session starts at once
 await pastRun(200,0,'web',refB,0,true);        // live now
 const report=await costs();
 expect(report.code).toBe('ACTIVE');
 const sessions=report.sessions.filter((s:any)=>s.userId===user);
 expect(sessions).toHaveLength(6);
 expect(sessions[0]).toMatchObject({running:true,endedAt:null,device:'web',email:'carol@example.invalid'});
 const byStart=[...sessions].sort((a:any,b:any)=>Date.parse(a.startedAt)-Date.parse(b.startedAt));
 expect(byStart.map((s:any)=>[s.device,Math.round((Date.parse(s.startedAt)-base)/60_000),s.running?null:Math.round((Date.parse(s.endedAt)-base)/60_000),s.audioMs]))
  .toEqual([['windows',0,6,120_000],['web',5,7,60_000],['windows',20,22,60_000],['windows',100,122,120_000],['windows',123,125,60_000],['web',200,null,0]]);
 expect(report.totals).toMatchObject({sessions:6,liveNow:1,audioMs:420_000,unpriced:0});
 expect(Number(report.totals.costUsd)).toBeCloseTo(7*0.0065,6);
 const row=report.customers.find((c:any)=>c.userId===user);
 expect(row).toMatchObject({email:'carol@example.invalid',sessions:6,running:true,audioMs:420_000});
 expect(report.models).toEqual([expect.objectContaining({provider:'deepgram',model:'flux-general-en',audioMs:420_000})]);
 expect(report.days.length).toBeGreaterThanOrEqual(1);
 expect(report.providerDays[0]).toMatchObject({provider:'deepgram'});
 expect(report.prices.some((p:any)=>p.model==='gemini-4-argon'&&p.from==='2026-12-01')).toBe(true);
 // Only sessions that started in the chosen period.
 const later=await costs(at(99),at(199));
 expect(later.totals.sessions).toBe(2);expect(later.timeZone).toBe('Asia/Kolkata');
 expect((await value('select public.cluera_admin_ai_costs($1,$2,null,null,$3) value',[admin,adminSession,'Not/AZone'])).timeZone).toBe('UTC');
});

it('gives the Customers tab the same priced numbers, for admins only',async()=>{
 const all=await value('select public.cluera_admin_usage_report($1,$2,null) value',[admin,adminSession]);
 expect(all.code).toBe('ACTIVE');
 // The earlier fix stays: time used comes from settlements, and time the Admin removed is shown apart.
 const settled=Number((await one('select coalesce(sum(spent_ms),0) v from public.customer_usage_settlements')).v);
 expect(Number(all.overall.usedMs)).toBe(settled);
 const detail=await value('select public.cluera_admin_usage_report($1,$2,$3) value',[admin,adminSession,all.customers.find((c:any)=>c.usage.length).userId]);
 expect(detail).toMatchObject({code:'ACTIVE',adminReducedMs:0});expect('spentByKind' in detail).toBe(false);
 expect(detail.models.length).toBeGreaterThan(0);expect(detail.models.every((m:any)=>'costUsd' in m&&'unpriced' in m)).toBe(true);
 expect(detail.sessions.every((run:any)=>run.usage.every((m:any)=>'costUsd' in m))).toBe(true);
 const total=all.overall.usage.reduce((sum:number,row:any)=>sum+Number(row.costUsd),0);
 expect(total).toBeCloseTo(Number((await costs()).totals.costUsd),6);
 expect((await costs(null,null,alice,aliceSession)).code).toBe('FORBIDDEN');
 await db.exec("update auth.sessions set aal='aal1'");expect((await costs()).code).toBe('FORBIDDEN');await db.exec("update auth.sessions set aal='aal2'");
});

it('keeps every new table, view and function closed to the browser',async()=>{
 for(const table of ['ai_provider_usage_progress','ai_price_book','ai_usage_costed'])
  for(const role of ['anon','authenticated','service_role'])expect((await one("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE') allowed",[role,`cluera_private.${table}`])).allowed).toBe(false);
 for(const fn of ['cluera_provider_usage_start','cluera_provider_usage_finish','cluera_provider_usage_progress','cluera_admin_ai_costs','cluera_admin_usage_report']){
  const rows=(await db.query<any>('select oid,prosecdef,proconfig from pg_proc where proname=$1',[fn])).rows;expect(rows).toHaveLength(1);
  expect(rows[0].prosecdef).toBe(true);expect(rows[0].proconfig).toContain('search_path=""');
  for(const role of ['anon','authenticated','service_role'])expect((await one("select has_function_privilege($1,$2::oid,'EXECUTE') allowed",[role,rows[0].oid])).allowed).toBe(role==='service_role');
 }
});
