'use strict';
// One-time, reversible assembly into new directories only. References stay intact.
const fs=require('node:fs'),path=require('node:path');
const {gitHash,beneath}=require('./prepare-reviewed-sources.cjs');
const root=path.resolve(__dirname,'..'),source=path.join(root,'.migration-source/account-with-ui');
const provenance=JSON.parse(fs.readFileSync(path.join(root,'.migration-source/source-provenance.json'),'utf8'));
const manifest=JSON.parse(fs.readFileSync(path.resolve(root,'../../../..','Documents/Codex/2026-10-05/context-from-my-ide-setup-active/cluera-separation/source-manifests.json'),'utf8'));
const expected=new Map(manifest.account.tree.filter(e=>e.type==='blob').map(e=>[e.path,e.sha]));
for(const entry of provenance.uiOverlay)expected.set(entry.path,entry.sha);
for(const [file,sha]of expected)if(gitHash(fs.readFileSync(beneath(source,path.join(source,file))))!==sha)throw Error('Reference source changed.');
for(const folder of ['desktop','web','backend','supabase'])if(fs.existsSync(path.join(root,folder)))throw Error('Assembly target already exists.');

const excludedDesktopTests=new Set(['sessionUsageTracker','sessionUsageIpc','runtimeLicenseStatus','licenseRuntimeEnforcement','providerCredentialIpc','providerConnectionTester','managedProviders','commercialExtensions','commercialDesktop','productionConfig','freshDesktopProfile','accountDistribution','accountReleasePreparation','accountReleaseStagingCheck','sourceSecretScan']);
const excludedWebTests=new Set(['adminMfaFlow','adminService','catalogPricing','commercialBoundaries','commercialLicensing','deviceReactivation','leaseSignature','licenseApi','licenseDurationUsage','licenseUsageDisplay','managedAccess','managedDeepgram','managedGemini','releasePolicy','releaseService','releaseSignature','runtimeLicenseStatus','supabaseRepository']);
function destination(file){
 if(file.startsWith('src/')){
  if(file.startsWith('src/main/licensing/')||file==='src/main/ipc/registerCommercialIpc.ts'||file==='src/main/config/desktopProfile.ts'||file==='src/renderer/pages/ActivationPage.tsx')return;
  if(/^src\/main\/providers\/(ManagedProviderClient|ProviderCredentialService|ProviderConnectionTester|providerMode)\.ts$/.test(file))return;
  return 'desktop/'+file;
 }
 if(file.startsWith('tests/')&&file.endsWith('.test.ts')&&!excludedDesktopTests.has(path.basename(file,'.test.ts')))return 'desktop/'+file;
 if(['package.json','package-lock.json','tsconfig.json','tsconfig.main.json','vite.config.ts','vitest.config.ts'].includes(file))return 'desktop/'+file;
 if(['scripts/run-electron.cjs','scripts/after-pack.cjs','scripts/harden-build.cjs','scripts/build-icon.cjs'].includes(file))return 'desktop/'+file;
 if(file==='resources/account-installer.nsh')return 'desktop/resources/cluera-installer.nsh';
 if(file.startsWith('supabase/migrations/20261004')||file.startsWith('supabase/migrations/20261008')||file.startsWith('supabase/migrations/20261009')||file.startsWith('supabase/migrations/20261011')||file.startsWith('supabase/migrations/20261012'))return file;
 if(file.startsWith('web/')){
  if(file.startsWith('web/app/admin/')||/^web\/app\/api\/(license|managed|admin|update|public)\//.test(file))return;
  if(file==='web/app/PricingSection.tsx')return;
  if(/^web\/lib\/(license|managed|auth)\//.test(file)||file==='web/lib/env.ts'||file==='web/lib/supabase/admin.ts'||/^web\/lib\/releases\/(repository|signature)\.ts$/.test(file)||file==='web/lib/catalog/repository.ts')return;
  if(file.startsWith('web/tests/')&&file.endsWith('.test.ts')&&excludedWebTests.has(path.basename(file,'.test.ts')))return;
  if(file.startsWith('web/relay/'))return 'backend/'+file.slice('web/relay/'.length);
  if(file.endsWith('.env.example')||file.endsWith('README.md')||file.endsWith('tsconfig.tsbuildinfo'))return;
  return file;
 }
}
const mappings=new Map([...expected.keys()].flatMap(file=>destination(file)?[[file,destination(file)]]:[]));
const pairs=[
 ['https://sigmaround-account-staging.vercel.app','https://cluera-ai-staging.vercel.app'],
 ['wss://sigmaround-account-relay-staging.onrender.com/v1/session','wss://cluera-ai-relay-staging.onrender.com/v1/session'],
 ['https://sigmaround-account-relay-staging.onrender.com','https://cluera-ai-relay-staging.onrender.com'],
 ['sigmaround-account-desktop-test-update','cluera-ai-desktop-test-update'],
 ['sigmaround-account-desktop-staging','cluera-ai-desktop-staging'],
 ['sigmaround-account-desktop','cluera-ai-desktop'],
 ['ai.sigmaround.account.desktop','ai.cluera.desktop'],
 ['sigmaround-account.sqlite','cluera-ai.sqlite'],
 ['sigmaround-account','cluera-ai'],
 ['account-beta','cluera-beta'],
 ['account-staging','cluera-staging'],
 ['SigmaRoundAccountTestSetup','ClueraAITestSetup'],
 ['SigmaRound Account','Cluera AI'],['SigmaRound AI','Cluera AI'],['SigmaRoundAI','Cluera AI'],
];
let count=0;
for(const [file,dest]of mappings){
 let bytes=fs.readFileSync(path.join(source,file));
 if(/\.(?:tsx?|[cm]?js|css|html|json|nsh)$/.test(file)&&!file.startsWith('supabase/')){
  let text=bytes.toString('utf8');
  for(const [before,after]of pairs)text=text.replaceAll(before,after);
  if(file.includes('/app/')||file.includes('/renderer/'))text=text.replaceAll('SigmaRound','Cluera');
  // Resolve old relative modules to their new locations, without a cross-product alias.
  text=text.replace(/((?:from\s*|import\s*|require\(|new URL\()(['"]))(\.{1,2}\/[^'"\r\n]+)(\2)/g,(full,lead,quote,spec,tail)=>{
   const old=path.posix.normalize(path.posix.join(path.posix.dirname(file),spec));
   const target=[old,old+'.ts',old+'.tsx',old+'.cjs',old+'.mjs'].find(p=>mappings.has(p));
   if(!target)return full;
   let relative=path.posix.relative(path.posix.dirname(dest),mappings.get(target));
   if(!path.posix.extname(spec))relative=relative.replace(/\.(?:tsx?|[cm]?js)$/,'');
   if(!relative.startsWith('.'))relative='./'+relative;
   return lead+relative+tail;
  });
  bytes=Buffer.from(text);
 }
 const target=beneath(root,path.join(root,dest));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes,{flag:'wx'});count++;
}
console.log(JSON.stringify({assembledFiles:count,referenceFiles:expected.size,originalWrites:0,databaseActions:0,status:'unverified-working-source'}));
