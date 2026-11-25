import {afterEach,expect,it,vi} from 'vitest';
import {providerAdapters,openaiReasoningLadder} from '../lib/accountRelay/providers';
import {commandFrame} from '../lib/accountRelay/protocol';
import {providerTelemetry} from '../lib/aiProviders/telemetry';
import type {ReceiptMetadata} from '../lib/aiProviders/usageMetadata';

const guard=()=>({signal:new AbortController().signal,assertActive(){}});
const sse=(events:unknown[])=>new Response(new ReadableStream({start(controller){
 for(const event of events)controller.enqueue(new TextEncoder().encode(`data: ${typeof event==='string'?event:JSON.stringify(event)}\n\n`));controller.close();}}),{status:200});
const secrets={serviceKey:'service-key-value-0000000000',rateKey:'rate-key-value-000000000000'};
const openai=(request:ReturnType<typeof vi.fn>,model:string)=>providerAdapters({...secrets,openaiKey:'sk-openai-test-key-000000000000'},{fetch:request as typeof fetch,textProvider:'openai',resolveModel:async()=>model,receipt:value=>receipts.push(value)});
const claude=(request:ReturnType<typeof vi.fn>,model:string)=>providerAdapters({...secrets,anthropicKey:'sk-ant-test-key-00000000000000'},{fetch:request as typeof fetch,textProvider:'anthropic',resolveModel:async()=>model,receipt:value=>receipts.push(value)});
let receipts:ReceiptMetadata[]=[];
const body=(request:ReturnType<typeof vi.fn>,call=0)=>JSON.parse(String(request.mock.calls[call][1]!.body));
afterEach(()=>{vi.restoreAllMocks();receipts=[];});

it('picks the fastest reasoning setting each OpenAI family accepts',()=>{
 expect(openaiReasoningLadder('gpt-5-mini')).toEqual(['minimal','none','low',undefined]);
 expect(openaiReasoningLadder('gpt-5.2')).toEqual(['minimal','none','low',undefined]);
 expect(openaiReasoningLadder('gpt-6')).toEqual(['minimal','none','low',undefined]);
 expect(openaiReasoningLadder('o4-mini')).toEqual(['low',undefined]);
 for(const chat of ['gpt-4o-mini','gpt-4.1','gpt-5-chat-latest','chatgpt-4o-latest'])expect(openaiReasoningLadder(chat)).toEqual([undefined]);
});
it('asks GPT-5 models not to think, caps the answer length, reads screenshots in high detail and reports usage',async()=>{
 const request=vi.fn(async()=>sse([{id:'chatcmpl-abc',choices:[{delta:{content:'Hello '}}]},{choices:[{delta:{content:'there'},finish_reason:'stop'}]},
  {id:'chatcmpl-abc',choices:[],usage:{prompt_tokens:1200,completion_tokens:150,total_tokens:1350,completion_tokens_details:{reasoning_tokens:30},prompt_tokens_details:{cached_tokens:1000}}},'[DONE]']));
 const chunks:string[]=[];
 const image={mimeType:'image/png' as const,data:Buffer.from([137,80,78,71,13,10,26,10]).toString('base64')};
 await openai(request,'gpt-5-mini-test-a').generate({type:'generate',id:'a1',prompt:'Hi',image,maxTokens:800},guard(),text=>chunks.push(text));
 expect(chunks.join('')).toBe('Hello there');
 const sent=body(request);
 expect(sent).toMatchObject({model:'gpt-5-mini-test-a',stream:true,stream_options:{include_usage:true},max_completion_tokens:800,reasoning_effort:'minimal'});
 expect('temperature' in sent).toBe(false);
 expect(sent.messages[1].content[1].image_url.detail).toBe('high');
 expect(receipts).toHaveLength(1);
 expect(receipts[0]).toMatchObject({inputTokens:1200,outputTokens:120,thinkingTokens:30,cachedTokens:1000,totalTokens:1350});
 expect(receipts[0].requestHash).toMatch(/^[a-f0-9]{64}$/);
});
it('walks the reasoning ladder down for a model that rejects a value, then remembers the accepted one',async()=>{
 const efforts:Array<string|undefined>=[];
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const effort=JSON.parse(String(init!.body)).reasoning_effort;efforts.push(effort);
  return effort==='none'?sse([{choices:[{delta:{content:'ok'}}]},'[DONE]']):new Response('{}',{status:400});});
 const run=()=>openai(request,'gpt-5.9-test-b').generate({type:'generate',id:'a2',prompt:'Hi'},guard(),()=>undefined);
 await run();expect(efforts).toEqual(['minimal','none']);
 efforts.length=0;await run();expect(efforts).toEqual(['none']);
});
it('keeps a steady temperature for chat-style OpenAI models and sends no reasoning setting',async()=>{
 const request=vi.fn(async()=>sse([{choices:[{delta:{content:'ok'}}]},'[DONE]']));
 await openai(request,'gpt-4o-mini').generate({type:'generate',id:'a3',prompt:'Hi'},guard(),()=>undefined);
 const sent=body(request);expect(sent.temperature).toBe(0.6);expect('reasoning_effort' in sent).toBe(false);expect(sent.max_completion_tokens).toBe(3000);
});
it('fails closed when OpenAI refuses or filters the answer',async()=>{
 for(const events of [[{choices:[{delta:{refusal:'no'}}]}],[{choices:[{delta:{content:'x'},finish_reason:'content_filter'}]}]]){
  await expect(openai(vi.fn(async()=>sse([...events,'[DONE]'])),'gpt-4o-mini').generate({type:'generate',id:'a4',prompt:'Hi'},guard(),()=>undefined)).rejects.toThrow('Provider unavailable.');
 }
});
it('reports Claude usage, caps the answer length and fails closed on a refusal',async()=>{
 const request=vi.fn(async()=>sse([{type:'message_start',message:{id:'msg_01',usage:{input_tokens:200,cache_read_input_tokens:800,cache_creation_input_tokens:0,output_tokens:1}}},
  {type:'content_block_delta',delta:{type:'text_delta',text:'Claude says hi'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:42}},{type:'message_stop'}]));
 const chunks:string[]=[];
 await claude(request,'claude-haiku-5-5').generate({type:'generate',id:'b1',prompt:'Hi',maxTokens:1500},guard(),text=>chunks.push(text));
 expect(chunks.join('')).toBe('Claude says hi');
 expect(body(request)).toMatchObject({model:'claude-haiku-5-5',max_tokens:1500,temperature:0.6,stream:true});
 expect(receipts[0]).toMatchObject({inputTokens:1000,cachedTokens:800,outputTokens:42});
 await expect(claude(vi.fn(async()=>sse([{type:'message_start',message:{usage:{input_tokens:1}}},{type:'content_block_delta',delta:{type:'text_delta',text:'x'}},{type:'message_delta',delta:{stop_reason:'refusal'},usage:{output_tokens:1}}])),'claude-haiku-5-5')
  .generate({type:'generate',id:'b2',prompt:'Hi'},guard(),()=>undefined)).rejects.toThrow('Provider unavailable.');
});
it('retries a Claude model once without a custom temperature when it refuses one, and remembers that',async()=>{
 const sent:Array<boolean>=[];
 const request=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{const has='temperature' in JSON.parse(String(init!.body));sent.push(has);
  return has?new Response('{}',{status:400}):sse([{type:'content_block_delta',delta:{type:'text_delta',text:'ok'}},{type:'message_stop'}]);});
 const run=()=>claude(request,'claude-notemp-test').generate({type:'generate',id:'b3',prompt:'Hi'},guard(),()=>undefined);
 await run();expect(sent).toEqual([true,false]);
 sent.length=0;await run();expect(sent).toEqual([false]);
});
it('limits Gemini answers by the requested length too',async()=>{
 const request=vi.fn(async()=>sse([{candidates:[{content:{parts:[{text:'ok'}]},finishReason:'STOP'}]}]));
 await providerAdapters({...secrets,geminiKey:'AIza-test-key-0000000000000000'},{fetch:request as typeof fetch,resolveModel:async()=>'gemini-3.5-flash'})
  .generate({type:'generate',id:'g1',prompt:'Hi',maxTokens:800},guard(),()=>undefined);
 expect(body(request).generationConfig.maxOutputTokens).toBe(800);
});
it('accepts only a sensible answer-length limit from the app',()=>{
 const base={type:'generate',id:'x1',prompt:'Hi'};
 expect(commandFrame.safeParse({...base,maxTokens:800}).success).toBe(true);
 for(const maxTokens of [99,4001,1.5,'800'])expect(commandFrame.safeParse({...base,maxTokens}).success).toBe(false);
});
it('records the model that answered, cache writes, thinking and region',async()=>{
 await openai(vi.fn(async()=>sse([{id:'chatcmpl-x',model:'gpt-6-luna-2026-09-15',service_tier:'default',choices:[{delta:{content:'ok'},finish_reason:'stop'}],usage:null},
  {id:'chatcmpl-x',choices:[],usage:{prompt_tokens:300,completion_tokens:20,total_tokens:320,prompt_tokens_details:{cached_tokens:100,cache_write_tokens:150}}},'[DONE]'])),'gpt-6-luna')
  .generate({type:'generate',id:'m1',prompt:'Hi'},guard(),()=>undefined);
 expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({servedModel:'gpt-6-luna-2026-09-15',serviceTier:'default',inputTokens:300,cachedTokens:100,cacheWriteTokens:150,outputTokens:20});
 expect('estimated' in receipts[0]).toBe(false);receipts=[];
 await claude(vi.fn(async()=>sse([{type:'message_start',message:{id:'msg_9',model:'claude-haiku-5-5-20261001',usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:30,cache_creation:{ephemeral_1h_input_tokens:10},output_tokens:1,inference_geo:'us',service_tier:'standard'}}},
  {type:'content_block_delta',delta:{type:'text_delta',text:'hi'}},{type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:50,output_tokens_details:{thinking_tokens:15}}}])),'claude-haiku-5-5')
  .generate({type:'generate',id:'m2',prompt:'Hi'},guard(),()=>undefined);
 expect(receipts[0]).toMatchObject({servedModel:'claude-haiku-5-5-20261001',inputTokens:60,cachedTokens:20,cacheWriteTokens:30,cacheWrite1hTokens:10,outputTokens:35,thinkingTokens:15,region:'us',serviceTier:'standard'});
});
const stoppable=()=>{const owner=new AbortController();return {owner,guard:{signal:owner.signal,assertActive(){if(owner.signal.aborted)throw Error('stopped');}}};};
it('records a reply the customer stopped as an estimate, using the provider counts when it sent them',async()=>{
 const gpt=stoppable();
 await expect(openai(vi.fn(async()=>sse([{id:'chatcmpl-s',model:'gpt-6-luna',choices:[{delta:{content:'hello world'}}]},{choices:[{delta:{content:'more'}}]},'[DONE]'])),'gpt-6-luna')
  .generate({type:'generate',id:'s1',prompt:'x'.repeat(400)},gpt.guard,()=>gpt.owner.abort())).rejects.toThrow('Provider unavailable.');
 expect(receipts).toHaveLength(1);expect(receipts[0]).toMatchObject({estimated:true,outputTokens:3,servedModel:'gpt-6-luna'});
 expect(receipts[0].inputTokens).toBe(Math.ceil((400+'You are Cluera, a concise interview copilot. Answer clearly and directly.'.length)/4));receipts=[];
 const claudeStop=stoppable();
 await expect(claude(vi.fn(async()=>sse([{type:'message_start',message:{id:'msg_s',usage:{input_tokens:900,output_tokens:1}}},{type:'content_block_delta',delta:{type:'text_delta',text:'a long first part'}},{type:'content_block_delta',delta:{type:'text_delta',text:'more'}}])),'claude-haiku-5-5')
  .generate({type:'generate',id:'s2',prompt:'Hi'},claudeStop.guard,()=>claudeStop.owner.abort())).rejects.toThrow('Provider unavailable.');
 expect(receipts[0]).toMatchObject({estimated:true,inputTokens:900,outputTokens:5});
});
it('adds no usage for a request the provider refused before answering',async()=>{
 await expect(openai(vi.fn(async()=>new Response('{}',{status:429})),'gpt-6-luna').generate({type:'generate',id:'r1',prompt:'Hi'},guard(),()=>undefined)).rejects.toThrow();
 await expect(claude(vi.fn(async()=>sse([{type:'error',error:{type:'overloaded_error'}}])),'claude-haiku-5-5').generate({type:'generate',id:'r2',prompt:'Hi'},guard(),()=>undefined)).rejects.toThrow();
 await expect(providerAdapters({...secrets,geminiKey:'AIza-test-key-0000000000000000'},{fetch:vi.fn(async()=>sse([{error:{code:500}}])) as typeof fetch,resolveModel:async()=>'gemini-3.6-flash',receipt:value=>receipts.push(value)})
  .generate({type:'generate',id:'r3',prompt:'Hi'},guard(),()=>undefined)).rejects.toThrow();
 expect(receipts).toEqual([]);
});
it('marks a Gemini reply cut off part way as an estimate and keeps its counts',async()=>{
 const owner=stoppable();
 await expect(providerAdapters({...secrets,geminiKey:'AIza-test-key-0000000000000000'},{resolveModel:async()=>'gemini-3.5-flash',receipt:value=>receipts.push(value),
  fetch:vi.fn(async()=>sse([{modelVersion:'gemini-3.6-flash',candidates:[{content:{parts:[{text:'part one of it'}]}}],usageMetadata:{promptTokenCount:700,candidatesTokenCount:3,totalTokenCount:703}},{candidates:[{content:{parts:[{text:'two'}]}}]}])) as typeof fetch})
  .generate({type:'generate',id:'c1',prompt:'Hi'},owner.guard,()=>owner.owner.abort())).rejects.toThrow('Provider unavailable.');
 expect(receipts[0]).toMatchObject({servedModel:'gemini-3.6-flash',inputTokens:700});expect(receipts.at(-1)).toEqual({estimated:true});
});
it('records usage receipts for ChatGPT and Claude as well as Gemini and Deepgram',async()=>{
 const rpc=vi.fn(async(name:string)=>name==='cluera_provider_usage_start'?{code:'RECORDED',operationId:rpc.mock.calls.at(-1)![1].p_operation}:{code:'RECORDED',operationId:rpc.mock.calls.at(-1)![1].p_operation});
 const telemetry=providerTelemetry(rpc as never,{CLUERA_PROVIDER_TELEMETRY_ENABLED:'true'});
 for(const provider of ['openai','anthropic'] as const){
  const receipt=await telemetry.start({runId:crypto.randomUUID(),provider,credentialId:crypto.randomUUID(),revision:1,model:'some-model-1'});
  receipt.observe({inputTokens:10,outputTokens:5});
  expect(await receipt.finish('SUCCEEDED')).toBe(true);
 }
 expect(rpc.mock.calls.filter(([name])=>name==='cluera_provider_usage_start').map(([,args])=>(args as {p_provider:string}).p_provider)).toEqual(['openai','anthropic']);
 expect(rpc.mock.calls.filter(([name])=>name==='cluera_provider_usage_finish')[0][1]).toMatchObject({p_usage:{inputTokens:10,outputTokens:5},p_outcome:'SUCCEEDED'});
});
