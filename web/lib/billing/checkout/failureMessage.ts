/** Browser-safe fixed text. Never render provider bodies, details or arbitrary codes. */
export function checkoutFailureMessage(value:unknown):string {
  if(!value||typeof value!=='object')return '';
  const failure=value as {stage?:unknown;httpStatus?:unknown;providerCode?:unknown};
  if(failure.stage==='http'&&failure.httpStatus===403&&failure.providerCode==='forbidden')
    return '[CHECKOUT_PERMISSION_DENIED] Paddle did not allow checkout preparation. Contact support; do not retry.';
  if(failure.stage==='http'&&failure.httpStatus===401)
    return '[CHECKOUT_PROVIDER_AUTH] The payment service could not authenticate. Contact support; do not retry.';
  if(failure.stage==='http'&&failure.httpStatus===400&&failure.providerCode==='invalid_field')
    return '[CHECKOUT_REQUEST_INVALID] The payment service rejected checkout preparation. Contact support; do not retry.';
  if(failure.stage==='http'&&typeof failure.providerCode==='string'&&['transaction_checkout_not_enabled','transaction_default_checkout_url_not_set',
    'transaction_checkout_url_domain_is_not_approved'].includes(failure.providerCode))
    return '[CHECKOUT_PROVIDER_CONFIGURATION] The payment service needs operator configuration. Contact support; do not retry.';
  if(failure.stage==='http'&&failure.httpStatus===429)
    return '[CHECKOUT_PROVIDER_LIMIT] The payment service is temporarily limited. This attempt still needs verification; do not retry.';
  if(failure.stage==='schema'||failure.stage==='binding')
    return '[CHECKOUT_RESPONSE_UNVERIFIED] The server could not verify the payment-service response. Contact support; do not retry.';
  return '';
}
