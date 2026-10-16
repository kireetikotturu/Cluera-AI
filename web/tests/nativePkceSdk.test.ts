import { afterEach, expect, it, vi } from 'vitest';
import { accountClients } from '../lib/accounts/clients';
import type { AccountConfig } from '../lib/accounts/config';

afterEach(() => vi.unstubAllGlobals());
it('the real Supabase SDK exchanges the exact main-owned PKCE verifier and retains opaque refresh credentials', async () => {
  const userId = '00000000-0000-4000-8000-000000000001';
  const verifier = 'v'.repeat(64), code = 'synthetic-one-use-code';
  const jwt = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({sub:userId,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.c3ludGhldGlj`;
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://yhnqlfcgrmckhyjdxegg.supabase.co/auth/v1/token?grant_type=pkce');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({auth_code:code,code_verifier:verifier});
    return new Response(JSON.stringify({access_token:jwt,refresh_token:'abcdefghijkl',expires_in:3600,
      token_type:'bearer',user:{id:userId,aud:'authenticated',email:'sdk@example.invalid',email_confirmed_at:'2026-10-09T00:00:00Z'}}),
      {headers:{'content-type':'application/json'}});
  });
  vi.stubGlobal('fetch', request);
  const config = {url:'https://yhnqlfcgrmckhyjdxegg.supabase.co',anonKey:'synthetic-public-key',serviceKey:'sb_secret_synthetic-service-placeholder'} as AccountConfig;
  const clients = accountClients(config, {'cluera-auth-yhnqlfcgrmckhyjdxegg-v1-code-verifier':JSON.stringify(verifier)});
  const result = await clients.auth.auth.exchangeCodeForSession(code);
  expect(result.error).toBeNull();expect(result.data.session?.refresh_token).toBe('abcdefghijkl');
  expect(result.data.session?.user.id).toBe(userId);
  expect(clients.flow()).toEqual({});expect(request).toHaveBeenCalledOnce();
});
