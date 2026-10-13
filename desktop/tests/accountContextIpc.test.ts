import {beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({handlers:new Map<string,(...args:any[])=>any>(),choose:vi.fn()}));
vi.mock('electron',()=>({ipcMain:{handle:(name:string,handler:(...args:any[])=>any)=>mocks.handlers.set(name,handler)},shell:{openExternal:vi.fn()},dialog:{showOpenDialog:mocks.choose}}));
import {registerAccountIpc} from '../src/main/accounts/registerAccountIpc';
const userId='00000000-0000-4000-8000-000000000001';
beforeEach(()=>{mocks.handlers.clear();vi.clearAllMocks();});
function fixture(){
 const window={webContents:{mainFrame:{}}};const event={sender:window.webContents,senderFrame:window.webContents.mainFrame};
 const state={state:'active',userId};const account={status:()=>state};
 const context={list:vi.fn(),read:vi.fn(),select:vi.fn(),change:vi.fn(),retry:vi.fn(),importFile:vi.fn()};
 const options={workspaceUserId:userId,stop:vi.fn(),restart:vi.fn(),updates:{assertSupported:vi.fn()},context};
 registerAccountIpc(window as never,account as never,options as never);return{event,context,state};
}
it('gates every context operation on trusted main frame and the matching active account',async()=>{
 const f=fixture();for(const operation of ['list','read','select','change','retry','import']){
  for(const event of [{...f.event,sender:{}},{...f.event,senderFrame:{}}])await expect(Promise.resolve().then(()=>mocks.handlers.get(`account:context-${operation}`)!(event,{}))).rejects.toThrow('Unauthorized');
 }
 f.state.userId='00000000-0000-4000-8000-000000000002';
 expect(()=>mocks.handlers.get('account:context-list')!(f.event)).toThrow('Sign in');expect(f.context.list).not.toHaveBeenCalled();
});
it('imports only a main-owned file chooser result, never a renderer-supplied path',async()=>{
 const f=fixture();await expect(mocks.handlers.get('account:context-import')!(f.event,{kind:'RESUME',path:'C:\\private.key'})).rejects.toThrow();expect(mocks.choose).not.toHaveBeenCalled();
 mocks.choose.mockResolvedValueOnce({canceled:false,filePaths:['C:\\synthetic.docx']});
 await mocks.handlers.get('account:context-import')!(f.event,'RESUME');
 expect(f.context.importFile).toHaveBeenCalledWith('C:\\synthetic.docx','RESUME');
 mocks.choose.mockResolvedValueOnce({canceled:true,filePaths:[]});expect(await mocks.handlers.get('account:context-import')!(f.event,'RESUME')).toBeNull();
 expect(f.context.importFile).toHaveBeenCalledOnce();
});
