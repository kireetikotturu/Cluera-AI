/** Client-safe fixed messages. Never display arbitrary API/SQL/error text. */
export function adminReadError(status: number): string {
  switch (status) {
    case 401: return '[ADMIN_SIGN_IN_REQUIRED] Your session ended. Sign in again, then complete authenticator verification.';
    case 403: return '[ADMIN_ACCESS_DENIED] This session is not allowed to read account administration. Use the assigned administrator and verified MFA session.';
    case 400: return '[ADMIN_QUERY_INVALID] Use an exact email or account UUID, or refresh the account list.';
    case 429: return '[ADMIN_RATE_LIMITED] Too many requests. Wait before refreshing account administration.';
    default: return '[ADMIN_SERVICE_UNAVAILABLE] Verified account details are temporarily unavailable. No change was made; refresh later.';
  }
}
