import {createRequire} from 'node:module';
import {it,expect,vi} from 'vitest';
const {run,paymentFlags}=createRequire(import.meta.url)('../../scripts/verify-cluera-private-configuration.cjs');
function fixture(){
 const listUsers=vi.fn(async()=>({error:null,data:{users:[{secret:'synthetic-private-response'}]}}));
 const readProviderStatus=vi.fn(async()=>({bootstrapMode:'auth-only',providers:[{enabled:false,configured:false,fingerprint:null},{enabled:false,configured:false,fingerprint:null}]}));
 return {listUsers,readProviderStatus,accountConfig:vi.fn(()=>({})),accountClients:vi.fn(()=>({service:{auth:{admin:{listUsers}}}}))};
}
const env=Object.fromEntries(paymentFlags.map((name:string)=>[name,'false']));
it('reads only server configuration, one bounded SDK listing and authenticated metadata with safe output',async()=>{
 const f=fixture(),value=await run(f,env);expect(f.listUsers).toHaveBeenCalledExactlyOnceWith({page:1,perPage:1});
 expect(value).toMatchObject({serviceKeyAuthenticated:true,relayAuthenticated:true,authOnly:true,providersDisabled:true,providerRequests:0,mutations:0});
 expect(JSON.stringify(value)).not.toContain('synthetic-private-response');
});
it('stops before network on missing configuration, unsafe payment flags or a provisioned vault',async()=>{
 for(const changed of [{...env,[paymentFlags[0]]:'true'},{...env,CLUERA_PROVIDER_VAULT_KEYRING_BASE64:'synthetic'}]){
  const f=fixture();await run(f,changed);expect(f.listUsers).not.toHaveBeenCalled();expect(f.readProviderStatus).not.toHaveBeenCalled();
 }
 const f=fixture();f.accountConfig.mockImplementation(()=>{throw Error('synthetic-secret');});expect((await run(f,env)).configuration).toBe(false);expect(f.listUsers).not.toHaveBeenCalled();
});
it('fails closed on authentication errors and does not mislabel legacy or enabled providers as auth-only',async()=>{
 const f=fixture();f.listUsers.mockResolvedValue({error:{message:'synthetic-private-error'},data:null} as any);
 const failed=await run(f,env);expect(failed.serviceKeyAuthenticated).toBe(false);expect(f.readProviderStatus).not.toHaveBeenCalled();expect(JSON.stringify(failed)).not.toContain('synthetic-private-error');
 const g=fixture();g.readProviderStatus.mockResolvedValue({providers:[{enabled:true,configured:true,fingerprint:'synthetic'},{enabled:true,configured:true,fingerprint:'synthetic'}]} as any);
 const old=await run(g,env);expect(old.authOnly).toBe(false);expect(old.providersDisabled).toBe(false);
});
