import { z } from 'zod';
import type { PaymentRpc } from '../core/types';
import { billingOwner, billingRpc, clueraBillingConfig, clueraCheckoutAllowed, clueraCheckoutEnabled } from './config';
import { bindingSchema, ClueraBillingError, type Binding } from './contracts';
import { clueraBillingStatus } from './checkout';
import { clueraRazorpayAdapter, ClueraResumeError } from './adapter';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { AccountError } from '../../accounts/config';
import { activeSession, rateLimit } from '../../accounts/handler';
import { stagingAccountConfig } from '../../accounts/workspace';
import { json } from '../../http';

type Account={userId:string;sessionId:string};
type Gateway=Pick<ReturnType<typeof clueraRazorpayAdapter>,'resumeUntouchedPack'>;
function eligible(binding:Binding,account:Account,intentId:string,orderId:string,revisionId:string) {
  if(binding.userId!==account.userId||binding.intentId!==intentId||binding.orderId!==orderId||binding.subscriptionId!==null
    ||binding.revision.revisionId!==revisionId||binding.code!=='BOUND'||binding.revision.kind!=='PACK'
    ||!binding.revision.enabled)throw new ClueraBillingError('PENDING');
  return binding;
}
/** Read-only recovery of the SAME server-owned untouched order. No caller may
 * supply a provider resource, create another order or retry an existing payment. */
export async function resumeClueraCheckout(rpc:PaymentRpc,account:Account,env=process.env,
  gateway:Gateway=clueraRazorpayAdapter(env)) {
  if(!clueraCheckoutAllowed(account.userId,env))throw new ClueraBillingError('CONFIGURATION');
  const {accountDigest,epoch}=await billingOwner(rpc,env);
  const pending=(await clueraBillingStatus(rpc,account)).pending;
  if(!pending||pending.legacy||pending.kind!=='PACK'||pending.state!=='BOUND'||!pending.orderId||pending.subscriptionId!==null)
    throw new ClueraBillingError('PENDING');
  const read=async()=>{
    const value=await billingRpc(rpc,'cluera_billing_binding',{p_resource:pending.orderId,p_account_digest:accountDigest});
    const raw=z.object({legacy:z.literal(false)}).passthrough().parse(value);const projected={...raw};delete (projected as Record<string,unknown>).legacy;
    return eligible(bindingSchema.parse(projected),account,pending.intentId,pending.orderId!,pending.revisionId);
  };
  const binding=await read(),resource=await gateway.resumeUntouchedPack(binding);
  if(resource.orderId!==pending.orderId||resource.subscriptionId!==null)throw new ClueraBillingError('PENDING');
  // Provider reads can take time. Re-attest owner/epoch, current session and
  // exact still-unresolved original binding before releasing SDK metadata.
  const owner=await billingOwner(rpc,env);if(owner.accountDigest!==accountDigest||owner.epoch!==epoch)throw new ClueraBillingError('PENDING');
  const current=(await clueraBillingStatus(rpc,account)).pending;
  if(!current||current.legacy||current.state!=='BOUND'||current.intentId!==pending.intentId||current.orderId!==pending.orderId
    ||current.subscriptionId!==null||current.revisionId!==pending.revisionId)throw new ClueraBillingError('PENDING');
  await read();
  if(!clueraCheckoutAllowed(account.userId,env))throw new ClueraBillingError('CONFIGURATION');
  return {code:'BOUND' as const,kind:'PACK' as const,...resource,keyId:clueraBillingConfig(env).keyId,
    amountPaise:binding.revision.amountPaise,currency:'INR' as const,revisionId:binding.revision.revisionId,offerCode:binding.revision.offerCode};
}
export async function handleClueraCheckoutResume(request:Request):Promise<Response> {
  if(!clueraCheckoutEnabled())return json({code:'CHECKOUT_DISABLED',error:'Not found.'},404);
  let cookies:AccountCookies|undefined;
  try {
    const config=stagingAccountConfig(),url=new URL(request.url),query=url.searchParams;
    if(request.method!=='GET'||url.origin!==config.origin||url.pathname!=='/api/account/payments/cluera/resume')return json({error:'Not found.'},404);
    if(request.headers.get('sec-fetch-site')==='cross-site'||(request.headers.has('origin')&&request.headers.get('origin')!==config.origin))throw new AccountError('FORBIDDEN',403);
    if(query.size!==1||query.getAll('expectedAccountId').length!==1||!z.uuid().safeParse(query.get('expectedAccountId')).success)throw new AccountError('INVALID_INPUT',400);
    const clients=accountClients(config);cookies=new AccountCookies(request,config);
    const {account}=await activeSession(clients,cookies);
    if(cookies.get('recovery')===account.sessionId)return cookies.apply(json({code:'RECOVERY_SESSION',error:'Finish password recovery and sign in before checkout.'},403));
    if(query.get('expectedAccountId')!==account.userId)return cookies.apply(json({code:'ACCOUNT_MISMATCH',error:'Account does not match.'},403));
    if(!clueraCheckoutAllowed(account.userId))return cookies.apply(json({code:'TEST_PURCHASER_REQUIRED',error:'You are signed in, but this account is not an approved Test purchaser.'},403));
    await rateLimit(request,config,clients,account.email,'billing-read');
    return cookies.apply(json({payment:await resumeClueraCheckout((name,args)=>clients.service.rpc(name,args),account)}));
  } catch(error) {
    const status=error instanceof AccountError?error.status:error instanceof ClueraBillingError&&error.code==='PENDING'?409:503;
    if(status===401)cookies?.clear();
    const response=json({...error instanceof ClueraResumeError&&error.reason==='ORDER_ALREADY_ATTEMPTED'?{code:'ORDER_RECONCILIATION_REQUIRED'}:{},error:status===429?'Too many status checks. Wait before verifying the original order.'
      :'The existing order cannot safely continue. Preserve it for verification; do not create or retry a payment.'},status);
    if (status === 429) response.headers.set('Retry-After', '60');
    return cookies?cookies.apply(response):response;
  }
}
