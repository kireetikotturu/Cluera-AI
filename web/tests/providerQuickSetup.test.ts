import {beforeEach,expect,it,vi} from 'vitest';
import {providerAdminRequest} from '../lib/aiProviders/admin';
import {runProviderSetup} from '../lib/aiProviders/quickSetup';
import {vaultKeyring} from '../lib/aiProviders/vault';

const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),limit:vi.fn(),discover:vi.fn()}));
vi.mock('../lib/aiProviders/discovery',async original=>({...await original<typeof import('../lib/aiProviders/discovery')>(),discoverModels:mocks.discover}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',async original=>({...await original<typeof import('../lib/accounts/handler')>(),activeSession:mocks.session,rateLimit:mocks.limit}));

const origin='https://cluera-ai-staging.vercel.app',actor='00000000-0000-4000-8000-000000000001',sid='00000000-0000-4000-8000-000000000002',factor='00000000-0000-4000-8000-000000000003';
const secret='synthetic-quick-setup-provider-key';
const keyring=Buffer.from(JSON.stringify({active:'test-1',keys:{'test-1':Buffer.alloc(32,8).toString('base64')}})).toString('base64');
const meta=(provider:string,revision:number,extra:object={})=>({provider,revision,credentialPresent:true,enabled:false,defaultModel:null,probeStatus:'UNVERIFIED',probeAt:null,models:[],complete:false,updatedAt:'2026-10-13T00:00:00Z',...extra});
const verified=(model:string)=>({status:'VERIFIED',models:[{id:model,runtimeCompatible:true}],complete:true});
let rpc:any,mfa:any,token:string,state:{revision:number;probe:any};

function fixture(provider:'gemini'|'deepgram',probe:any,policies:any[]=[]){
 state={revision:0,probe};
 rpc=vi.fn(async(name:string,args:any)=>{
  if(name==='account_admin_check')return {data:true,error:null};
  if(name==='account_models_read')return {data:policies,error:null};
  if(name==='account_admin_mutate')return {data:{code:'APPLIED'},error:null};
  if(name==='cluera_provider_mutate'){
   if(args.p_revision!==state.revision)return {data:{code:'CONFLICT'},error:null};
   state.revision+=1;
   const kind=args.p_action,input=args.p_input;
   return {data:{code:'APPLIED',metadata:meta(provider,state.revision,kind==='TEST'?{probeStatus:input.status,probeAt:'2026-10-13T00:00:00Z',models:input.models,complete:input.complete}
    :kind==='CONFIGURE'?{probeStatus:'VERIFIED',probeAt:'2026-10-13T00:00:00Z',models:state.probe.models,complete:true,enabled:input.enabled,defaultModel:input.defaultModel}:{})},error:null};
  }
  throw Error(`Unexpected RPC ${name}`);
 });
}
beforeEach(()=>{
 for(const [key,value] of Object.entries({SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:origin,NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-infrastructure-service-key',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,3).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,4).toString('base64'),CLUERA_PROVIDER_VAULT_ENABLED:'true',CLUERA_PROVIDER_VAULT_KEYRING_BASE64:keyring}))vi.stubEnv(key,value);
 token=`header.${Buffer.from(JSON.stringify({aal:'aal2',session_id:sid})).toString('base64url')}.synthetic`;
 mocks.session.mockResolvedValue({account:{userId:actor,sessionId:sid,email:'admin@example.invalid'},session:{access_token:token,refresh_token:'synthetic-refresh'}});
 mocks.limit.mockResolvedValue(undefined);
 mfa={listFactors:vi.fn(async()=>({data:{all:[{id:factor,status:'verified',factor_type:'totp'}]},error:null})),challengeAndVerify:vi.fn(async()=>({data:{access_token:token,refresh_token:'synthetic-new-refresh',expires_in:3600},error:null}))};
 const getUser=vi.fn(async()=>({data:{user:{id:actor,email_confirmed_at:'2026-10-01T00:00:00Z',is_anonymous:false}},error:null}));
 fixture('gemini',verified('gemini-3.5-flash'));
 mocks.clients.mockImplementation(()=>({service:{rpc:(name:string,args:any)=>rpc(name,args)},auth:{auth:{setSession:vi.fn(async()=>({error:null})),getUser,mfa}}}));
 mocks.discover.mockImplementation(async()=>state.probe);
});
const post=(body:object)=>new Request(`${origin}/api/account/admin/ai-providers`,{method:'POST',headers:{origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
const setup=(provider:'gemini'|'deepgram',revision=0)=>({action:'SETUP',provider,operationId:crypto.randomUUID(),revision,factorId:factor,code:'123456',apiKey:secret});

it('saves, checks, enables and approves Gemini with one authenticator confirmation',async()=>{
 const response=await providerAdminRequest(post(setup('gemini')));
 expect(response.status).toBe(200);
 const result=await response.json();
 expect(result).toMatchObject({code:'SETUP_COMPLETE',modelId:'gemini-3.5-flash',metadata:{provider:'gemini',revision:3,enabled:true,defaultModel:'gemini-3.5-flash'}});
 expect(JSON.stringify(result)).not.toContain(secret);
 expect(mfa.challengeAndVerify).toHaveBeenCalledTimes(1);
 expect(rpc.mock.calls.filter(([name]:any)=>name==='cluera_provider_mutate').map(([,args]:any)=>args.p_action)).toEqual(['REPLACE','TEST','CONFIGURE']);
 const replace=rpc.mock.calls.find(([,args]:any)=>args?.p_action==='REPLACE')[1];
 expect(replace.p_operation).toBe(replace.p_input.credentialId);
 expect(vaultKeyring().open(replace.p_input.sealed,{provider:'gemini',credentialId:replace.p_input.credentialId})).toBe(secret);
 expect(JSON.stringify(rpc.mock.calls)).not.toContain(secret);
 const model=rpc.mock.calls.find(([name]:any)=>name==='account_admin_mutate')[1];
 expect(model).toMatchObject({p_subject:null,p_action:'MODEL',p_input:{provider:'gemini',modelId:'gemini-3.5-flash',enabled:true,isDefault:true,capabilities:['text','image'],health:'UNVERIFIED'}});
});
it('keeps an existing model display name, priority and declared health',async()=>{
 fixture('deepgram',verified('flux-general-en'),[{modelId:'flux-general-en',displayName:'Meeting transcription',provider:'deepgram',enabled:false,isDefault:false,priority:7,capabilities:['audio'],health:'DEGRADED'}]);
 const result=await (await providerAdminRequest(post(setup('deepgram')))).json();
 expect(result.code).toBe('SETUP_COMPLETE');
 expect(rpc.mock.calls.find(([name]:any)=>name==='account_admin_mutate')[1].p_input).toMatchObject({displayName:'Meeting transcription',priority:7,health:'DEGRADED',enabled:true,isDefault:true});
});
it('rejects an unsupported provider and a wrong authenticator without touching the vault',async()=>{
 expect((await providerAdminRequest(post({...setup('gemini'),provider:'openai'}))).status).toBe(400);
 mfa.challengeAndVerify.mockResolvedValueOnce({data:null,error:Error('bad code')});
 expect((await providerAdminRequest(post(setup('gemini')))).status).toBe(403);
 expect(rpc.mock.calls.some(([name]:any)=>name==='cluera_provider_mutate')).toBe(false);
});
it.each([
 ['REJECTED','CHECK_KEY','KEY_REJECTED',{status:'REJECTED',models:[],complete:false}],
 ['UNAVAILABLE','CHECK_KEY','PROVIDER_UNAVAILABLE',{status:'UNAVAILABLE',models:[],complete:false}],
 ['a listing without the required model','CHECK_KEY','MODEL_NOT_AVAILABLE',{status:'VERIFIED',models:[{id:'gemini-2.0-flash',runtimeCompatible:false}],complete:true}],
])('stops safely when the provider check is %s and never enables or approves a model',async(_name,stage,reason,probe)=>{
 fixture('gemini',probe);
 const result=await (await providerAdminRequest(post(setup('gemini')))).json();
 expect(result).toMatchObject({code:'SETUP_STOPPED',stage,reason});
 expect(rpc.mock.calls.some(([,args]:any)=>args?.p_action==='CONFIGURE')).toBe(false);
 expect(rpc.mock.calls.some(([name]:any)=>name==='account_admin_mutate')).toBe(false);
});
it('reports a revision conflict instead of overwriting a concurrent change',async()=>{
 const result=await (await providerAdminRequest(post(setup('gemini',4)))).json();
 expect(result).toMatchObject({code:'SETUP_STOPPED',stage:'SAVE_KEY',reason:'CONFLICT',metadata:null});
 expect(mocks.discover).not.toHaveBeenCalled();
});
it('reports a refused model approval after the provider was enabled',async()=>{
 const base=rpc;rpc=vi.fn(async(name:string,args:any)=>name==='account_admin_mutate'?{data:{code:'CONFLICT'},error:null}:base(name,args));
 const result=await (await providerAdminRequest(post(setup('gemini')))).json();
 expect(result).toMatchObject({code:'SETUP_STOPPED',stage:'APPROVE_MODEL',reason:'CHANGE_REJECTED',metadata:{enabled:true}});
});
it('treats an unexpected database result as unknown and never echoes the key',async()=>{
 rpc=vi.fn(async(name:string)=>name==='account_admin_check'?{data:true,error:null}:{data:null,error:Error('boom')});
 const response=await providerAdminRequest(post(setup('gemini')));
 expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain(secret);
});
it('uses the same reauthentication timestamp for every audited step',async()=>{
 const calls:any[]=[];
 const result=await runProviderSetup({provider:'deepgram',revision:0,apiKey:secret,operationId:crypto.randomUUID()},{
  actor,session:sid,reauthenticatedAt:'2026-10-13T00:00:00.000Z',digest:value=>value.length.toString(16).padStart(64,'0'),
  seal:(key,binding)=>vaultKeyring().seal(key,binding),discover:async()=>({status:'VERIFIED',models:[{id:'flux-general-en',runtimeCompatible:true}],complete:true}),
  rpc:async(name,args)=>{calls.push([name,args]);return name==='account_models_read'?[]:name==='account_admin_mutate'?{code:'APPLIED'}:{code:'APPLIED',metadata:meta('deepgram',calls.filter(([n])=>n==='cluera_provider_mutate').length,{enabled:true,defaultModel:'flux-general-en',probeStatus:'VERIFIED',models:[{id:'flux-general-en',runtimeCompatible:true}],complete:true,probeAt:'2026-10-13T00:00:00Z'})};},
 });
 expect(result.code).toBe('SETUP_COMPLETE');
 expect(new Set(calls.filter(([n])=>n==='cluera_provider_mutate').map(([,a])=>a.p_reauthenticated_at))).toEqual(new Set(['2026-10-13T00:00:00.000Z']));
 expect(new Set(calls.filter(([n])=>n==='cluera_provider_mutate').map(([,a])=>a.p_operation)).size).toBe(3);
});
