import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {GET} from '../app/api/account/payments/cluera/history/route';
import {accountConfig} from '../lib/accounts/config';
import {seal} from '../lib/accounts/cookies';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

// Full BFF/cookie/live-session/SQL chain, entirely synthetic. Only the Auth SDK
// response is intercepted; no hosted Auth, provider or database request occurs.
const mocks=vi.hoisted(()=>({clients:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const site='https://cluera-ai-staging.vercel.app';
const first={userId:randomUUID(),sessionId:randomUUID()},second={userId:randomUUID(),sessionId:randomUUID()};
const migration=readFileSync('../supabase/migrations/20261019085323_cluera_customer_billing_history.sql','utf8');
const frozenProposal=readFileSync('../docs/proposals/cluera-billing-history.sql','utf8');
const financialRelations=['auth.users','auth.sessions','public.customer_accounts','public.customer_trial_grants','public.customer_usage_grants',
 'cluera_billing_private.intents','cluera_billing_private.payments','cluera_billing_private.subscriptions',
 'cluera_billing_private.terms','cluera_billing_private.events','cluera_billing_private.applications'];
let db:PGlite,rpc:ReturnType<typeof vi.fn>,auth:Record<string,ReturnType<typeof vi.fn>>;
function token(owner=first){return `header.${Buffer.from(JSON.stringify({sub:owner.userId,session_id:owner.sessionId,
 iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',
 exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic-signature-not-real`;}
function request(owner=first,expected=owner.userId,recovery=false){
 const config=accountConfig(),credentials=[`__Host-sr-account-access=${seal(token(owner),'access',config,3600)}`,
  `__Host-sr-account-refresh=${seal('synthetic-refresh-credential','refresh',config,3600)}`,
  `__Host-sr-account-session=${seal(owner,'session',config,3600)}`];
 if(recovery)credentials.push(`__Host-sr-account-recovery-lock=${seal({sessionId:owner.sessionId,resetUntil:Date.now()+600000},'recovery-lock',config,3600)}`);
 return new Request(`${site}/api/account/payments/cluera/history?expectedAccountId=${expected}`,{headers:{origin:site,cookie:credentials.join('; ')}});
}
async function preservation(){const value:Record<string,unknown>={};for(const relation of financialRelations)
 value[relation]=(await db.query(`select coalesce(jsonb_agg(row_value order by row_value::text),'[]') value from (select to_jsonb(t) row_value from ${relation} t) q`)).rows[0].value;
 return value;}
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
  create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
  create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
  create function public.rls_auto_enable() returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 await db.exec(migration);
},60000);
beforeEach(async()=>{
 for(const [key,value]of Object.entries({...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_BILLING_HISTORY_ENABLED:'true',
  CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',
  SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',
  SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Unexpected hosted network request');}));
 await db.exec('begin');
 const revision=(await db.query<{id:string}>("select id from cluera_billing_private.catalog_revisions where kind='PACK'")).rows[0].id;
 for(const [index,owner]of [first,second].entries()){
  await db.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())',[owner.userId,`${owner.userId}@example.invalid`]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal1')",[owner.sessionId,owner.userId]);
  await db.query('select public.customer_authorize($1,$2)',[owner.userId,owner.sessionId]);
  const intent=randomUUID(),suffix=String(index+1).padStart(8,'0');
  await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,order_id) values($1,$2,$3,$4,$5,1,'VERIFIED',$6)",
   [intent,owner.userId,randomUUID(),revision,'a'.repeat(64),`order_fullhistory${suffix}`]);
  await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,amount_paise,revision_id,state) values($1,$2,$3,$4,54900,$5,'VERIFIED')",
   [`pay_fullhistory${suffix}`,`order_fullhistory${suffix}`,intent,owner.userId,revision]);
 }
 const names=new Set(['customer_authorize','customer_auth_rate_limit','cluera_billing_history']);
 rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{
  if(!names.has(name)||Object.keys(args).some(key=>!/^p_[a-z_]+$/.test(key)))throw Error('Unexpected write/provider RPC');
  const entries=Object.entries(args);
  try{return {data:(await db.query<{value:unknown}>(`select public.${name}(${entries.map(([key],index)=>`${key}=>$${index+1}`).join(',')}) value`,entries.map(([,value])=>value))).rows[0].value,error:null,status:200};}
  catch(error){return {data:null,error,status:500};}
 });
 auth={getUser:vi.fn(async(access:string)=>{
  const claims=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString());
  const user=(await db.query('select id,email,email_confirmed_at,is_anonymous from auth.users where id=$1',[claims.sub])).rows[0];
  return {data:{user},error:null};
 }),refreshSession:vi.fn(()=>{throw Error('Unexpected Auth refresh action');})};
 mocks.clients.mockReturnValue({auth:{auth},service:{rpc}});
});
afterEach(async()=>{await db.exec('rollback');vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});
afterAll(async()=>{await db?.close();});

it('tracked migration retains the exact reviewed executable proposal and deployed function body',()=>{
 const executable=(value:string)=>value.slice(value.indexOf('create index')).replace(/\s*commit;\s*$/,'').trim();
 expect(createHash('sha256').update(frozenProposal).digest('hex')).toBe('49e093e16308fd68157e0e6ce4ae99991c975322128a2ae749e6f529f71e3383');
 expect(executable(migration)).toBe(executable(frozenProposal));
 expect(createHash('md5').update(migration.match(/as \$\$([\s\S]*?)\$\$;/i)![1]).digest('hex')).toBe('22d7512fcddf9b05783d024d3eb7174b');
});
it('verified encrypted BFF session reads its actual SQL history while purchases are paused, preserving all Auth/trial/financial rows',async()=>{
 const before=await preservation(),response=await GET(request());expect(response.status).toBe(200);
 const result=await response.json();expect(result.history.userId).toBe(first.userId);
 expect(result.history.payments.map((row:{paymentId:string})=>row.paymentId)).toEqual(['pay_fullhistory00000001']);
 expect(result.history.subscriptions).toEqual([]);expect(response.headers.get('cache-control')).toBe('no-store');
 expect(response.headers.get('x-content-type-options')).toBe('nosniff');expect(response.headers.get('set-cookie')).toBeNull();
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['customer_authorize','customer_auth_rate_limit','customer_auth_rate_limit','cluera_billing_history']);
 expect(rpc).toHaveBeenLastCalledWith('cluera_billing_history',{p_user:first.userId,p_session:first.sessionId});
 expect(await preservation()).toEqual(before);
 expect((await db.query('select count(*) n from public.customer_request_limits')).rows[0].n).toBe(2);
 expect(JSON.stringify(result)).not.toMatch(/synthetic-refresh|synthetic-signature|account_digest|service_role|@example.invalid/);
 expect(JSON.stringify(result)).not.toContain(first.sessionId);expect(fetch).not.toHaveBeenCalled();
});
it('a stale expected owner cannot read across a genuine cookie account switch; the new owner receives only its own rows',async()=>{
 const before=await preservation();
 expect((await GET(request(first,second.userId))).status).toBe(403);
 expect((await GET(request(second,first.userId))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_history')).toBe(false);
 const response=await GET(request(second));expect(response.status).toBe(200);
 const result=await response.json();expect(result.history.userId).toBe(second.userId);
 expect(result.history.payments.map((row:{paymentId:string})=>row.paymentId)).toEqual(['pay_fullhistory00000002']);
 expect(await preservation()).toEqual(before);expect(auth.refreshSession).not.toHaveBeenCalled();
});
it('a recovery-restricted cookie cannot reach the history RPC or financial data',async()=>{
 const before=await preservation(),response=await GET(request(first,first.userId,true));
 expect(response.status).toBe(403);expect(await response.json()).toEqual({error:'This history request is not allowed.'});
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['customer_authorize']);expect(await preservation()).toEqual(before);
});
it('removing the synthetic live session denies an otherwise verified token before rate limiting/history and clears browser cookies',async()=>{
 await db.query('delete from auth.sessions where id=$1',[first.sessionId]);const before=await preservation();
 const response=await GET(request());expect(response.status).toBe(401);
 expect(await response.json()).toEqual({error:'Sign in with a verified Cluera account.'});
 expect(rpc.mock.calls.map(([name])=>name)).toEqual(['customer_authorize']);expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
 expect(await preservation()).toEqual(before);expect(auth.refreshSession).not.toHaveBeenCalled();
});
