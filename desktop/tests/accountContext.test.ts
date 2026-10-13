import {expect,it,vi} from 'vitest';
import {AccountContextManager} from '../src/main/accounts/AccountContextManager';
import {selectedContextExcerpt,contextCommand,type ContextDocument} from '../src/shared/accountContext';
const owner='00000000-0000-4000-8000-000000000001', id='00000000-0000-4000-8000-000000000002';
const doc:ContextDocument={id,name:'Résumé',kind:'RESUME',bytes:27,updatedAt:'2026-10-08',body:'Synthetic SQL engineering skills'};
function fixture(){
 let docs=[doc];const lifetime=new AbortController();const state={mode:'cluera-staging',state:'active',userId:owner};
 const request=vi.fn(async(_url:unknown,init:any)=>{const body=JSON.parse(init.body);return Response.json({code:'ACTIVE',documents:body.action==='READ'?docs:docs.map(({body:_,...metadata})=>metadata)});});
 const account={status:()=>state,authorizeWork:vi.fn(async()=>({accessToken:'synthetic-private-native-token',signal:lifetime.signal}))};
 const processor={extract:vi.fn(async()=>({text:doc.body!,mimeType:'text/plain',sizeBytes:27}))};
 const manager=new AccountContextManager(account as never,owner,request as never,processor as never);
 return {manager,request,account,state,lifetime,processor,setDocs:(value:ContextDocument[])=>{docs=value;}};
}
it('does no context network work until explicit selection and retrieves only selected current IDs',async()=>{
 const f=fixture();expect(await f.manager.augment('SQL question',new AbortController().signal)).toBe('SQL question');expect(f.request).not.toHaveBeenCalled();
 await f.manager.select([id]);const result=await f.manager.augment('SQL question',new AbortController().signal);
 expect(result).toContain('SQL engineering');expect(JSON.parse(f.request.mock.calls.at(-1)![1].body)).toEqual({action:'READ',ids:[id]});
 expect(JSON.stringify(await f.manager.list())).not.toContain('synthetic-private-native-token');
 f.setDocs([]);expect(await f.manager.augment('SQL question',new AbortController().signal)).toBe('SQL question');
 expect((await f.manager.list()).selectedIds).toEqual([]);
});
it('drops updated/deleted data on the next generation rather than caching its text',async()=>{
 const f=fixture();await f.manager.select([id]);await f.manager.augment('SQL',new AbortController().signal);
 f.setDocs([{...doc,body:'Updated Rust expertise'}]);const answer=await f.manager.augment('Rust',new AbortController().signal);
 expect(answer).toContain('Updated Rust');expect(answer).not.toContain('SQL engineering');
});
it('preserves identical uncertain operation and disallows another write or answer until recovery',async()=>{
 const f=fixture();f.request.mockRejectedValueOnce(new Error('Synthetic outage'));
 const change={action:'SAVE',id,operationId:owner,kind:'RESUME',name:'CV',body:'Safe synthetic text'};
 await expect(f.manager.change(change)).rejects.toThrow();
 await expect(f.manager.change(change)).rejects.toThrow();await expect(f.manager.augment('Q',new AbortController().signal)).rejects.toThrow();
 await f.manager.retry();expect(f.request.mock.calls[0][1].body).toBe(f.request.mock.calls[1][1].body);
 expect((await f.manager.list()).pending).toBe(false);
});
it('unlocks a definite pre-write rejection without retrying it or blocking unrelated answers',async()=>{
 for(const status of [400,413,429]){
  const f=fixture();f.request.mockResolvedValueOnce(new Response(null,{status}));
  await expect(f.manager.change({action:'SAVE',id,operationId:owner,kind:'RESUME',name:'CV',body:'Safe text'})).rejects.toThrow('not saved');
  expect((await f.manager.list()).pending).toBe(false);expect(await f.manager.augment('Q',new AbortController().signal)).toBe('Q');
 }
});
it('does not forget an earlier unknown outcome when a subsequent retry is rate-limited before RPC',async()=>{
 const f=fixture();f.request.mockRejectedValueOnce(new Error('Response lost')).mockResolvedValueOnce(new Response(null,{status:429}));
 const input={action:'SAVE',id,operationId:owner,kind:'RESUME',name:'CV',body:'Synthetic context'};
 await expect(f.manager.change(input)).rejects.toThrow();await expect(f.manager.retry()).rejects.toThrow();
 await expect(f.manager.change(input)).rejects.toThrow();expect((await f.manager.list()).pending).toBe(true);
 await f.manager.retry();expect((await f.manager.list()).pending).toBe(false);
 const saves=f.request.mock.calls.map(call=>JSON.parse(call[1].body)).filter(value=>value.action==='SAVE');
 expect(saves).toEqual([input,input,input]);
});
it('fences account switch and logout during extraction/fetch without leaking content',async()=>{
 const f=fixture();await f.manager.select([id]);f.state.userId=id;
 await expect(f.manager.augment('Q',new AbortController().signal)).rejects.toThrow();
 f.state.userId=owner;expect((await f.manager.list()).selectedIds).toEqual([]);
 f.request.mockImplementationOnce(async()=>{f.lifetime.abort();return Response.json({code:'ACTIVE',documents:[doc]});});
 await expect(f.manager.read(id)).rejects.toThrow();
});
it('reuses extraction without returning file paths and validates extracted UTF8 size before upload',async()=>{
 const f=fixture();await f.manager.importFile('C:\\private\\synthetic.txt','RESUME');
 const sent=JSON.parse(f.request.mock.calls[0][1].body);expect(sent.name).toBe('synthetic.txt');expect(sent.body).toBe(doc.body);
 expect(JSON.stringify(sent)).not.toContain('private');expect(f.processor.extract).toHaveBeenCalledOnce();
 f.processor.extract.mockResolvedValueOnce({text:'é'.repeat(60001),mimeType:'text/plain',sizeBytes:120002});
 await expect(f.manager.importFile('C:\\private\\big.txt','RESUME')).rejects.toThrow();expect(f.request).toHaveBeenCalledOnce();
 f.processor.extract.mockRejectedValueOnce(new Error('Cannot read C:\\private\\sensitive.txt'));
 await expect(f.manager.importFile('C:\\private\\sensitive.txt','RESUME')).rejects.toThrow('Document could not be imported');
});
it('bounds retrieval and prioritizes relevant selected excerpts without treating source as privileged instructions',()=>{
 const text='unrelated '.repeat(9000)+' SQL distributed transactions '+ 'unrelated '.repeat(2000);
 const result=selectedContextExcerpt([{...doc,body:text},{...doc,id:owner,name:'Preferences',kind:'INSTRUCTIONS',body:'Use concise examples'}],'SQL distributed transactions');
 expect(result).toContain('SQL distributed transactions');expect(result).toContain('quoted reference data');expect(Buffer.byteLength(result)).toBeLessThan(12300);
 expect(contextCommand.safeParse({action:'READ',ids:Array(9).fill(id)}).success).toBe(false);
});
