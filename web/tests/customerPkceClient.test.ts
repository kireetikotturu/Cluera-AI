import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountClients } from '../lib/accounts/clients';
import type { AccountConfig } from '../lib/accounts/config';
const config: AccountConfig = { origin: 'https://accounts.example.invalid', secure: true, url: 'https://example.supabase.co',
  anonKey: 'public-synthetic-placeholder', serviceKey: 'private-synthetic-placeholder', cookieKey: Buffer.alloc(32), rateKey: Buffer.alloc(32, 1) };
afterEach(() => vi.unstubAllGlobals());
describe('installed Supabase PKCE storage integration', () => {
  it('resend creates a fresh S256 verifier and callback exchange uses only the new sealed flow',async()=>{
    const first=accountClients(config);await first.auth.auth.signInWithOAuth({provider:'google',options:{redirectTo:config.origin+'/api/account/callback',skipBrowserRedirect:true}});
    const old=first.flow();const resend=accountClients(config);let requestBody:any,callback:URL;
    vi.stubGlobal('fetch',vi.fn(async(input:any,init?:RequestInit)=>{const url=new URL(String(input));expect(url.origin).toBe(config.url);expect(url.pathname).toBe('/auth/v1/resend');
      expect(init?.signal).toBeInstanceOf(AbortSignal);requestBody=JSON.parse(init!.body as string);callback=new URL(url.searchParams.get('redirect_to')!);return Response.json({});}));
    const sent=await resend.auth.auth.resend({type:'signup',email:'fixture@example.invalid',options:{emailRedirectTo:config.origin+'/api/account/callback'}});expect(sent.error).toBeNull();expect(requestBody).toMatchObject({type:'signup',email:'fixture@example.invalid',code_challenge_method:'s256'});
    const fresh=resend.flow();expect(fresh).not.toEqual(old);expect(callback!.origin+callback!.pathname).toBe(config.origin+'/api/account/callback');
    // Redirect flow IDs are opt-in in the installed SDK. Keep the exact
    // allowlisted callback unchanged; prove the freshly sealed ring/alias
    // instead of requiring an experimental query parameter.
    expect(callback!.searchParams.get('sb_flow_id')).toBeNull();
    const ring=JSON.parse(fresh['cluera-auth-yhnqlfcgrmckhyjdxegg-v1-flows-code-verifier']);expect(ring).toHaveLength(1);
    const flowId=ring[0];expect(flowId).toMatch(/^[a-f0-9]{32}$/);
    // SDK 2.117.2 stores one identified slot, a bounded slot index and a
    // matching legacy alias. Assert the exact new flow, not an assumed count.
    expect(Object.keys(fresh).sort()).toEqual([`cluera-auth-yhnqlfcgrmckhyjdxegg-v1-flow-${flowId}-code-verifier`,'cluera-auth-yhnqlfcgrmckhyjdxegg-v1-flows-code-verifier','cluera-auth-yhnqlfcgrmckhyjdxegg-v1-code-verifier'].sort());
    expect(JSON.parse(fresh['cluera-auth-yhnqlfcgrmckhyjdxegg-v1-flows-code-verifier'])).toEqual([flowId]);
    const raw=JSON.parse(fresh[`cluera-auth-yhnqlfcgrmckhyjdxegg-v1-flow-${flowId}-code-verifier`]);expect(JSON.parse(fresh['cluera-auth-yhnqlfcgrmckhyjdxegg-v1-code-verifier'])).toBe(raw);
    expect(Object.values(old)).not.toContain(fresh['cluera-auth-yhnqlfcgrmckhyjdxegg-v1-code-verifier']);
    expect(JSON.stringify(requestBody)).not.toContain(raw);
    const token=`header.${Buffer.from(JSON.stringify({sub:'uid',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')}.synthetic`;
    vi.stubGlobal('fetch',vi.fn(async(_input:any,init?:RequestInit)=>{expect(JSON.parse(init!.body as string)).toMatchObject({auth_code:'latest-fixture-code',code_verifier:raw});return Response.json({access_token:token,refresh_token:'fixture-refresh',expires_in:3600,token_type:'bearer',user:{id:'uid'}});}));
    const restored=accountClients(config,fresh);const exchanged=await restored.auth.auth.exchangeCodeForSession('latest-fixture-code');expect(exchanged.error).toBeNull();expect(JSON.stringify(restored.flow())).not.toContain('fixture-refresh');
  });
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
    const verifier = JSON.parse(stored[flowId ? `cluera-auth-yhnqlfcgrmckhyjdxegg-v1-flow-${flowId}-code-verifier` : 'cluera-auth-yhnqlfcgrmckhyjdxegg-v1-code-verifier']);
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
