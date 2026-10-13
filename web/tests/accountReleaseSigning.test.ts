import {generateKeyPairSync,verify} from 'node:crypto';
import {syntheticUpdatePair} from './helpers/clueraSigning';
vi.mock('../lib/accounts/releaseTrust',async()=>({CLUERA_UPDATE_KEY_SHA256:(await import('./helpers/clueraSigning')).syntheticUpdateKeySha256}));
import {afterEach,expect,it,vi} from 'vitest';
import {accountReleaseInput,accountReleaseSigningKey,signAccountRelease} from '../lib/accounts/releases';
const pair=syntheticUpdatePair;
const env={CLUERA_RELEASE_PRIVATE_KEY_BASE64:Buffer.from(pair.privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'),CLUERA_RELEASE_PUBLIC_KEY_BASE64:pair.publicKey.export({type:'spki',format:'der'}).toString('base64')};
const record={id:'11111111-1111-4111-8111-111111111111',version:'1.0.8',minimumSupportedVersion:'1.0.8',downloadUrl:'https://github.com/kireetikotturu/SigmaRound-Releases-Test/releases/download/account-1.0.8-test/ClueraAITestSetup-1.0.8.exe',sha256:'a'.repeat(64),fileSizeBytes:123,releaseNotes:'Account TEST',updateType:'OPTIONAL' as const,state:'PUBLISHED' as const,publishedAt:'2026-10-09T00:00:00Z'};
afterEach(()=>vi.unstubAllEnvs());
it('signs a bounded independent account audience/product/channel and verifies cryptographically',()=>{
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://github.com');
 const token=signAccountRelease(record,1000,env),[h,p,s]=token.split('.');
 expect(verify(null,Buffer.from(`${h}.${p}`),pair.publicKey,Buffer.from(s,'base64url'))).toBe(true);
 const claims=JSON.parse(Buffer.from(p,'base64url').toString());
 expect(claims).toMatchObject({product:'cluera-ai',channel:'cluera-beta',aud:'cluera-ai-desktop-test-update',iat:1000,exp:87400});
 expect(token).not.toContain(env.CLUERA_RELEASE_PRIVATE_KEY_BASE64);
 expect(()=>signAccountRelease({...record,state:'DRAFT'},1000,env)).toThrow();
});
it('rejects missing, mismatched, non-Ed25519 and reused legacy signing material',()=>{
 expect(()=>accountReleaseSigningKey({})).toThrow();
 const substitute=generateKeyPairSync('ed25519');
 expect(()=>accountReleaseSigningKey({CLUERA_RELEASE_PRIVATE_KEY_BASE64:Buffer.from(substitute.privateKey.export({format:'pem',type:'pkcs8'})).toString('base64'),CLUERA_RELEASE_PUBLIC_KEY_BASE64:substitute.publicKey.export({format:'der',type:'spki'}).toString('base64')})).toThrow();
 expect(()=>accountReleaseSigningKey({...env,CLUERA_RELEASE_PUBLIC_KEY_BASE64:'invalid'})).toThrow();
 expect(()=>accountReleaseSigningKey({...env,LICENSE_SIGNING_PRIVATE_KEY_BASE64:env.CLUERA_RELEASE_PRIVATE_KEY_BASE64})).toThrow();
 const rsa=generateKeyPairSync('rsa',{modulusLength:2048});
 expect(()=>accountReleaseSigningKey({CLUERA_RELEASE_PRIVATE_KEY_BASE64:Buffer.from(rsa.privateKey.export({format:'pem',type:'pkcs8'})).toString('base64'),CLUERA_RELEASE_PUBLIC_KEY_BASE64:rsa.publicKey.export({format:'der',type:'spki'}).toString('base64')})).toThrow();
});
it('rejects legacy names, mismatched version, unapproved origin, oversized notes and fractional size',()=>{
 const {id,state,publishedAt,...draft}=record;expect(accountReleaseInput.safeParse(draft).success).toBe(true);
 for(const patch of [{downloadUrl:record.downloadUrl.replace('ClueraAITest','SigmaRound')},{version:'1.0.9'},{minimumSupportedVersion:'2.0.0'},{fileSizeBytes:1.1},{releaseNotes:'x'.repeat(2001)},{downloadUrl:record.downloadUrl+'?token=secret'}])expect(accountReleaseInput.safeParse({...draft,...patch}).success).toBe(false);
 vi.stubEnv('RELEASE_DOWNLOAD_ORIGINS','https://example.invalid');expect(()=>signAccountRelease(record,1000,env)).toThrow();
});
