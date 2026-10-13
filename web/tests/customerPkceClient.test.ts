import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountClients } from '../lib/accounts/clients';
import type { AccountConfig } from '../lib/accounts/config';
const config: AccountConfig = { origin: 'https://accounts.example.invalid', secure: true, url: 'https://example.supabase.co',
  anonKey: 'public-synthetic-placeholder', serviceKey: 'private-synthetic-placeholder', cookieKey: Buffer.alloc(32), rateKey: Buffer.alloc(32, 1) };
afterEach(() => vi.unstubAllGlobals());
describe('installed Supabase PKCE storage integration', () => {
  it('exports verifier slots only, uses S256 and exchanges against the same stored flow', async () => {
    const first = accountClients(config);
    const started = await first.auth.auth.signInWithOAuth({ provider: 'google', options: {
      redirectTo: `${config.origin}/api/account/callback`, skipBrowserRedirect: true,
    } });
    expect(started.error).toBeNull();
    const url = new URL(started.data.url!);
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    const redirect = new URL(url.searchParams.get('redirect_to')!);
    const flowId = redirect.searchParams.get('sb_flow_id');
    expect(redirect.origin + redirect.pathname).toBe(`${config.origin}/api/account/callback`);
    const stored = first.flow(); expect(Object.keys(stored).every(key => key.endsWith('code-verifier'))).toBe(true);
    const verifier = JSON.parse(stored[flowId ? `sr-account-flow-${flowId}-code-verifier` : 'sr-account-code-verifier']);
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'uid', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toMatchObject({ auth_code: 'fixture-code', code_verifier: verifier });
      return Response.json({ access_token: token, refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'bearer', user: { id: 'uid' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const second = accountClients(config, stored);
    const result = await second.auth.auth.exchangeCodeForSession('fixture-code', flowId ? { flowId } : undefined);
    expect(result.error).toBeNull(); expect(result.data.session?.refresh_token).toBe('fixture-refresh');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second.flow())).not.toContain('fixture-refresh');
    expect(JSON.stringify(second.flow())).not.toContain(token);
  });
});
