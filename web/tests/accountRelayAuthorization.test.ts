import { beforeEach, describe, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ getUser: vi.fn(), rpc: vi.fn(), createClient: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: fake.createClient }));
import { authorizeRelay } from '../lib/accountRelay/authorization';
import { STAGING_DATABASE, STAGING_SITE } from '../lib/accountRelay/config';
const user = '00000000-0000-4000-8000-000000000801', session = '00000000-0000-4000-8000-000000000802';
const config = { port: 8080, database: STAGING_DATABASE, site: STAGING_SITE,
  serviceKey: 'synthetic-service-only', geminiKey: 'synthetic-gemini-only', deepgramKey: 'synthetic-deepgram-only',
  rateKey: Buffer.alloc(32, 7).toString('base64') };
const env = { SIGMAROUND_ACCOUNTS_ENABLED: 'true', SIGMAROUND_ACCOUNT_ORIGIN: STAGING_SITE, NEXT_PUBLIC_SUPABASE_URL: STAGING_DATABASE };
const token = (claims = {}) => `synthetic.${Buffer.from(JSON.stringify({ sub: user, session_id: session,
  exp: Math.floor(Date.now() / 1000) + 3600, ...claims })).toString('base64url')}.synthetic`;
beforeEach(() => {
  vi.resetAllMocks(); fake.createClient.mockReturnValue({ auth: { getUser: fake.getUser }, rpc: fake.rpc });
  fake.getUser.mockResolvedValue({ data: { user: { id: user, email: 'synthetic@example.invalid', email_confirmed_at: '2026-10-04', is_anonymous: false } }, error: null });
  fake.rpc.mockImplementation(async name => ({ data: name === 'customer_authorize' ? { code: 'ACTIVE', userId: user } : true, error: null }));
});
describe('native account relay authorization', () => {
  it('verifies Auth, then live session/account, then bounded account rate; no raw token/provider key in result', async () => {
    const access = token(); const result = await authorizeRelay(access, config, env);
    expect(fake.getUser).toHaveBeenCalledWith(access);
    expect(fake.rpc.mock.calls[0]).toEqual(['customer_authorize', { p_user_id: user, p_session_id: session }]);
    expect(fake.rpc.mock.calls[1][0]).toBe('customer_auth_rate_limit');
    expect(fake.rpc.mock.calls[1][1].p_bucket_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(fake.rpc.mock.calls[1][1].p_maximum).toBe(30);
    expect(Object.keys(result).sort()).toEqual(['createRun', 'remainingTokenMs']);
    expect(fake.rpc).toHaveBeenCalledTimes(2); // no trial spending on authentication
    expect(fake.createClient.mock.calls[0][2].auth).toMatchObject({ persistSession: false, autoRefreshToken: false });
  });
  it.each(['SUSPENDED', 'UNAUTHENTICATED'])('rejects %s even with a JWT accepted by Auth', async code => {
    fake.rpc.mockResolvedValue({ data: { code }, error: null });
    await expect(authorizeRelay(token(), config, env)).rejects.toThrow(); expect(fake.rpc).toHaveBeenCalledOnce();
  });
  it('rejects anonymous/unverified users, mismatched sub and expired access tokens', async () => {
    await expect(authorizeRelay(token({ sub: session }), config, env)).rejects.toThrow(); expect(fake.rpc).not.toHaveBeenCalled();
    await expect(authorizeRelay(token({ exp: 1 }), config, env)).rejects.toThrow();
    fake.getUser.mockResolvedValue({ data: { user: { id: user, email: 'synthetic@example.invalid', email_confirmed_at: null } }, error: null });
    fake.rpc.mockClear(); await expect(authorizeRelay(token(), config, env)).rejects.toThrow(); expect(fake.rpc).not.toHaveBeenCalled();
  });
  it('rejects bad staging config before any Auth or ledger calls', async () => {
    await expect(authorizeRelay(token(), { ...config, database: 'https://bzccuqforilpifhiysjk.supabase.co' }, env)).rejects.toThrow();
    expect(fake.createClient).not.toHaveBeenCalled();
    await expect(authorizeRelay(token(), config, {})).rejects.toThrow(); expect(fake.getUser).not.toHaveBeenCalled();
  });
  it('denies distributed rate exhaustion and does not retry a grant with an unknown outcome', async () => {
    fake.rpc.mockResolvedValueOnce({ data: { code: 'ACTIVE', userId: user }, error: null }).mockResolvedValueOnce({ data: false, error: null });
    await expect(authorizeRelay(token(), config, env)).rejects.toThrow(); expect(fake.rpc).toHaveBeenCalledTimes(2);
  });
});
