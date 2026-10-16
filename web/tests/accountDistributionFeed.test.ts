import {afterEach, expect, it,vi } from 'vitest';
import {syntheticUpdatePair} from './helpers/clueraSigning';
vi.mock('../lib/accounts/releaseTrust',async()=>({CLUERA_UPDATE_KEY_SHA256:(await import('./helpers/clueraSigning')).syntheticUpdateKeySha256}));
import {generateKeyPairSync} from 'node:crypto';
const mocks=vi.hoisted(()=>({rpc:vi.fn()}));
vi.mock('../lib/accounts/clients',()=>({accountClients:()=>({service:{rpc:mocks.rpc}})}));
import { GET as feed } from '../app/api/account/update/test/route';
import { GET as download } from '../app/account/download/route';
afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();});

it('keeps reserved account distribution fail-closed without a legacy/demo fallback', async () => {
  const update = await feed();
  expect(update.status).toBe(503); expect(update.headers.get('cache-control')).toBe('no-store');
  expect(await update.json()).not.toHaveProperty('signedManifest');
  const installer = await download(); expect(installer.status).toBe(503);
  expect(installer.headers.get('location')).toBeNull();
  expect(installer.headers.get('cache-control')).toBe('no-store');
});
it('reads only approved account data, reflects withdrawal and uses a non-proxy no-store redirect',async()=>{
 const pair=syntheticUpdatePair;
 const vars={SIGMAROUND_ACCOUNTS_ENABLED:'true',SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',NEXT_PUBLIC_SUPABASE_ANON_KEY:'sb_publishable_synthetic_public_key_00000000000000000',SUPABASE_SERVICE_ROLE_KEY:'sb_secret_synthetic-server-key-only',SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:Buffer.alloc(32,1).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:Buffer.alloc(32,2).toString('base64'),RELEASE_DOWNLOAD_ORIGINS:'https://github.com',CLUERA_RELEASE_PRIVATE_KEY_BASE64:Buffer.from(pair.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),CLUERA_RELEASE_PUBLIC_KEY_BASE64:pair.publicKey.export({type:'spki',format:'der'}).toString('base64')};
 for(const [k,v]of Object.entries(vars))vi.stubEnv(k,v);
 mocks.rpc.mockResolvedValue({data:null,error:null,status:200});expect((await feed()).status).toBe(404);
 const row={id:crypto.randomUUID(),version:'1.0.8',minimumSupportedVersion:'1.0.8',downloadUrl:'https://github.com/test/repo/releases/download/account-test/ClueraAITestSetup-1.0.8.exe',sha256:'a'.repeat(64),fileSizeBytes:123,updateType:'OPTIONAL',releaseNotes:'Test',state:'PUBLISHED',publishedAt:'2026-10-09T00:00:00Z'};
 mocks.rpc.mockResolvedValue({data:row,error:null,status:200});const response=await feed();expect(response.status).toBe(200);expect(await response.json()).toHaveProperty('signedManifest');
 const redirect=await download();expect(redirect.status).toBe(302);expect(redirect.headers.get('location')).toBe(row.downloadUrl);expect(await redirect.text()).toBe('');expect(redirect.headers.get('cache-control')).toBe('no-store');
 expect(mocks.rpc.mock.calls.every(([name])=>name==='cluera_release_latest')).toBe(true);
 // Empty approval checks alone do not exercise the installer allowlist. Check
 // actual published rows without ever creating one in the hosted database.
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS',undefined);
 const deniedFeed=await feed(),deniedDownload=await download();
 expect(deniedFeed.status).toBe(503);expect(await deniedFeed.json()).not.toHaveProperty('signedManifest');
 expect(deniedDownload.status).toBe(503);expect(deniedDownload.headers.get('location')).toBeNull();
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');
 for(const downloadUrl of [row.downloadUrl.replace('github.com','github.com.evil.invalid'),
  row.downloadUrl.replace('github.com','release-assets.githubusercontent.com'),row.downloadUrl.replace('ClueraAITest','SigmaRound')]){
  mocks.rpc.mockResolvedValue({data:{...row,downloadUrl},error:null,status:200});
  expect((await feed()).status).toBe(503);
  const rejected=await download();expect(rejected.status).toBe(503);expect(rejected.headers.get('location')).toBeNull();
 }
 mocks.rpc.mockResolvedValue({data:row,error:null,status:200});
 expect((await feed()).status).toBe(200);expect((await download()).headers.get('location')).toBe(row.downloadUrl);
 mocks.rpc.mockResolvedValue({data:{...row,state:'WITHDRAWN'},error:null,status:200});expect((await feed()).status).toBe(503);
 mocks.rpc.mockResolvedValue({data:null,error:null,status:200});expect((await download()).status).toBe(404);
});
