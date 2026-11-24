import {expect,it,vi} from 'vitest';
import {modelRegistry} from '../lib/accountRelay/models';
import {accountModelPolicy} from '../lib/accounts/modelPolicy';

const base={displayName:'Model',enabled:true,isDefault:false,priority:10,health:'UNVERIFIED' as const,provider:'openai' as const,capabilities:['text','image'] as const};

it('accepts a model label, a blank label for automatic and a dash for no label',()=>{
 for(const tag of ['Recommended','Very slow','Best for coding','','-'])
  expect(accountModelPolicy.safeParse({...base,modelId:'gpt-5',capabilities:[...base.capabilities],tag}).success,tag).toBe(true);
 expect(accountModelPolicy.safeParse({...base,modelId:'gpt-5',capabilities:[...base.capabilities]}).success).toBe(true);
});
it('rejects labels that are too long or carry markup or control characters',()=>{
 for(const tag of ['x'.repeat(25),'<b>Fast</b>','Fast\u0007','a>b'])
  expect(accountModelPolicy.safeParse({...base,modelId:'gpt-5',capabilities:[...base.capabilities],tag}).success,JSON.stringify(tag)).toBe(false);
});
it('keeps the label when the model list is read, and still accepts rows without one',async()=>{
 const registry=modelRegistry(async()=>[
  {modelId:'gpt-5',displayName:'GPT 5',provider:'openai',enabled:true,isDefault:false,priority:10,capabilities:['text'],health:'UNVERIFIED',tag:'Fast'},
  {modelId:'gpt-4',displayName:'GPT 4',provider:'openai',enabled:true,isDefault:false,priority:20,capabilities:['text'],health:'UNVERIFIED'},
 ]);
 const list=await registry.list();
 expect(list.map(model=>model.tag)).toEqual(['Fast',undefined]);
 const broken=modelRegistry(async()=>[{modelId:'gpt-5',displayName:'GPT 5',provider:'openai',enabled:true,isDefault:false,priority:10,capabilities:['text'],health:'UNVERIFIED',tag:'x'.repeat(30)}]);
 await expect(broken.list()).rejects.toThrow();
});
it('publishes the label in the public model list',async()=>{
 vi.resetModules();
 vi.doMock('../lib/accounts/workspace',()=>({stagingAccountConfig:()=>({})}));
 vi.doMock('../lib/accounts/clients',()=>({accountClients:()=>({service:{rpc:async()=>({data:[
  {modelId:'gpt-5',displayName:'GPT 5',provider:'openai',enabled:true,isDefault:true,priority:10,capabilities:['text'],health:'UNVERIFIED',tag:'Recommended'},
  {modelId:'gpt-4',displayName:'GPT 4',provider:'openai',enabled:true,isDefault:false,priority:20,capabilities:['text'],health:'UNVERIFIED'},
  {modelId:'flux-general-en',displayName:'Live',provider:'deepgram',enabled:true,isDefault:true,priority:1,capabilities:['audio'],health:'UNVERIFIED',tag:''},
 ],error:null,status:200})}})}));
 const {GET}=await import('../app/api/account/models/route');
 const body=await (await GET()).json() as {models:{modelId:string;tag:string}[]};
 expect(body.models.find(model=>model.modelId==='gpt-5')?.tag).toBe('Recommended');
 expect(body.models.find(model=>model.modelId==='gpt-4')?.tag).toBe('');
 vi.doUnmock('../lib/accounts/workspace');vi.doUnmock('../lib/accounts/clients');
});
