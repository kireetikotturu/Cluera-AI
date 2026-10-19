import {CLUERA_SUPABASE_URL,CLUERA_SITE_ORIGIN} from '../supabase/target';
export const STAGING_DATABASE = CLUERA_SUPABASE_URL;
export const STAGING_SITE = CLUERA_SITE_ORIGIN;
import {vaultKeyring} from '../aiProviders/vault';

/** Server process only; explicit staging gate. Never imported by a client page. */
export function relayConfig(env = process.env) {
  const fail = () => { throw new Error('Account relay configuration unavailable.'); };
  if (env.SIGMAROUND_ACCOUNT_RELAY_ENABLED !== 'true' || env.SIGMAROUND_ACCOUNTS_ENABLED !== 'true'
    || env.NEXT_PUBLIC_SUPABASE_URL !== STAGING_DATABASE || env.SIGMAROUND_ACCOUNT_ORIGIN !== STAGING_SITE) fail();
  const secret = (name: string) => {
    const value = env[name];
    if (!value || value.length < 20 || value.length > 4096 || /[\r\n]/.test(value)) return fail();
    return value;
  };
  const rateKey = secret('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64');
  if (Buffer.from(rateKey, 'base64').length !== 32 || Buffer.from(rateKey, 'base64').toString('base64') !== rateKey) fail();
  const serviceKey=secret('SUPABASE_SERVICE_ROLE_KEY');
  if(!/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(serviceKey))fail();
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  const providerMode=env.CLUERA_AI_BOOTSTRAP_MODE??'legacy-environment';
  if(!['legacy-environment','auth-only','admin-vault'].includes(providerMode))fail();
  if(providerMode==='admin-vault')vaultKeyring(env);
  if(env.CLUERA_PROVIDER_TELEMETRY_ENABLED!==undefined&&!['true','false'].includes(env.CLUERA_PROVIDER_TELEMETRY_ENABLED))fail();
  if(env.CLUERA_PROVIDER_TELEMETRY_ENABLED==='true'&&providerMode!=='admin-vault')fail();
  // Explicit auth-only bootstrap still requires EVERY infrastructure guard.
  // No fabricated provider key or automatic legacy credential migration.
  return { port, database: STAGING_DATABASE, site: STAGING_SITE, rateKey,
    serviceKey,
    providerMode,
    geminiKey: providerMode==='legacy-environment'?secret('SIGMAROUND_MANAGED_GEMINI_API_KEY'):undefined,
    deepgramKey: providerMode==='legacy-environment'?secret('SIGMAROUND_MANAGED_DEEPGRAM_API_KEY'):undefined,
  };
}
export type RelayConfig = ReturnType<typeof relayConfig>;
