/** Public reason codes contain no customer, merchant or provider identifiers. */
export type CheckoutDenial = 'SIGNED_OUT' | 'ACCOUNT_MISMATCH' | 'RECOVERY_SESSION' | 'TEST_PURCHASER_REQUIRED' | 'LIVE_PURCHASER_REQUIRED' | 'FORBIDDEN';

export function checkoutDenial(status: number, body: unknown): CheckoutDenial | null {
  if (status === 401) return 'SIGNED_OUT';
  if (status !== 403) return null;
  const code = body && typeof body === 'object' && 'code' in body ? body.code : null;
  return code === 'ACCOUNT_MISMATCH' || code === 'RECOVERY_SESSION' || code === 'TEST_PURCHASER_REQUIRED' || code === 'LIVE_PURCHASER_REQUIRED' ? code : 'FORBIDDEN';
}

export const checkoutDenialMessage: Record<CheckoutDenial, string> = {
  SIGNED_OUT: 'Your session has ended. Sign in to continue checkout.',
  ACCOUNT_MISMATCH: 'The signed-in account does not match this checkout. Return to your account and open checkout again. For a desktop purchase, use the same account in Windows and your browser.',
  RECOVERY_SESSION: 'Finish resetting your password, then sign in normally before buying time.',
  TEST_PURCHASER_REQUIRED: 'You are signed in. Test checkout is currently limited to the approved Test purchaser. This account cannot buy yet. Your existing balance is unchanged. Use the approved account or contact Cluera support.',
  LIVE_PURCHASER_REQUIRED: 'You are signed in. Purchases are currently limited to approved launch testers. Public sales are not open yet. Your existing balance is unchanged. Contact Cluera support.',
  FORBIDDEN: 'Checkout access was denied. Return to your account or contact Cluera support. Do not repeat a payment.',
};

export function checkoutFailureMessage(status: number, body?: unknown): string {
  if(status===409 && body && typeof body==='object' && 'code' in body && body.code==='ORDER_RECONCILIATION_REQUIRED')
    return 'This order already has a payment attempt. It cannot be continued automatically. Check billing status or contact Cluera support before making another payment.';
  if (status === 404) return 'Checkout is not enabled for this deployment. Your sign-in is unchanged. Contact Cluera support.';
  if (status === 409) return 'An existing payment or order needs verification. Refresh billing status; do not create another attempt.';
  if (status === 429) return 'Too many billing requests. Wait before refreshing status. Do not retry a payment.';
  return 'Payment verification or configuration is unavailable. Your sign-in is unchanged. Refresh status only; do not retry a payment.';
}
