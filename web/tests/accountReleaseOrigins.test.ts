import {readFileSync} from 'node:fs';
import {afterEach,expect,it,vi} from 'vitest';
import {accountReleaseInput} from '../lib/accounts/releases';
import {assertTrustedInstallerUrl,isTrustedInstallerUrl,trustedInstallerOrigins} from '../lib/releases/policy';

const installer='https://github.com/kireetikotturu/SigmaRound-Releases-Test/releases/download/account-v1.0.8-test/ClueraAITestSetup-1.0.8.exe';
afterEach(()=>vi.unstubAllEnvs());

it('matches the exact hosted installer origin to account packaged trust without trusting the asset CDN as a source',()=>{
 const trust=JSON.parse(readFileSync(new URL('../../desktop/resources/production-config.json',import.meta.url),'utf8'));
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');
 expect([...trustedInstallerOrigins()]).toEqual(trust.trustedInstallerOrigins);
 expect(new URL(installer).origin).toBe('https://github.com');
 expect(()=>assertTrustedInstallerUrl(installer)).not.toThrow();
 expect(trust.trustedInstallerRedirectOrigins).toEqual(['https://release-assets.githubusercontent.com']);
 expect(isTrustedInstallerUrl(installer.replace('github.com','release-assets.githubusercontent.com'))).toBe(false);
});

it('fails closed for absent, empty, malformed or path-valued origin configuration',()=>{
 for(const value of [undefined,'','  ','https://downloads.example.invalid',installer,'"https://github.com"','["https://github.com"]',
  'https://*.github.com','http://github.com','https://user@github.com','https://github.com?anything=1','https://github.com#fragment']){
  vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS',value);
  expect(()=>assertTrustedInstallerUrl(installer)).toThrow();
 }
});

it('uses exact HTTPS origin membership plus the stricter account path, filename and version contract',()=>{
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');
 const draft={version:'1.0.8',minimumSupportedVersion:'1.0.8',downloadUrl:installer,sha256:'a'.repeat(64),
  fileSizeBytes:122030307,updateType:'OPTIONAL',releaseNotes:''};
 expect(accountReleaseInput.safeParse(draft).success).toBe(true);
 for(const url of [installer.replace('https:','http:'),installer.replace('github.com','github.com.evil.invalid'),
  installer.replace('github.com','assets.github.com'),installer.replace('github.com','github.com:444'),
  installer.replace('github.com','github.com@evil.invalid'),installer.replace('github.com','user@github.com')]){
  expect(isTrustedInstallerUrl(url)).toBe(false);
  expect(accountReleaseInput.safeParse({...draft,downloadUrl:url}).success).toBe(false);
 }
 for(const url of [installer+'?download=1',installer+'#fragment',installer.replace('ClueraAITest','SigmaRound'),installer.replace('1.0.8.exe','1.0.9.exe')]){
  expect(accountReleaseInput.safeParse({...draft,downloadUrl:url}).success).toBe(false);
 }
});
