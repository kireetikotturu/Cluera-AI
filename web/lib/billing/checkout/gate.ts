import {assertCheckoutStaging} from './service';

/** Private explicit opt-in; a configured client token alone never opens checkout. */
export function sandboxCheckoutEnabled(env=process.env):boolean{
  try{assertCheckoutStaging(env);}catch{return false;}
  return env.CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED==='true' && env.SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED==='true'
    // The unresolved sandbox outcome must remain paused until a separately
    // authorized recovery. Missing configuration fails closed, not open.
    &&env.SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED==='false'
    &&sandboxTesters(env).length>0
    &&/^test_[A-Za-z0-9]{16,128}$/.test(env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN??'');
}

/** Temporary Sandbox operator safety control, NOT customer identity or an
 * administrator approval workflow. Future live checkout must not use this
 * staging allowlist. The verified session supplies the purchasing account.
 * Private UUID allowlist, never email/user_metadata/query input. Any malformed
 * configuration fails closed. No wildcard or automatic administrator exemption. */
function sandboxTesters(env:NodeJS.ProcessEnv):string[]{
  const value=env.SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS??'';
  if(!value||value.length>4096)return [];
  const ids=value.split(',').map(id=>id.trim());
  if(ids.length>50||ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)))return [];
  return [...new Set(ids)];
}
export function sandboxCheckoutAllowed(userId:string,env=process.env):boolean{
  return sandboxCheckoutEnabled(env)&&sandboxTesters(env).includes(userId);
}
