import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {accountAdminRequest} from '../lib/accounts/admin';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn(),providerStatus:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/providerStatus',()=>({readProviderStatus:mocks.providerStatus}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,rateLimit:mocks.limit}));
const origin='https://cluera-ai-staging.vercel.app';
const actor='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002',factor='00000000-0000-4000-8000-000000000003';
let rpc:ReturnType<typeof vi.fn>,mfa:ReturnType<typeof makeMfa>;
function makeMfa(){return {
 listFactors:vi.fn(async()=>({data:{all:[] as Array<{id:string;status:string;factor_type:string}>},error:null})),
 enroll:vi.fn(async()=>({data:{id:factor,totp:{qr_code:'<svg/>',secret:'synthetic-totp-secret'}},error:null})),
 challengeAndVerify:vi.fn(async()=>({data:{access_token:'synthetic-mfa-access',refresh_token:'synthetic-mfa-refresh',expires_in:3600},error:null})),
 unenroll:vi.fn(async()=>({error:null})),
};}
beforeEach(()=>{
 vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','true');vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN',origin);
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://dwqltsqumiwsxtkzdoaa.supabase.co');
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_synthetic_public_key_00000000000000000');vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','synthetic-service-key-placeholder');
 vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64',Buffer.alloc(32,3).toString('base64'));
 vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',Buffer.alloc(32,4).toString('base64'));
 vi.stubEnv('SIGMAROUND_ACCOUNT_TEST_ENTITLEMENTS_ENABLED','false');
 mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal2'})).toString('base64url')}.synthetic`,refresh_token:'synthetic-refresh'}});
 mocks.limit.mockResolvedValue(undefined);mfa=makeMfa();
 mocks.providerStatus.mockResolvedValue({observedAt:'2026-10-08T00:00:00.000Z',providers:[]});
 rpc=vi.fn(async(name:string,args:any)=>({data:name==='account_admin_check'?true:name==='account_admin_read_v2'?{code:'ACTIVE',users:[],catalog:[]}:['account_admin_mutate','account_admin_adjust'].includes(name)?{code:'APPLIED'}:null,error:null,status:200}));
 mocks.clients.mockReturnValue({service:{rpc},auth:{auth:{setSession:vi.fn(async()=>({error:null})),mfa}}});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();vi.restoreAllMocks();});
const request=(body?:object)=>new Request(`${origin}/api/account/admin`,body?{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{});
const change=()=>({action:'GRANT_TEST',operationId:crypto.randomUUID(),subjectId:actor,reason:'Disposable staging test allocation',input:{minutes:60}});
it('reports fixed read errors with bounded stage/code/status logs, never SQL, account IDs or tokens',async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 rpc.mockImplementation(async(name)=>name==='account_admin_read_v2'?{data:null,error:{code:'PGRST202',message:'private SQL/auth value',details:actor},status:404}:{data:true,error:null,status:200});
 const failed=await accountAdminRequest(request());
 expect(failed.status).toBe(503);expect(await failed.json()).toEqual({error:'ADMIN_SERVICE_UNAVAILABLE'});
 expect(log).toHaveBeenCalledWith('[account-admin] read rejected',{operation:'account.admin.read',stage:'read_rpc',code:'ADMIN_SERVICE_UNAVAILABLE',status:503,databaseCode:'PGRST202',databaseStatus:404});
 expect(JSON.stringify(log.mock.calls)).not.toMatch(/private SQL|00000000|synthetic-refresh/);
});
it('distinguishes temporary session restore failure from an expired login and preserves MFA checks',async()=>{
 const restore=mocks.clients().auth.auth.setSession;
 restore.mockResolvedValueOnce({error:{status:503,message:'private outage'}});
 const unavailable=await accountAdminRequest(request());
 expect(unavailable.status).toBe(503);expect(await unavailable.json()).toEqual({error:'ADMIN_SERVICE_UNAVAILABLE'});
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_read_v2')).toBe(false);
 restore.mockResolvedValueOnce({error:{status:401}});
 expect(await(await accountAdminRequest(request())).json()).toEqual({error:'ADMIN_SIGN_IN_REQUIRED'});
});
it('routes account drafts only through the MFA-protected account RPC and never legacy release RPCs',async()=>{
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');
 const body={action:'RELEASE_DRAFT',operationId:crypto.randomUUID(),subjectId:null,reason:'Reviewed separate account test artifact',input:{version:'1.0.8',minimumSupportedVersion:'1.0.8',downloadUrl:'https://github.com/test/repo/releases/download/test/ClueraAITestSetup-1.0.8.exe',sha256:'a'.repeat(64),fileSizeBytes:123,updateType:'OPTIONAL',releaseNotes:''}};
 rpc.mockImplementation(async(name)=>({data:name==='account_admin_check'?true:{code:'APPLIED'},error:null,status:200}));
 expect((await accountAdminRequest(request(body))).status).toBe(200);
 expect(rpc).toHaveBeenCalledWith('cluera_release_admin',expect.objectContaining({p_actor:actor,p_session:sid,p_action:'DRAFT',p_input:body.input}));
 expect(rpc.mock.calls.some(([name])=>name==='admin_create_test_release')).toBe(false);
 rpc.mockClear();mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1'})).toString('base64url')}.synthetic`,refresh_token:'synthetic'}});
 expect((await accountAdminRequest(request(body))).status).toBe(403);expect(rpc.mock.calls.some(([name])=>name==='cluera_release_admin')).toBe(false);
});
it('does not expose admin records or enroll factors without a verified live account and explicit allowlist',async()=>{
 const {AccountError}=await import('../lib/accounts/config');mocks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));
 expect((await accountAdminRequest(request())).status).toBe(401);expect(rpc).not.toHaveBeenCalled();
 rpc.mockResolvedValue({data:false,error:null,status:200});expect((await accountAdminRequest(request({action:'MFA_ENROLL'}))).status).toBe(403);
 expect(mfa.enroll).not.toHaveBeenCalled();
});
it('requires AAL2 for data and mutations, and only lists factors during refresh',async()=>{
 rpc.mockImplementation(async(name,args)=>({data:name==='account_admin_check'&&!args.p_require_mfa,error:null,status:200}));
 const response=await accountAdminRequest(request());expect(await response.json()).toEqual({needsMfa:true,factors:[]});
 expect(mfa.enroll).not.toHaveBeenCalled();expect((await accountAdminRequest(request(change()))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_mutate')).toBe(false);
});
it('does not promote an old AAL1 bearer merely because its database session is now AAL2',async()=>{
 mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1'})).toString('base64url')}.synthetic`,refresh_token:'synthetic-refresh'}});
 const response=await accountAdminRequest(request());expect(await response.json()).toMatchObject({needsMfa:true});
 expect((await accountAdminRequest(request(change()))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_read_v2'||name==='account_admin_mutate'||name==='account_admin_adjust')).toBe(false);
});
it('explicitly enrolls once, rejects stale duplicate enrollment and never cancels a verified factor',async()=>{
 expect((await accountAdminRequest(request({action:'MFA_ENROLL'}))).status).toBe(200);expect(mfa.enroll).toHaveBeenCalledOnce();
 mfa.listFactors.mockResolvedValue({data:{all:[{id:factor,status:'unverified',factor_type:'totp'}]},error:null});
 expect((await accountAdminRequest(request({action:'MFA_ENROLL'}))).status).toBe(403);
 expect((await accountAdminRequest(request({action:'MFA_CANCEL',factorId:factor}))).status).toBe(200);
 mfa.listFactors.mockResolvedValue({data:{all:[{id:factor,status:'verified',factor_type:'totp'}]},error:null});
 expect((await accountAdminRequest(request({action:'MFA_CANCEL',factorId:factor}))).status).toBe(403);expect(mfa.unenroll).toHaveBeenCalledOnce();
});
it('challenge/verifies the selected factor and returns tokens only as encrypted HttpOnly cookies',async()=>{
 mfa.listFactors.mockResolvedValue({data:{all:[{id:factor,status:'unverified',factor_type:'totp'}]},error:null});
 const response=await accountAdminRequest(request({action:'MFA_VERIFY',factorId:factor,code:'123456'}));
 expect(response.status).toBe(200);expect(mfa.challengeAndVerify).toHaveBeenCalledWith({factorId:factor,code:'123456'});
 expect(await response.text()).toBe('{"ok":true}');const cookies=response.headers.get('set-cookie')!;
 expect(cookies).toContain('HttpOnly');expect(cookies).toContain('Secure');expect(cookies).not.toContain('synthetic-mfa-');
});
it('requires the staging gate and creates only a server-stamped audited test grant',async()=>{
 const body=change();expect((await accountAdminRequest(request(body))).status).toBe(403);
 vi.stubEnv('SIGMAROUND_ACCOUNT_TEST_ENTITLEMENTS_ENABLED','true');
 expect((await accountAdminRequest(request(body))).status).toBe(200);
 expect(rpc).toHaveBeenCalledWith('account_admin_mutate',expect.objectContaining({p_actor:actor,p_session:sid,p_operation:body.operationId,p_input:{minutes:60,environment:'account-staging'}}));
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://bzccuqforilpifhiysjk.supabase.co');expect((await accountAdminRequest(request(body))).status).toBe(503);
});
it('rejects cross-origin, caller actor IDs, missing reasons and provider secrets',async()=>{
 const cross=request(change());cross.headers.set('origin','https://untrusted.invalid');expect((await accountAdminRequest(cross)).status).toBe(403);
 for(const body of [{...change(),actorId:actor},{...change(),reason:''},{...change(),input:{minutes:60,apiKey:'synthetic-secret'}}]){
  vi.stubEnv('SIGMAROUND_ACCOUNT_TEST_ENTITLEMENTS_ENABLED','true');expect((await accountAdminRequest(request(body))).status).toBe(400);
 }
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_mutate')).toBe(false);
});

const providerRequest=()=>new Request(`${origin}/api/account/admin?providers=1`);
it('never contacts the relay for missing sessions, ordinary users or AAL1 admins',async()=>{
 const {AccountError}=await import('../lib/accounts/config');
 mocks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));
 expect((await accountAdminRequest(providerRequest())).status).toBe(401);
 rpc.mockResolvedValueOnce({data:false,error:null,status:200});
 expect((await accountAdminRequest(providerRequest())).status).toBe(403);
 mocks.session.mockResolvedValueOnce({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},
  session:{access_token:`header.${Buffer.from(JSON.stringify({aal:'aal1'})).toString('base64url')}.synthetic`,refresh_token:'synthetic-refresh'}});
 expect(await (await accountAdminRequest(providerRequest())).json()).toEqual({needsMfa:true,factors:[]});
 expect(mocks.providerStatus).not.toHaveBeenCalled();expect(mocks.limit).not.toHaveBeenCalled();
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_read_v2')).toBe(false);
});
it('requires current database MFA authorization even if the request token claims AAL2',async()=>{
 rpc.mockImplementation(async(name,args)=>({data:name==='account_admin_check'&&!args.p_require_mfa,error:null,status:200}));
 expect(await (await accountAdminRequest(providerRequest())).json()).toEqual({needsMfa:true,factors:[]});
 expect(mocks.providerStatus).not.toHaveBeenCalled();
});
it('AAL2 admin explicitly reads a bounded provider snapshot without ordinary page loads requesting it',async()=>{
 await accountAdminRequest(request());expect(mocks.providerStatus).not.toHaveBeenCalled();
 const response=await accountAdminRequest(providerRequest());expect(response.status).toBe(200);
 expect(await response.json()).toEqual({providerStatus:{observedAt:'2026-10-08T00:00:00.000Z',providers:[]}});
 expect(response.headers.get('cache-control')).toContain('no-store');expect(mocks.providerStatus).toHaveBeenCalledOnce();expect(mocks.limit).toHaveBeenCalledOnce();
 expect(mocks.limit.mock.invocationCallOrder[0]).toBeLessThan(mocks.providerStatus.mock.invocationCallOrder[0]);
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_adjust'||name==='account_admin_mutate')).toBe(false);
});
it('rate-limited provider reads cannot reach the relay and relay errors cannot expose raw details',async()=>{
 const {AccountError}=await import('../lib/accounts/config');
 mocks.limit.mockRejectedValueOnce(new AccountError('RATE_LIMITED',429));
 expect((await accountAdminRequest(providerRequest())).status).toBe(429);expect(mocks.providerStatus).not.toHaveBeenCalled();
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 mocks.providerStatus.mockRejectedValueOnce(new Error('synthetic-private-provider-detail'));
 const failed=await accountAdminRequest(providerRequest());expect(failed.status).toBe(503);
 expect(await failed.text()).not.toContain('synthetic-private-provider-detail');expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-private-provider-detail');
});
it('passes validated search and paired cursor to the bounded authorized read RPC',async()=>{
 const cursor='2026-10-07T23:00:00.000Z';
 const query=new URLSearchParams({subject:actor,query:'  lookup@example.invalid  ',before:cursor,beforeId:sid});
 expect((await accountAdminRequest(new Request(`${origin}/api/account/admin?${query}`))).status).toBe(200);
 expect(rpc).toHaveBeenCalledWith('account_admin_read_v2',{p_actor:actor,p_session:sid,p_subject:actor,p_query:'lookup@example.invalid',p_before:cursor,p_before_id:sid});
});
it('rejects malformed subject/search/cursor values before reading account data',async()=>{
 for(const [query,status] of [['subject=bad',400],[`query=${'a'.repeat(255)}`,400],['before=bad&beforeId='+sid,400],
  ['before=2026-10-07T23%3A00%3A00.000Z',403],['beforeId='+sid,403]] as const){
  expect((await accountAdminRequest(new Request(`${origin}/api/account/admin?${query}`))).status).toBe(status);
 }
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_read_v2')).toBe(false);
});
it('routes adjustments to the dedicated audited RPC using the exact caller operation ID for retries',async()=>{
 const operationId=crypto.randomUUID();
 const body={action:'ADD_MINUTES',operationId,subjectId:actor,reason:'Account support approved time credit',input:{minutes:15}};
 for(let i=0;i<2;i++)expect((await accountAdminRequest(request(body))).status).toBe(200);
 const adjustments=rpc.mock.calls.filter(([name])=>name==='account_admin_adjust');expect(adjustments).toHaveLength(2);expect(adjustments[0]).toEqual(adjustments[1]);
 expect(adjustments[0][1]).toEqual({p_actor:actor,p_session:sid,p_operation:operationId,p_subject:actor,p_action:'ADD_MINUTES',p_reason:body.reason,p_input:{minutes:15}});
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_mutate')).toBe(false);
});
it('requires a grant for removals and preserves authoritative insufficient-unused conflict',async()=>{
 const base={action:'REMOVE_MINUTES',operationId:crypto.randomUUID(),subjectId:actor,reason:'Remove approved unused minutes',input:{minutes:15}};
 expect((await accountAdminRequest(request(base))).status).toBe(400);
 rpc.mockImplementation(async(name)=>({data:name==='account_admin_check'?true:{code:'INSUFFICIENT_UNUSED'},error:null,status:200}));
 const response=await accountAdminRequest(request({...base,input:{minutes:15,grantId:factor}}));expect(response.status).toBe(409);
 expect(await response.json()).toEqual({code:'INSUFFICIENT_UNUSED'});
});
it('rejects arbitrary paid state, negative/fractional/excess minutes and missing adjustment authorization fields',async()=>{
 const base={action:'ADD_MINUTES',operationId:crypto.randomUUID(),subjectId:actor,reason:'Approved account adjustment',input:{minutes:15}};
 for(const body of [
  {...base,input:{minutes:-1}},{...base,input:{minutes:0}},{...base,input:{minutes:1.5}},{...base,input:{minutes:60001}},
  {...base,input:{minutes:15,transactionId:'txn_synthetic'}},{...base,reason:''},{...base,operationId:'invalid'},
 ])expect((await accountAdminRequest(request(body))).status).toBe(400);
 expect((await accountAdminRequest(request({...base,subjectId:null}))).status).toBe(403);
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_adjust')).toBe(false);
});
it('catalog edits cover only the four approved offers and never accept browser pricing or Paddle IDs',async()=>{
 const base={action:'CATALOG',operationId:crypto.randomUUID(),subjectId:null,reason:'Review approved account catalog',input:{code:'pro_3_hours',name:'SigmaPro 3 Hours',enabled:true,priority:10}};
 expect((await accountAdminRequest(request(base))).status).toBe(200);
 expect(rpc).toHaveBeenCalledWith('account_admin_adjust',expect.objectContaining({p_action:'CATALOG',p_input:base.input}));
 for(const input of [{...base.input,code:'pro_100'},{...base.input,amount:1},{...base.input,priceId:'pri_synthetic'}])
  expect((await accountAdminRequest(request({...base,input}))).status).toBe(400);
});
it('rejects unsupported model policy before privileged mutation',async()=>{
 const base={action:'MODEL',operationId:crypto.randomUUID(),subjectId:null,reason:'Review account model policy',input:{modelId:'flux-unknown',displayName:'Internal audio',provider:'deepgram',enabled:true,isDefault:true,priority:100,capabilities:['audio'],health:'UNVERIFIED'}};
 expect((await accountAdminRequest(request(base))).status).toBe(400);
 expect(rpc.mock.calls.some(([name])=>name==='account_admin_mutate')).toBe(false);
});

const accountDraft=()=>({action:'RELEASE_DRAFT',operationId:crypto.randomUUID(),subjectId:null,
 reason:'Reviewed independently hosted separate account test installer',input:{version:'1.0.8',minimumSupportedVersion:'1.0.8',
 downloadUrl:'https://github.com/kireetikotturu/SigmaRound-Releases-Test/releases/download/account-v1.0.8-test/ClueraAITestSetup-1.0.8.exe',
 sha256:'8c8b396032a8b65f56f536bd8471660ff7c024096ba9fe8ccd466bea69a0bd22',fileSizeBytes:122030307,updateType:'OPTIONAL',releaseNotes:''}});
it.each([undefined,'','https://downloads.example.invalid','https://release-assets.githubusercontent.com',
 'https://github.com/kireetikotturu/SigmaRound-Releases-Test','"https://github.com"'])
 ('rejects absent or mismatched account installer origin configuration before the draft RPC (%s)',async(value)=>{
  vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS',value);vi.spyOn(console,'error').mockImplementation(()=>{});
  const denied=await accountAdminRequest(request(accountDraft()));
  expect(denied.status).toBe(400);expect(await denied.json()).toEqual({error:'RELEASE_ORIGIN_DENIED'});
  expect(denied.headers.get('cache-control')).toContain('no-store');
  expect(rpc.mock.calls.some(([name])=>name==='cluera_release_admin'||name==='admin_create_test_release'||name==='admin_create_release')).toBe(false);
 });
it('accepts the exact verified hosted metadata with GitHub explicitly configured and invokes only one account draft operation',async()=>{
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');const body=accountDraft();
 rpc.mockImplementation(async(name)=>({data:name==='account_admin_check'?true:{code:'APPLIED'},error:null,status:200}));
 expect((await accountAdminRequest(request(body))).status).toBe(200);
 expect(rpc.mock.calls.filter(([name])=>name==='cluera_release_admin')).toEqual([['cluera_release_admin',{
  p_actor:actor,p_session:sid,p_operation:body.operationId,p_action:'DRAFT',p_reason:body.reason,p_input:body.input,
 }]]);
 expect(rpc.mock.calls.some(([name])=>name==='admin_create_test_release'||name==='admin_create_release')).toBe(false);
});
it('returns specific safe release validation codes before any draft RPC',async()=>{
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 const base=accountDraft();
 const patches=[['version','v1.0.8','RELEASE_VERSION_INVALID'],['minimumSupportedVersion','2.0.0','RELEASE_MINIMUM_INVALID'],
  ['downloadUrl',base.input.downloadUrl.replace('ClueraAITest','SigmaRound'),'RELEASE_URL_INVALID'],['sha256','not-a-hash','RELEASE_HASH_INVALID'],
  ['fileSizeBytes',122030307.5,'RELEASE_SIZE_INVALID'],['releaseNotes',null,'RELEASE_NOTES_INVALID'],['updateType','IGNORE','RELEASE_POLICY_INVALID']] as const;
 for(const [field,value,error]of patches){const response=await accountAdminRequest(request({...base,input:{...base.input,[field]:value}}));expect(response.status).toBe(400);expect(await response.json()).toEqual({error});}
 for(const [patch,error]of [[{operationId:'bad'},'RELEASE_OPERATION_INVALID'],[{reason:'short'},'RELEASE_REASON_INVALID']] as const){const response=await accountAdminRequest(request({...base,...patch}));expect(response.status).toBe(400);expect(await response.json()).toEqual({error});}
 expect(rpc.mock.calls.some(([name])=>name==='cluera_release_admin')).toBe(false);
 expect(JSON.stringify(log.mock.calls)).not.toContain(base.input.downloadUrl);expect(JSON.stringify(log.mock.calls)).not.toContain(base.reason);
});
it('reports the database rejection and an allowlisted service cause without exposing input or SQL',async()=>{
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 rpc.mockImplementation(async(name)=>({data:name==='account_admin_check'?true:{code:'INVALID'},error:null,status:200}));
 const rejected=await accountAdminRequest(request(accountDraft()));expect(rejected.status).toBe(409);expect(await rejected.json()).toEqual({error:'RELEASE_DATABASE_INVALID'});
 expect(log).toHaveBeenCalledWith('[account-release] request rejected',{operation:'account.admin',stage:'release_rpc',action:'RELEASE_DRAFT',result:'INVALID'});
 rpc.mockImplementation(async(name)=>name==='account_admin_check'?{data:true,error:null,status:200}:{data:null,error:{code:'42501',message:'synthetic-secret SQL token',details:'synthetic-secret'},status:403});
 const failure=await accountAdminRequest(request(accountDraft()));expect(failure.status).toBe(503);expect(await failure.json()).toEqual({error:'RELEASE_SERVICE_UNAVAILABLE'});
 expect(log).toHaveBeenCalledWith('[account-release] request rejected',expect.objectContaining({stage:'release_rpc',action:'RELEASE_DRAFT',code:'42501',httpStatus:403,cause:'DATABASE_SERVICE'}));
 expect(JSON.stringify(log.mock.calls)).not.toContain('synthetic-secret');expect(JSON.stringify(log.mock.calls)).not.toContain('admin@example');
});
it('keeps trusted installer origin, token AAL2 and live database MFA mandatory',async()=>{
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://downloads.example.invalid');
 const denied=await accountAdminRequest(request(accountDraft()));expect(denied.status).toBe(400);expect(await denied.json()).toEqual({error:'RELEASE_ORIGIN_DENIED'});
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');
 rpc.mockImplementation(async(name,args)=>({data:name==='account_admin_check'&&!args.p_require_mfa,error:null,status:200}));
 const mfaDenied=await accountAdminRequest(request(accountDraft()));expect(mfaDenied.status).toBe(403);expect(await mfaDenied.json()).toEqual({error:'RELEASE_MFA_REQUIRED'});
 expect(rpc.mock.calls.some(([name])=>name==='cluera_release_admin')).toBe(false);expect(log).toHaveBeenCalled();
});
