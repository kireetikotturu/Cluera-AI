import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {GET} from '../app/api/account/admin/billing/cluera/native-commands/route';
import {adminNativeCommandsRequest} from '../lib/payments/cluera/adminNativeCommands';
import {nativeCommandsSchema} from '../lib/payments/cluera/adminNativeCommandContracts';
import {merchantDigest} from '../lib/payments/cluera/config';
import {accountConfig} from '../lib/accounts/config';
import {seal} from '../lib/accounts/cookies';
import {paymentTestEnvironment} from './helpers/paymentTestMode';
const mocks=vi.hoisted(()=>({clients:vi.fn()}));vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const site='https://cluera-ai-staging.vercel.app',path='/api/account/admin/billing/cluera/native-commands';
const first={userId:randomUUID(),sessionId:randomUUID()},second={userId:randomUUID(),sessionId:randomUUID()},digest=merchantDigest(paymentTestEnvironment);
const created='2026-01-01T00:00:00.000Z',sub='sub_review00000001';let db:PGlite,rpc:ReturnType<typeof vi.fn>,beforeDefinitions:unknown,afterDefinitions:unknown;
let transform:((name:string,value:unknown)=>unknown)|undefined;
function request(query='',owner=first,aal='aal2',recovery=false){const config=accountConfig();
 const access=`header.${Buffer.from(JSON.stringify({sub:owner.userId,session_id:owner.sessionId,aal,iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic-signature`;
 const cookies=[`__Host-sr-account-access=${seal(access,'access',config,3600)}`,`__Host-sr-account-refresh=${seal('synthetic-refresh','refresh',config,3600)}`,`__Host-sr-account-session=${seal(owner,'session',config,3600)}`];
 if(recovery)cookies.push(`__Host-sr-account-recovery-lock=${seal({sessionId:owner.sessionId,resetUntil:Date.now()+600000},'recovery-lock',config,3600)}`);
 return new Request(`${site}${path}${query?`?${query}`:''}`,{headers:{origin:site,cookie:cookies.join('; ')}});}
async function call(name:string,args:Record<string,unknown>){const entries=Object.entries(args);await db.exec('savepoint review_rpc');try{
 const value=(await db.query<{v:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')})v`,entries.map(([,value])=>value))).rows[0].v;
 await db.exec('release savepoint review_rpc');return value;
 }catch(error){await db.exec('rollback to savepoint review_rpc');await db.exec('release savepoint review_rpc');throw error;}}
const sql=()=>({p_actor:first.userId,p_session:first.sessionId,p_account_digest:digest,p_epoch:1,p_subject:null,p_after_created:null,p_after_id:null});
async function viewer(owner=first){const response=await GET(request('',owner));expect(response.status).toBe(200);return(await response.json()).viewer as string;}
const query=(viewer:string,extra:Record<string,string>={})=>new URLSearchParams({viewer,...extra}).toString();
async function snapshot(){const result:Record<string,unknown>={};for(const relation of['auth.users','auth.sessions','public.account_admin_profiles','public.customer_accounts',
 'public.customer_trial_grants','public.customer_usage_grants','cluera_billing_private.native_config','cluera_billing_private.native_outbox','cluera_billing_private.native_schedules',
 'cluera_billing_private.native_audit','cluera_billing_private.payments','cluera_billing_private.events','cluera_billing_private.applications'])result[relation]=
 (await db.query(`select coalesce(jsonb_agg(v order by v::text),'[]')v from(select to_jsonb(t)v from ${relation} t)q`)).rows[0].v;return result;}
async function seed(n:number,state='REVIEW',kind='RESCHEDULE',merchant=digest,epoch=1){
 const id=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 await db.query("insert into cluera_billing_private.native_outbox(id,user_id,subscription_id,schedule_version,action_key,kind,effective_at,state,claim_id,lease_until,account_digest,epoch,created_at,evidence)values($1,$2,$3,$4,$5,$6,$7,$8,$9,now()-interval '1 hour',$10,$11,$12,$13)",
 [id,first.userId,sub,n,`synthetic-key-${n}`,kind,kind==='RESCHEDULE'?'2026-11-01T00:00:00Z':null,state,randomUUID(),merchant,epoch,created,{private:'synthetic-secret-evidence'}]);return id;}
beforeAll(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 await db.exec(readFileSync('../docs/proposals/cluera-native-recurring.sql','utf8'));
 const definition="select jsonb_agg(jsonb_build_object('oid',p.oid,'body',pg_get_functiondef(p.oid),'acl',p.proacl)order by p.oid)v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','cluera_billing_private')and p.prokind='f'and p.proname<>'cluera_billing_admin_native_commands'";
 beforeDefinitions=(await db.query(definition)).rows[0].v;await db.exec(readFileSync('../docs/proposals/cluera-admin-native-commands-read.sql','utf8'));afterDefinitions=(await db.query(definition)).rows[0].v;
},60000);
beforeEach(async()=>{
 for(const[key,value]of Object.entries({...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED:'true',CLUERA_ADMIN_NATIVE_COMMANDS_READ_ENABLED:'true',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('No hosted/provider action allowed');}));await db.exec('begin');transform=undefined;
 for(const owner of[first,second]){await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())',[owner.userId,`${owner.userId}@example.invalid`]);await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[owner.sessionId,owner.userId]);await db.query('select public.customer_authorize($1,$2)',[owner.userId,owner.sessionId]);await db.query('insert into public.account_admin_profiles(user_id,active)values($1,true)',[owner.userId]);}
 const revision=(await db.query("select id from cluera_billing_private.catalog_revisions where offer_code='cluera_monthly_40h_v2'")).rows[0].id,intent=randomUUID();
 await db.query("update cluera_billing_private.processing_owner set account_digest=$1 where singleton",[digest]);
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id)values($1,$2,$3,$4,$5,1,'VERIFIED',$6)",[intent,first.userId,randomUUID(),revision,digest,sub]);
 await db.query("insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at)values($1,$2,$3,$4,$5,'ACTIVE',now())",[sub,first.userId,intent,revision,digest]);
 for(const[n,state]of['PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW','DONE','SUPERSEDED'].entries())await seed(n+1,state,state==='REVIEW'?'RESCHEDULE':'CANCEL_FUTURE');
 await seed(8,'UNCERTAIN','CANCEL_FUTURE',digest,2);
 const names=new Set(['customer_authorize','customer_auth_rate_limit','account_admin_check','cluera_billing_owner','cluera_billing_admin_native_commands']);
 rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{if(!names.has(name))throw Error('Unexpected claim/write/provider RPC');try{const value=await call(name,args);return{data:transform?transform(name,value):value,error:null,status:200};}catch(error){return{data:null,error,status:500};}});
 mocks.clients.mockReturnValue({service:{rpc},auth:{auth:{getUser:vi.fn(async(access:string)=>{const claims=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString());return{data:{user:(await db.query('select id,email,email_confirmed_at,is_anonymous from auth.users where id=$1',[claims.sub])).rows[0]},error:null};}),refreshSession:vi.fn(()=>{throw Error('No Auth action expected');})}}});
});
afterEach(async()=>{await db.exec('rollback');vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});afterAll(async()=>{await db?.close();});

it('proposal adds only a STABLE SELECT service RPC/index without changing prior function bodies or ACLs',async()=>{
 expect(afterDefinitions).toEqual(beforeDefinitions);const value=(await db.query("select p.provolatile,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'EXECUTE')anon,has_function_privilege('authenticated',p.oid,'EXECUTE')browser,has_function_privilege('service_role',p.oid,'EXECUTE')service,pg_get_functiondef(p.oid)body from pg_proc p where p.proname='cluera_billing_admin_native_commands'")).rows[0];
 expect(value).toMatchObject({provolatile:'s',prosecdef:true,anon:false,browser:false,service:true});expect(value.body).not.toMatch(/\b(insert|update|delete|truncate|perform|execute|claim_id|evidence|native_command_claim|native_command_finish)\b/i);
 expect(value.proconfig).toEqual(expect.arrayContaining(['search_path=""','TimeZone=UTC','statement_timeout=5s']));
});
it('absent read flag and unsupported methods stop before any Auth or native table read',async()=>{
 vi.stubEnv('CLUERA_ADMIN_NATIVE_COMMANDS_READ_ENABLED','false');expect((await GET(request())).status).toBe(404);expect(mocks.clients).not.toHaveBeenCalled();
 expect((await adminNativeCommandsRequest(new Request(`${site}${path}`,{method:'POST'}))).status).toBe(404);
});
it('actual encrypted same-session Admin+AAL2 BFF reads retained states without claims, private evidence or business/Auth changes',async()=>{
 const before=await snapshot(),tag=await viewer(),response=await GET(request(query(tag)));expect(response.status).toBe(200);const report=nativeCommandsSchema.parse(await response.json());
 expect(report.rows.map(row=>row.state)).toEqual(['PENDING','CLAIMED','ACCEPTED','UNCERTAIN','REVIEW']);expect(report.nextCursor).toBeNull();
 expect(await snapshot()).toEqual(before);expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(report)).not.toMatch(/claimId|claim_id|account_digest|synthetic-secret|synthetic-refresh|@example.invalid|evidence|action_key/);
 expect(JSON.stringify(report)).not.toContain(first.sessionId);expect(response.headers.get('cache-control')).toBe('no-store');
});
it('token/database AAL2, recovery and exact valid Admin/session viewer fences are mandatory',async()=>{
 const tag=await viewer();rpc.mockClear();expect((await GET(request(query(tag),first,'aal1'))).status).toBe(403);
 expect((await GET(request(query(tag),first,'aal2',true))).status).toBe(403);expect((await GET(request(query(tag),second))).status).toBe(403);
 const replacement={userId:first.userId,sessionId:randomUUID()};await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[replacement.sessionId,first.userId]);expect((await GET(request(query(tag),replacement))).status).toBe(403);
 await db.query("update auth.sessions set aal='aal1'where id=$1",[first.sessionId]);expect((await GET(request(query(tag)))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_native_commands')).toBe(false);
});
it('SQL independently rejects stale Admin/session/merchant/epoch and browser roles cannot invoke it',async()=>{
 for(const statement of['update public.account_admin_profiles set active=false',"update auth.sessions set aal='aal1'",'delete from auth.sessions',"update auth.users set banned_until=now()+interval '1 day'"]){
  await db.exec('savepoint denied');await db.exec(statement);expect(await call('cluera_billing_admin_native_commands',sql())).toEqual({code:'FORBIDDEN'});await db.exec('rollback to savepoint denied');await db.exec('release savepoint denied');}
 for(const altered of[{p_epoch:2},{p_account_digest:'b'.repeat(64)}])expect(await call('cluera_billing_admin_native_commands',{...sql(),...altered})).toEqual({code:'UNAVAILABLE'});
 for(const role of['anon','authenticated']){await db.exec('savepoint role_probe');await db.exec(`set local role ${role}`);await expect(db.query('select public.cluera_billing_admin_native_commands(null,null,null,null)')).rejects.toThrow();await db.exec('rollback to savepoint role_probe');await db.exec('release savepoint role_probe');}
});
it('tied-time oldest-first pages are unique and signed cursor ownership/customer filters cannot be rebound',async()=>{
 for(let n=9;n<=60;n++)await seed(n);const tag=await viewer(),firstPage=await GET(request(query(tag))),page=nativeCommandsSchema.parse(await firstPage.json());expect(page.rows).toHaveLength(50);
 const next=await GET(request(query(tag,{cursor:page.nextCursor!}))),rest=nativeCommandsSchema.parse(await next.json());expect(rest.rows).toHaveLength(7);expect(new Set([...page.rows,...rest.rows].map(row=>row.id)).size).toBe(57);
 rpc.mockClear();expect((await GET(request(query(tag,{cursor:page.nextCursor!,subject:first.userId})))).status).toBe(403);
 expect((await GET(request(query(tag,{cursor:`${page.nextCursor!.slice(0,-2)}xx`})))).status).toBe(400);
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_native_commands')).toBe(false);
});
it('private fields, invalid command relationships or a different subject never become an operator report',async()=>{
 const tag=await viewer();for(const change of[(v:any)=>{v.rows[0].claimId=randomUUID();},(v:any)=>{v.rows[0].evidence='secret';},(v:any)=>{v.rows[0].kind='RESCHEDULE';},(v:any)=>{v.subject=second.userId;}]){
  transform=(name,value)=>{if(name!=='cluera_billing_admin_native_commands')return value;const copy=structuredClone(value);change(copy);return copy;};const response=await GET(request(query(tag)));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'Native command review is unavailable.'});}
});
it('cross-site, duplicate/unknown parameters and a revoked sealed session never reach command SQL',async()=>{
 const tag=await viewer();rpc.mockClear();for(const value of[`${query(tag)}&viewer=${tag}`,`${query(tag)}&retry=true`])expect((await GET(request(value))).status).toBe(400);
 const cross=request(query(tag));cross.headers.set('origin','https://foreign.invalid');expect((await GET(cross)).status).toBe(403);
 await db.query('delete from auth.sessions where id=$1',[first.sessionId]);expect((await GET(request(query(tag)))).status).toBe(401);expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_native_commands')).toBe(false);
});
