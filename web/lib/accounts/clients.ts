import { createClient } from '@supabase/supabase-js';
import type { AccountConfig } from './config';

// Per-request clients only. Never share a logged-in Auth client across customers.
export function accountClients(config: AccountConfig, storedFlow: Record<string, string> = {}) {
  const flow = new Map(Object.entries(storedFlow));
  const storage = {
    getItem: (key: string) => flow.get(key) ?? null,
    setItem: (key: string, value: string) => { flow.set(key, value); },
    removeItem: (key: string) => { flow.delete(key); },
  };
  const boundedFetch: typeof fetch = (input, init) => fetch(input, { ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
  const auth = createClient(config.url, config.anonKey, { global: { fetch: boundedFetch }, auth: {
      flowType: 'pkce', storageKey: 'sr-account', storage, persistSession: true,
      autoRefreshToken: false, detectSessionInUrl: false, debug: false,
    } });
  let recovery = false;
  auth.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') recovery = true; });
  return {
    auth,
    recovery: () => recovery,
    service: createClient(config.url, config.serviceKey, { global: { fetch: boundedFetch }, auth: {
      persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, debug: false,
    } }),
    flow: () => Object.fromEntries([...flow].filter(([key]) => key.endsWith('code-verifier'))),
  };
}
