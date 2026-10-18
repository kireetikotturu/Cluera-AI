import { z } from 'zod';
import { stagingAccountConfig } from '../../accounts/workspace';
import { AccountCookies } from '../../accounts/cookies';
import { accountClients } from '../../accounts/clients';
import { activeSession, assertAccountOrigin, rateLimit } from '../../accounts/handler';
import { json, readJsonBody } from '../../http';
import { razorpayCheckoutAllowed, razorpayCheckoutEnabled } from '../core/config';
import { createPaymentOrder, paymentStatus, verifyPaymentCallback } from './service';

export async function handlePaymentCheckout(request: Request): Promise<Response> {
  // V2 owns new Cluera checkout. Keep the older API closed even when the
  // shared Test checkout flag is enabled; legacy behavior outside V2 is intact.
  if (process.env.CLUERA_BILLING_V2_ENABLED === 'true') return json({ error: 'Not found.' }, 404);
  let cookies: AccountCookies | undefined;
  try {
    if (!razorpayCheckoutEnabled()) return json({ error: 'Test checkout awaits configuration.' }, 404);
    const config = stagingAccountConfig();
    if (request.method === 'POST') assertAccountOrigin(request, config.origin);
    else if (request.method !== 'GET') return json({ error: 'Not found.' }, 404);
    const clients = accountClients(config); cookies = new AccountCookies(request, config);
    const { account } = await activeSession(clients, cookies);
    if (cookies.get('recovery') === account.sessionId || !razorpayCheckoutAllowed(account.userId)) return json({ error: 'This action is not allowed.' }, 403);
    await rateLimit(request, config, clients, account.email);
    const rpc = (name: string, args: Record<string, unknown>) => clients.service.rpc(name, args);
    if (request.method === 'GET') {
      const query = new URL(request.url).searchParams;
      if (query.size !== 1 || query.getAll('expectedAccountId').length !== 1 || query.get('expectedAccountId') !== account.userId) return json({ error: 'Account does not match.' }, 403);
      return cookies.apply(json({ payment: await paymentStatus(rpc, account) }));
    }
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('CREATE'), expectedAccountId: z.uuid(), requestId: z.uuid(), offerCode: z.literal('pro_3_hours'), provider: z.literal('razorpay') }).strict(),
      z.object({ action: z.literal('VERIFY_CALLBACK'), expectedAccountId: z.uuid(), orderId: z.string().regex(/^order_[A-Za-z0-9]{8,64}$/),
        paymentId: z.string().regex(/^pay_[A-Za-z0-9]{8,64}$/), signature: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    ]).parse(await readJsonBody(request, 2048));
    if (input.expectedAccountId !== account.userId) return json({ error: 'Account does not match.' }, 403);
    const payment = input.action === 'CREATE' ? await createPaymentOrder(rpc, account, input.requestId)
      : await verifyPaymentCallback(rpc, account, input);
    return cookies.apply(json({ payment }, payment.code === 'PENDING' ? 409 : 200));
  } catch (error) {
    // Fixed status/categories; never pass a gateway error/JSON body to apiError/UI.
    const status = (error as { status?: number })?.status;
    if (status === 401) cookies?.clear();
    const response = json({ error: status === 401 ? 'Sign in with a verified email.' : 'Payment verification is unavailable. Do not retry.' },
      status === 401 || status === 403 ? status : error instanceof z.ZodError ? 400 : 503);
    return cookies ? cookies.apply(response) : response;
  }
}
