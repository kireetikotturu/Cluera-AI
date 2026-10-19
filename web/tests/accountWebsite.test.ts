import {generateKeyPairSync} from 'node:crypto';
import {syntheticUpdatePair} from './helpers/clueraSigning';
vi.mock('../lib/accounts/releaseTrust',async()=>({CLUERA_UPDATE_KEY_SHA256:(await import('./helpers/clueraSigning')).syntheticUpdateKeySha256}));
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({rpc:vi.fn(),legacy:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:()=>({service:{rpc:mocks.rpc}})}));
import Home from '../app/page';
import Download,{metadata as downloadMetadata} from '../app/download/page';
import Setup,{metadata as setupMetadata} from '../app/setup/page';
import Layout,{metadata as siteMetadata} from '../app/layout';
import {SiteHeader} from '../app/SiteHeader';
import {GET as installer} from '../app/download/installer/route';
import {GET as accountDownload} from '../app/account/download/route';
import {GET as feed} from '../app/api/account/update/test/route';
import {accountWebsite} from '../lib/accounts/site';

beforeEach(()=>{
 const pair=syntheticUpdatePair;
 const env={SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',
  NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',
  SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-server-key-only',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,1).toString('base64'),
  SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,2).toString('base64'),RELEASE_DOWNLOAD_ORIGINS:'https://github.com',
  CLUERA_RELEASE_PRIVATE_KEY_BASE64:Buffer.from(pair.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),
  CLUERA_RELEASE_PUBLIC_KEY_BASE64:pair.publicKey.export({type:'spki',format:'der'}).toString('base64')};
 for(const [key,value]of Object.entries(env))vi.stubEnv(key,value);
 mocks.rpc.mockResolvedValue({data:null,error:null,status:200});
 mocks.legacy.mockImplementation(()=>{throw Error('Legacy backend must not be read in Account mode');});
});
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});
const row={id:'00000000-0000-4000-8000-000000000001',version:'1.0.8',minimumSupportedVersion:'1.0.8',
 downloadUrl:'https://github.com/kireetikotturu/SigmaRound-Releases-Test/releases/download/account-v1.0.8-test/ClueraAITestSetup-1.0.8.exe',
 sha256:'a'.repeat(64),fileSizeBytes:122030307,updateType:'OPTIONAL',releaseNotes:'Account test notes',state:'PUBLISHED',publishedAt:'2026-10-09T00:00:00Z'};
it('shows Account awaiting-approval without a binary download and keeps all installer endpoints empty',async()=>{
 const html=renderToStaticMarkup(await Download());
 expect(html).toContain('Cluera TEST installer awaiting approval');expect(html).toContain('unsigned TEST');
 expect(html).not.toContain('href="/account/download"');expect(html).not.toContain('activate your license');
 expect(html).not.toContain('SigmaRoundSetup-');expect(html).not.toContain('href="/download/installer"');
 for(const get of [installer,accountDownload,feed]){const response=await get();expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('location')).toBeNull();expect(await response.text()).not.toContain('signedManifest');}
 expect(mocks.legacy).not.toHaveBeenCalled();expect(mocks.rpc.mock.calls.every(([name])=>name==='cluera_release_latest')).toBe(true);
});
it('approved Account page links only to the existing account download and both redirects select its record',async()=>{
 mocks.rpc.mockResolvedValue({data:row,error:null,status:200});
 const html=renderToStaticMarkup(await Download());expect(html).toContain('Latest version 1.0.8');expect(html).toContain('Account test notes');
 expect(html).toContain('href="/account/download"');expect(html).not.toContain('href="/download/installer"');
 for(const get of [installer,accountDownload]){const response=await get();expect(response.status).toBe(302);expect(response.headers.get('location')).toBe(row.downloadUrl);expect(response.headers.get('cache-control')).toBe('no-store');}
 expect(mocks.legacy).not.toHaveBeenCalled();
});
it('fails closed on missing signer, withdrawn data, untrusted origin or wrong product instead of legacy fallback',async()=>{
 for(const record of [{...row,state:'WITHDRAWN'},{...row,downloadUrl:row.downloadUrl.replace('github.com','github.com.evil.invalid')},{...row,downloadUrl:row.downloadUrl.replace('ClueraAITest','SigmaRound')}]){
  mocks.rpc.mockResolvedValue({data:record,error:null,status:200});
  expect(renderToStaticMarkup(await Download())).toContain('temporarily unavailable');expect((await installer()).status).toBe(503);
 }
 vi.stubEnv('CLUERA_RELEASE_PRIVATE_KEY_BASE64','');
 expect(renderToStaticMarkup(await Download())).toContain('temporarily unavailable');expect((await installer()).status).toBe(503);
 expect(mocks.legacy).not.toHaveBeenCalled();
});
it('uses Account branding, navigation, CTAs and setup copy without legacy onboarding or repository queries',()=>{
 const home=renderToStaticMarkup(Home()),setup=renderToStaticMarkup(Setup());
 const layout=renderToStaticMarkup(Layout({children:createElement('main',null,'test')}));
 for(const html of [home,setup,layout]){expect(html).not.toContain('href="/download/installer"');expect(html).not.toContain('href="/admin"');expect(html).not.toContain('Activate your license');expect(html).not.toContain('One-time purchase');expect(html).not.toContain('Bring your own AI');}
 expect(home).toContain('href="/download"');expect(home).toContain('shared account balance');
 expect(setup).toContain('ClueraAITestSetup-');expect(setup).toContain('no personal provider credentials');
 expect(layout).not.toContain('href="/account/admin"');expect(layout).not.toContain('>Admin<');expect(layout).toContain('My account');
 expect(layout).toContain('class="account-site cluera-site"');
 expect(siteMetadata.description).toContain('managed AI');expect(downloadMetadata.title).toContain('Cluera');expect(setupMetadata.description).not.toContain('activate');
 expect(mocks.rpc).not.toHaveBeenCalled();expect(mocks.legacy).not.toHaveBeenCalled();
});
it('always presents Cluera without a License fallback when Account access is disabled',()=>{
 vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','false');
 for(const html of [renderToStaticMarkup(Layout({children:createElement('main',null,'test')})),renderToStaticMarkup(Setup()),renderToStaticMarkup(Home())]){
  expect(html).toContain('Cluera');expect(html).not.toMatch(/Activate your device|Bring your own|href="\/admin"/);
 }
 expect(mocks.rpc).not.toHaveBeenCalled();
});
it('never silently renders legacy when enabled Account configuration points at a different project',async()=>{
 vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://bzccuqforilpifhiysjk.supabase.co');
 expect(()=>accountWebsite()).toThrow('target configuration');expect(()=>Home()).toThrow();expect((await installer()).status).toBe(503);
 expect(mocks.legacy).not.toHaveBeenCalled();expect(mocks.rpc).not.toHaveBeenCalled();
});
