import { z } from 'zod';
import { accountClients } from '../../accounts/clients';
import { AccountCookies } from '../../accounts/cookies';
import { stagingAccountConfig } from '../../accounts/workspace';
import { activeSession, assertAccountOrigin, rateLimit } from '../../accounts/handler';
import { json } from '../../http';
import { clueraBillingV2Enabled, clueraCheckoutAllowed, clueraCheckoutEnabled } from './config';
import { callbackSchema, clueraBillingCatalog, clueraBillingStatus, createClueraCheckout, verifyClueraCallback } from './checkout';
import { readClueraRawBody } from './events';

export async function handleClueraCatalog(request: Request) {
  try {
    if (request.method !== 'GET' || new URL(request.url).searchParams.size) return json({error:'Not found.'},404);
    if (!clueraBillingV2Enabled()) return json({error:'Billing catalog awaits schema approval.'},503);
    const config = stagingAccountConfig(), clients = accountClients(config);
    return json({catalog:await clueraBillingCatalog((name,args)=>clients.service.rpc(name,args))});
  } catch { return json({error:'Billing catalog is unavailable.'},503); }
}
export async function handleClueraCheckout(request: Request, callback = false) {
  let cookies:AccountCookies|undefined;
  try {
    if (!clueraCheckoutEnabled()) return json({error:'Test checkout awaits approval.'},404);
    if (!['GET','POST'].includes(request.method) || (callback && request.method !== 'POST')) return json({error:'Not found.'},404);
    const config = stagingAccountConfig();
    if (request.method === 'POST') assertAccountOrigin(request,config.origin);
    else if (request.headers.get('sec-fetch-site') === 'cross-site' || (request.headers.has('origin') && request.headers.get('origin') !== config.origin)) return json({error:'This action is not allowed.'},403);
    const clients = accountClients(config); cookies = new AccountCookies(request,config);
    const {account} = await activeSession(clients,cookies);
    if (cookies.get('recovery') === account.sessionId || !clueraCheckoutAllowed(account.userId)) return cookies.apply(json({error:'This action is not allowed.'},403));
    await rateLimit(request,config,clients,account.email);
    const rpc = (name:string,args:Record<string,unknown>)=>clients.service.rpc(name,args);
    if (request.method === 'GET') {
      const query = new URL(request.url).searchParams;
      if (query.size !== 1 || query.getAll('expectedAccountId').length !== 1 || query.get('expectedAccountId') !== account.userId)
        return cookies.apply(json({error:'Account does not match.'},403));
      return cookies.apply(json({payment:await clueraBillingStatus(rpc,account)}));
    }
    if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return cookies.apply(json({error:'The request could not be accepted.'},400));
    const raw = await readClueraRawBody(request,2048);
    const input = callback ? callbackSchema.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)))
      : z.object({expectedAccountId:z.uuid(),requestId:z.uuid(),revisionId:z.uuid()}).strict().parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
    if (input.expectedAccountId !== account.userId) return cookies.apply(json({error:'Account does not match.'},403));
    const payment = 'requestId' in input ? await createClueraCheckout(rpc,account,input.requestId,input.revisionId)
      : await verifyClueraCallback(rpc,account,input);
    return cookies.apply(json({payment},payment.code === 'PENDING' ? 409 : 200));
  } catch (error) {
    const status = (error as {status?:unknown})?.status;
    if (status === 401) cookies?.clear();
    const response = json({error:status === 401 ? 'Sign in with a verified email.' : 'Payment verification is unavailable. Do not retry.'},
      status === 401 || status === 403 ? status : error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 503);
    return cookies ? cookies.apply(response) : response;
  }
}
