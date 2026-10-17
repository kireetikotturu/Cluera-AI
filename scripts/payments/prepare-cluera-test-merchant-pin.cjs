'use strict';
// Offline operator preparation ONLY. No environment, credential, network,
// provider, database, file-write or application-route import. Evidence and
// approval below are operator attestations, not self-proving API authority.
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),PROJECT='yhnqlfcgrmckhyjdxegg';
const FOUNDATION_SHA='ae0f1eeef39e9d988386c1c36b3150cee8b10895b38e7d270d373f4b9009379e';
const TEMPLATE_SHA='c76a00e938d8588fb852442ad9f3d08a3e8bd44b51c1875ddda05711d2e35f73';
// Approval receipt time is retained, never refreshed by a later technical check.
// It binds the exact project, operation, merchant and unchanged SQL template.
const EVIDENCE_MAX_AGE_MS=120000,APPROVAL_MAX_AGE_MS=60*60*1000;
const APPROVAL='OWNER_APPROVED_CLUERA_TEST_MERCHANT_PIN_ONLY';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex=/^[a-f0-9]{64}$/,instant=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EMPTY=Object.freeze(['public.customer_checkout_intents','public.paddle_sandbox_events','public.customer_pack_purchases',
 'public.customer_recurring_subscriptions','public.customer_recurring_terms','public.customer_billing_jobs','public.customer_billing_outbox',
 'billing_private.payment_intents','billing_private.payment_events','billing_private.payment_applications','billing_private.payment_diagnostics',
 'cluera_billing_private.intents','cluera_billing_private.events','cluera_billing_private.subscriptions','cluera_billing_private.payments',
 'cluera_billing_private.terms','cluera_billing_private.applications','cluera_billing_private.worker_nonces','cluera_billing_private.plan_verifications',
 'cluera_billing_private.cutover_audit']);
const GUARDED=Object.freeze([...EMPTY,'cluera_billing_private.processing_owner','cluera_billing_private.catalog_heads',
 'billing_private.worker_config','public.customer_usage_grants']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function record(value,keys){
 if(!value||typeof value!=='object'||![null,Object.prototype].includes(Object.getPrototypeOf(value)))throw Error('Merchant pin record refused.');
 const descriptors=Object.getOwnPropertyDescriptors(value),names=Reflect.ownKeys(descriptors);
 if(names.some(key=>typeof key!=='string')||names.sort().join(',')!==[...keys].sort().join(',')
   ||Object.values(descriptors).some(property=>!Object.hasOwn(property,'value')))throw Error('Merchant pin record refused.');
 // No inherited/non-enumerable toJSON, custom coercion or accessor is serialized.
 const safe=Object.create(null);for(const key of keys)safe[key]=descriptors[key].value;return safe;
}
const strings=(value,keys)=>keys.every(key=>typeof value[key]==='string');
function bodyHash(sql,name){const escaped=name.replaceAll('.','\\.');
 const match=sql.match(new RegExp('create function '+escaped+'\\([^]*?as \\$\\$([^]*?)\\$\\$;'));
 if(!match)throw Error('Reviewed function pin unavailable.');return createHash('md5').update(match[1]).digest('hex');}
function prepareMerchantPin(input,now=Date.now(),read=file=>fs.readFileSync(path.join(ROOT,file))){
 input=record(input,['projectRef','operationId','merchantDigest','evidence','approval']);
 if(!strings(input,['projectRef','operationId','merchantDigest'])||input.projectRef!==PROJECT
 ||!uuid.test(input.operationId)||!hex.test(input.merchantDigest))throw Error('Merchant pin input refused.');
 const e=record(input.evidence,['projectRef','deploymentId','sourceCommit','reportDigest','observedAt','testAuthentication','merchantMatches',
   'configuredDigestMatches','testModeVerified','requests','mutations']);
 const a=record(input.approval,['scope','projectRef','operationId','approvedAt','merchantDigest','templateSha256']);
 if(!strings(e,['projectRef','deploymentId','sourceCommit','reportDigest','observedAt'])||e.projectRef!==PROJECT
   ||!/^dpl_[A-Za-z0-9]{8,80}$/.test(e.deploymentId)||!/^[a-f0-9]{40}$/.test(e.sourceCommit)
   ||!hex.test(e.reportDigest)||!instant.test(e.observedAt)
   ||![e.testAuthentication,e.merchantMatches,e.configuredDigestMatches,e.testModeVerified].every(v=>v===true)
   ||!Number.isSafeInteger(e.requests)||e.requests<2||e.requests>13||e.mutations!==0)
   throw Error('Fresh verified Test merchant evidence required.');
 if(!strings(a,['scope','projectRef','operationId','approvedAt','merchantDigest','templateSha256'])||a.scope!==APPROVAL||a.projectRef!==PROJECT
   ||a.operationId!==input.operationId||!instant.test(a.approvedAt)||a.merchantDigest!==input.merchantDigest
   ||a.templateSha256!==TEMPLATE_SHA)throw Error('Separate exact owner approval required.');
 const observed=Date.parse(e.observedAt),approved=Date.parse(a.approvedAt);
 if(!Number.isFinite(now)||!Number.isFinite(observed)||!Number.isFinite(approved)||observed>now||approved>now
   ||new Date(observed).toISOString()!==e.observedAt||new Date(approved).toISOString()!==a.approvedAt
   ||observed<now-EVIDENCE_MAX_AGE_MS||approved<now-APPROVAL_MAX_AGE_MS)throw Error('Merchant pin evidence/approval expired.');
 const foundation=Buffer.from(read('docs/proposals/cluera-clean-foundation.sql'));
 const template=Buffer.from(read('docs/proposals/cluera-test-merchant-pin.sql'));
 if(sha(foundation)!==FOUNDATION_SHA||sha(template)!==TEMPLATE_SHA)throw Error('Reviewed merchant pin source mismatch.');
 const detail=Object.assign(Object.create(null),{kind:'CLEAN_TEST_MERCHANT_PIN',projectRef:PROJECT,evidence:e,approval:a,
   authority:"Owner's direct approval; database operator execution, not authenticated Admin action",
   activationAuthorized:false,financialObligationsCleared:false,providerMutationAuthorized:false});
 const values={OPERATION_ID:input.operationId,MERCHANT_DIGEST:input.merchantDigest,OBSERVED_AT:e.observedAt,
   DEADLINE:new Date(Math.min(observed+EVIDENCE_MAX_AGE_MS,approved+APPROVAL_MAX_AGE_MS)).toISOString(),PROVENANCE_JSON:JSON.stringify(detail).replaceAll("'","''"),
   OWNER_MD5:bodyHash(foundation.toString(),'public.cluera_billing_owner'),
   CUTOVER_MD5:bodyHash(foundation.toString(),'public.cluera_billing_cutover'),
   OWNS_MD5:bodyHash(foundation.toString(),'cluera_billing_private.owns'),
   IMMUTABLE_MD5:bodyHash(foundation.toString(),'cluera_billing_private.immutable'),
   GUARDED_RELATIONS:GUARDED.map(v=>`'${v}'`).join(','),EMPTY_RELATIONS:EMPTY.map(v=>`'${v}'`).join(',')};
 let sql=template.toString();for(const [key,value] of Object.entries(values)){
   if(!sql.includes('__'+key+'__'))throw Error('Merchant pin template mismatch.');sql=sql.replaceAll('__'+key+'__',value);
 }
 if(/__[A-Z_]+__/.test(sql))throw Error('Unresolved merchant pin template.');
 return {sql,sha256:sha(sql),projectRef:PROJECT,preparedOnly:true,activationAuthorized:false,
   financialObligationsCleared:false,executionTargetIndependentlyVerified:false};
}
module.exports={PROJECT,APPROVAL,TEMPLATE_SHA,EVIDENCE_MAX_AGE_MS,APPROVAL_MAX_AGE_MS,EMPTY,GUARDED,prepareMerchantPin};
