import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({clients:vi.fn(),session:vi.fn(),rate:vi.fn(),origin:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:mocks.clients}));
vi.mock('../lib/accounts/handler',()=>({activeSession:mocks.session,rateLimit:mocks.rate,assertAccountOrigin:mocks.origin}));
import {workspaceRequest} from '../lib/accounts/workspace';
import {AccountError} from '../lib/accounts/config';
const user='00000000-0000-4000-8000-000000000001',session='00000000-0000-4000-8000-000000000002';
let rpc:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','true');vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN','https://cluera-ai-staging.vercel.app');
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://yhnqlfcgrmckhyjdxegg.supabase.co');vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY','sb_publishable_synthetic_public_key_00000000000000000');
 vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY','sb_secret_synthetic-service-key-placeholder');
 vi.stubEnv('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64',Buffer.alloc(32,3).toString('base64'));
 vi.stubEnv('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',Buffer.alloc(32,4).toString('base64'));
 rpc=vi.fn(async()=>({data:{code:'ACTIVE',documents:[]},error:null,status:200}));mocks.clients.mockReturnValue({service:{rpc}});
 mocks.session.mockResolvedValue({account:{userId:user,sessionId:session,email:'synthetic@example.invalid'}});mocks.rate.mockResolvedValue(undefined);
});
afterEach(()=>{vi.unstubAllEnvs();vi.resetAllMocks();});
const request=(body:object)=>new Request('https://cluera-ai-staging.vercel.app/api/account/workspace',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
it('routes browser saves/deletes through the same replay journal and returns a fresh workspace snapshot',async()=>{
 const body={action:'SAVE_CONTEXT',id:user,operationId:session,kind:'RESUME',name:'CV',body:'Synthetic text'};
 expect((await workspaceRequest(request(body))).status).toBe(200);
 expect(rpc).toHaveBeenNthCalledWith(1,'customer_context_command',{p_user:user,p_session:session,p_input:{...body,action:'SAVE'}});
 expect(rpc).toHaveBeenNthCalledWith(2,'customer_workspace',{p_user:user,p_session:session,p_action:'READ',p_input:{}});
});
it('rejects missing operation/foreign identity before RPC and never treats unauthorized access as context authority',async()=>{
 expect((await workspaceRequest(request({action:'DELETE_CONTEXT',id:user}))).status).toBe(400);expect(rpc).not.toHaveBeenCalled();
 expect((await workspaceRequest(request({action:'DELETE_CONTEXT',id:user,operationId:session,userId:user}))).status).toBe(400);expect(rpc).not.toHaveBeenCalled();
 mocks.session.mockRejectedValueOnce(new AccountError('UNAUTHENTICATED',401));
 expect((await workspaceRequest(request({action:'DELETE_CONTEXT',id:user,operationId:session}))).status).toBe(401);expect(rpc).not.toHaveBeenCalled();
});
it('maps authoritative quota/validation denial to a definite rejection without running a second write',async()=>{
 rpc.mockResolvedValueOnce({data:{code:'CAPACITY'},error:null,status:200});
 expect((await workspaceRequest(request({action:'DELETE_CONTEXT',id:user,operationId:session}))).status).toBe(400);expect(rpc).toHaveBeenCalledOnce();
});
