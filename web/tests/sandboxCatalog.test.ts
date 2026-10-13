import { describe, expect, it, vi } from 'vitest';
import { sandboxOffer, sandboxOffers, verifySandboxOffer } from '../lib/billing/sandboxCatalog';
const env = { PADDLE_ENVIRONMENT: 'sandbox', PADDLE_API_KEY: 'synthetic-catalog-fixture-only' };
const productId = 'pro_' + 'a'.repeat(26);
function price(index = 0) {
  const offer = sandboxOffers[index];
  return { id: offer.priceId, status: 'active', type: 'standard', product_id: productId,
    product: { id: productId, status: 'active' }, unit_price: { amount: offer.amount, currency_code: 'INR' },
    billing_cycle: offer.interval ? { interval: offer.interval, frequency: 1 } : null,
    trial_period: null, unit_price_overrides: [], quantity: { minimum: 1, maximum: 99 },
    custom_data: { untrusted: 'do-not-forward' } };
}
describe('owner-approved sandbox catalog', () => {
  it('contains exactly the four confirmed IDs and excludes Pro 100', () => {
    expect(sandboxOffers.map(offer => offer.priceId)).toEqual([
      'pri_01m42b4wbjta3q8r5rm9var416', 'pri_01m42ba17h2tavx8b1pfb6nx6g',
      'pri_01m42bmfpypv4n9n0zj0v0enhh', 'pri_01m42bs6sg49s0764c9e718qcz',
    ]);
    expect(sandboxOffers.map(offer => offer.seconds)).toEqual([10800, 144000, 108000, 720000]);
    expect(sandboxOffers.map(offer => offer.remote)).toEqual([false, false, true, true]);
    expect(() => sandboxOffer('pro_100_hours', 'sandbox')).toThrow();
    expect(Object.isFrozen(sandboxOffers)).toBe(true);
    expect(sandboxOffers.every(Object.isFrozen)).toBe(true);
  });
  it('never resolves sandbox IDs for live mode or arbitrary codes/price IDs', async () => {
    const request = vi.fn();
    for (const environment of [undefined, 'live', 'production']) {
      expect(() => sandboxOffer('pro_3_hours', environment)).toThrow();
    }
    for (const code of ['../customers', sandboxOffers[0].priceId, 'pro_100_hours']) {
      await expect(verifySandboxOffer(code, env, request)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('checks active price/product, INR amount, cycle and no Paddle trial using bounded read-only requests', async () => {
    for (let index = 0; index < sandboxOffers.length; index++) {
      const request = vi.fn(async () => Response.json({ data: price(index) }));
      const result = await verifySandboxOffer(sandboxOffers[index].code, env, request);
      expect(result).toEqual(sandboxOffers[index]);
      expect(request).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledWith(`https://sandbox-api.paddle.com/prices/${result.priceId}?include=product`,
        expect.objectContaining({ redirect: 'error', cache: 'no-store' }));
      expect(JSON.stringify(result)).not.toContain('do-not-forward');
    }
  });
  it('fails closed on mismatched/archived/unknown pricing and unsafe defaults', async () => {
    for (const change of [{ id: 'pri_' + 'b'.repeat(26) }, { status: 'archived' }, { type: 'custom' },
      { product: { id: productId, status: 'archived' } }, { product: { id: 'wrong', status: 'active' } },
      { unit_price: { amount: '1', currency_code: 'INR' } }, { unit_price: { amount: '54900', currency_code: 'USD' } },
      { billing_cycle: { interval: 'month', frequency: 1 } }, { trial_period: { interval: 'day', frequency: 7 } },
      { quantity: { minimum: 2, maximum: 10 } }, { unit_price_overrides: [{}] }]) {
      await expect(verifySandboxOffer('pro_3_hours', env, async () => Response.json({ data: { ...price(), ...change } }))).rejects.toThrow('Paddle sandbox request could not be verified.');
    }
    await expect(verifySandboxOffer('pro_40_hours', env, async () => Response.json({ data: { ...price(1),
      billing_cycle: { interval: 'month', frequency: 12 } } }))).rejects.toThrow();
  });
  it('does not fall back to unchecked prices when product-inclusive access is forbidden', async () => {
    const request = vi.fn(async () => Response.json({ error: {
      code: 'forbidden', detail: 'synthetic-private-provider-error',
    } }, { status: 403 }));
    await expect(verifySandboxOffer('pro_3_hours', env, request))
      .rejects.toThrow('Paddle sandbox request could not be verified.');
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith(`https://sandbox-api.paddle.com/prices/${sandboxOffers[0].priceId}?include=product`, expect.any(Object));
  });
});
