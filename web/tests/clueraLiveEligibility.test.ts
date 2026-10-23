import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleLiveBilling } from '../lib/payments/cluera/liveRoutes';
import { AccountCookies } from '../lib/accounts/cookies';
import { AccountError } from '../lib/accounts/config';
import { paymentLiveEnvironment as env } from './helpers/paymentLiveMode';
import { checkoutDenial, checkoutDenialMessage } from '../lib/payments/cluera/checkoutFailure';
import { ClueraBillingError } from '../lib/payments/cluera/contracts';
const mocks = vi.hoisted(() => ({ clients: vi.fn(), session: vi.fn(), limit: vi.fn(), owner: vi.fn(), status: vi.fn(), history: vi.fn(), cancellation: vi.fn() }));
vi.mock('../lib/accounts/clients', () => ({ accountClients: mocks.clients }));
vi.mock('../lib/accounts/handler', async original => ({ ...await original<typeof import('../lib/accounts/handler')>(), activeSession: mocks.session, rateLimit: mocks.limit }));
vi.mock('../lib/payments/cluera/config', async original => ({ ...await original<typeof import('../lib/payments/cluera/config')>(), billingOwner: mocks.owner }));
vi.mock('../lib/payments/cluera/checkout', async original => ({ ...await original<typeof import('../lib/payments/cluera/checkout')>(), clueraBillingStatus: mocks.status }));
vi.mock('../lib/payments/cluera/history', () => ({ readClueraBillingHistory: mocks.history }));
vi.mock('../lib/payments/cluera/cancellation', async original => ({ ...await original<typeof import('../lib/payments/cluera/cancellation')>(), readClueraCancellation: mocks.cancellation }));
const actor = '00000000-0000-4000-8000-000000000055', sid = '00000000-0000-4000-8000-000000000056';
const request = (path = 'checkout', id = actor, body?: object) => new Request(`${env.CLUERA_LIVE_ACCOUNT_ORIGIN}/api/account/payments/cluera/live/${path}${body ? '' : '?expectedAccountId=' + id}`, body ? {
  method: 'POST', headers: { origin: env.CLUERA_LIVE_ACCOUNT_ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify({ expectedAccountId: id, ...body }),
} : undefined);
beforeEach(() => {
  for (const [key, value] of Object.entries({ ...env, NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_synthetic_public_key_00000000000000000',
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64: Buffer.alloc(32, 3).toString('base64'), SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: Buffer.alloc(32, 4).toString('base64') })) vi.stubEnv(key, value);
  mocks.session.mockResolvedValue({ account: { userId: actor, sessionId: sid, email: 'synthetic@example.invalid' }, session: {} });
  mocks.clients.mockReturnValue({ service: { rpc: vi.fn() } }); mocks.limit.mockResolvedValue(undefined); mocks.owner.mockResolvedValue({});
  mocks.status.mockResolvedValue({ code: 'AVAILABLE' }); mocks.history.mockResolvedValue({ code: 'ACTIVE' }); mocks.cancellation.mockResolvedValue({ code: 'PENDING' });
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it.each(['checkout', 'resume'])('Live %s rejects an unapproved acceptance account before status/provider calls without clearing Auth', async path => {
  const clear = vi.spyOn(AccountCookies.prototype, 'clear');
  const response = await handleLiveBilling(request(path), path as 'checkout' | 'resume', env);
  expect(response.status).toBe(403); const body = await response.json();
  expect(checkoutDenial(response.status, body)).toBe('LIVE_PURCHASER_REQUIRED');
  expect(checkoutDenialMessage.LIVE_PURCHASER_REQUIRED).toContain('Your existing balance is unchanged');
  expect(clear).not.toHaveBeenCalled(); expect(mocks.status).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('public Live approval permits verified customers without either purchaser list or a Test approval', async () => {
  const response = await handleLiveBilling(request(), 'checkout', { ...env, CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED: 'true', CLUERA_LIVE_PURCHASER_IDS: '',
    SIGMAROUND_PAYMENT_TESTER_IDS: '', CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED: 'false' });
  expect(response.status).toBe(200); expect(mocks.status).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});
it('Live pending financial state remains a conflict and throttling retains its retry delay without clearing Auth',async()=>{
 const clear=vi.spyOn(AccountCookies.prototype,'clear'),approved={...env,CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED:'true'};
 mocks.status.mockRejectedValue(new ClueraBillingError('PENDING'));
 expect((await handleLiveBilling(request(),'checkout',approved)).status).toBe(409);
 mocks.limit.mockRejectedValue(new AccountError('RATE_LIMITED',429));
 const response=await handleLiveBilling(request(),'checkout',approved);
 expect(response.status).toBe(429);expect(response.headers.get('retry-after')).toBe('60');expect(clear).not.toHaveBeenCalled();
});
it.each(['GET', 'POST'])('account mismatch precedes Live eligibility for %s', async method => {
  const response = await handleLiveBilling(request('checkout', sid, method === 'POST' ? { requestId: sid, revisionId: sid } : undefined), 'checkout', env);
  expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  expect(mocks.status).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
it('recovery and expired sessions remain distinct', async () => {
  const get = vi.spyOn(AccountCookies.prototype, 'get').mockReturnValue(sid);
  const recovery = await handleLiveBilling(request(), 'checkout', env); expect(await recovery.json()).toMatchObject({ code: 'RECOVERY_SESSION' }); get.mockRestore();
  mocks.session.mockRejectedValue(new AccountError('UNAUTHENTICATED', 401));
  expect((await handleLiveBilling(request(), 'checkout', env)).status).toBe(401); expect(fetch).not.toHaveBeenCalled();
});
it('a sales pause blocks purchases but keeps authenticated history and cancellation observation available', async () => {
  const paused = { ...env, CLUERA_LIVE_CHECKOUT_ENABLED: 'false', CLUERA_LIVE_PUBLIC_CHECKOUT_APPROVED: 'true' };
  expect((await handleLiveBilling(request(), 'checkout', paused)).status).toBe(404);
  expect((await handleLiveBilling(request('history'), 'history', paused)).status).toBe(200);
  const cancel = new Request(request('cancellation').url + '&operationId=' + sid);
  expect((await handleLiveBilling(cancel, 'cancellation', paused)).status).toBe(200);
  expect(mocks.status).not.toHaveBeenCalled(); expect(mocks.history).toHaveBeenCalledOnce(); expect(mocks.cancellation).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
});
