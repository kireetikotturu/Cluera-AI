import {it,expect} from 'vitest';
import {checkoutFailureMessage} from '../lib/billing/checkout/failureMessage';
it('renders only fixed support categories, never reflects untrusted provider strings',()=>{
 for(const value of [null,undefined,'sensitive',{}, {stage:'http',providerCode:'sensitive'},
  {stage:'http',httpStatus:400,providerCode:{toString:()=>{throw Error('must not invoke');}}}])expect(checkoutFailureMessage(value)).toBe('');
 const examples=[{stage:'http',httpStatus:403,providerCode:'forbidden'}, {stage:'http',httpStatus:401},
  {stage:'http',httpStatus:400,providerCode:'invalid_field'},
  {stage:'http',httpStatus:400,providerCode:'transaction_default_checkout_url_not_set'}, {stage:'http',httpStatus:429}, {stage:'binding'}];
 for(const value of examples){const message=checkoutFailureMessage({...value,detail:'synthetic-private',providerRequestId:'synthetic-private'});
  expect(message).toContain('do not retry');expect(message).not.toContain('synthetic-private');}
});
it('shows the fixed validation category only for the documented HTTP 400, without reflecting field details',()=>{
 const value={stage:'http',httpStatus:400,providerCode:'invalid_field',detail:'synthetic-private',errors:[{field:'synthetic-private',value:'synthetic-private'}]};
 expect(checkoutFailureMessage(value)).toBe('[CHECKOUT_REQUEST_INVALID] The payment service rejected checkout preparation. Contact support; do not retry.');
 expect(checkoutFailureMessage({...value,httpStatus:403})).toBe('');
 expect(checkoutFailureMessage({...value,stage:'binding'})).not.toContain('CHECKOUT_REQUEST_INVALID');
});
