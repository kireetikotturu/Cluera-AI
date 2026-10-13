import { z } from 'zod';
import { PaddleBoundaryError, readSandboxResource } from './paddle';
import { paymentOffers } from '../payments/core/catalog';

// Owner-confirmed SANDBOX IDs only. Never reuse this mapping for live checkout.
// Amounts are integer INR paise; allowances are seconds, not client-supplied values.
const paddlePriceIds = { pro_3_hours: 'pri_01m42b4wbjta3q8r5rm9var416', pro_40_hours: 'pri_01m42ba17h2tavx8b1pfb6nx6g',
  enterprise_weekly: 'pri_01m42bmfpypv4n9n0zj0v0enhh', enterprise_monthly: 'pri_01m42bs6sg49s0764c9e718qcz' } as const;
export const sandboxOffers = Object.freeze(paymentOffers.map(offer => Object.freeze({ ...offer, priceId: paddlePriceIds[offer.code] })));
export type SandboxOffer = typeof sandboxOffers[number];

export function sandboxOffer(code: string, environment: string | undefined): SandboxOffer {
  if (environment !== 'sandbox') throw new PaddleBoundaryError();
  const offer = sandboxOffers.find(candidate => candidate.code === code);
  if (!offer) throw new PaddleBoundaryError();
  return offer;
}

const priceSchema = z.object({
  id: z.string(), status: z.literal('active'), type: z.literal('standard'),
  product_id: z.string().regex(/^pro_[a-z0-9]{26}$/),
  product: z.object({ id: z.string(), status: z.literal('active') }),
  unit_price: z.object({ amount: z.string().regex(/^\d+$/), currency_code: z.literal('INR') }),
  billing_cycle: z.object({ interval: z.enum(['week', 'month']), frequency: z.literal(1) }).nullable(),
  trial_period: z.null(), // Sigma's one-time 15-minute trial is not a Paddle recurring trial.
  unit_price_overrides: z.array(z.unknown()).max(0), // No unreviewed international/region pricing.
  quantity: z.object({ minimum: z.number().int().min(1).max(1), maximum: z.number().int().min(1) }),
});

/** Future checkout preflight: read-only and fail-closed, never grants an allowance. */
export async function verifySandboxOffer(code: string, env = process.env, request: typeof fetch = fetch): Promise<SandboxOffer> {
  return (await verifySandboxPrice(code,env,request)).offer;
}

/** The product binding is internal reconciliation evidence, never buyer input. */
export async function verifySandboxPrice(code:string,env=process.env,request:typeof fetch=fetch){
  const offer = sandboxOffer(code, env.PADDLE_ENVIRONMENT);
  try {
    const price = priceSchema.parse(await readSandboxResource('prices', offer.priceId, env, request));
    if (price.id !== offer.priceId || price.product.id !== price.product_id
      || price.unit_price.amount !== offer.amount
      || (price.billing_cycle?.interval ?? null) !== offer.interval) throw new PaddleBoundaryError();
    return {offer,productId:price.product_id}; // No raw provider/customer data.
  } catch { throw new PaddleBoundaryError(); }
}
