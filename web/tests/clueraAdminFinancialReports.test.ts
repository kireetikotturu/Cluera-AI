import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {afterAll,afterEach,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {GET} from '../app/api/account/admin/billing/cluera/report/route';
import {clueraAdminFinancialReportRequest,clueraAdminReportsEnabled} from '../lib/payments/cluera/adminReports';
import {financialReportSchema} from '../lib/payments/cluera/adminReportContracts';
import {merchantDigest} from '../lib/payments/cluera/config';
import {accountConfig} from '../lib/accounts/config';
import {seal} from '../lib/accounts/cookies';
import {paymentTestEnvironment} from './helpers/paymentTestMode';

const mocks=vi.hoisted(()=>({clients:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
const site='https://cluera-ai-staging.vercel.app',path='/api/account/admin/billing/cluera/report';
const first={userId:randomUUID(),sessionId:randomUUID()},second={userId:randomUUID(),sessionId:randomUUID()};
const digest=merchantDigest(paymentTestEnvironment),from=new Date(Date.now()-30*86400000).toISOString(),to=new Date().toISOString();
const fixtureCreated=new Date(Date.now()-86400000).toISOString();
const migration=readFileSync('../supabase/migrations/20261019095719_cluera_admin_financial_report_read.sql','utf8');
const relations=['auth.users','auth.sessions','public.account_admin_profiles','public.customer_accounts','public.customer_trial_grants',
 'public.customer_usage_grants','public.account_admin_audit','cluera_billing_private.intents','cluera_billing_private.payments',
 'cluera_billing_private.subscriptions','cluera_billing_private.terms','cluera_billing_private.events','cluera_billing_private.applications',
 'cluera_billing_private.processing_owner','cluera_billing_private.admin_audit'];
let db:PGlite,rpc:ReturnType<typeof vi.fn>,revision:string,functionsBefore:unknown,functionsAfter:unknown;
let transform:((name:string,value:unknown)=>unknown)|undefined;
function token(owner=first,aal='aal2'){return `header.${Buffer.from(JSON.stringify({sub:owner.userId,session_id:owner.sessionId,aal,
 iss:'https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1',aud:'authenticated',role:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic-signature`;}
function request(query='',owner=first,aal='aal2',recovery=false){
 const config=accountConfig(),cookies=[`__Host-sr-account-access=${seal(token(owner,aal),'access',config,3600)}`,
  `__Host-sr-account-refresh=${seal('synthetic-refresh','refresh',config,3600)}`,`__Host-sr-account-session=${seal(owner,'session',config,3600)}`];
 if(recovery)cookies.push(`__Host-sr-account-recovery-lock=${seal({sessionId:owner.sessionId,resetUntil:Date.now()+600000},'recovery-lock',config,3600)}`);
 return new Request(`${site}${path}${query?`?${query}`:''}`,{headers:{origin:site,cookie:cookies.join('; ')}});
}
async function preservation(){const value:Record<string,unknown>={};for(const relation of relations)value[relation]=
 (await db.query(`select coalesce(jsonb_agg(v order by v::text),'[]')value from(select to_jsonb(t)v from ${relation} t)q`)).rows[0].value;return value;}
async function dbCall(name:string,args:Record<string,unknown>){
 const entries=Object.entries(args);await db.exec('savepoint report_read');
 try{const value=(await db.query<{v:unknown}>(`select public.${name}(${entries.map(([key],i)=>`${key}=>$${i+1}`).join(',')})v`,entries.map(([,value])=>value))).rows[0].v;
  await db.exec('release savepoint report_read');return value;
 }catch(error){await db.exec('rollback to savepoint report_read');await db.exec('release savepoint report_read');throw error;}
}
const sqlArgs=(owner=first)=>({p_actor:owner.userId,p_session:owner.sessionId,p_account_digest:digest,p_epoch:1,
 p_from:from,p_to:to,p_subject:null,p_before_created:null,p_before_intent:null,p_before_payment:null});
async function viewer(owner=first){const response=await GET(request('',owner));expect(response.status).toBe(200);return(await response.json()).viewer as string;}
const query=(tag:string,extra:Record<string,string>={})=>new URLSearchParams({viewer:tag,from,to,...extra}).toString();
async function seed(n:number,state:'VERIFIED'|'REFUNDED'|null='VERIFIED',owner=first,merchant=digest){
 const id=randomUUID(),suffix=String(n).padStart(10,'0'),created=fixtureCreated;
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,order_id,created_at)values($1,$2,$3,$4,$5,1,$6,$7,$8)",
 [id,owner.userId,randomUUID(),revision,merchant,state??'UNCERTAIN',`order_report${suffix}`,created]);
 if(state)await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,amount_paise,revision_id,state)values($1,$2,$3,$4,54900,$5,$6)",
 [`pay_report${suffix}`,`order_report${suffix}`,id,owner.userId,revision,state]);
 return id;
}
beforeAll(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;
 create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz,is_anonymous boolean not null default false);
 create table auth.identities(user_id uuid);create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,aal text);
 create function public.rls_auto_enable()returns event_trigger language plpgsql as $$begin return;end$$;`);
 await db.exec(readFileSync('../supabase/migrations/20261016014532_cluera_clean_foundation.sql','utf8'));
 const definitions="select coalesce(jsonb_agg(jsonb_build_object('oid',p.oid,'definition',pg_get_functiondef(p.oid),'acl',p.proacl)order by p.oid),'[]')v from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','cluera_billing_private','billing_private')and p.prokind='f'and p.proname<>'cluera_billing_admin_report'";
 functionsBefore=(await db.query(definitions)).rows[0].v;
 await db.exec(migration);
 functionsAfter=(await db.query(definitions)).rows[0].v;
 revision=(await db.query<{id:string}>("select id from cluera_billing_private.catalog_revisions where kind='PACK'")).rows[0].id;
},60000);
beforeEach(async()=>{
 for(const [key,value]of Object.entries({...paymentTestEnvironment,CLUERA_BILLING_V2_ENABLED:'true',CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED:'true',
  CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'false',SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED:'true',SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:'false',SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:'false',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),
  SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64')}))vi.stubEnv(key,value);
 vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Hosted network forbidden');}));await db.exec('begin');transform=undefined;
 for(const owner of[first,second]){await db.query('insert into auth.users(id,email,email_confirmed_at)values($1,$2,now())',[owner.userId,`${owner.userId}@example.invalid`]);
  await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[owner.sessionId,owner.userId]);await db.query('select public.customer_authorize($1,$2)',[owner.userId,owner.sessionId]);
  await db.query('insert into public.account_admin_profiles(user_id,active)values($1,true)',[owner.userId]);}
 await db.query('update cluera_billing_private.processing_owner set account_digest=$1 where singleton',[digest]);
 await seed(1);await seed(2,'REFUNDED',second);await seed(3,null);await seed(4,'VERIFIED',second,'b'.repeat(64));
 const names=new Set(['customer_authorize','customer_auth_rate_limit','account_admin_check','cluera_billing_owner','cluera_billing_admin_report']);
 rpc=vi.fn(async(name:string,args:Record<string,unknown>)=>{if(!names.has(name))throw Error('Unexpected write RPC');
  try{const value=await dbCall(name,args);return{data:transform?transform(name,value):value,error:null,status:200};}catch(error){return{data:null,error,status:500};}});
 mocks.clients.mockReturnValue({service:{rpc},auth:{auth:{getUser:vi.fn(async(access:string)=>{
  const claims=JSON.parse(Buffer.from(access.split('.')[1],'base64url').toString());return{data:{user:(await db.query('select id,email,email_confirmed_at,is_anonymous from auth.users where id=$1',[claims.sub])).rows[0]},error:null};
 }),refreshSession:vi.fn(()=>{throw Error('No Auth refresh action expected');})}}});
});
afterEach(async()=>{await db.exec('rollback');vi.clearAllMocks();vi.unstubAllEnvs();vi.unstubAllGlobals();});afterAll(async()=>{await db?.close();});

it('proposal adds one SELECT-only service RPC and two indexes while preserving every existing function definition and ACL',async()=>{
 expect(migration).toBe(readFileSync('../docs/proposals/cluera-admin-financial-report.sql','utf8'));
 expect(createHash('sha256').update(migration).digest('hex')).toBe('a53ee8915093aec706861ba6cecabff250d6d08e1dedcdc01f33c30bc5592776');
 expect(createHash('md5').update(migration.match(/as \$\$([\s\S]*?)\$\$;/i)![1]).digest('hex')).toBe('21e6d94bdc1dcf675f8956cf436caa13');
 expect(functionsAfter).toEqual(functionsBefore);
 const metadata=(await db.query("select p.provolatile,p.proconfig,p.prosecdef,has_function_privilege('anon',p.oid,'EXECUTE')anon,has_function_privilege('authenticated',p.oid,'EXECUTE')browser,has_function_privilege('service_role',p.oid,'EXECUTE')service from pg_proc p where p.proname='cluera_billing_admin_report'")).rows[0];
 expect(metadata).toMatchObject({provolatile:'s',prosecdef:true,anon:false,browser:false,service:true});expect(metadata.proconfig).toEqual(expect.arrayContaining(['search_path=""','TimeZone=UTC','statement_timeout=5s']));
 expect((await db.query("select count(*)n from pg_indexes where schemaname='cluera_billing_private'and indexname in('cluera_report_intent_cursor','cluera_report_payment_intent')")).rows[0].n).toBe(2);
 for(const role of['anon','authenticated','service_role']){await db.exec('savepoint acl_probe');try{await db.exec(`set local role ${role}`);await expect(db.query('select *from cluera_billing_private.payments')).rejects.toThrow();}finally{await db.exec('rollback to savepoint acl_probe');await db.exec('release savepoint acl_probe');}}
});
it('default-disabled and wrong-target routes stop before Auth or reporting reads',async()=>{
 vi.stubEnv('CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED','false');expect((await GET(request())).status).toBe(404);expect(mocks.clients).not.toHaveBeenCalled();
 for(const env of[{...process.env,CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED:'true',RAZORPAY_ENVIRONMENT:'live'},
  {...process.env,CLUERA_ADMIN_FINANCIAL_REPORTS_ENABLED:'true',VERCEL_ENV:'preview'}])expect(clueraAdminReportsEnabled(env)).toBe(false);
});
it('actual encrypted Admin/AAL2 session reads bounded real ledger totals while checkout is paused and preserves all business/Auth rows',async()=>{
 const before=await preservation(),tag=await viewer(),response=await GET(request(query(tag)));expect(response.status).toBe(200);
 const report=financialReportSchema.parse(await response.json());expect(report.rows).toHaveLength(3);expect(report.totals).toEqual({scope:'CURRENT_PAGE',currency:'INR',verifiedCount:1,verifiedAmountPaise:54900,refundedCount:1,refundedAmountPaise:54900,requestsWithoutPayment:1});
 expect(report.nextCursor).toBeNull();expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('x-content-type-options')).toBe('nosniff');
 expect(await preservation()).toEqual(before);expect(fetch).not.toHaveBeenCalled();expect(JSON.stringify(report)).not.toMatch(/@example.invalid|synthetic-refresh|synthetic-signature|account_digest|service_role/);
 expect(JSON.stringify(report)).not.toContain(first.sessionId);expect(JSON.stringify(report)).not.toContain(second.sessionId);
});
it('cross-site, unknown and duplicate parameters, method changes and excessive windows cannot reach report SQL',async()=>{
 const tag=await viewer();rpc.mockClear();
 for(const q of[`${query(tag)}&from=${from}`,`${query(tag)}&secret=x`,query(tag,{from:'2000-01-01T00:00:00Z'}),query(tag,{subject:'not-a-uuid'}),query(tag,{to:from})])expect((await GET(request(q))).status).toBe(400);
 const cross=request(query(tag));cross.headers.set('origin','https://example.invalid');expect((await GET(cross)).status).toBe(403);
 expect((await clueraAdminFinancialReportRequest(new Request(`${site}${path}`,{method:'POST'}))).status).toBe(404);
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_report')).toBe(false);
});
it('same actor must have AAL2 in both the verified token and live database session',async()=>{
 const tag=await viewer();rpc.mockClear();expect((await GET(request(query(tag),first,'aal1'))).status).toBe(403);
 await db.query("update auth.sessions set aal='aal1'where id=$1",[first.sessionId]);expect((await GET(request(query(tag)))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_report')).toBe(false);
});
it('a recovery-restricted session cannot invoke the Admin role or financial report RPC',async()=>{
 const response=await GET(request('',first,'aal2',true));expect(response.status).toBe(403);expect(rpc.mock.calls.map(([name])=>name)).toEqual(['customer_authorize']);
});
it('revoked/deleted live sessions, allowlists and suspended actors are independently denied by SQL',async()=>{
 const args=sqlArgs();expect((await dbCall('cluera_billing_admin_report',args)as any).code).toBe('ACTIVE');
 for(const statement of["update auth.sessions set aal='aal1'",'update public.account_admin_profiles set active=false',"update public.customer_accounts set state='SUSPENDED'",
  "update auth.users set banned_until=now()+interval '1 day'","update auth.users set deleted_at=now()",'delete from auth.sessions']){
  await db.exec('savepoint deny_case');await db.exec(statement);expect(await dbCall('cluera_billing_admin_report',args)).toEqual({code:'FORBIDDEN'});await db.exec('rollback to savepoint deny_case');await db.exec('release savepoint deny_case');
 }
});
it('a different valid Admin or replacement session cannot use an earlier viewer fence',async()=>{
 const tag=await viewer();rpc.mockClear();expect((await GET(request(query(tag),second))).status).toBe(403);
 const replacement={userId:first.userId,sessionId:randomUUID()};await db.query("insert into auth.sessions values($1,$2,null,'aal2')",[replacement.sessionId,replacement.userId]);
 expect((await GET(request(query(tag),replacement))).status).toBe(403);expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_report')).toBe(false);
});
it('deleting a live session rejects an apparently verified cookie before financial data and clears credentials',async()=>{
 await db.query('delete from auth.sessions where id=$1',[first.sessionId]);const response=await GET(request());expect(response.status).toBe(401);
 expect(response.headers.get('set-cookie')).toContain('Max-Age=0');expect(rpc.mock.calls.map(([name])=>name)).toEqual(['customer_authorize']);
});
it('an Auth response or sealed identity anchor cannot substitute another user or session',async()=>{
 const clients=mocks.clients.mock.results.at(-1)?.value??mocks.clients();
 clients.auth.auth.getUser.mockResolvedValueOnce({data:{user:{id:second.userId,email:'second@example.invalid',email_confirmed_at:to,is_anonymous:false}},error:null});
 expect((await GET(request())).status).toBe(401);expect(rpc).not.toHaveBeenCalled();
 const original=request(),config=accountConfig(),headers=new Headers(original.headers);
 headers.set('cookie',headers.get('cookie')!.replace(/__Host-sr-account-session=[^;]+/,`__Host-sr-account-session=${seal(second,'session',config,3600)}`));
 expect((await GET(new Request(original.url,{headers}))).status).toBe(401);expect(rpc).not.toHaveBeenCalled();
});
it('merchant/epoch mismatch and invalid SQL ranges or half-cursors fail closed without mutating records',async()=>{
 const before=await preservation(),args=sqlArgs();
 for(const altered of[{p_epoch:2},{p_account_digest:'b'.repeat(64)}])expect(await dbCall('cluera_billing_admin_report',{...args,...altered})).toEqual({code:'UNAVAILABLE'});
 for(const altered of[{p_from:'2000-01-01T00:00:00Z'},{p_to:from},{p_before_created:from},{p_before_payment:'pay_badbadbad'}])expect(await dbCall('cluera_billing_admin_report',{...args,...altered})).toEqual({code:'INVALID'});
 expect(await preservation()).toEqual(before);
});
it('stable tied-time keyset pages are bounded, unique, signed and bound to original Admin/session/filter window',async()=>{
 for(let n=5;n<=60;n++)await seed(n);
 const tag=await viewer(),response=await GET(request(query(tag))),page=financialReportSchema.parse(await response.json());expect(page.rows).toHaveLength(50);expect(page.nextCursor).toBeTruthy();
 const next=await GET(request(query(tag,{cursor:page.nextCursor!})));expect(next.status).toBe(200);const rest=financialReportSchema.parse(await next.json());expect(rest.rows).toHaveLength(9);expect(rest.nextCursor).toBeNull();
 expect(new Set([...page.rows,...rest.rows].map(row=>row.payment?.paymentId??row.intentId)).size).toBe(59);
 rpc.mockClear();
 const tampered=`${page.nextCursor!.slice(0,-2)}xx`;
 expect((await GET(request(query(tag,{cursor:tampered})))).status).toBe(400);
 expect((await GET(request(query(tag,{cursor:page.nextCursor!,subject:first.userId})))).status).toBe(403);
 expect((await GET(request(query(await viewer(second),{cursor:page.nextCursor!}),second))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='cluera_billing_admin_report')).toBe(false);
});
it('customer selection constrains actual SQL rows and never carries cross-customer totals',async()=>{
 const tag=await viewer(),response=await GET(request(query(tag,{subject:second.userId}))),report=financialReportSchema.parse(await response.json());
 expect(report.rows).toHaveLength(1);expect(report.rows[0].userId).toBe(second.userId);expect(report.totals.verifiedAmountPaise).toBe(0);expect(report.totals.refundedAmountPaise).toBe(54900);
});
it('one recurring intent with many invoice payments pages on the full tied-time identity without skipping an invoice',async()=>{
 const revision=(await db.query<{id:string}>("select id from cluera_billing_private.catalog_revisions where offer_code='cluera_monthly_40h_v2'")).rows[0].id;
 const intent=randomUUID(),sub='sub_reportrecurring01';
 await db.query("insert into cluera_billing_private.intents(id,user_id,request_id,revision_id,account_digest,epoch,state,subscription_id,created_at)values($1,$2,$3,$4,$5,1,'VERIFIED',$6,$7)",[intent,second.userId,randomUUID(),revision,digest,sub,fixtureCreated]);
 await db.query("insert into cluera_billing_private.subscriptions(subscription_id,user_id,intent_id,revision_id,account_digest,state,observed_at)values($1,$2,$3,$4,$5,'ACTIVE',now())",[sub,second.userId,intent,revision,digest]);
 for(let n=1;n<=55;n++){const suffix=String(n).padStart(8,'0');await db.query("insert into cluera_billing_private.payments(payment_id,order_id,intent_id,user_id,invoice_id,subscription_id,amount_paise,revision_id,state,period_start,period_end,paid_at)values($1,$2,$3,$4,$5,$6,549900,$7,'VERIFIED',now()-interval '1 day',now()+interval '29 days',now()-interval '1 day')",
  [`pay_recurring${suffix}`,`order_recurring${suffix}`,intent,second.userId,`inv_recurring${suffix}`,sub,revision]);}
 const args={...sqlArgs(),p_subject:second.userId},page=await dbCall('cluera_billing_admin_report',args)as any;
 expect(page.rows).toHaveLength(50);expect(page.hasMore).toBe(true);
 const next=await dbCall('cluera_billing_admin_report',{...args,p_before_created:page.before.createdAt,p_before_intent:page.before.intentId,p_before_payment:page.before.paymentId})as any;
 expect(next.rows).toHaveLength(6);expect(new Set([...page.rows,...next.rows].map((row:any)=>row.payment.paymentId)).size).toBe(56);
});
it('raw numeric strings, extra provider data, currencies and inconsistent totals are never normalized or exposed',async()=>{
 const tag=await viewer();
 for(const alter of[(v:any)=>{v.rows.find((r:any)=>r.payment).payment.amountPaise='54900';},(v:any)=>{v.rows[0].rawProvider={secret:'private-provider-payload'};},
  (v:any)=>{v.totals.currency='USD';},(v:any)=>{v.totals.verifiedAmountPaise=0;}]){
  transform=(name,value)=>{if(name!=='cluera_billing_admin_report')return value;const v=structuredClone(value);alter(v);return v;};
  const response=await GET(request(query(tag)));expect(response.status).toBe(503);expect(await response.json()).toEqual({error:'Financial reports are unavailable.'});
 }
});
it('mismatched physical ledger prices are rejected rather than counted as verified revenue',async()=>{
 await db.exec('update cluera_billing_private.payments set amount_paise=1');expect(await dbCall('cluera_billing_admin_report',sqlArgs())).toEqual({code:'UNAVAILABLE'});
});
