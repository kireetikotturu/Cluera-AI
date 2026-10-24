'use strict';
// Protected, read-only build diagnostic. No provider traffic, customer session,
// credential read-back, database mutation, website artifact or alias.
const path=require('node:path'),{createRequire,Module}=require('node:module');
async function main(){
 const [sha,...extra]=process.argv.slice(2);
 if(extra.length||! /^[a-f0-9]{40}$/.test(sha||'')||process.env.VERCEL_ENV!=='production'
  ||process.env.VERCEL_PROJECT_ID!=='prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B'
  ||process.env.VERCEL_GIT_COMMIT_SHA!==sha||process.env.CLUERA_PROVIDER_VAULT_ENABLED!=='true'
  ||process.env.CLUERA_AI_BOOTSTRAP_MODE!=='admin-vault')throw Error();
 const web=path.resolve(__dirname,'../web'),req=createRequire(path.join(web,'package.json'));
 const output=req('esbuild').buildSync({stdin:{contents:"export {vaultKeyring} from './lib/aiProviders/vault';export {accountConfig} from './lib/accounts/config';export {readProviderStatus} from './lib/accounts/providerStatus';",resolveDir:web,loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',logLevel:'silent'}).outputFiles[0].text;
 const compiled=new Module(path.join(web,'provider-bootstrap-memory.cjs'),module);compiled.paths=Module._nodeModulePaths(web);compiled._compile(output,compiled.id);
 const {vaultKeyring,accountConfig,readProviderStatus}=compiled.exports;
 const vault=vaultKeyring(),identity={provider:'gemini',credentialId:'00000000-0000-4000-8000-000000000001'},synthetic='synthetic-provider-bootstrap-check';
 const envelope=vault.seal(synthetic,identity);if(vault.open(envelope,identity)!==synthetic)throw Error();
 let refused=false;try{vault.open(envelope,{...identity,provider:'deepgram'});}catch{refused=true;}if(!refused)throw Error();
 const relay=await readProviderStatus(accountConfig());if(relay.bootstrapMode!=='admin-vault')throw Error();
 console.log('CLUERA_PROVIDER_BOOTSTRAP '+JSON.stringify({observedAt:new Date().toISOString(),source:sha,keyringValidated:true,syntheticEnvelopeVerified:true,wrongProviderRefused:true,signedRelayMode:relay.bootstrapMode,providerCalls:0,financialMutations:0}));
}
if(require.main===module)main().catch(()=>{console.log('CLUERA_PROVIDER_BOOTSTRAP {"stopped":"UNAVAILABLE","providerCalls":0,"financialMutations":0}');}).finally(()=>{process.exitCode=2;});
