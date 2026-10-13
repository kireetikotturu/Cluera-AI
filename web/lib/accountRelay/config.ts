export const STAGING_DATABASE = 'https://dwqltsqumiwsxtkzdoaa.supabase.co';
export const STAGING_SITE = 'https://cluera-ai-staging.vercel.app';

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
  const port = Number(env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail();
  return { port, database: STAGING_DATABASE, site: STAGING_SITE, rateKey,
    serviceKey: secret('SUPABASE_SERVICE_ROLE_KEY'),
    geminiKey: secret('SIGMAROUND_MANAGED_GEMINI_API_KEY'),
    deepgramKey: secret('SIGMAROUND_MANAGED_DEEPGRAM_API_KEY'),
  };
}
export type RelayConfig = ReturnType<typeof relayConfig>;
