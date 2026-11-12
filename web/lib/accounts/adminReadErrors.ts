/** Client-safe fixed messages. Never display arbitrary API/SQL/error text. Each says what to do next, in plain English;
 * the bracketed code is only for support. */
export function adminReadError(status: number): string {
  switch (status) {
    case 401: return '[ADMIN_SIGN_IN_REQUIRED] Your sign-in ended. Sign in again, then enter the 6-digit code from your authenticator app.';
    case 403: return '[ADMIN_ACCESS_DENIED] This sign-in cannot open Admin. Use the Admin account and finish the authenticator step.';
    case 400: return '[ADMIN_QUERY_INVALID] Type a customer\'s exact email or account ID, or press "All recent accounts".';
    case 429: return '[ADMIN_RATE_LIMITED] Too many requests. Wait a minute, then press Refresh.';
    default: return '[ADMIN_SERVICE_UNAVAILABLE] Admin details are not available right now. Nothing was changed. Wait a minute, then press Refresh.';
  }
}
