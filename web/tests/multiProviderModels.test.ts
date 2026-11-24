import {afterEach,expect,it,vi} from 'vitest';
import {providerAdapters} from '../lib/accountRelay/providers';
import {modelRegistry} from '../lib/accountRelay/models';
import {accountModelPolicy} from '../lib/accounts/modelPolicy';

const guard=()=>({signal:new AbortController().signal,assertActive(){}});
const sse=(events:unknown[])=>new Response(new ReadableStream({start(controller){
 for(const event of events)controller.enqueue(new TextEncoder().encode(`data: ${typeof event==='string'?event:JSON.stringify(event)}\n\n`));controller.close();}}),{status:200});
const secrets={serviceKey:'service-key-value-0000000000',rateKey:'rate-key-value-000000000000'};
const models=[
 {modelId:'gemini-3.5-flash',displayName:'Gemini 3.5 Flash',provider:'gemini',enabled:true,isDefault:true,priority:100,capabilities:['text','image'],health:'UNVERIFIED'},
 {modelId:'gpt-4o-mini',displayName:'ChatGPT mini',provider:'openai',enabled:true,isDefault:false,priority:50,capabilities:['text','image'],health:'UNVERIFIED'},
 {modelId:'claude-3-5-haiku-latest',displayName:'Claude Haiku',provider:'anthropic',enabled:true,isDefault:false,priority:60,capabilities:['text'],health:'UNVERIFIED'},
 {modelId:'gpt-old',displayName:'Old',provider:'openai',enabled:false,isDefault:false,priority:1,capabilities:['text'],health:'UNVERIFIED'},
 {modelId:'flux-general-en',displayName:'Live transcription',provider:'deepgram',enabled:true,isDefault:true,priority:100,capabilities:['audio'],health:'UNVERIFIED'},
];
afterEach(()=>vi.restoreAllMocks());

it('streams a ChatGPT answer from the fixed OpenAI host with the selected model',async()=>{
 const request=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>sse([{choices:[{delta:{content:'Hello '}}]},{choices:[{delta:{content:'there'}}]},'[DONE]']));
 const chunks:string[]=[];
 await providerAdapters({...secrets,openaiKey:'sk-openai-test-key-000000000000'},{fetch:request as typeof fetch,textProvider:'openai',resolveModel:async()=>'gpt-4o-mini'})
  .generate({type:'generate',id:'a1',prompt:'Hi'},guard(),text=>chunks.push(text));
 expect(chunks.join('')).toBe('Hello there');
 const [url,init]=request.mock.calls[0];expect(String(url)).toBe('https://api.openai.com/v1/chat/completions');
 expect(JSON.parse(String(init!.body)).model).toBe('gpt-4o-mini');expect(init!.redirect).toBe('error');
});
it('streams a Claude answer from the fixed Anthropic host and sends images in Claude format',async()=>{
 const request=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>sse([{type:'message_start'},{type:'content_block_delta',delta:{type:'text_delta',text:'Claude says hi'}},{type:'message_stop'}]));
 const chunks:string[]=[];
 const image={mimeType:'image/png' as const,data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
 await providerAdapters({...secrets,anthropicKey:'sk-ant-test-key-00000000000000'},{fetch:request as typeof fetch,textProvider:'anthropic',resolveModel:async()=>'claude-3-5-haiku-latest'})
  .generate({type:'generate',id:'a2',prompt:'Look',image},guard(),text=>chunks.push(text));
 expect(chunks.join('')).toBe('Claude says hi');
 const [url,init]=request.mock.calls[0];expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
 const body=JSON.parse(String(init!.body));expect(body.model).toBe('claude-3-5-haiku-latest');expect(body.messages[0].content[0].type).toBe('image');
});
it('fails closed on a provider error or an empty answer and never echoes the key',async()=>{
 const key='sk-openai-secret-0000000000000';
 for(const response of [new Response('{}',{status:401}),sse(['[DONE]']),sse([{error:{message:key}}])]){
  const chunks:string[]=[];
  await expect(providerAdapters({...secrets,openaiKey:key},{fetch:(async()=>response) as typeof fetch,textProvider:'openai',resolveModel:async()=>'gpt-4o-mini'})
   .generate({type:'generate',id:'a3',prompt:'Hi'},guard(),text=>chunks.push(text))).rejects.toThrow('Provider unavailable.');
  expect(chunks.join('')).not.toContain(key);
 }
});
it('routes an answer model to its provider and falls back to the answer default when none is chosen',async()=>{
 const registry=modelRegistry(async()=>models);
 expect(await registry.resolveText('gpt-4o-mini')).toEqual({provider:'openai',modelId:'gpt-4o-mini'});
 expect(await registry.resolveText('claude-3-5-haiku-latest')).toEqual({provider:'anthropic',modelId:'claude-3-5-haiku-latest'});
 expect(await registry.resolveText()).toEqual({provider:'gemini',modelId:'gemini-3.5-flash'});
 await expect(registry.resolveText('gpt-old')).rejects.toThrow();
 await expect(registry.resolveText('claude-3-5-haiku-latest',true)).rejects.toThrow();
 await expect(registry.resolveText('flux-general-en')).rejects.toThrow();
 expect(await registry.resolveAudio()).toEqual({provider:'deepgram',modelId:'flux-general-en'});
});
it('accepts ChatGPT, Claude and new Deepgram Flux models, and rejects unusable policies',()=>{
 const base={displayName:'Model',enabled:true,isDefault:false,priority:10,health:'UNVERIFIED' as const};
 expect(accountModelPolicy.safeParse({...base,modelId:'gpt-5',provider:'openai',capabilities:['text','image']}).success).toBe(true);
 expect(accountModelPolicy.safeParse({...base,modelId:'claude-sonnet-4-5',provider:'anthropic',capabilities:['text']}).success).toBe(true);
 expect(accountModelPolicy.safeParse({...base,modelId:'flux-general-multi',provider:'deepgram',capabilities:['audio']}).success).toBe(true);
 expect(accountModelPolicy.safeParse({...base,modelId:'nova-3',provider:'deepgram',capabilities:['audio']}).success).toBe(false);
 expect(accountModelPolicy.safeParse({...base,modelId:'gpt-5',provider:'openai',capabilities:['audio']}).success).toBe(false);
});
it('lists every answer model as an answer model for installed desktop apps, with one default each',async()=>{
 vi.resetModules();
 vi.doMock('../lib/accounts/clients',()=>({accountClients:()=>({service:{rpc:async()=>({data:models,error:null,status:200})}})}));
 vi.doMock('../lib/accounts/workspace',()=>({stagingAccountConfig:()=>({})}));
 const {GET}=await import('../app/api/account/models/route');
 const body=await (await GET()).json();
 expect(new Set(body.models.map((m:{provider:string})=>m.provider))).toEqual(new Set(['gemini','deepgram']));
 expect(body.models.find((m:{modelId:string})=>m.modelId==='claude-3-5-haiku-latest')).toMatchObject({provider:'gemini',enabled:true,description:'Claude model'});
 expect(body.models.filter((m:{provider:string;isDefault:boolean})=>m.provider==='gemini'&&m.isDefault)).toHaveLength(1);
 expect(body.models.filter((m:{provider:string;isDefault:boolean})=>m.provider==='deepgram'&&m.isDefault)).toHaveLength(1);
 vi.doUnmock('../lib/accounts/clients');vi.doUnmock('../lib/accounts/workspace');
});
it('uses fast thinking per Gemini family and retries a new model that rejects it',async()=>{
 const {geminiFastThinking}=await import('../lib/accountRelay/providers');
 expect(geminiFastThinking('gemini-2.5-flash')).toEqual({thinkingBudget:0});
 expect(geminiFastThinking('gemini-3.5-flash')).toEqual({thinkingLevel:'minimal'});
 expect(geminiFastThinking('gemini-4-argon')).toEqual({thinkingLevel:'minimal'});
 expect(geminiFastThinking('gemini-pro-latest')).toBeUndefined();
 const bodies:unknown[]=[];
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{bodies.push(JSON.parse(String(init!.body)));
  return bodies.length===1?new Response('{}',{status:400}):sse([{candidates:[{content:{parts:[{text:'ok answer'}]},finishReason:'STOP'}]}]);});
 const chunks:string[]=[];
 await providerAdapters({...secrets,geminiKey:'AIza-test-key-0000000000000000'},{fetch:request as typeof fetch,resolveModel:async()=>'gemini-4-argon'})
  .generate({type:'generate',id:'g1',prompt:'Hi'},guard(),text=>chunks.push(text));
 expect(chunks.join('')).toBe('ok answer');expect(request).toHaveBeenCalledTimes(2);
 expect((bodies[0] as {generationConfig:{thinkingConfig?:unknown}}).generationConfig.thinkingConfig).toEqual({thinkingLevel:'minimal'});
 expect((bodies[1] as {generationConfig:{thinkingConfig?:unknown}}).generationConfig.thinkingConfig).toBeUndefined();
});
