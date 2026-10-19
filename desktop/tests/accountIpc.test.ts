import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,(...args:any[])=>any>(),openExternal:vi.fn()}));
vi.mock('electron',()=>({ipcMain:{handle:(name:string,handler:(...args:any[])=>any)=>mocks.handlers.set(name,handler)},shell:{openExternal:mocks.openExternal}}));
import {registerAccountIpc} from '../src/main/accounts/registerAccountIpc';
const userId='00000000-0000-4000-8000-000000000001';
beforeEach(()=>{mocks.handlers.clear();vi.clearAllMocks();});
function fixture(active=true){
 const window={webContents:{mainFrame:{}}};const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
 const view={mode:'cluera-staging',state:active?'active':'signed-out',userId:active?userId:undefined};
 const account={status:()=>view,login:vi.fn(async()=>view),restore:vi.fn(async()=>view),logout:vi.fn(async()=>({mode:'cluera-staging',state:'signed-out'})),authorizeWork:vi.fn(async()=>({accessToken:'synthetic-sensitive-token'}))};
 const options={workspaceUserId:userId,stop:vi.fn(async()=>undefined),restart:vi.fn(),updates:{assertSupported:vi.fn(),install:vi.fn(async()=>({state:'current'})),officialDownloadPage:()=> 'https://cluera-ai-staging.vercel.app/download'}};
 registerAccountIpc(window as never,account as never,options as never);return {window,event,account,options};
}
it('rejects another renderer or subframe on every account action',async()=>{
 const f=fixture();for(const name of ['account:status','account:auth-options','account:login','account:google','account:retry','account:logout','account:open-web']){
  for(const event of [{...f.event,senderFrame:{}},{...f.event,sender:{}}]){
   await expect(Promise.resolve().then(()=>mocks.handlers.get(name)!(event,{}))).rejects.toThrow('Unauthorized');
  }
 }
 expect(f.account.login).not.toHaveBeenCalled();expect(f.account.logout).not.toHaveBeenCalled();
});
it('accepts only typed login fields and never exposes an access-token or relay IPC method',async()=>{
 const f=fixture();await expect(mocks.handlers.get('account:login')!(f.event,{email:'x@example.invalid',password:'valid',accessToken:'bad'})).rejects.toThrow('valid email');
 expect([...mocks.handlers.keys()].some(name=>/token|relay|credential/.test(name))).toBe(false);
 const result=await mocks.handlers.get('account:login')!(f.event,{email:'x@example.invalid',password:'valid'});expect(result).toMatchObject({state:'active'});
 expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-token');
});
it('defers a different account to workspace restart, not access to another local database',async()=>{
 const f=fixture();f.account.login.mockResolvedValueOnce({mode:'cluera-staging',state:'active',userId:'00000000-0000-4000-8000-000000000002'});
 expect(await mocks.handlers.get('account:login')!(f.event,{email:'x@example.invalid',password:'valid'})).toMatchObject({state:'checking'});
 expect(f.options.restart).toHaveBeenCalledOnce();
});
it('blocks arbitrary external destinations and gates updates with live account authorization',async()=>{
 const f=fixture();await expect(mocks.handlers.get('account:open-web')!(f.event,'https://evil.invalid')).rejects.toThrow();
 await mocks.handlers.get('account:open-web')!(f.event,'signup');expect(mocks.openExternal).toHaveBeenCalledWith('https://cluera-ai-staging.vercel.app/account#signup');
 await mocks.handlers.get('account:open-web')!(f.event,'reset-password');expect(mocks.openExternal).toHaveBeenCalledWith('https://cluera-ai-staging.vercel.app/account#forgot-password');
 await mocks.handlers.get('account:open-web')!(f.event,'dashboard');expect(mocks.openExternal).toHaveBeenCalledWith('https://cluera-ai-staging.vercel.app/account');
 await mocks.handlers.get('updates:install')!(f.event);expect(f.account.authorizeWork).toHaveBeenCalledOnce();expect(f.options.updates.install).toHaveBeenCalledOnce();
});
it('allows an authenticated required-update install without bypassing account authorization',async()=>{
 const f=fixture();f.options.updates.assertSupported.mockImplementation(()=>{throw new Error('Required update');});
 await mocks.handlers.get('updates:install')!(f.event);
 expect(f.options.updates.assertSupported).not.toHaveBeenCalled();
 expect(f.account.authorizeWork).toHaveBeenCalledOnce();expect(f.options.updates.install).toHaveBeenCalledOnce();
 f.account.authorizeWork.mockRejectedValueOnce(new Error('Account revoked'));
 await expect(mocks.handlers.get('updates:install')!(f.event)).rejects.toThrow('Account revoked');
 expect(f.options.updates.install).toHaveBeenCalledTimes(1);
});
it('refuses update installation from signed-out accounts and untrusted frames',async()=>{
 const f=fixture(false);
 await expect(mocks.handlers.get('updates:install')!(f.event)).rejects.toThrow('Sign in');
 await expect(mocks.handlers.get('updates:install')!({...f.event,senderFrame:{}})).rejects.toThrow('Unauthorized');
 expect(f.options.updates.install).not.toHaveBeenCalled();expect(f.account.authorizeWork).not.toHaveBeenCalled();
});
