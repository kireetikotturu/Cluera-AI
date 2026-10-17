import { afterEach, expect, it, vi } from 'vitest';
import { WEB_DISPATCH_URL } from '../../shared/billingDispatch';
const hooks = vi.hoisted(() => ({ after: vi.fn(), webhook: vi.fn(), wake: vi.fn() }));
vi.mock('next/server', () => ({ after: hooks.after }));
vi.mock('../lib/payments/cluera/events', async original => ({ ...await original<typeof import('../lib/payments/cluera/events')>(), handleClueraWebhook: hooks.webhook }));
vi.mock('../lib/payments/cluera/wakeRelay', () => ({ wakeClueraBillingRelay: hooks.wake }));
import { POST as webhookPost } from '../app/api/account/payments/cluera/webhook/route';
import { POST as dispatchPost } from '../app/api/internal/billing/cluera/dispatch/route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('disabled dispatch route ignores Next context and never treats it as env/dependencies', async () => {
  vi.stubEnv('CLUERA_BILLING_EXTERNAL_SCHEDULER_ENABLED', 'false');
  const handler = dispatchPost as (request: Request, context: unknown) => Promise<Response>;
  const response = await handler(new Request(WEB_DISPATCH_URL, { method: 'POST', body: '{}' }), { params: Promise.resolve({}) });
  expect(response.status).toBe(404); expect(response.headers.get('cache-control')).toBe('no-store');
});
it('webhook route registers wake through Next after, while generic verified-handler owns STORED eligibility', async () => {
  hooks.webhook.mockImplementation(async (_request, _env, _rpc, stored) => { stored(); return Response.json({ received: true }); });
  hooks.wake.mockResolvedValue('DISABLED');
  const request = new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook', { method: 'POST', body: '{}' });
  expect((await webhookPost(request)).status).toBe(200); expect(hooks.webhook).toHaveBeenCalledExactlyOnceWith(request, process.env, undefined, expect.any(Function));
  expect(hooks.after).toHaveBeenCalledExactlyOnceWith(expect.any(Function)); expect(hooks.wake).not.toHaveBeenCalled();
  await hooks.after.mock.calls[0][0](); expect(hooks.wake).toHaveBeenCalledOnce();
});
it('route creates no background work when handler accepts a duplicate or rejects before STORED', async () => {
  hooks.webhook.mockResolvedValue(Response.json({ received: true }));
  await webhookPost(new Request('https://cluera-ai-staging.vercel.app/api/account/payments/cluera/webhook', { method: 'POST', body: '{}' }));
  expect(hooks.after).not.toHaveBeenCalled(); expect(hooks.wake).not.toHaveBeenCalled();
});
