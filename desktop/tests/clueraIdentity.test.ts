import fs from 'node:fs';
import {createHash,createPublicKey} from 'node:crypto';
import {createRequire} from 'node:module';
import {expect,it} from 'vitest';
import {ACCOUNT_DISTRIBUTION} from '../src/shared/accountDistribution';
import {CLUERA_UPDATE_KEY_SHA256} from '../src/shared/clueraTrust';
import {NATIVE_GOOGLE_CALLBACK} from '../src/main/accounts/GoogleAccountLogin';
import {providerSetupProblem} from '../src/renderer/services/providerSetup';
const require=createRequire(import.meta.url);
it('pins new app, profile, database, channel, origins and public key independently',()=>{
 const config=require('../electron-builder.cluera.cjs');
 expect(config.appId).toBe('ai.cluera.desktop');expect(config.publish).toBeNull();
 expect(ACCOUNT_DISTRIBUTION).toMatchObject({profile:'cluera-ai-desktop-staging',database:'cluera-ai.sqlite',
  channel:'cluera-beta',audience:'cluera-ai-desktop-test-update',apiOrigin:'https://cluera-ai-staging.vercel.app'});
 const publicKey=createPublicKey(fs.readFileSync('resources/cluera-public-key.pem'));
 expect(publicKey.asymmetricKeyType).toBe('ed25519');
 expect(createHash('sha256').update(publicKey.export({type:'spki',format:'der'})).digest('hex')).toBe(CLUERA_UPDATE_KEY_SHA256);
 expect(CLUERA_UPDATE_KEY_SHA256).not.toBe('f04909dec7e00d7609f48e9b79b10dc6d9b8a82b8c5deb0b03aabd1cb768909a');
 expect(NATIVE_GOOGLE_CALLBACK).toBe('http://127.0.0.1:43822/cluera/callback');
});
it('keeps Windows installation per-user and refuses both existing products',()=>{
 const config=require('../electron-builder.cluera.cjs'),hook=fs.readFileSync('resources/cluera-installer.nsh','utf8');
 expect(config.nsis).toMatchObject({perMachine:false,allowElevation:false,allowToChangeInstallationDirectory:false,deleteAppDataOnUninstall:false});
 for(const value of ['Programs\\Cluera AI','SigmaRound AI.exe','SigmaRound Account.exe'])expect(hook).toContain(value);
 expect(config.win.artifactName).toBe('ClueraAITestSetup-${version}.${ext}');
});
it('never offers personal key setup or accepts a stale BYOK status',()=>{
 expect(providerSetupProblem({providerMode:'byok'} as any)).toContain('personal API keys are not supported');
 expect(providerSetupProblem({providerMode:'managed',defaultGeminiModel:'flash',modelOptions:[{modelId:'flash'}]} as any)).toBeNull();
 expect(providerSetupProblem({providerMode:'managed',defaultGeminiModel:'disabled',modelOptions:[{modelId:'flash'}]} as any)).toContain('unavailable');
});
