import { z } from 'zod';
import {isPublishableKey} from '../supabase/publicKey';

export class AccountError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'RATE_LIMITED',
    readonly status: 400 | 401 | 403 | 429 | 503) { super(code); }
}
export function accountConfig(env = process.env) {
  if (env.SIGMAROUND_ACCOUNTS_ENABLED !== 'true') throw new AccountError('UNAVAILABLE', 503);
  const schema = z.object({
    SIGMAROUND_ACCOUNT_ORIGIN: z.url(), NEXT_PUBLIC_SUPABASE_URL: z.url(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20), SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
    SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64: z.string(), SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: z.string(),
  });
  const result = schema.safeParse(env);
  if (!result.success || !isPublishableKey(result.data.NEXT_PUBLIC_SUPABASE_ANON_KEY)) throw new AccountError('UNAVAILABLE', 503);
  const values = result.data;
  const origin = new URL(values.SIGMAROUND_ACCOUNT_ORIGIN);
  const supabase = new URL(values.NEXT_PUBLIC_SUPABASE_URL);
  const local = env.NODE_ENV !== 'production' && origin.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(origin.hostname);
  if ((!local && origin.protocol !== 'https:') || origin.origin !== values.SIGMAROUND_ACCOUNT_ORIGIN
    || origin.username || origin.password || supabase.protocol !== 'https:' || supabase.username || supabase.password
    || supabase.origin !== values.NEXT_PUBLIC_SUPABASE_URL || supabase.origin !== 'https://dwqltsqumiwsxtkzdoaa.supabase.co'
    || (!local && origin.origin !== 'https://cluera-ai-staging.vercel.app')) throw new AccountError('UNAVAILABLE', 503);
  const secret = (value: string) => {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new AccountError('UNAVAILABLE', 503);
    return bytes;
  };
  return { origin: origin.origin, secure: !local, url: supabase.origin, anonKey: values.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    serviceKey: values.SUPABASE_SERVICE_ROLE_KEY, cookieKey: secret(values.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64),
    rateKey: secret(values.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64) };
}
export type AccountConfig = ReturnType<typeof accountConfig>;
