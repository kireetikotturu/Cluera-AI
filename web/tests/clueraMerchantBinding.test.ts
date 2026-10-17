import { expect, it, vi } from 'vitest';
import { billingOwner, merchantDigest } from '../lib/payments/cluera/config';
import { paymentTestEnvironment } from './helpers/paymentTestMode';

const env = { ...paymentTestEnvironment, CLUERA_BILLING_V2_ENABLED: 'true' };
const active = { code: 'ACTIVE', owner: 'cluera', epoch: 7 };
function replies(...results: unknown[]) {
  const first = results.length > 0 ? results[0] : active;
  const second = results.length > 1 ? results[1] : { code: 'CONFLICT' };
  return vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: null as unknown, error: null as unknown }))
    .mockResolvedValueOnce({ data: first, error: null }).mockResolvedValueOnce({ data: second, error: null });
}
it('proves exact configured merchant binding with two read-only owner RPCs and one fixed valid foreign digest', async () => {
  const rpc = replies(), digest = merchantDigest(env);
  expect(await billingOwner(rpc, env)).toEqual({ epoch: 7, accountDigest: digest });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[0]).toEqual(['cluera_billing_owner', { p_account_digest: digest }]);
  const foreign = String(rpc.mock.calls[1][1].p_account_digest);
  expect(foreign).toMatch(/^[a-f0-9]{64}$/); expect(foreign).not.toBe(digest);
  expect(Number.parseInt(foreign[0], 16) ^ Number.parseInt(digest[0], 16)).toBe(1);
  expect(foreign.slice(1)).toBe(digest.slice(1)); expect(rpc.mock.calls[1][0]).toBe('cluera_billing_owner');
  const repeat = replies(); await billingOwner(repeat, env); expect(repeat.mock.calls).toEqual(rpc.mock.calls);
});
it('rejects the clean NULL-merchant behavior that reports ACTIVE for both distinct valid digests', async () => {
  const rpc = replies(active, active);
  await expect(billingOwner(rpc, env)).rejects.toMatchObject({ code: 'CONFIGURATION' });
  expect(rpc).toHaveBeenCalledTimes(2); expect(rpc.mock.calls.every(([name]) => name === 'cluera_billing_owner')).toBe(true);
});
it('rejects a foreign pinned merchant before a second read', async () => {
  const rpc = replies({ code: 'CONFLICT' });
  await expect(billingOwner(rpc, env)).rejects.toMatchObject({ code: 'CONFIGURATION' }); expect(rpc).toHaveBeenCalledTimes(1);
});
it.each([undefined, null, {}, [], { owner: 'cluera', epoch: 7 },
  { code: 'ACTIVE', owner: 'account', epoch: 7 }, { code: 'PENDING', owner: 'cluera', epoch: 7 },
  { ...active, epoch: 0 }, { ...active, epoch: -1 }, { ...active, epoch: 1.5 },
  { ...active, epoch: '7' }, { ...active, epoch: Number.MAX_SAFE_INTEGER + 1 },
  { ...active, epoch: Number.NaN }, { ...active, epoch: Number.POSITIVE_INFINITY },
  { ...active, accountDigest: 'unexpected' }, { ...active, code: 'active' }])
('rejects noncanonical positive owner response before the foreign read: %j', async result => {
  const rpc = replies(result); await expect(billingOwner(rpc, env)).rejects.toMatchObject({ code: 'CONFIGURATION' }); expect(rpc).toHaveBeenCalledTimes(1);
});
it.each([undefined, null, {}, [], active, { code: 'PENDING' }, { code: 'conflict' },
  { code: 'CONFLICT', epoch: 7 }, { code: 'CONFLICT', owner: 'cluera' }])
('requires exact CONFLICT, not a permissive or ambiguous negative response: %j', async result => {
  const rpc = replies(active, result); await expect(billingOwner(rpc, env)).rejects.toMatchObject({ code: 'CONFIGURATION' }); expect(rpc).toHaveBeenCalledTimes(2);
});
it.each([1, Number.MAX_SAFE_INTEGER])('accepts only the supported safe-integer epoch range (%s)', async epoch => {
  expect(await billingOwner(replies({ ...active, epoch }), env)).toEqual({ epoch, accountDigest: merchantDigest(env) });
});
it.each([1, 2])('fails unavailable on RPC error at read %s without retry or any other RPC', async failedRead => {
  const rpc = replies();
  rpc.mockReset().mockResolvedValueOnce(failedRead === 1 ? { data: null, error: { message: 'SYNTHETIC_PRIVATE' } } : { data: active, error: null });
  if (failedRead === 2) rpc.mockResolvedValueOnce({ data: null, error: { message: 'SYNTHETIC_PRIVATE' } });
  await expect(billingOwner(rpc, env)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Billing verification is unavailable.' });
  expect(rpc).toHaveBeenCalledTimes(failedRead); expect(rpc.mock.calls.every(([name]) => name === 'cluera_billing_owner')).toBe(true);
});
it('does not perform either owner read while V2 is disabled or the exact Test target is invalid', async () => {
  const rpc = replies();
  await expect(billingOwner(rpc, { ...env, CLUERA_BILLING_V2_ENABLED: 'false' })).rejects.toThrow();
  await expect(billingOwner(rpc, { ...env, NEXT_PUBLIC_SUPABASE_URL: 'https://foreign.supabase.co' })).rejects.toThrow(); expect(rpc).not.toHaveBeenCalled();
});
