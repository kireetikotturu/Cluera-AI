// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {AccountPanel} from '../app/account/AccountPanel';
import {replaceAccountLocation} from '../lib/accounts/browserNavigation';
import {clearLiveIntent,liveIntentFromSearch,liveWelcomePath,LIVE_PATH,LIVE_SIGN_IN_PATH,resolveLiveIntent} from '../lib/live/intent';
import {resolveCheckoutSelection} from '../lib/cluera/checkoutJourney';
vi.mock('../lib/accounts/browserNavigation',async original=>({...await original<typeof import('../lib/accounts/browserNavigation')>(),replaceAccountLocation:vi.fn()}));
vi.mock('../app/account/AccountWorkspace',()=>({AccountWorkspace:()=>createElement('p',{},'Synthetic account workspace')}));

const KEY='cluera.live-intent.v1';
const account={userId:'00000000-0000-4000-8000-000000000802',email:'fixture@example.invalid',trialSecondsGranted:900,remoteDesktop:false};
const securityFor=(recovery:boolean)=>Response.json({accountId:account.userId,passwordRecovery:recovery,recoveryExpired:false,needsMfa:false,factors:[]});
/** A signed-in browser: the session read succeeds. */
const signedIn=(recovery=false)=>vi.fn(async(url:unknown)=>String(url).startsWith('/api/account/password-security?')?securityFor(recovery):Response.json({account,passwordRecovery:recovery}));

describe('create-session intent', () => {
  it('follows only exactly ?next=live', () => {
    expect(liveIntentFromSearch('?next=live')).toBe(true);
    expect(liveIntentFromSearch('?next=live&next=live')).toBe(false);
    expect(liveIntentFromSearch('?next=https://example.invalid')).toBe(false);
    expect(liveIntentFromSearch('?next=/account/live')).toBe(false);
    expect(liveIntentFromSearch('')).toBe(false);
    expect(liveIntentFromSearch(`?next=live&x=${'a'.repeat(5000)}`)).toBe(false);
  });
  it('remembers it for ten minutes, then forgets it', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) };
    expect(resolveLiveIntent('', storage, 1_000)).toBe(false);
    expect(resolveLiveIntent('?next=live', storage, 1_000)).toBe(true);
    expect(resolveLiveIntent('', storage, 1_000 + 9 * 60_000)).toBe(true);
    expect(resolveLiveIntent('', storage, 1_000 + 11 * 60_000)).toBe(false);
    expect(store.has(KEY)).toBe(false);
    resolveLiveIntent('?next=live', storage, 5_000);
    clearLiveIntent(storage);
    expect(resolveLiveIntent('', storage, 5_001)).toBe(false);
    store.set(KEY, 'not a time');
    expect(resolveLiveIntent('', storage, 5_002)).toBe(false);
  });
  it('never fails when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(resolveLiveIntent('?next=live', broken)).toBe(true);
    expect(resolveLiveIntent('', broken)).toBe(false);
    expect(() => clearLiveIntent(broken)).not.toThrow();
  });
  it('uses the live page paths the website links to', () => {
    expect(LIVE_PATH).toBe('/account/live');
    expect(LIVE_SIGN_IN_PATH).toBe('/account?next=live');
    expect(liveWelcomePath()).toBe('/account/live?welcome=1');
  });
});

describe('sign-in page for Create session', () => {
  let host: HTMLDivElement, root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.mocked(replaceAccountLocation).mockClear();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    sessionStorage.clear();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
    history.replaceState(null, '', '/account');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 401 })));
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
  const render = async (): Promise<void> => { await act(async () => root.render(createElement(AccountPanel))); };

  it('tells a signed-out visitor to sign in first and that the first 15 minutes are free', async () => {
    history.replaceState(null, '', '/account?next=live');
    await render();
    expect(host.querySelector('h2')?.textContent).toBe('Sign in');
    expect(host.querySelector('.account-auth-description')?.textContent).toContain('Sign in to create your session');
    expect(host.querySelector('.account-auth-description')?.textContent).toContain('15 free minutes');
    expect(sessionStorage.getItem(KEY)).not.toBeNull();
    expect(replaceAccountLocation).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
  it('says the same on the create-account form', async () => {
    history.replaceState(null, '', '/account?next=live#signup');
    await render();
    expect(host.querySelector('h2')?.textContent).toBe('Create an account');
    expect(host.querySelector('.account-auth-description')?.textContent).toContain('Your first 15 minutes are free');
  });
  it('keeps the normal wording when the visitor did not come from Create session', async () => {
    await render();
    expect(host.querySelector('.account-auth-description')?.textContent).toBe('Welcome back to Cluera.');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
  it('sends a signed-in visitor on to the live page once, with the welcome', async () => {
    history.replaceState(null, '', '/account?next=live');
    vi.stubGlobal('fetch', signedIn());
    await render();
    expect(replaceAccountLocation).toHaveBeenCalledExactlyOnceWith('/account/live?welcome=1');
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
  it('still sends them on after a Google return in the same tab (the intent is remembered)', async () => {
    sessionStorage.setItem(KEY, String(Date.now()));
    vi.stubGlobal('fetch', signedIn());
    await render();
    expect(replaceAccountLocation).toHaveBeenCalledExactlyOnceWith('/account/live?welcome=1');
  });
  it('does not redirect an ordinary visit to the account page', async () => {
    vi.stubGlobal('fetch', signedIn());
    await render();
    expect(replaceAccountLocation).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Synthetic account workspace');
  });
  it('a chosen plan comes first, then the live page is not used', async () => {
    resolveCheckoutSelection('?offer=cluera_monthly_40h_v2', sessionStorage);
    sessionStorage.setItem(KEY, String(Date.now()));
    vi.stubGlobal('fetch', signedIn());
    await render();
    expect(replaceAccountLocation).toHaveBeenCalledExactlyOnceWith('/account/checkout?offer=cluera_monthly_40h_v2');
  });
  it('password recovery never jumps to the live page', async () => {
    history.replaceState(null, '', '/account?next=live');
    vi.stubGlobal('fetch', signedIn(true));
    await render();
    expect(replaceAccountLocation).not.toHaveBeenCalled();
  });
  it('signing out forgets the intent', async () => {
    history.replaceState(null, '', '/account');
    const request = vi.fn(async (url: unknown, init?: RequestInit) => String(url).startsWith('/api/account/password-security?') ? securityFor(true)
      : init?.method === 'POST' ? Response.json({ ok: true }) : Response.json({ account, passwordRecovery: true }));
    sessionStorage.setItem(KEY, String(Date.now()));
    vi.stubGlobal('fetch', request);
    await render();
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === 'Sign out of this browser')!.click());
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });
});
