import { z } from 'zod';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { AccountError } from '../../accounts/config';
import { activeSession, assertAccountOrigin, rateLimit } from '../../accounts/handler';
import { stagingAccountConfig } from '../../accounts/workspace';
import { json } from '../../http';
import { billingRpc, merchantDigest, clueraBillingV2Enabled } from './config';
import { offerCode, planId, revisionSchema, type Revision } from './contracts';
import { clueraRazorpayAdapter } from './adapter';
import { readClueraRawBody } from './events';
import { liveBillingProfile, liveBillingRpc } from './modeProfile';
import { testPlanInput, testPlanOperation } from './planSyncContracts';
import { syncTestPlan } from './planSync';

const common = { operationId:z.uuid(), offerCode, expectedRevisionId:z.uuid(), reason:z.string().trim().min(10).max(500),
  factorId:z.uuid(), code:z.string().regex(/^\d{6}$/) };
export const catalogMutationSchema = z.discriminatedUnion('action',[
  z.object({...common,action:z.literal('CREATE_REVISION'),input:z.object({name:z.string().trim().min(2).max(80),
    amountPaise:z.number().int().min(100).max(10000000),allowanceSeconds:z.number().int().min(60).max(3600000),
    razorpayPlanId:planId.nullable(),totalCount:z.number().int().min(1).max(120).nullable()}).strict()}).strict(),
  z.object({...common,action:z.literal('SET_ENABLED'),input:z.object({enabled:z.boolean()}).strict()}).strict(),
  z.object({...common,action:z.literal('CREATE_TEST_PLAN'),input:testPlanInput}).strict(),
  z.object({operationId:z.uuid(),factorId:z.uuid(),code:z.string().regex(/^\d{6}$/),action:z.literal('RECONCILE_TEST_PLAN'),
    input:z.object({razorpayPlanId:planId.nullable()}).strict()}).strict(),
]);
function claims(token:string) { try { return JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8')); } catch { return {}; } }
const publicRevision = (revision:Revision) => { const {razorpayPlanId:_plan,...value}=revision;return value; };
/** Catalog mutations require current Admin+AAL2, fresh same-session MFA and an immutable operation/revision CAS. */
export async function clueraBillingAdminRequest(request:Request, env = process.env):Promise<Response> {
  let cookies:AccountCookies|undefined;
  try {
    const config = stagingAccountConfig();
    const live = liveBillingProfile(env);
    if (live && (env.CLUERA_LIVE_ADMIN_ENABLED !== 'true' || live.origin !== config.origin))
      return json({error:'Not found.'},404);
    if (request.method !== 'GET') assertAccountOrigin(request,config.origin);
    else if (request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== config.origin)) throw new AccountError('FORBIDDEN',403);
    const clients = accountClients(config); cookies = new AccountCookies(request,config);
    const {account,session} = await activeSession(clients,cookies);
    if (cookies.get('recovery') === account.sessionId) throw new AccountError('FORBIDDEN',403);
    const rawRpc = (name:string,args:Record<string,unknown>) => clients.service.rpc(name,args);
    const rpc = live ? liveBillingRpc(rawRpc) : rawRpc;
    const admin = {p_actor:account.userId,p_session:account.sessionId};
    if (claims(session.access_token).aal !== 'aal2' || await billingRpc(rawRpc,'account_admin_check',{...admin,p_require_mfa:true}) !== true) throw new AccountError('FORBIDDEN',403);
    await rateLimit(request,config,clients,account.email);
    if (!clueraBillingV2Enabled(env)) return cookies.apply(json({error:'BILLING_SCHEMA_APPROVAL_REQUIRED'},503));
    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      if (params.size > 1 || [...params.keys()].some(key=>!['factors','operation','plans'].includes(key))) throw new AccountError('INVALID_INPUT',400);
      if (params.has('plans')) {
        if (live || params.get('plans') !== '1' || env.RAZORPAY_ENVIRONMENT !== 'test') throw new AccountError('FORBIDDEN',403);
        const result=await billingRpc(rpc,'cluera_billing_plan_sync_read',{...admin,p_operation:null}) as {code?:unknown;catalog?:unknown;operations?:unknown};
        if (result.code !== 'ACTIVE') throw new AccountError('FORBIDDEN',403);
        return cookies.apply(json({code:'ACTIVE',catalog:z.array(revisionSchema).max(4).parse(result.catalog),
          operations:z.array(testPlanOperation).max(3).parse(result.operations)}));
      }
      if (params.get('factors') === '1') {
        const restored = await clients.auth.auth.setSession(session); if (restored.error) throw new AccountError('UNAVAILABLE',503);
        const factors = await clients.auth.auth.mfa.listFactors(); if (factors.error) throw new AccountError('UNAVAILABLE',503);
        return cookies.apply(json({factors:factors.data.all.filter(factor=>factor.factor_type === 'totp' && factor.status === 'verified').map(factor=>({id:factor.id,status:'verified'}))}));
      }
      const operation = params.has('operation') ? z.uuid().parse(params.get('operation')) : null;
      const result = await billingRpc(rpc,'cluera_billing_admin_read',{...admin,p_operation:operation}) as {code?:unknown;catalog?:unknown;revision?:unknown};
      if (operation) return cookies.apply(json(result.code === 'APPLIED' ? {code:'APPLIED',revision:publicRevision(revisionSchema.parse(result.revision))} : {code:'PENDING'}));
      if (result.code !== 'ACTIVE') throw new AccountError('FORBIDDEN',403);
      return cookies.apply(json({code:'ACTIVE',catalog:z.array(revisionSchema).max(4).parse(result.catalog).map(publicRevision)}));
    }
    if (request.method !== 'POST') return json({error:'METHOD_NOT_ALLOWED'},405);
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new AccountError('INVALID_INPUT',400);
    const input = catalogMutationSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readClueraRawBody(request,4096))));
    const planAction=input.action === 'CREATE_TEST_PLAN' || input.action === 'RECONCILE_TEST_PLAN';
    if (planAction && (live || env.RAZORPAY_ENVIRONMENT !== 'test')) throw new AccountError('FORBIDDEN',403);
    const read = await billingRpc(rpc,'cluera_billing_admin_read',{...admin,p_operation:null}) as {code?:unknown;catalog?:unknown};
    if (read.code !== 'ACTIVE') throw new AccountError('FORBIDDEN',403);
    const catalog=z.array(revisionSchema).max(4).parse(read.catalog);
    const current = input.action === 'RECONCILE_TEST_PLAN' ? undefined : catalog.find(revision=>revision.offerCode === input.offerCode);
    if (input.action !== 'RECONCILE_TEST_PLAN' && (!current || current.revisionId !== input.expectedRevisionId)) return cookies.apply(json({error:'CONFLICT'},409));
    if (input.action === 'CREATE_TEST_PLAN' && current?.kind !== 'RECURRING') throw new AccountError('INVALID_INPUT',400);
    if (input.action === 'CREATE_REVISION' && (current!.kind === 'PACK' ? input.input.razorpayPlanId !== null || input.input.totalCount !== null : !input.input.razorpayPlanId || !input.input.totalCount)) throw new AccountError('INVALID_INPUT',400);
    const restored = await clients.auth.auth.setSession(session); if (restored.error) throw new AccountError('UNAVAILABLE',503);
    const factors = await clients.auth.auth.mfa.listFactors();
    if (factors.error || !factors.data.all.some(factor=>factor.id === input.factorId && factor.factor_type === 'totp' && factor.status === 'verified')) throw new AccountError('FORBIDDEN',403);
    const step = await clients.auth.auth.mfa.challengeAndVerify({factorId:input.factorId,code:input.code});
    if (step.error) throw new AccountError('FORBIDDEN',403);
    const checked = await clients.auth.auth.getUser(step.data.access_token), elevated = claims(step.data.access_token);
    if (checked.error || checked.data.user?.id !== account.userId || !checked.data.user.email_confirmed_at || checked.data.user.is_anonymous
      || elevated.aal !== 'aal2' || elevated.session_id !== account.sessionId) throw new AccountError('FORBIDDEN',403);
    const reauthenticatedAt = new Date().toISOString();
    cookies.set('access',step.data.access_token,Math.max(1,Math.min(step.data.expires_in-30,3570)));
    cookies.set('refresh',step.data.refresh_token,30*86400);
    if (input.action === 'CREATE_TEST_PLAN' || input.action === 'RECONCILE_TEST_PLAN') {
      try {
        const result=await syncTestPlan(rpc,{...admin,p_reauthenticated_at:reauthenticatedAt},input,env);
        return cookies.apply(json(result.code === 'APPLIED' ? {code:'APPLIED',revision:publicRevision(result.revision)} : result));
      } catch {
        // Validation/transport/SQL errors after a durable claim are unknown outcomes,
        // never pre-write 400/403 responses that could invite another creation.
        return cookies.apply(json({error:'PLAN_SYNC_PENDING_REVIEW'},503));
      }
    }
    if (!current) throw new AccountError('INVALID_INPUT',400);
    const gateway = input.action === 'CREATE_REVISION' && current.kind === 'RECURRING' || input.action === 'SET_ENABLED' && input.input.enabled && current.kind === 'RECURRING'
      ? clueraRazorpayAdapter(env) : null;
    if (input.action === 'CREATE_REVISION' && gateway) {
      // Read-only compatibility preflight. No plan creation/update and no subscription changes.
      await gateway.verifyPlan({...current,...input.input} as Revision);
    }
    if (input.action === 'SET_ENABLED' && gateway) {
      const evidence = await gateway.verifyPlan(current);
      if (await billingRpc(rpc,'cluera_billing_plan_verify',{p_revision:current.revisionId,p_account_digest:merchantDigest(env),p_evidence:evidence}) !== 'VERIFIED')
        return cookies.apply(json({error:'PLAN_REQUIRES_REVIEW'},409));
    }
    const result = await billingRpc(rpc,'cluera_billing_admin_mutate',{...admin,p_operation:input.operationId,p_action:input.action,p_offer:input.offerCode,
      p_expected_revision:input.expectedRevisionId,p_reauthenticated_at:reauthenticatedAt,p_reason:input.reason,p_input:input.input}) as {code?:unknown;revision?:unknown};
    if (result.code !== 'APPLIED') return cookies.apply(json({error:result.code === 'CONFLICT' ? 'CONFLICT' : 'CHANGE_REJECTED'},409));
    return cookies.apply(json({code:'APPLIED',revision:publicRevision(revisionSchema.parse(result.revision))}));
  } catch (error) {
    const response = json({error:error instanceof AccountError ? error.code : error instanceof z.ZodError || error instanceof SyntaxError ? 'INVALID_INPUT' : 'BILLING_SERVICE_UNAVAILABLE'},
      error instanceof AccountError ? error.status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503);
    return cookies ? cookies.apply(response) : response;
  }
}
