// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {ModelPolicyEditor,type ModelPolicy} from '../app/account/admin/ModelPolicyEditor';
let host:HTMLDivElement,root:Root;
const gemini:ModelPolicy={modelId:'gemini-3.5-flash',displayName:'Fast answers',provider:'gemini',enabled:true,isDefault:true,priority:42,capabilities:['text','image'],health:'UNVERIFIED'};
const audio:ModelPolicy={...gemini,modelId:'flux-general-en',displayName:'Internal audio',provider:'deepgram',capabilities:['audio']};
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
const input=(name:string)=>host.querySelector(`[name="${name}"]`) as HTMLInputElement;
async function select(value:string){await act(async()=>{const choice=host.querySelector('[aria-label="Model policy"]') as HTMLSelectElement;choice.value=value;choice.dispatchEvent(new Event('change',{bubbles:true}));});}
it('prefills existing model fields and sends the same identity with an explicit reason',async()=>{
 const save=vi.fn();await act(async()=>root.render(createElement(ModelPolicyEditor,{models:[gemini,audio],disabled:false,onSave:save})));
 await select('gemini:gemini-3.5-flash');expect(input('displayName').value).toBe('Fast answers');expect(input('modelId').readOnly).toBe(true);
 expect(input('enabled').checked).toBe(true);expect(input('isDefault').checked).toBe(true);expect(input('image').checked).toBe(true);expect(input('priority').value).toBe('42');
 input('reason').value='Confirm enabled screenshot policy';
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(save).toHaveBeenCalledWith(gemini,'Confirm enabled screenshot policy');
 expect(host.textContent).toContain('administrator-declared label');
});
it('keeps Deepgram internal, fixed to Flux and audio-only, and locks mutations when parent is uncertain',async()=>{
 const save=vi.fn();await act(async()=>root.render(createElement(ModelPolicyEditor,{models:[gemini,audio],disabled:false,onSave:save})));
 await select('deepgram:flux-general-en');expect(host.querySelector('[name="image"]')).toBeNull();expect(input('modelId').value).toBe('flux-general-en');
 input('reason').value='Keep internal Flux approved';
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(save).toHaveBeenCalledWith(audio,'Keep internal Flux approved');save.mockClear();
 await act(async()=>root.render(createElement(ModelPolicyEditor,{models:[gemini,audio],disabled:true,onSave:save})));
 await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(save).not.toHaveBeenCalled();expect(host.querySelector('fieldset')!.disabled).toBe(true);
});
it('refreshes existing form values only after an authoritative model change',async()=>{
 const save=vi.fn();await act(async()=>root.render(createElement(ModelPolicyEditor,{models:[gemini],disabled:false,onSave:save})));
 await select('gemini:gemini-3.5-flash');input('reason').value='Draft audit reason remains';
 await act(async()=>root.render(createElement(ModelPolicyEditor,{models:[{...gemini}],disabled:false,onSave:save})));
 expect(input('reason').value).toBe('Draft audit reason remains');
 await act(async()=>root.render(createElement(ModelPolicyEditor,{models:[{...gemini,priority:22}],disabled:false,onSave:save})));
 expect(input('priority').value).toBe('22');expect(input('reason').value).toBe('');
});
