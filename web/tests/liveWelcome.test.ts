// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';

const api=vi.hoisted(()=>({
 getHome:vi.fn(),getModels:vi.fn(),listSessions:vi.fn(),
}));
vi.mock('../lib/live/liveApi',async original=>({...await original<typeof import('../lib/live/liveApi')>(),
 getHome:api.getHome,getModels:api.getModels,listSessions:api.listSessions}));
import {LiveApp} from '../app/account/live/LiveApp';
import {LiveApiError} from '../lib/live/liveApi';

let host:HTMLDivElement,root:ReturnType<typeof createRoot>;
const phone=(matches:boolean)=>vi.stubGlobal('matchMedia',(query:string)=>({matches,media:query,addEventListener(){},removeEventListener(){},addListener(){},removeListener(){},onchange:null,dispatchEvent:()=>false}));
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
 phone(true);
 api.getHome.mockResolvedValue({documents:[],availableMilliseconds:15*60_000});
 api.getModels.mockResolvedValue({models:[],sessionDefaults:{}});
 api.listSessions.mockResolvedValue([]);
 history.replaceState(null,'','/account/live');
});
afterEach(()=>{act(()=>root.unmount());host.remove();vi.unstubAllGlobals();vi.clearAllMocks();});
const render=async()=>{await act(async()=>root.render(createElement(LiveApp)));};

it('welcomes a visitor who just signed in from Create session, once, and cleans the address',async()=>{
 history.replaceState(null,'','/account/live?welcome=1');
 await render();
 const card=host.querySelector('.lv-welcome');
 expect(card?.textContent).toContain('Welcome to Cluera');
 expect(card?.textContent).toContain('15m');
 expect(card?.textContent).toContain('Your first 15 minutes are free');
 expect(location.search).toBe('');
 expect(host.textContent).toContain('New session');
});
it('shows no welcome on an ordinary visit',async()=>{
 await render();
 expect(host.querySelector('.lv-welcome')).toBeNull();
 expect(host.textContent).toContain('Live session');
});
it('ignores any other welcome value',async()=>{
 history.replaceState(null,'','/account/live?welcome=yes');
 await render();
 expect(host.querySelector('.lv-welcome')).toBeNull();
});
it('does not claim free minutes when the account has none left',async()=>{
 api.getHome.mockResolvedValue({documents:[],availableMilliseconds:0});
 history.replaceState(null,'','/account/live?welcome=1');
 await render();
 expect(host.querySelector('.lv-welcome')?.textContent).not.toContain('free');
});
it('sends a signed-out visitor to sign in and then back here',async()=>{
 api.getHome.mockRejectedValue(new LiveApiError('signin'));
 await render();
 const link=host.querySelector<HTMLAnchorElement>('a.lv-btn');
 expect(link?.textContent).toBe('Sign in');
 expect(link?.getAttribute('href')).toBe('/account?next=live');
 expect(host.textContent).toContain('15 free minutes');
});
