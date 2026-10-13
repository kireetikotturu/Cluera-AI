import { z } from 'zod';
import { paymentOffer, type OfferCode } from '../core/catalog';
import { PaymentError } from '../core/types';

/** Phase-two capability constraints, not a claim that a merchant/method is enabled.
 * No auth/mandate/setup charge constitutes a paid entitlement or a renewal. */
export function recurringMethodPolicy(code: OfferCode, method: 'card' | 'upi' | 'emandate', network?: string) {
  const offer = paymentOffer(code);
  if (!offer.interval) throw new PaymentError('UNSUPPORTED');
  const highValue = Number(offer.amount) >= 1500000;
  return { provider: 'razorpay' as const, environment: 'test' as const,
    supportedByPolicy: !(method === 'upi' && highValue) && !(method === 'card' && network === 'RuPay' && highValue),
    requiresMandate: true, requiresMerchantEnablement: true, requiresPerDebitAuthentication: method === 'card' && highValue,
    customerPausedUpiCanBeResumedByMerchant: false, operational: false };
}
/** Verify a separately owner-provisioned Test plan; never invent/mutate plan IDs. */
export function verifyRecurringPlan(code: OfferCode, expectedId: string, raw: unknown) {
  const offer = paymentOffer(code);
  if (!offer.interval || !/^plan_[A-Za-z0-9]{8,64}$/.test(expectedId)) throw new PaymentError('UNSUPPORTED');
  const plan = z.object({ id: z.literal(expectedId), entity: z.literal('plan'), period: z.enum(['weekly','monthly']), interval: z.literal(1),
    item: z.object({ amount: z.number().int(), currency: z.literal('INR'), active: z.literal(true) }) }).parse(raw);
  if (plan.period !== (offer.interval === 'week' ? 'weekly' : 'monthly') || plan.item.amount !== Number(offer.amount)) throw new PaymentError('INVALID');
  return { offerCode: offer.code, planId: plan.id, amount: plan.item.amount, currency: 'INR' as const,
    allowanceMilliseconds: offer.seconds * 1000, interval: offer.interval };
}
/** Merchant/API lifecycle states normalized without granting money/time. Paid
 * invoices + captured payments must be independently bound before any term. */
export function subscriptionState(state: string): 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'PAUSED' | 'PENDING' {
  return ({active:'ACTIVE',pending:'PAST_DUE',halted:'PAST_DUE',paused:'PAUSED',cancelled:'CANCELED',completed:'CANCELED',expired:'CANCELED'} as const)[state] ?? 'PENDING';
}
