import { afterEach, expect, it, vi } from 'vitest';
import { readAuthOptions } from '../lib/accounts/authOptions';
import { CLUERA_SUPABASE_URL } from '../lib/supabase/target';

const config = { url: CLUERA_SUPABASE_URL, anonKey: 'sb_publishable_abcdefghijklmnopqrstuvwxyz123456' };
afterEach(() => vi.useRealTimers());
it.each([true, false])('reads only public Google availability: %s', async google => {
  const request = vi.fn(async () => Response.json({ external: { google }, secret: 'never-return-this' }));
  expect(await readAuthOptions(config, request)).toEqual({ google: google ? 'enabled' : 'disabled' });
  expect(request).toHaveBeenCalledTimes(1);
  const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe(`${CLUERA_SUPABASE_URL}/auth/v1/settings`);
  expect(init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'error', credentials: 'omit' });
  expect(init.headers).toEqual({ apikey: config.anonKey, Accept: 'application/json' });
});
it.each([{ url: 'https://foreign.invalid', anonKey: config.anonKey }, { ...config, anonKey: 'sb_secret_not-public' }])('refuses a foreign target or privileged key before any request', async input => {
  const request = vi.fn();
  expect(await readAuthOptions(input, request)).toEqual({ google: 'unavailable' });
  expect(request).not.toHaveBeenCalled();
});
it.each([{}, { external: {} }, { external: { google: 'true' } }, { external: null }])('does not guess availability from malformed metadata', async value => {
  expect(await readAuthOptions(config, vi.fn(async () => Response.json(value)))).toEqual({ google: 'unavailable' });
});
it.each([
  () => new Response('private', { status: 503 }),
  () => new Response('not json', { headers: { 'content-type': 'text/html' } }),
  () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '32769' } }),
  () => new Response(' '.repeat(32769), { headers: { 'content-type': 'application/json' } }),
  () => new Response('{', { headers: { 'content-type': 'application/json' } }),
])('fails closed without returning upstream response data', async response => {
  expect(await readAuthOptions(config, vi.fn(async () => response()))).toEqual({ google: 'unavailable' });
});
it('bounds a stalled settings request and does not retry', async () => {
  vi.useFakeTimers();
  const request = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('private upstream error')), { once: true });
  }));
  const result = readAuthOptions(config, request);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await result).toEqual({ google: 'unavailable' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('settles when the transport ignores abort',async()=>{
 vi.useFakeTimers();const request=vi.fn(()=>new Promise<Response>(()=>{}));const result=readAuthOptions(config,request);
 await vi.advanceTimersByTimeAsync(5000);expect(await result).toEqual({google:'unavailable'});expect(request).toHaveBeenCalledOnce();
});
it('bounds a stalled body without waiting for hanging stream cancellation',async()=>{
 vi.useFakeTimers();const body=new ReadableStream<Uint8Array>({pull:()=>new Promise(()=>{}),cancel:()=>new Promise(()=>{})});
 const result=readAuthOptions(config,vi.fn(async()=>new Response(body,{headers:{'content-type':'application/json'}})));
 await vi.advanceTimersByTimeAsync(5000);expect(await result).toEqual({google:'unavailable'});
});
