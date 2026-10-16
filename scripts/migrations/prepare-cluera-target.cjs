'use strict';
// Offline preparation only: no clients, environment discovery, writes or apply path.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..');
const RETAINED='dwqltsqumiwsxtkzdoaa',DESTINATION='yhnqlfcgrmckhyjdxegg';
const destinationUrl=`https://${DESTINATION}.supabase.co`;
function freeze(value){if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const preparationRequest=freeze({
 version:1,mode:'offline-preparation-only',
 destination:{projectRef:DESTINATION,url:destinationUrl,region:'ap-south-1'},
 runtimePolicy:'prepare-clean-source-without-switching-served-targets',
 credentialPolicy:{apiKeys:'fresh-modern-only',privilegedJwt:'never-reuse',jwtSigning:'destination-native-only',
  cookieEncryption:'fresh-destination-only',providerVaultEncryption:'new-keyring-required',authSessions:'fresh-login-required',
  releaseSigning:'preserve-independent-installer-trust'},
 historyPolicy:{source:'no-source-data-import',identities:'fresh-auth-only',trials:'fresh-once-ever-only',
  balances:'no-imported-allowance',payments:'independent-provider-reconciliation-required'},
 financialPolicy:{owner:'no-cluera-processing-before-approved-test',destinationWorkers:'not-scheduled',schedulerSecrets:'never-copy',
  webhooks:'unchanged',checkout:'disabled',receiptImport:'inert-no-replay'},
 paymentFlags:{CLUERA_BILLING_V2_ENABLED:false,CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:false,SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED:false,
  SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED:false,SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED:false},
 paymentPausePolicy:'paused',providerMode:'auth-only',providerActivationPolicy:'not-authorized',customerByok:'disabled',
});
function reject(){throw Error('Cluera target preparation rejected; use the exact offline isolation policy without credentials.');}
function exact(actual,expected){
 if(expected&&typeof expected==='object'){
  if(!actual||typeof actual!=='object'||Array.isArray(actual)
   ||![Object.prototype,null].includes(Object.getPrototypeOf(actual)))reject();
  const keys=Object.keys(expected),descriptors=Object.getOwnPropertyDescriptors(actual);
  if(Reflect.ownKeys(actual).length!==keys.length||keys.some(key=>!Object.hasOwn(descriptors,key)
   ||!Object.hasOwn(descriptors[key],'value')))reject();
  for(const key of keys)exact(descriptors[key].value,expected[key]);
 }else if(actual!==expected)reject();
}
function inspectCurrentPins(){
 const checks=[
  ['web/lib/supabase/target.ts',destinationUrl],
  ['web/lib/accounts/config.ts','CLUERA_SUPABASE_URL'],
  ['web/lib/accountRelay/config.ts','CLUERA_SUPABASE_URL'],
  ['desktop/src/main/accounts/GoogleAccountLogin.ts',`${destinationUrl}/auth/v1/authorize`],
  ['desktop/src/shared/accountDistribution.ts','https://cluera-ai-staging.vercel.app'],
 ];
 return checks.map(([file,pin])=>{
  const location=path.join(ROOT,file),stat=fs.lstatSync(location);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>128*1024)reject();
  const bytes=fs.readFileSync(location),text=bytes.toString('utf8');
  if(!text.includes(pin)||text.includes(RETAINED))reject();
  return {file,sha256:createHash('sha256').update(bytes).digest('hex')};
 });
}
function prepareTargetPlan(request=preparationRequest){
 exact(request,preparationRequest);
 return {
  status:'PREPARED-NOT-APPLIED',activationAuthorized:false,
  destination:{projectRef:DESTINATION,publicUrl:destinationUrl,region:'ap-south-1'},
  preparedSourcePins:inspectCurrentPins(),sourceEvidence:'prepared-clean-local-source-not-hosted-verification',
  servedRuntimeChange:'none',environmentChange:'none',databaseChange:'none',
  customerOrHistoryImport:'excluded-clean-setup',oldSourceBackupRequired:false,containmentVerified:false,
  billingOwnerChange:'none',destinationScheduler:'not-created',paymentActivation:'not-authorized',
  providerMode:'auth-only',providerActivation:'not-authorized',
  windows:{existingCandidate:'1.0.2',newAuthProjectGoogle:'new-reviewed-candidate-required',
   reason:'prepared-new-native-Google-pin-requires-separate-versioned-build-not-overwrite',
   existingInstallerChange:'none',packagedAcceptance:'not-performed-by-this-offline-tool'},
  requiredSettingNames:{webInfrastructure:['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY',
    'SIGMAROUND_ACCOUNTS_ENABLED','SIGMAROUND_ACCOUNT_ORIGIN','SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64','SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64'],
   relayInfrastructure:['NEXT_PUBLIC_SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SIGMAROUND_ACCOUNTS_ENABLED',
    'SIGMAROUND_ACCOUNT_ORIGIN','SIGMAROUND_ACCOUNT_RELAY_ENABLED','SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64','CLUERA_AI_BOOTSTRAP_MODE'],
   deferredProviderBootstrap:['CLUERA_PROVIDER_VAULT_KEYRING_BASE64'],
   deferredBillingTarget:['SIGMAROUND_RAZORPAY_TEST_PROJECT_REF']},
  requiredBeforeAuthOnlySwitch:['complete-reviewed-fresh-schema-with-financial-and-provider-flags-disabled',
   'fresh-destination-modern-key-positive-and-old-authority-negative-evidence','reviewed-isolated-runtime-pins',
   'matched-fresh-cookie-rate-keys-and-auth-only-relay','configured-exact-new-project-Auth-and-Google-callbacks',
   'complete-source-READY-and-reversible-environment-tuple'],
  requiredBeforeFinancialActivation:['independent-provider-financial-reconciliation','single-writer-epoch-fenced-cutover-and-rollback',
   'separate-controlled-Test-approval','genuine-captured-order-signed-receipt-idempotent-credit-and-installed-balance-acceptance'],
  requiredBeforeProviderActivation:['dedicated-new-vault-encryption-custody','fresh-MFA-Admin-credential-and-model-acceptance',
   'separate-metered-Gemini-Deepgram-and-shared-usage-acceptance'],
  pendingRealAcceptance:['destination-email-Google-session-and-MFA','installed-Windows-secure-store-and-complete-feature-flow'],
 };
}
module.exports={prepareTargetPlan,preparationRequest,inspectCurrentPins};
if(require.main===module){
 try{if(process.argv.length!==2)reject();console.log(JSON.stringify(prepareTargetPlan()));}
 catch{console.error('Cluera target preparation failed closed; no configuration or data was changed.');process.exitCode=1;}
}
