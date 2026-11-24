import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,expect,it,vi} from 'vitest';
import {BUILT_IN_SESSION_DEFAULTS,effectiveSessionDefaults,sessionDefaultsInput} from '../lib/accounts/sessionDefaults';
import {SessionDefaults} from '../app/account/admin/SessionDefaults';

afterEach(()=>{vi.doUnmock('../lib/accounts/workspace');vi.doUnmock('../lib/accounts/clients');vi.resetModules();});

it('uses the built-in text and model wherever nothing usable is stored',()=>{
 expect(effectiveSessionDefaults(null)).toEqual(BUILT_IN_SESSION_DEFAULTS);
 expect(effectiveSessionDefaults({interviewContext:'  ',assignmentContext:7,assignmentModel:'not a model'})).toEqual(BUILT_IN_SESSION_DEFAULTS);
 expect(effectiveSessionDefaults({interviewContext:'Be brief.',assignmentContext:'Java only.',assignmentModel:'claude-haiku-5-5'}))
  .toEqual({interviewContext:'Be brief.',assignmentContext:'Java only.',assignmentModel:'claude-haiku-5-5'});
 expect(BUILT_IN_SESSION_DEFAULTS.assignmentModel).toBe('gpt-6-luna');
});

it('accepts only complete, sensible values from the Admin',()=>{
 const ok={interviewContext:'Short answers.',assignmentContext:'SQL round.',assignmentModel:'gpt-6-luna'};
 expect(sessionDefaultsInput.safeParse(ok).success).toBe(true);
 expect(sessionDefaultsInput.safeParse({...ok,assignmentModel:''}).success).toBe(true);          // blank = built-in model
 expect(sessionDefaultsInput.safeParse({...ok,assignmentContext:''}).success).toBe(true);        // blank = built-in text
 expect(sessionDefaultsInput.safeParse({...ok,assignmentModel:'bad model!'}).success).toBe(false);
 expect(sessionDefaultsInput.safeParse({...ok,interviewContext:'x'.repeat(4001)}).success).toBe(false);
 expect(sessionDefaultsInput.safeParse({...ok,extra:true}).success).toBe(false);
 expect(sessionDefaultsInput.safeParse({interviewContext:'only one'}).success).toBe(false);
});

async function modelsRoute(rpc:(name:string)=>Promise<{data:unknown;error:unknown;status:number}>){
 vi.resetModules();
 vi.doMock('../lib/accounts/workspace',()=>({stagingAccountConfig:()=>({})}));
 vi.doMock('../lib/accounts/clients',()=>({accountClients:()=>({service:{rpc}})}));
 const {GET}=await import('../app/api/account/models/route');
 return (await GET()).json() as Promise<{models:{modelId:string}[];sessionDefaults:Record<string,string>}>;
}
const modelRows=[{modelId:'gpt-5',displayName:'GPT 5',provider:'openai',enabled:true,isDefault:true,priority:10,capabilities:['text'],health:'UNVERIFIED'}];

it('publishes the Admin\'s defaults next to the model list',async()=>{
 const body=await modelsRoute(async name=>name==='account_session_defaults_read'
  ?{data:{interviewContext:'Short answers.',assignmentContext:'',assignmentModel:'claude-haiku-5-5'},error:null,status:200}
  :{data:modelRows,error:null,status:200});
 expect(body.models.map(model=>model.modelId)).toEqual(['gpt-5']);
 expect(body.sessionDefaults).toEqual({interviewContext:'Short answers.',assignmentContext:BUILT_IN_SESSION_DEFAULTS.assignmentContext,assignmentModel:'claude-haiku-5-5'});
});

it('never hides the model list when the defaults cannot be read',async()=>{
 const missing=await modelsRoute(async name=>name==='account_session_defaults_read'?{data:null,error:{message:'function does not exist'},status:404}:{data:modelRows,error:null,status:200});
 expect(missing.models).toHaveLength(1);
 expect(missing.sessionDefaults).toEqual(BUILT_IN_SESSION_DEFAULTS);
 const broken=await modelsRoute(async name=>{if(name==='account_session_defaults_read')throw new Error('network');return {data:modelRows,error:null,status:200};});
 expect(broken.models).toHaveLength(1);
 expect(broken.sessionDefaults).toEqual(BUILT_IN_SESSION_DEFAULTS);
});

it('shows the two texts and the model choice in the Admin panel',()=>{
 const html=renderToStaticMarkup(createElement(SessionDefaults,{disabled:false,refreshKey:0,onSave:()=>undefined,models:[
  {modelId:'gpt-6-luna',displayName:'GPT-6 Luna',provider:'openai',enabled:true,isDefault:false,priority:100,capabilities:['text','image'],health:'UNVERIFIED'},
  {modelId:'gemini-3.5-flash',displayName:'Gemini 3.5 Flash',provider:'gemini',enabled:true,isDefault:true,priority:100,capabilities:['text','image'],health:'UNVERIFIED'},
  {modelId:'old-model',displayName:'Old',provider:'gemini',enabled:false,isDefault:false,priority:100,capabilities:['text'],health:'UNVERIFIED'},
  {modelId:'flux-general-en',displayName:'Live',provider:'deepgram',enabled:true,isDefault:true,priority:100,capabilities:['audio'],health:'UNVERIFIED'},
 ]}));
 expect(html).toContain('Interview — starting context');
 expect(html).toContain('Assignment — starting context');
 expect(html).toContain('Assignment — recommended model');
 expect(html).toContain(BUILT_IN_SESSION_DEFAULTS.assignmentContext);
 expect(html).toContain('GPT-6 Luna · gpt-6-luna');
 expect(html).toContain('Gemini 3.5 Flash · gemini-3.5-flash');
 expect(html).not.toContain('Old · old-model');          // only models that are turned on
 expect(html).not.toContain('flux-general-en');          // transcription models are not answer models
});
