'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {prepareTargetPlan,preparationRequest}=require('../scripts/migrations/prepare-cluera-target.cjs');
const request=()=>structuredClone(preparationRequest);
test('prepares only the exact new Mumbai project without authorizing activation or claiming acceptance',()=>{
 const plan=prepareTargetPlan();
 assert.equal(plan.status,'PREPARED-NOT-APPLIED');assert.equal(plan.activationAuthorized,false);
 assert.deepEqual(plan.destination,{projectRef:'yhnqlfcgrmckhyjdxegg',publicUrl:'https://yhnqlfcgrmckhyjdxegg.supabase.co',region:'ap-south-1'});
 assert.equal(plan.oldSourceBackupRequired,false);assert.equal(plan.containmentVerified,false);
 for(const key of ['servedRuntimeChange','environmentChange','databaseChange','billingOwnerChange'])assert.equal(plan[key],'none');
 assert.equal(plan.customerOrHistoryImport,'excluded-clean-setup');assert.equal(plan.destinationScheduler,'not-created');
 assert.equal(plan.providerMode,'auth-only');assert.equal(plan.paymentActivation,'not-authorized');
 assert.equal(plan.providerActivation,'not-authorized');assert.equal(plan.preparedSourcePins.length,5);
 assert(plan.requiredBeforeFinancialActivation.includes('independent-provider-financial-reconciliation'));
 assert.equal(plan.requiredBeforeAuthOnlySwitch.includes('independent-provider-financial-reconciliation'),false);
 assert.equal(plan.requiredBeforeAuthOnlySwitch.some(value=>/Windows-acceptance|MFA-and-Windows/.test(value)),false);
 assert(plan.requiredSettingNames.webInfrastructure.includes('SUPABASE_SERVICE_ROLE_KEY'));
 assert.equal(JSON.stringify(plan).includes('sb_secret_'),false);
});
test('rejects foreign, old, noncanonical and mismatched project, origin and region inputs',()=>{
 for(const changes of [{projectRef:'dwqltsqumiwsxtkzdoaa'},{projectRef:'foreignproject'},
  {url:'https://dwqltsqumiwsxtkzdoaa.supabase.co'},{url:'https://yhnqlfcgrmckhyjdxegg.supabase.co/'},
  {url:'https://yhnqlfcgrmckhyjdxegg.supabase.co.evil.invalid'},{url:'https://user:password@yhnqlfcgrmckhyjdxegg.supabase.co'},
  {region:'us-east-1'}]){const value=request();Object.assign(value.destination,changes);assert.throws(()=>prepareTargetPlan(value),/rejected/);}
});
test('rejects secret or unknown fields without exposing their values',()=>{
 const sentinel='sb_secret_synthetic-not-a-real-key';
 for(const change of [value=>{value.SUPABASE_SERVICE_ROLE_KEY=sentinel;},value=>{value.destination.key=sentinel;},
  value=>{value.credentialPolicy.apiKeys=sentinel;},value=>{value.apply=true;},value=>{value.activationAuthorized=true;}]){
  const value=request();change(value);
  assert.throws(()=>prepareTargetPlan(value),error=>!error.message.includes(sentinel)&&error.message.includes('rejected'));
 }
});
test('refuses legacy authority, encryption/session reuse and duplicate financial ownership policy',()=>{
 for(const [group,key,unsafe] of [
  ['credentialPolicy','apiKeys','reuse-old-key'],['credentialPolicy','privilegedJwt','copy-old-service-role'],
  ['credentialPolicy','jwtSigning','reuse-source-signing-key'],['credentialPolicy','cookieEncryption','copy-old-key'],
  ['credentialPolicy','providerVaultEncryption','reuse-source-keyring'],['credentialPolicy','authSessions','copy-old-sessions'],
  ['financialPolicy','owner','both-projects'],['financialPolicy','destinationWorkers','start-scheduler'],
  ['financialPolicy','schedulerSecrets','copy-old-cron'],['financialPolicy','webhooks','repoint-now'],
  ['financialPolicy','receiptImport','replay-imported-receipts']]){
  const value=request();value[group][key]=unsafe;assert.throws(()=>prepareTargetPlan(value),/rejected/);
 }
});
test('no boolean or policy assertion can enable payment, providers, migration or backups',()=>{
 for(const flag of Object.keys(preparationRequest.paymentFlags)){
  const value=request();value.paymentFlags[flag]=true;assert.throws(()=>prepareTargetPlan(value),/rejected/);
 }
 for(const changes of [{mode:'apply'},{runtimePolicy:'switch-current-target'},
  {providerMode:'admin-vault'},{providerActivationPolicy:'approved'},{customerByok:'enabled'},
  {paymentPausePolicy:'unpaused'},{backupVerified:true},{containmentVerified:true}]){
  assert.throws(()=>prepareTargetPlan(Object.assign(request(),changes)),/rejected/);
 }
});
test('prepares the new native Google pin without changing retained installers or installer trust',()=>{
 const root=path.resolve(__dirname,'..'),google=fs.readFileSync(path.join(root,'desktop/src/main/accounts/GoogleAccountLogin.ts'),'utf8');
 assert(google.includes('https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/authorize'));
 assert.equal(google.includes('dwqltsqumiwsxtkzdoaa'),false);
 assert(google.includes('NATIVE_GOOGLE_CALLBACK'));assert(google.includes('code_challenge_method'));
 const plan=prepareTargetPlan();assert.equal(plan.windows.newAuthProjectGoogle,'new-reviewed-candidate-required');
 assert.equal(plan.windows.existingInstallerChange,'none');
 const trust=fs.readFileSync(path.join(root,'desktop/src/shared/clueraTrust.ts'),'utf8');
 assert(trust.includes('89d6409d29c8eed4f583936bdd2cab0b84a97b15552c340f5697b7336da6c5c1'));
});
test('rejects malformed objects and accessor input without invoking the accessor',()=>{
 for(const value of [null,[],true,'apply'])assert.throws(()=>prepareTargetPlan(value),/rejected/);
 const value=request();let called=false;Object.defineProperty(value,'mode',{enumerable:true,get(){called=true;return 'offline-preparation-only';}});
 assert.throws(()=>prepareTargetPlan(value),/rejected/);assert.equal(called,false);
 const hidden=request();Object.defineProperty(hidden,'secret',{value:'synthetic-credential',enumerable:false});
 assert.throws(()=>prepareTargetPlan(hidden),/rejected/);
 const symbol=request();symbol[Symbol('activationAuthorized')]=true;assert.throws(()=>prepareTargetPlan(symbol),/rejected/);
});
test('CLI is read-only preparation with no apply or credential-input option',()=>{
 const {spawnSync}=require('node:child_process'),script=path.resolve(__dirname,'../scripts/migrations/prepare-cluera-target.cjs');
 const invoke=args=>spawnSync(process.execPath,[script,...args],{encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:64*1024});
 const prepared=invoke([]);assert.equal(prepared.error,undefined);assert.equal(prepared.status,0);
 assert.equal(JSON.parse(prepared.stdout).activationAuthorized,false);
 const rejected=invoke(['--apply']);assert.equal(rejected.error,undefined);assert.equal(rejected.status,1);
 assert.equal(rejected.stdout,'');assert(rejected.stderr.includes('no configuration or data was changed'));
});
