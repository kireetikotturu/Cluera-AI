import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {it,expect,vi} from 'vitest';
import {HomePage} from '../src/renderer/pages/HomePage';
import {SettingsPage} from '../src/renderer/pages/SettingsPage';
import {UpdatePage} from '../src/renderer/pages/UpdatePage';
const fixture=vi.hoisted(()=>({state:{sessions:[],copilotStatus:'idle',settings:{theme:'dark',overlayOpacity:1,geminiModel:'gemini-3.5-flash'},
 providerStatus:{providerMode:'byok',geminiConfigured:false,deepgramConfigured:false,modelOptions:[{modelId:'gemini-3.5-flash',displayName:'Gemini Flash'}]},setError:()=>{},setPage:()=>{},setSettings:()=>{}}}));
vi.mock('../src/renderer/stores/appStore',()=>({useAppStore:Object.assign((select:any)=>select(fixture.state),{getState:()=>fixture.state})}));
const account={mode:'cluera-staging' as const,state:'active' as const,userId:'00000000-0000-4000-8000-000000000001',email:'synthetic@example.invalid'};
it('Account dashboard exposes credits/support but not License & Support',()=>{
 const html=renderToStaticMarkup(createElement(HomePage,{onCollapse:()=>{},account,customerName:account.email}));
 expect(html).toContain('Credits &amp; Usage');expect(html).toContain('Buy Credits');expect(html).toContain('Cluera AI');expect(html).not.toContain('License &amp; Support');
});
it('Account settings never render BYOK fields even when a stale legacy provider mode is supplied',()=>{
 const html=renderToStaticMarkup(createElement(()=>SettingsPage({account})));
 expect(html).toContain('Approved answer model');expect(html).toContain('Sign out this device');
 expect(html).not.toContain('type="password"');expect(html).not.toContain('Use my own API keys');expect(html).not.toContain('Save key &amp; model');
});
it('required Account update page uses compact Support without weakening update policy',()=>{
 const html=renderToStaticMarkup(createElement(UpdatePage,{status:{state:'required',version:'1.0.11'} as any,onRetry:()=>{},account:true}));
 expect(html).not.toContain('License &amp; Support');expect(html).toContain('1.0.11');
});
