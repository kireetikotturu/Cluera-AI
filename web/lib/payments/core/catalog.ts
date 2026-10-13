/** Provider-independent approved policy. Gateway IDs are not plan rules. */
export const paymentOffers = Object.freeze([
  Object.freeze({ code: 'pro_3_hours', name: 'SigmaPro 3 Hours', tier: 'PRO', amount: '54900', currency: 'INR', seconds: 10800, interval: null, remote: false } as const),
  Object.freeze({ code: 'pro_40_hours', name: 'SigmaPro 40 Hours', tier: 'PRO', amount: '549900', currency: 'INR', seconds: 144000, interval: 'month', remote: false } as const),
  Object.freeze({ code: 'enterprise_weekly', name: 'SigmaEnterprise Weekly', tier: 'ENTERPRISE', amount: '549900', currency: 'INR', seconds: 108000, interval: 'week', remote: true } as const),
  Object.freeze({ code: 'enterprise_monthly', name: 'SigmaEnterprise Monthly', tier: 'ENTERPRISE', amount: '1954900', currency: 'INR', seconds: 720000, interval: 'month', remote: true } as const),
] as const);
export type PaymentOffer = typeof paymentOffers[number];
export type OfferCode = PaymentOffer['code'];
export function paymentOffer(code: string): PaymentOffer {
  const offer = paymentOffers.find(value => value.code === code);
  if (!offer) throw new Error('Unsupported payment offer.');
  return offer;
}
