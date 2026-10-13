import { PaddleBoundaryError } from '../paddle';

const stages = ['configuration', 'request', 'http', 'body', 'schema', 'binding'] as const;
type Stage = typeof stages[number];
const codes = new Set([
  'forbidden', 'invalid_token', 'bad_request', 'invalid_field', 'validation_error', 'too_many_requests',
  'transaction_creation_blocked', 'transaction_checkout_not_enabled',
  'transaction_default_checkout_url_not_set', 'transaction_checkout_url_domain_is_not_approved',
]);

/** Fixed categories only. Never retain Paddle detail/errors, URLs or response bodies. */
export class CheckoutTransportError extends PaddleBoundaryError {
  readonly stage: Stage;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly providerRequestId?: string;
  constructor(stage: Stage, status?: number, code?: unknown, requestId?: unknown) {
    super();
    this.stage = stages.includes(stage) ? stage : 'request';
    this.httpStatus = Number.isInteger(status) && status! >= 100 && status! <= 599 ? status : undefined;
    this.providerCode = typeof code === 'string' && codes.has(code) ? code : undefined;
    // Paddle support correlation only; never accept arbitrary strings or headers.
    this.providerRequestId = typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId) ? requestId : undefined;
  }
}

export function checkoutFailureDetails(error: unknown) {
  // Reconstruct even typed fields: do not trust mutated errors or injected dependencies.
  const safe = error instanceof CheckoutTransportError
    ? new CheckoutTransportError(error.stage, error.httpStatus, error.providerCode, error.providerRequestId)
    : new CheckoutTransportError('request');
  return {
    stage: safe.stage,
    ...(safe.httpStatus === undefined ? {} : { httpStatus: safe.httpStatus }),
    ...(safe.providerCode ? { providerCode: safe.providerCode } : {}),
    ...(safe.providerRequestId ? { providerRequestId: safe.providerRequestId } : {}),
  };
}

export function logCheckoutFailure(error: unknown): void {
  console.error('[billing-checkout] create unresolved', checkoutFailureDetails(error));
}
