// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ClueraCheckoutClient from '../app/account/checkout/ClueraCheckoutClient';
import { BillingCatalog } from '../app/account/admin/BillingCatalog';
import { TestPlanSync } from '../app/account/admin/TestPlanSync';
import { clueraPublicRevision, type ClueraPublicRevision } from '../lib/payments/cluera/publicCatalog';

let host: HTMLDivElement, root: Root;
const userId = '00000000-0000-4000-8000-000000000801';
const factorId = '00000000-0000-4000-8000-000000000811';
const orderId = 'order_synthetic0001', subscriptionId = 'sub_synthetic0001';
const catalog: ClueraPublicRevision[] = [
  { revisionId: '00000000-0000-4000-8000-000000000821', offerCode: 'cluera_pack_3h_v2', name: 'Cluera 3 Hours',
    version: 1, amountPaise: 54900, currency: 'INR', allowanceSeconds: 10800, kind: 'PACK', interval: null, totalCount: null, testPlanValidated: true, enabled: true },
  { revisionId: '00000000-0000-4000-8000-000000000822', offerCode: 'cluera_monthly_40h_v2', name: 'Cluera Pro 40 Hours',
    version: 1, amountPaise: 549900, currency: 'INR', allowanceSeconds: 144000, kind: 'RECURRING', interval: 'MONTH', totalCount: 120, testPlanValidated: true, enabled: true },
  { revisionId: '00000000-0000-4000-8000-000000000823', offerCode: 'cluera_monthly_100h_v2', name: 'Cluera Pro 100 Hours',
    version: 1, amountPaise: 959900, currency: 'INR', allowanceSeconds: 360000, kind: 'RECURRING', interval: 'MONTH', totalCount: 120, testPlanValidated: false, enabled: false },
  { revisionId: '00000000-0000-4000-8000-000000000824', offerCode: 'cluera_monthly_200h_v2', name: 'Cluera Enterprise 200 Hours',
    version: 1, amountPaise: 1954900, currency: 'INR', allowanceSeconds: 720000, kind: 'RECURRING', interval: 'MONTH', totalCount: 120, testPlanValidated: false, enabled: false },
];
const credits = { userId, displayName: 'Synthetic Tester', availableMilliseconds: 900000,
  payments: [{ offerCode: 'pro_3_hours', state: 'BOUND', createdAt: '2026-10-11T01:23:13Z' }] };
const status = { payment: { userId, code: 'AVAILABLE', pending: null, resolvedOrderIds: [], resolvedSubscriptionIds: [] } };
let createdBinding:ReturnType<typeof makeBound>['payment']|null=null;
const makeBound = (row = catalog[0]) => ({ payment: { code: 'BOUND', kind: row.kind, orderId: row.kind === 'PACK' ? orderId : null,
  subscriptionId: row.kind === 'RECURRING' ? subscriptionId : null, keyId: 'rzp_test_synthetic123456', amountPaise: row.amountPaise,
  currency: 'INR', revisionId: row.revisionId, offerCode: row.offerCode } });
const bound = (row=catalog[0]) => {const result=makeBound(row);createdBinding=result.payment;return result;};
const buttons = () => [...host.querySelectorAll('button')];
const button = (text: string) => buttons().find(item => item.textContent === text)!;
const buy = () => host.querySelector<HTMLButtonElement>('button[data-offer-code="cluera_pack_3h_v2"]')!;
const subscribe = () => host.querySelector<HTMLButtonElement>('button[data-offer-code="cluera_monthly_40h_v2"]')!;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  history.replaceState(null, '', '/account/checkout');
  sessionStorage.clear();
  createdBinding=null;
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete window.Razorpay;
  document.querySelectorAll('script[src*="razorpay"]').forEach(script => script.remove());
  vi.unstubAllGlobals();
});
const renderCheckout = async (enabled = true) => { await act(async () => root.render(createElement(ClueraCheckoutClient, { enabled }))); };
const checkoutGet = (url: RequestInfo | URL) => Response.json(String(url).endsWith('/catalog') ? { catalog }
  : String(url).includes('/resume?') ? makeBound()
  : String(url).includes('/checkout?') ? createdBinding ? {payment:{...status.payment,code:'PENDING',pending:{legacy:false,intentId:factorId,
      state:'BOUND',kind:createdBinding.kind,revisionId:createdBinding.revisionId,offerCode:createdBinding.offerCode,
      orderId:createdBinding.orderId,subscriptionId:createdBinding.subscriptionId}}} : status : credits);

it.each([['TEST_PURCHASER_REQUIRED','You are signed in. Test checkout'],['LIVE_PURCHASER_REQUIRED','Public sales are not open yet']])('keeps identity and trial on %s, with no sign-in loop, SDK or write', async (code,message) => {
  const request=vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/checkout?')
    ? Response.json({code,error:'PRIVATE_DO_NOT_REFLECT'},{status:403}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();
  expect(host.textContent).toContain(message);
  expect(host.textContent).toContain('Synthetic Tester');expect(host.textContent).toContain('15m');
  expect(host.textContent).not.toContain('PRIVATE_DO_NOT_REFLECT');
  expect(host.querySelector('a[href*="#login"]')).toBeNull();expect(buy().disabled).toBe(true);
  await act(async()=>button('Refresh billing status').click());
  expect(host.textContent).toContain('Synthetic Tester');expect(document.querySelector('script[src*="razorpay"]')).toBeNull();
  expect(request.mock.calls.every(([,init])=>!(init as RequestInit|undefined)?.method)).toBe(true);
});

it.each([
  [401,undefined,'Your session has ended'],[403,'ACCOUNT_MISMATCH','does not match this checkout'],
  [403,'RECOVERY_SESSION','Finish resetting your password'],[403,undefined,'Checkout access was denied'],
  [404,undefined,'not enabled for this deployment'],[409,undefined,'existing payment or order'],
  [429,undefined,'Too many billing requests'],[503,undefined,'configuration is unavailable'],
] as const)('explains checkout status %s/%s without claiming a different failure',async(http,code,notice)=>{
  vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL)=>String(url).includes('/checkout?')
    ?Response.json({code,error:'PRIVATE_DO_NOT_REFLECT'},{status:http}):checkoutGet(url)));
  await renderCheckout();expect(host.textContent).toContain(notice);expect(host.textContent).not.toContain('PRIVATE_DO_NOT_REFLECT');
  if(http===401)expect(host.querySelector('a[aria-label="Sign in to buy: Cluera 3 Hours"]')).not.toBeNull();
  else expect(buy().disabled).toBe(true);
  expect(button('Refresh billing status').disabled).toBe(http===429);
  if(http!==401)expect(host.querySelector('a[aria-label="Sign in to buy: Cluera 3 Hours"]')).toBeNull();
  if(http>=404)expect(host.textContent).toContain('Synthetic Tester');
});

it('revoking Test eligibility closes checkout and fences late callbacks while retaining the verified balance',async()=>{
  let denied=false,options:Record<string,any>={};const close=vi.fn();
  window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=vi.fn();close=close;on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json(bound())
    :denied&&String(url).includes('/checkout?')?Response.json({code:'TEST_PURCHASER_REQUIRED'},{status:403}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>buy().click());denied=true;
  await act(async()=>button('Refresh billing status').click());expect(close).toHaveBeenCalledOnce();
  expect(host.textContent).toContain('Synthetic Tester');expect(host.textContent).toContain('approved Test purchaser');
  await act(async()=>options.handler({razorpay_order_id:orderId,razorpay_payment_id:'pay_synthetic0001',razorpay_signature:'a'.repeat(64)}));
  expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});

it.each(['rzp_live_synthetic123456', 'rzp_test_synthetic123456'])('Live checkout uses only Live routes and rejects the wrong key mode: %s', async keyId => {
  const open = vi.fn(); let options: Record<string, unknown> = {};
  window.Razorpay = class { constructor(value: Record<string, unknown>) { options = value; } open = open; close = vi.fn(); on = vi.fn(); };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes('/payments/')) expect(String(url)).toContain('/payments/cluera/live/');
    if (init?.method === 'POST') { const result = bound(); return Response.json({ payment: { ...result.payment, keyId } }); }
    return checkoutGet(url);
  });
  vi.stubGlobal('fetch', request);
  await act(async () => root.render(createElement(ClueraCheckoutClient, { enabled: true, mode: 'live' })));
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await act(async () => buy().click());
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  if (keyId.startsWith('rzp_live_')) { expect(open).toHaveBeenCalledOnce(); expect(options.key).toBe(keyId); expect(options.name).toBe('Cluera AI'); }
  else expect(open).not.toHaveBeenCalled();
});

it.each([undefined,[{state:'ACTIVE',paymentState:'ACTIVE'}]])('first-subscription-only availability blocks unproven or competing monthly access while packs remain available',async plans=>{
 const request=vi.fn(async(url:RequestInfo|URL)=>String(url).startsWith('/api/account/credits')?Response.json({...credits,plans}):checkoutGet(url));vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(ClueraCheckoutClient,{enabled:true,firstSubscriptionOnly:true})));
 expect(host.textContent).toContain('One monthly subscription at a time');expect(host.textContent).toContain('Automatic upgrades are unavailable');expect(subscribe().disabled).toBe(true);expect(buy().disabled).toBe(false);
 expect(request.mock.calls.every(([,init])=>!(init as RequestInit|undefined)?.method)).toBe(true);expect(document.querySelector('script')).toBeNull();
});
it('an independently loaded empty plan snapshot may show first monthly checkout under the explicit capability',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:RequestInfo|URL)=>String(url).startsWith('/api/account/credits')?Response.json({...credits,plans:[]}):checkoutGet(url)));
 await act(async()=>root.render(createElement(ClueraCheckoutClient,{enabled:true,firstSubscriptionOnly:true})));expect(subscribe().disabled).toBe(false);
});

it('shows all four approved presentations while migration is unavailable, with no order, SDK, UUID input or recurring-live claim', async () => {
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/catalog')
    ? Response.json({ error: 'synthetic-private-diagnostic' }, { status: 503 }) : Response.json(credits));
  vi.stubGlobal('fetch', request); await renderCheckout(false);
  expect(host.querySelectorAll('.account-plan-card')).toHaveLength(4);
  for (const price of ['₹549', '₹5,499', '₹9,599', '₹19,549']) expect(host.textContent).toContain(price);
  expect(host.textContent).toContain('Presentation only'); expect(host.textContent).toContain('Checkout is disabled');
  expect(host.textContent).not.toContain('synthetic-private-diagnostic');
  const unavailable=[...host.querySelectorAll<HTMLButtonElement>('button[data-checkout-action="purchase"]')];
  expect(unavailable).toHaveLength(4);expect(unavailable.every(item=>item.disabled)).toBe(true);
  expect(unavailable.map(item=>item.textContent)).toEqual(['Buy Now','Subscribe','Subscribe','Subscribe']);
  expect(host.textContent).not.toContain('Checkout unavailable');
  expect(request.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
  expect(document.querySelector('script[src*="razorpay"]')).toBeNull(); expect(host.querySelector('input')).toBeNull();
});
it('a pricing selection highlights one planned offer and preserves sign-in without bypassing disabled checkout',async()=>{
 history.replaceState(null,'',`/account/checkout?offer=cluera_monthly_100h_v2&desktopAccount=${userId}`);
 const request=vi.fn(async()=>new Response(null,{status:401}));vi.stubGlobal('fetch',request);
 await renderCheckout(false);
 expect(host.querySelectorAll('.cluera-plan-selected')).toHaveLength(1);
 expect(host.querySelector('.cluera-plan-selected')!.textContent).toContain('Cluera Pro 100 Hours');
 expect(host.querySelector<HTMLAnchorElement>('a')!.getAttribute('href')).toBe(`/account?offer=cluera_monthly_100h_v2&desktopAccount=${userId}#login`);
 expect(request.mock.calls.every(([,init])=>!(init as RequestInit|undefined)?.method)).toBe(true);
 expect(document.querySelector('script')).toBeNull();expect([...host.querySelectorAll<HTMLButtonElement>('button[data-offer-code]')].every(b=>b.disabled)).toBe(true);
});
it('duplicate desktop owner hints fail closed before any account/catalog reads',async()=>{
 history.replaceState(null,'',`/account/checkout?desktopAccount=${userId}&desktopAccount=${factorId}`);
 const request=vi.fn();vi.stubGlobal('fetch',request);await renderCheckout(true);
 expect(request).not.toHaveBeenCalled();expect(host.textContent).not.toContain('Signed in as');
 expect(host.querySelectorAll('.account-plan-card button')).toHaveLength(4);
 expect([...host.querySelectorAll<HTMLButtonElement>('.account-plan-card button')].every(b=>b.disabled)).toBe(true);
});
it('signed-out pricing preserves the selected purchasable plan through sign-in without creating an order',async()=>{
 history.replaceState(null,'','/pricing');
 const request=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/catalog')?Response.json({catalog}):new Response(null,{status:401}));
 vi.stubGlobal('fetch',request);
 await act(async()=>root.render(createElement(ClueraCheckoutClient,{enabled:true,offers:catalog})));
 const link=host.querySelector<HTMLAnchorElement>('a[aria-label="Sign in to buy: Cluera 3 Hours"]')!;
 expect(link.getAttribute('href')).toBe('/account?offer=cluera_pack_3h_v2#login');
 expect(host.querySelector('a[aria-label="Sign in to subscribe: Cluera Pro 100 Hours"]')).toBeNull();
 expect(request.mock.calls.every(([,init])=>!(init as RequestInit|undefined)?.method)).toBe(true);
 expect(document.querySelector('script[src*="razorpay"]')).toBeNull();
});

it('retains historical Paddle rows without using them as a new binding or automatically opening checkout', async () => {
  const request = vi.fn(async (url: RequestInfo | URL) => checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); expect(buy().disabled).toBe(false); expect(host.textContent).toContain('pro_3_hours');
  expect(host.textContent).toContain('Old drafts are not resumed'); expect(document.querySelector('script')).toBeNull();
  expect(request.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
});

it.each(['CREATING', 'BOUND', 'UNCERTAIN'])('locks new purchases for a canonical %s attempt; only a bound pack offers explicit continuation', async state => {
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/checkout?') ? Response.json({ payment: {
    ...status.payment, code: 'PENDING', pending: { legacy: false, intentId: factorId, state, kind: 'PACK', revisionId: catalog[0].revisionId,
      offerCode: catalog[0].offerCode, orderId: state === 'BOUND' ? orderId : null, subscriptionId: null },
  } }) : checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); expect(buy().disabled).toBe(state!=='BOUND'); expect(subscribe().disabled).toBe(true);
  expect(buy().dataset.checkoutAction).toBe(state==='BOUND'?'resume':'purchase');
  expect(document.querySelector('script')).toBeNull(); expect(request.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
});

it('preserves a real legacy Razorpay pending binding without inventing a Cluera revision or offering resume', async () => {
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).includes('/checkout?') ? Response.json({ payment: {
    ...status.payment, code: 'PENDING', pending: { legacy: true, intentId: factorId, state: 'BOUND', kind: 'PACK', revisionId: null,
      offerCode: 'pro_3_hours', orderId, subscriptionId: null },
  } }) : checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); expect(buy().disabled).toBe(true); expect(subscribe().disabled).toBe(true);
  expect(host.textContent).toContain('existing Account-era Razorpay attempt');
  expect(host.textContent).toContain('preserved, not resumed or recreated'); expect(document.querySelector('script')).toBeNull();
  expect(buttons().some(item => /resume/i.test(item.textContent ?? ''))).toBe(false);
});

it('keeps one unknown CREATE operation locked through stale AVAILABLE reads and never resubmits', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: 'raw-provider-secret' }, { status: 503 }) : checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); await act(async () => { buy().click(); buy().click(); });
  const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1]!.body as string)).toEqual({ expectedAccountId: userId, requestId: expect.any(String), revisionId: catalog[0].revisionId });
  await act(async () => button('Refresh billing status').click()); expect(buy().disabled).toBe(true);
  expect(subscribe().disabled).toBe(true); expect(host.textContent).not.toContain('raw-provider-secret'); expect(document.querySelector('script')).toBeNull();
});

it('requires the exact frozen revision/amount before SDK loading and fails closed on an unrelated bound response', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ payment: { ...bound().payment, amountPaise: 55000 } }) : checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); await act(async () => buy().click());
  expect(document.querySelector('script')).toBeNull(); expect(buy().disabled).toBe(true);
  await act(async () => button('Refresh billing status').click()); expect(buy().disabled).toBe(true);
});

it('opens only one explicit owned Test order; valid callback cannot grant or clear its binding', async () => {
  let options: Record<string, any> = {}; const open = vi.fn(), close = vi.fn();
  window.Razorpay = class { constructor(input: Record<string, unknown>) { options = input; } open = open; close = close; on = vi.fn(); };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json(String(url).endsWith('/callback') ? { payment: { code: 'AWAITING_WEBHOOK' } } : bound()) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout(); expect(open).not.toHaveBeenCalled();
  await act(async () => buy().click()); expect(open).toHaveBeenCalledOnce(); expect(options).toMatchObject({ order_id: orderId, amount: 54900, retry: { enabled: false } });
  await act(async () => options.handler({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_synthetic0001', razorpay_signature: 'a'.repeat(64) }));
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  expect(host.textContent).toContain('awaiting authoritative verification'); expect(buy().disabled).toBe(true); expect(close).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([url]) => /grant|reconcile|tick|refund/.test(String(url)))).toBe(false);
});

it('uses subscription_id, not a fabricated order, and treats mandate callback as awaiting independent evidence', async () => {
  let options: Record<string, any> = {}; const open = vi.fn();
  window.Razorpay = class { constructor(input: Record<string, unknown>) { options = input; } open = open; close = vi.fn(); on = vi.fn(); };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json(String(url).endsWith('/callback') ? { payment: { code: 'AWAITING_WEBHOOK' } } : bound(catalog[1])) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout(); await act(async () => subscribe().click());
  expect(options.subscription_id).toBe(subscriptionId); expect(options.order_id).toBeUndefined(); expect(options.amount).toBeUndefined();
  expect(host.textContent).toContain('up to 120 monthly charges');
  await act(async () => options.handler({ razorpay_subscription_id: subscriptionId, razorpay_payment_id: 'pay_synthetic0001', razorpay_signature: 'a'.repeat(64) }));
  expect(subscribe().disabled).toBe(true); expect(open).toHaveBeenCalledOnce();
});

it('never opens SDK for an unverified monthly Test plan even when stale catalog enabled=true', async () => {
  const unverified = catalog.map(row => row.kind === 'RECURRING' ? { ...row, enabled: true, testPlanValidated: false } : row);
  const request = vi.fn(async (url: RequestInfo | URL) => String(url).endsWith('/catalog') ? Response.json({ catalog: unverified }) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout(); expect(subscribe().disabled).toBe(true);
  await act(async () => subscribe().click()); expect(document.querySelector('script')).toBeNull();
  expect(host.textContent).toContain('Subscriptions for this plan are not open yet.');
});

it('does not trust a browser-supplied foreign resource in callback and does not echo it', async () => {
  let options: Record<string, any> = {};
  window.Razorpay = class { constructor(input: Record<string, unknown>) { options = input; } open = vi.fn(); close = vi.fn(); on = vi.fn(); };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json(bound()) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout(); await act(async () => buy().click());
  await act(async () => options.handler({ razorpay_order_id: 'order_foreign0001', razorpay_payment_id: 'pay_synthetic0001', razorpay_signature: 'a'.repeat(64) }));
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1); expect(host.textContent).not.toContain('foreign0001'); expect(buy().disabled).toBe(true);
});

it('closes the old owner overlay and fences callbacks after definitive status denial', async () => {
  let options: Record<string, any> = {}, denied = false; const close = vi.fn();
  window.Razorpay = class { constructor(input: Record<string, unknown>) { options = input; } open = vi.fn(); close = close; on = vi.fn(); };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json(bound())
    : denied && String(url).includes('/checkout?') ? new Response(null, { status: 403 }) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout(); await act(async () => buy().click()); denied = true;
  await act(async () => button('Refresh billing status').click()); expect(close).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain('Signed in as');
  expect(button('Refresh billing status').disabled).toBe(false);
  await act(async () => options.handler({ razorpay_order_id: orderId, razorpay_payment_id: 'pay_synthetic0001', razorpay_signature: 'a'.repeat(64) }));
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});

it('abort/flag changes stop late SDK initialization; no security flag or retry is loosened', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json(bound()) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout();
  await act(async () => { void buy().click(); });
  const script = document.querySelector<HTMLScriptElement>('script[src*="razorpay"]'); expect(script).not.toBeNull();
  await renderCheckout(false); expect(document.querySelector('script[src*="razorpay"]')).toBeNull(); expect(buy().disabled).toBe(true);
});
it('a browser account switch during deferred CREATE cannot open the old owner payment overlay', async () => {
  const open=vi.fn();window.Razorpay=class {open=open;close=vi.fn();on=vi.fn();};
  let finishCreate:(response:Response)=>void=()=>{},switched=false;
  const created=new Promise<Response>(resolve=>{finishCreate=resolve;});
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?created
    : switched&&String(url).includes('/credits')?Response.json({...credits,userId:factorId}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();
  await act(async()=>{buy().click();});switched=true;
  await act(async()=>{finishCreate(Response.json(bound()));});
  expect(open).not.toHaveBeenCalled();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it.each([401,403,'mismatch','malformed',503] as const)('a deferred SDK load requires fresh same-owner authorization; %s cannot open',async failure=>{
  const open=vi.fn();let switched=false;
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json(bound())
    : switched&&String(url).includes('/credits')?failure==='mismatch'?Response.json({...credits,userId:factorId})
      : failure==='malformed'?Response.json({userId:'invalid',secret:'never-reflect'}) : new Response(null,{status:failure})
      : checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>{buy().click();});
  const script=document.querySelector<HTMLScriptElement>('script[src*="razorpay"]');expect(script).not.toBeNull();switched=true;
  window.Razorpay=class {open=open;close=vi.fn();on=vi.fn();};
  await act(async()=>{script!.dispatchEvent(new Event('load'));});
  expect(open).not.toHaveBeenCalled();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(host.textContent).not.toContain('never-reflect');
});
it.each([401,403,503,'malformed','foreign-owner','foreign-binding','unresolved-available'] as const)
  ('pre-open server binding verification fails closed for %s without another order',async failure=>{
    const open=vi.fn();window.Razorpay=class {open=open;close=vi.fn();on=vi.fn();};
    const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
      if(init?.method==='POST')return Response.json(bound());
      if(String(url).includes('/checkout?')&&createdBinding){
        if(typeof failure==='number')return new Response(null,{status:failure});
        if(failure==='malformed')return Response.json({payment:{raw:'never-echo'}});
        if(failure==='unresolved-available')return Response.json(status);
        const body=await checkoutGet(url).json();
        if(failure==='foreign-owner')body.payment.userId=factorId;
        else body.payment.pending.orderId='order_foreign0001';
        return Response.json(body);
      }
      return checkoutGet(url);
    });
    vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>{buy().click();});
    expect(open).not.toHaveBeenCalled();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
    expect(host.textContent).not.toContain('never-echo');
    if(failure===401)expect(host.querySelector('a[aria-label="Sign in to buy: Cluera 3 Hours"]')).not.toBeNull();
    else expect(buy().disabled).toBe(true);
  });

it('automatically observes a delayed signed-payment resolution and refreshes the committed balance without a payment action',async()=>{
  vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  try {
    let resolvePayment=false,settled=false;
    const request=vi.fn(async(url:RequestInfo|URL)=>{
      if(String(url).includes('/resume?'))return Response.json(makeBound());
      if(String(url).includes('/checkout?')) {
        if(resolvePayment){settled=true;return Response.json({payment:{...status.payment,resolvedOrderIds:[orderId]}});}
        return Response.json({payment:{...status.payment,code:'PENDING',pending:{legacy:false,intentId:factorId,state:'BOUND',kind:'PACK',
          revisionId:catalog[0].revisionId,offerCode:catalog[0].offerCode,orderId,subscriptionId:null}}});
      }
      return String(url).endsWith('/catalog')?Response.json({catalog}):Response.json({...credits,availableMilliseconds:settled?11700000:900000});
    });
    vi.stubGlobal('fetch',request);await renderCheckout();expect(buy().dataset.checkoutAction).toBe('resume');expect(host.textContent).toContain('15m');
    resolvePayment=true;await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});
    expect(buy().disabled).toBe(false);expect(host.textContent).toContain('3h 15m');
    const count=request.mock.calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(300_000);});
    expect(request).toHaveBeenCalledTimes(count);expect(request.mock.calls.every(([,init])=>!(init as RequestInit|undefined)?.method)).toBe(true);
    expect(document.querySelector('script[src*="razorpay"]')).toBeNull();
  } finally {visibility.mockRestore();vi.useRealTimers();}
});
it('bounds automatic checks to four and never clears an unknown create or retries payment',async()=>{
  vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  try {
    const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?new Response(null,{status:503}):checkoutGet(url));
    vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>buy().click());
    await act(async()=>{await vi.advanceTimersByTimeAsync(120_000);});
    expect(request.mock.calls.filter(([url])=>String(url).includes('/checkout?'))).toHaveLength(5);
    expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);expect(buy().disabled).toBe(true);
    const count=request.mock.calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(300_000);});expect(request).toHaveBeenCalledTimes(count);
  } finally {visibility.mockRestore();vi.useRealTimers();}
});
it.each(['VERIFIED','REFUNDED','unrelated','balance-unavailable'] as const)('success requires exact callback payment plus authoritative %s history and a refreshed balance',async proof=>{
 vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 try{
  let options:Record<string,any>={},resolved=false,settled=false;
  window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=vi.fn();close=vi.fn();on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
   const path=String(url);
   if(path.endsWith('/callback'))return Response.json({payment:{code:'AWAITING_WEBHOOK'}});
   if(init?.method==='POST')return Response.json(bound());
   if(path.includes('/history?'))return Response.json({history:{code:'ACTIVE',userId,payments:createdBinding?[{
    paymentId:proof==='unrelated'?'pay_other000001':'pay_callback0001',invoiceId:null,subscriptionId:null,
    state:proof==='REFUNDED'?'REFUNDED':'VERIFIED',revision:{revisionId:catalog[0].revisionId,offerCode:catalog[0].offerCode,version:1,
     name:catalog[0].name,kind:'PACK',amountPaise:54900,currency:'INR',allowanceSeconds:10800},
    intentCreatedAt:'2026-10-20T00:00:00Z',paidAt:null,periodStart:null,periodEnd:null}]:[],subscriptions:[],hasMorePayments:false,hasMoreSubscriptions:false}},
    {headers:{'cache-control':'no-store','x-content-type-options':'nosniff'}});
   if(path.includes('/checkout?')&&resolved){settled=true;return Response.json({payment:{...status.payment,resolvedOrderIds:[orderId]}});}
   if(path.startsWith('/api/account/credits'))return proof==='balance-unavailable'&&settled?new Response(null,{status:503}):Response.json({...credits,availableMilliseconds:settled?11700000:900000});
   return checkoutGet(url);
  });
  vi.stubGlobal('fetch',request);
  await act(async()=>root.render(createElement(ClueraCheckoutClient,{enabled:true,historyEnabled:true})));
  await act(async()=>buy().click());
  // The customer can spend several minutes in Checkout before completing it.
  await act(async()=>{await vi.advanceTimersByTimeAsync(150000);});
  await act(async()=>options.handler({razorpay_payment_id:'pay_callback0001',razorpay_order_id:orderId,razorpay_signature:'a'.repeat(64)}));
  expect(host.textContent).not.toContain('Payment verified.');
  resolved=true;await act(async()=>{await vi.advanceTimersByTimeAsync(30000);});
  if(proof==='balance-unavailable')expect(host.textContent).not.toContain('3h 15m');
  else expect(host.textContent).toContain('3h 15m');
  if(proof==='VERIFIED')expect(host.textContent).toContain('Payment verified. Your available time and billing history are up to date.');
  else expect(host.textContent).not.toContain('Payment verified.');
  expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(2);
 }finally{visibility.mockRestore();vi.useRealTimers();}
});
it.each(['callback','dismiss','failure'] as const)('a late %s starts one bounded observation window without repeating payment writes',async event=>{
 vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 try{
  let options:Record<string,any>={},failed=()=>{};
  window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=vi.fn();close=vi.fn();on=(_event:string,callback:()=>void)=>{failed=callback;};};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'
   ?Response.json(String(url).endsWith('/callback')?{payment:{code:'AWAITING_WEBHOOK'}}:bound()):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>buy().click());
  await act(async()=>{await vi.advanceTimersByTimeAsync(150000);});
  const stopped=request.mock.calls.length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});expect(request).toHaveBeenCalledTimes(stopped);
  const returnFromCheckout=()=>event==='callback'?options.handler({razorpay_order_id:orderId,razorpay_payment_id:'pay_synthetic0001',razorpay_signature:'a'.repeat(64)})
   :event==='dismiss'?options.modal.ondismiss():failed();
  await act(async()=>{await returnFromCheckout();await returnFromCheckout();});
  const reads=request.mock.calls.filter(([url])=>String(url).includes('/checkout?')).length;
  await act(async()=>{await vi.advanceTimersByTimeAsync(120000);});
  expect(request.mock.calls.filter(([url])=>String(url).includes('/checkout?'))).toHaveLength(reads+4);
  const finished=request.mock.calls.length;
  await act(async()=>{await returnFromCheckout();await vi.advanceTimersByTimeAsync(300000);});
  expect(request).toHaveBeenCalledTimes(finished);
  expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(event==='callback'?2:1);
  if(event==='callback'){expect(buy().disabled).toBe(true);expect(button('Continue existing checkout')).toBeUndefined();}
  expect([...host.querySelectorAll<HTMLButtonElement>('button[data-checkout-action="purchase"]')].every(item=>item.disabled)).toBe(true);
  expect(host.textContent).not.toContain('Payment verified.');
 }finally{visibility.mockRestore();vi.useRealTimers();}
});

it('automatic checks stop after a definitive owner denial and keep the previous overlay closed',async()=>{
  vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
  try {
    const close=vi.fn();window.Razorpay=class{open=vi.fn();close=close;on=vi.fn();};let denied=false;
    const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json(bound())
      :denied&&String(url).includes('/credits')?new Response(null,{status:403}):checkoutGet(url));
    vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>buy().click());denied=true;
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_000);});expect(close).toHaveBeenCalledOnce();expect(host.textContent).not.toContain('Signed in as');
    const count=request.mock.calls.length;await act(async()=>{await vi.advanceTimersByTimeAsync(300_000);});expect(request).toHaveBeenCalledTimes(count);
    expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
  } finally {visibility.mockRestore();vi.useRealTimers();}
});
it('continuation supersedes a slow background read, revalidates ownership and ignores its late foreign response',async()=>{
 createdBinding=makeBound().payment;let delay=false,finish!:(value:Response)=>void,slowSignal:AbortSignal|undefined;
 const open=vi.fn();window.Razorpay=class{open=open;close=vi.fn();on=vi.fn();};
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>{
  if(delay&&String(url).includes('/credits')){delay=false;slowSignal=init?.signal as AbortSignal;return new Promise<Response>(resolve=>{finish=resolve;});}
  return String(url).includes('/resume?')?Response.json(makeBound()):checkoutGet(url);
 });
 vi.stubGlobal('fetch',request);await renderCheckout();delay=true;
 await act(async()=>button('Refresh billing status').click());
 expect(button('Refresh billing status').disabled).toBe(true);expect(button('Continue existing checkout').disabled).toBe(false);
 await act(async()=>button('Continue existing checkout').click());
 expect(slowSignal?.aborted).toBe(true);expect(open).toHaveBeenCalledOnce();
 await act(async()=>finish(Response.json({...credits,userId:factorId,displayName:'Foreign account'})));
 expect(host.textContent).toContain('Synthetic Tester');expect(host.textContent).not.toContain('Foreign account');
 expect(request.mock.calls.filter(([url])=>String(url).includes('/resume?'))).toHaveLength(3);
 expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
});
it('an SDK load failure stays visible until an explicit read rechecks the same order',async()=>{
 createdBinding=makeBound().payment;
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')?Response.json(makeBound()):checkoutGet(url));
 vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>button('Continue existing checkout').click());
 const script=document.querySelector<HTMLScriptElement>('script[src*="razorpay"]')!;
 await act(async()=>script.dispatchEvent(new Event('error')));
 expect(host.textContent).toContain('Razorpay window could not load');expect(button('Continue existing checkout')).toBeUndefined();expect(buy().disabled).toBe(true);
 await act(async()=>button('Refresh billing status').click());
 expect(button('Continue existing checkout').disabled).toBe(false);expect(buy().disabled).toBe(false);expect(buy().dataset.checkoutAction).toBe('resume');
 const open=vi.fn();window.Razorpay=class{open=open;close=vi.fn();on=vi.fn();};
 await act(async()=>button('Continue existing checkout').click());expect(open).toHaveBeenCalledOnce();
 expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
});
it.each([true,false])('ten-minute expiry reconciles the original order; untouched=%s never creates or cancels an order',async untouched=>{
 vi.useFakeTimers();const visibility=vi.spyOn(document,'visibilityState','get').mockReturnValue('visible');
 try{
  createdBinding=makeBound().payment;let expired=false,options:Record<string,any>={};const close=vi.fn(),open=vi.fn();
  window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=open;close=close;on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')
   ?expired&&!untouched?Response.json({error:'Pending'},{status:409}):Response.json(makeBound()):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>button('Continue existing checkout').click());
  expect(options.timeout).toBe(600);expect(host.textContent).toContain('10:00');
  await act(async()=>vi.advanceTimersByTimeAsync(599000));expect(close).not.toHaveBeenCalled();expired=true;
  await act(async()=>vi.advanceTimersByTimeAsync(1000));expect(close).toHaveBeenCalledOnce();
  expect(request.mock.calls.filter(([url])=>String(url).includes('/resume?'))).toHaveLength(4);
  expect(buy().disabled).toBe(!untouched);expect(buy().dataset.checkoutAction).toBe(untouched?'resume':'purchase');
  if(untouched){expect(host.textContent).toContain('Your order was not canceled');expect(button('Continue existing checkout').disabled).toBe(false);}
  else expect(button('Continue existing checkout')).toBeUndefined();
  expect(open).toHaveBeenCalledOnce();expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
 }finally{visibility.mockRestore();vi.useRealTimers();}
});
it('closing an untouched checkout offers deliberate same-order continuation without a second CREATE',async()=>{
 let options:Record<string,any>={};const open=vi.fn();
 window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=open;close=vi.fn();on=vi.fn();};
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json(bound())
  :String(url).includes('/resume?')?Response.json(makeBound()):checkoutGet(url));
 vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>buy().click());
 await act(async()=>options.modal.ondismiss());expect(button('Continue existing checkout').disabled).toBe(false);
 await act(async()=>button('Continue existing checkout').click());expect(open).toHaveBeenCalledTimes(2);expect(options.order_id).toBe(orderId);
 expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
});
it('a resume throttle preserves identity and prevents repeat reads until the bounded retry delay ends',async()=>{
 vi.useFakeTimers();try{
  createdBinding=makeBound().payment;let throttled=true;
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')&&throttled
   ?Response.json({error:'Wait'},{status:429,headers:{'Retry-After':'7'}}):String(url).includes('/resume?')?Response.json(makeBound()):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();expect(button('Continue existing checkout')).toBeUndefined();
  expect(host.textContent).toContain('Please wait 7s');expect(host.textContent).toContain('Synthetic Tester');
  const count=request.mock.calls.length;await act(async()=>{button('Refresh billing status').click();await vi.advanceTimersByTimeAsync(6000);});
  expect(request).toHaveBeenCalledTimes(count);expect(button('Refresh billing status').disabled).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(1000));expect(button('Refresh billing status').disabled).toBe(false);
  throttled=false;await act(async()=>button('Refresh billing status').click());expect(button('Continue existing checkout').disabled).toBe(false);
  expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
 }finally{vi.useRealTimers();}
});
it('initial verification offers the original order but only explicit continuation opens it without a checkout CREATE POST',async()=>{
  createdBinding=makeBound().payment;let options:Record<string,any>={};const open=vi.fn();
  window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=open;close=vi.fn();on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')?Response.json(makeBound()):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();expect(open).not.toHaveBeenCalled();expect(document.querySelector('script')).toBeNull();expect(buy().dataset.checkoutAction).toBe('resume');
  await act(async()=>{button('Continue existing checkout').click();button('Continue existing checkout').click();});
  expect(open).toHaveBeenCalledOnce();expect(options.order_id).toBe(orderId);expect(options.retry).toEqual({enabled:false});
  expect(request.mock.calls.filter(([url])=>String(url).includes('/resume?'))).toHaveLength(3);
  expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);expect(button('Continue existing checkout')).toBeUndefined();
});
it.each(['/pricing?offer=cluera_pack_3h_v2',`/account/checkout?offer=cluera_pack_3h_v2&desktopAccount=${userId}`])('the plan-card continuation opens only the original popup and preserves route/handoff: %s',async path=>{
  history.replaceState(null,'',path);createdBinding=makeBound().payment;
  let options:Record<string,any>={};const open=vi.fn();
  window.Razorpay=class{constructor(value:Record<string,unknown>){options=value;}open=open;close=vi.fn();on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')?Response.json(makeBound()):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();
  expect(buy().textContent).toBe('Continue payment');expect(buy().disabled).toBe(false);
  expect(subscribe().textContent).toBe('Subscribe');expect(subscribe().disabled).toBe(true);
  expect(host.textContent).toContain('Subscriptions for this plan are not open yet.');
  expect(host.textContent).not.toContain('Checkout unavailable');
  await act(async()=>{buy().click();buy().click();});
  expect(open).toHaveBeenCalledOnce();expect(options.order_id).toBe(orderId);
  expect(options.callback_url).toBeUndefined();expect(options.redirect).not.toBe(true);
  expect(options.modal).toMatchObject({backdropclose:false,escape:true});
  expect(location.pathname+location.search).toBe(path);
  await act(async()=>options.modal.ondismiss());
  expect(location.pathname+location.search).toBe(path);expect(buy().dataset.checkoutAction).toBe('resume');
  expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
});

it('a retained order that fails strict server verification never loads SDK, retries payment or creates a replacement order',async()=>{
  createdBinding=makeBound().payment;const open=vi.fn();window.Razorpay=class{open=open;close=vi.fn();on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')?new Response(null,{status:503}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();expect(button('Continue existing checkout')).toBeUndefined();
  expect(open).not.toHaveBeenCalled();expect(document.querySelector('script')).toBeNull();expect(host.textContent).toContain('existing order cannot safely continue');
  expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);expect(buy().disabled).toBe(true);
});
it('checks a saved BOUND order before showing Continue and explains an attempted-order refusal',async()=>{
 createdBinding=makeBound().payment;
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')
  ?Response.json({code:'ORDER_RECONCILIATION_REQUIRED',error:'PRIVATE_DO_NOT_REFLECT'},{status:409}):checkoutGet(url));
 vi.stubGlobal('fetch',request);await renderCheckout();
 expect(host.textContent).toContain('already has a payment attempt');expect(host.textContent).toContain('15m');
 expect(button('Continue existing checkout')).toBeUndefined();expect(buy().disabled).toBe(true);
 expect(document.querySelector('script[src*="razorpay"]')).toBeNull();expect(host.textContent).not.toContain('PRIVATE_DO_NOT_REFLECT');
 expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
});
it.each(['initial','explicit'] as const)('a stalled %s resume settles without a popup or a late response restoring Continue',async phase=>{
 vi.useFakeTimers();
 try{
  createdBinding=makeBound().payment;let stall=phase==='initial',finish!:(value:Response)=>void;
  const open=vi.fn();window.Razorpay=class{open=open;close=vi.fn();on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')&&stall
   ?new Promise<Response>(resolve=>{finish=resolve;}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();
  if(phase==='explicit'){stall=true;await act(async()=>button('Continue existing checkout').click());}
  expect(button('Continue existing checkout')).toBeUndefined();
  await act(async()=>vi.advanceTimersByTimeAsync(15001));
  expect(button('Refresh billing status').disabled).toBe(false);
  expect(host.textContent).not.toContain('Preparing your secure checkout');
  expect(host.textContent).toContain('15m');expect(buy().disabled).toBe(true);
  const notice=host.querySelector('[role="status"]')!.textContent;
  await act(async()=>{finish(Response.json(makeBound()));await vi.advanceTimersByTimeAsync(120000);});
  expect(host.querySelector('[role="status"]')!.textContent).toBe(notice);
  expect(button('Continue existing checkout')).toBeUndefined();expect(open).not.toHaveBeenCalled();
  expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
 }finally{vi.useRealTimers();}
});
it('a deferred SDK must repeat untouched-order proof immediately before continuation; a changed provider outcome cannot open',async()=>{
  createdBinding=makeBound().payment;let checks=0;const open=vi.fn();
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')?++checks<=2?Response.json(makeBound()):new Response(null,{status:409}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();await act(async()=>button('Continue existing checkout').click());
  const script=document.querySelector<HTMLScriptElement>('script[src*="razorpay"]');expect(script).not.toBeNull();
  window.Razorpay=class{open=open;close=vi.fn();on=vi.fn();};await act(async()=>script!.dispatchEvent(new Event('load')));
  expect(checks).toBe(3);expect(open).not.toHaveBeenCalled();expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
});
it.each([409,503])('a failed resume %s survives background polling and requires explicit successful verification before reoffering',async(http)=>{
 vi.useFakeTimers();
 try{
  createdBinding=makeBound().payment;let allowed=true;const open=vi.fn();window.Razorpay=class{open=open;close=vi.fn();on=vi.fn();};
  const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>String(url).includes('/resume?')
   ?allowed?Response.json(makeBound()):Response.json({error:'PRIVATE_DO_NOT_REFLECT'},{status:http}):checkoutGet(url));
  vi.stubGlobal('fetch',request);await renderCheckout();allowed=false;await act(async()=>button('Continue existing checkout').click());
  const failure=host.querySelector('[role="status"]')!.textContent;
  expect(button('Continue existing checkout')).toBeUndefined();expect(buy().disabled).toBe(true);
  await act(async()=>vi.advanceTimersByTimeAsync(120000));
  expect(host.querySelector('[role="status"]')!.textContent).toBe(failure);
  expect(button('Continue existing checkout')).toBeUndefined();expect(host.textContent).toContain('15m');
  expect(request.mock.calls.filter(([url])=>String(url).includes('/resume?'))).toHaveLength(2);
  await act(async()=>button('Refresh billing status').click());
  expect(button('Continue existing checkout')).toBeUndefined();
  allowed=true;await act(async()=>button('Refresh billing status').click());
  expect(button('Continue existing checkout').disabled).toBe(false);expect(open).not.toHaveBeenCalled();
  await act(async()=>button('Continue existing checkout').click());expect(open).toHaveBeenCalledOnce();
  expect(request.mock.calls.every(([,init])=>init?.method!=='POST')).toBe(true);
 }finally{vi.useRealTimers();}
});
it('only exact authoritative resolved resource IDs unlock a known order', async () => {
  let resolved = false,opened=false; const close = vi.fn();
  window.Razorpay = class { open = vi.fn(()=>{opened=true;}); close = close; on = vi.fn(); };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST' ? Response.json(bound())
    : String(url).includes('/checkout?') && (!createdBinding || opened) ? Response.json({ payment: { ...status.payment, resolvedOrderIds: resolved ? [orderId] : ['order_foreign0001'] } }) : checkoutGet(url));
  vi.stubGlobal('fetch', request); await renderCheckout(); await act(async () => buy().click());
  await act(async () => button('Refresh billing status').click()); expect(buy().disabled).toBe(true); expect(close).not.toHaveBeenCalled();
  resolved = true; await act(async () => button('Refresh billing status').click()); expect(buy().disabled).toBe(false); expect(close).toHaveBeenCalledOnce();
});

it('rejects a desktop/browser owner mismatch without exposing identity or creating orders', async () => {
  history.replaceState(null, '', '/account/checkout?desktopAccount=00000000-0000-4000-8000-000000000999');
  const request = vi.fn(async (url: RequestInfo | URL) => checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); expect(host.textContent).not.toContain('Signed in as');
  expect(host.querySelectorAll('.account-plan-card')).toHaveLength(4);
  expect([...host.querySelectorAll<HTMLButtonElement>('.account-plan-card button')].every(item => item.disabled)).toBe(true);
  expect(request.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
});

it('malformed desktop owner hint cannot silently become an unpinned checkout session', async () => {
  history.replaceState(null, '', '/account/checkout?desktopAccount=invalid-account');
  const request = vi.fn(async (url: RequestInfo | URL) => checkoutGet(url)); vi.stubGlobal('fetch', request);
  await renderCheckout(); expect(request).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Signed in as');
  expect([...host.querySelectorAll<HTMLButtonElement>('.account-plan-card button')].every(item => item.disabled)).toBe(true);
});

it('public revision DTO rejects secret/plan fields, weekly cadence, old codes and excessive recurring charges', () => {
  expect(clueraPublicRevision.safeParse(catalog[0]).success).toBe(true);
  for (const row of [{ ...catalog[0], keySecret: 'secret' }, { ...catalog[1], razorpayPlanId: 'plan_synthetic0001' },
    { ...catalog[1], interval: 'WEEK' }, { ...catalog[0], offerCode: 'pro_3_hours' }, { ...catalog[1], totalCount: 121 }]) {
    expect(clueraPublicRevision.safeParse(row).success).toBe(false);
  }
});

it('preserves the authoritative resume denial when sequential reads take more than fifteen seconds altogether', async () => {
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController(); setTimeout(() => controller.abort(), ms); return controller.signal;
  });
  createdBinding = makeBound().payment;
  const request = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    const path = String(url);
    const delay = path.includes('/credits') ? 8000 : path.includes('/checkout?') ? 5000 : path.includes('/resume?') ? 4000 : 0;
    await new Promise(resolve => setTimeout(resolve, delay));
    return path.includes('/resume?') ? Response.json({code:'ORDER_RECONCILIATION_REQUIRED'}, {status:409}) : checkoutGet(url);
  });
  vi.stubGlobal('fetch', request);
  try {
    await renderCheckout();
    await act(async () => vi.advanceTimersByTimeAsync(17001));
    expect(host.textContent).toContain('This order already has a payment attempt');
    expect(host.textContent).toContain('Synthetic Tester'); expect(host.textContent).toContain('15m');
    expect(button('Continue existing checkout')).toBeUndefined(); expect(buy().disabled).toBe(true);
    expect(button('Refresh billing status').disabled).toBe(false);
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    expect(document.querySelector('script[src*="razorpay"]')).toBeNull();
  } finally { timeout.mockRestore(); vi.useRealTimers(); }
});

it('keeps automatic checks quiet while preserving the attempted-order reason and explicit refresh progress', async () => {
  vi.useFakeTimers(); createdBinding = makeBound().payment;
  let slow = false;
  const request = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
    if (slow && String(url).includes('/credits')) await new Promise(resolve => setTimeout(resolve, 4000));
    return String(url).includes('/resume?') ? Response.json({code:'ORDER_RECONCILIATION_REQUIRED'}, {status:409}) : checkoutGet(url);
  });
  vi.stubGlobal('fetch', request);
  try {
    await renderCheckout(); slow = true;
    await act(async () => vi.advanceTimersByTimeAsync(30000));
    expect(host.textContent).toContain('This order already has a payment attempt');
    expect(host.textContent).not.toContain('Refreshing payment status');
    expect(host.textContent).not.toContain('Checking payment availability');
    expect(button('Refresh billing status').disabled).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    await act(async () => button('Refresh billing status').click());
    expect(host.textContent).toContain('Refreshing payment status');
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(host.textContent).toContain('This order already has a payment attempt');
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    const reads = request.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(120000));
    expect(request.mock.calls).toHaveLength(reads);
    expect(request.mock.calls.filter(([url]) => String(url).includes('/resume?'))).toHaveLength(2);
    expect(button('Continue existing checkout')).toBeUndefined(); expect(buy().disabled).toBe(true);
    expect(request.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  } finally { vi.useRealTimers(); }
});

const renderAdmin = async (disabled = false) => { await act(async () => root.render(createElement(BillingCatalog, { disabled }))); };
async function readyAdmin() {
  await renderAdmin(); await act(async () => button('Refresh billing catalog').click());
  await act(async () => button('Load billing authenticators').click());
}
function fillAdminForm() {
  const form = host.querySelector('form')!;
  (form.elements.namedItem('factor') as HTMLSelectElement).value = factorId;
  (form.elements.namedItem('code') as HTMLInputElement).value = '123456';
  (form.elements.namedItem('reason') as HTMLTextAreaElement).value = 'Synthetic future price revision';
  return form;
}
const adminGet = (url: RequestInfo | URL) => Response.json(String(url).includes('factors=1')
  ? { factors: [{ id: factorId, status: 'verified' }] } : { code: 'ACTIVE', catalog });

it('Admin is explicit-read only and fails closed before approved billing schema with no raw body echo', async () => {
  const request = vi.fn(async () => Response.json({ error: 'private-db-diagnostic' }, { status: 503 })); vi.stubGlobal('fetch', request);
  await renderAdmin(); expect(request).not.toHaveBeenCalled();
  await act(async () => button('Refresh billing catalog').click()); expect(host.textContent).toContain('schema is not available');
  expect(host.textContent).not.toContain('private-db-diagnostic'); expect(host.querySelector('form')).toBeNull();
});

it('Admin creates a disabled immutable future revision with exact paise/time, clears MFA code and deduplicates submit', async () => {
  const changed = { ...catalog[0], revisionId: '00000000-0000-4000-8000-000000000899', version: 2, amountPaise: 59950, enabled: false };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ code: 'APPLIED', revision: changed }) : adminGet(url)); vi.stubGlobal('fetch', request); await readyAdmin();
  const form = fillAdminForm(); (form.elements.namedItem('price') as HTMLInputElement).value = '599.50';
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({ action: 'CREATE_REVISION', offerCode: catalog[0].offerCode,
    expectedRevisionId: catalog[0].revisionId, factorId, code: '123456', operationId: expect.any(String),
    input: { amountPaise: 59950, allowanceSeconds: 10800, razorpayPlanId: null, totalCount: null } });
  expect((form.elements.namedItem('code') as HTMLInputElement).value).toBe('');
  expect(host.textContent).toContain('Revision 2'); expect(host.textContent).toContain('current catalog revision is disabled');
});

it('Admin unknown outcome stays locked through refresh and is verified by GET, never retransmitted', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: 'raw-private-body' }, { status: 503 }) : String(url).includes('operation=')
      ? Response.json({ code: 'APPLIED', revision: { ...catalog[0], enabled: false } }) : adminGet(url));
  vi.stubGlobal('fetch', request); await readyAdmin(); const form = fillAdminForm();
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('fieldset')!.disabled).toBe(true); expect(host.textContent).not.toContain('raw-private-body');
  await act(async () => button('Refresh billing catalog').click()); expect(host.querySelector('fieldset')!.disabled).toBe(true);
  await act(async () => button('Verify original billing change').click());
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  expect(host.textContent).toContain('Audited change confirmed');
});

it('Admin rejects missing fresh authenticator code and does not enroll or auto-enable any provider/payments', async () => {
  const request = vi.fn(async (url: RequestInfo | URL) => adminGet(url)); vi.stubGlobal('fetch', request); await readyAdmin();
  const form = fillAdminForm(); (form.elements.namedItem('code') as HTMLInputElement).value = 'wrong';
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(request.mock.calls.every(([, init]) => !(init as RequestInit | undefined)?.method)).toBe(true);
  expect(host.textContent).toContain('fresh six-digit code'); expect(host.textContent).toContain('never creates provider plans');
});

it('Admin catalog availability sends only the intended SET_ENABLED action and does not reprice existing records', async () => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ code: 'APPLIED', revision: { ...catalog[0], enabled: false } }) : adminGet(url));
  vi.stubGlobal('fetch', request); await readyAdmin(); const form = fillAdminForm();
  (form.elements.namedItem('action') as HTMLSelectElement).value = 'SET_ENABLED';
  (form.elements.namedItem('enabled') as HTMLInputElement).checked = false;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(JSON.parse(request.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as string)).toMatchObject({ action: 'SET_ENABLED', input: { enabled: false } });
});

it.each([true, false])('catalog confirmation reports audited availability %s without implying checkout or worker activation', async enabled => {
  const changed = { ...catalog[0], enabled };
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ code: 'APPLIED', revision: changed }) : adminGet(url));
  vi.stubGlobal('fetch', request); await readyAdmin(); const form = fillAdminForm();
  (form.elements.namedItem('action') as HTMLSelectElement).value = 'SET_ENABLED';
  (form.elements.namedItem('enabled') as HTMLInputElement).checked = enabled;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const statusMessage = host.querySelector('[role="status"]')!.textContent;
  expect(statusMessage).toContain(`current catalog revision is ${enabled ? 'enabled' : 'disabled'}`);
  expect(statusMessage).toContain('does not activate checkout or change webhook/scheduler ownership');
  const changedCard = [...host.querySelectorAll('article')].find(card => card.querySelector('h3')?.textContent === catalog[0].name)!;
  expect(changedCard.querySelector('header')!.textContent).toContain(enabled ? 'Catalog enabled' : 'Catalog disabled');
  const writes = request.mock.calls.filter(([, init]) => init?.method === 'POST'); expect(writes).toHaveLength(1);
  expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({ action: 'SET_ENABLED', expectedRevisionId: catalog[0].revisionId,
    factorId, code: '123456', input: { enabled } });
  expect((form.elements.namedItem('code') as HTMLInputElement).value).toBe('');
  expect(request.mock.calls.every(([url]) => String(url).startsWith('/api/account/payments/cluera/admin'))).toBe(true);
});

it.each([true, false])('catalog confirmation uses original-operation read-back availability %s without another mutation', async enabled => {
  const request = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ error: 'Outcome unknown' }, { status: 503 }) : String(url).includes('operation=')
      ? Response.json({ code: 'APPLIED', revision: { ...catalog[0], enabled } }) : adminGet(url));
  vi.stubGlobal('fetch', request); await readyAdmin(); const form = fillAdminForm();
  (form.elements.namedItem('action') as HTMLSelectElement).value = 'SET_ENABLED';
  (form.elements.namedItem('enabled') as HTMLInputElement).checked = enabled;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('fieldset')!.disabled).toBe(true);
  await act(async () => button('Verify original billing change').click());
  expect(host.querySelector('[role="status"]')!.textContent).toContain(`current catalog revision is ${enabled ? 'enabled' : 'disabled'}`);
  expect(request.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  const mutation = JSON.parse(request.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body as string);
  const read = request.mock.calls.find(([url]) => String(url).includes('operation='))!;
  expect(String(read[0])).toContain(`operation=${mutation.operationId}`); expect(read[1]?.method).toBeUndefined();
});

it('Admin rejects secret-bearing metadata instead of rendering it or enabling mutation', async () => {
  const request = vi.fn(async () => Response.json({ code: 'ACTIVE', catalog: [{ ...catalog[0], apiSecret: 'private-secret' }] }));
  vi.stubGlobal('fetch', request); await renderAdmin(); await act(async () => button('Refresh billing catalog').click());
  expect(host.textContent).not.toContain('private-secret'); expect(host.querySelector('form')).toBeNull();
});

it('Admin disabled owner boundary aborts a read and fences its late response', async () => {
  let resolve!: (response: Response) => void, signal: AbortSignal | undefined;
  const request = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal as AbortSignal; return new Promise<Response>(done => { resolve = done; }); });
  vi.stubGlobal('fetch', request); await renderAdmin(); await act(async () => button('Refresh billing catalog').click());
  await renderAdmin(true); expect(signal!.aborted).toBe(true);
  await act(async () => resolve(Response.json({ code: 'ACTIVE', catalog }))); expect(host.querySelector('form')).toBeNull();
});

const syncCatalog=catalog.slice(1).map(row=>({...row,razorpayPlanId:null,enabled:false,testPlanValidated:false}));
const syncRead=(url:RequestInfo|URL,operations:unknown[]=[])=>Response.json(String(url).includes('factors=1')?{factors:[{id:factorId,status:'verified'}]}:{code:'ACTIVE',catalog:syncCatalog,operations});
async function readySync(){await act(async()=>root.render(createElement(TestPlanSync)));await act(async()=>button('Refresh Test plan sync').click());}
it('Test plan UI is explicit and sends one reviewed creation with exact prices, clearing the MFA input',async()=>{
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json({code:'APPLIED',revision:{...catalog[1],enabled:false}}):syncRead(url));
 vi.stubGlobal('fetch',request);await act(async()=>root.render(createElement(TestPlanSync)));expect(request).not.toHaveBeenCalled();
 await act(async()=>button('Refresh Test plan sync').click());const form=fillAdminForm();
 await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 const writes=request.mock.calls.filter(([,init])=>init?.method==='POST');expect(writes).toHaveLength(1);
 expect(JSON.parse(writes[0][1]!.body as string)).toMatchObject({action:'CREATE_TEST_PLAN',offerCode:catalog[1].offerCode,expectedRevisionId:catalog[1].revisionId,
  input:{amountPaise:549900,allowanceSeconds:144000,totalCount:120},factorId,code:'123456'});
 expect((form.elements.namedItem('code') as HTMLInputElement).value).toBe('');expect(host.textContent).toContain('Test plan mapped and verified');
});
it('a pending Test plan is recovered from the database after remount and sends reconciliation instead of another create',async()=>{
 const op={operationId:factorId,offerCode:catalog[1].offerCode,expectedRevisionId:catalog[1].revisionId,state:'BOUND',
  input:{name:catalog[1].name,amountPaise:549900,allowanceSeconds:144000,totalCount:120},reason:'Original reviewed Test setup',razorpayPlanId:'plan_syntheticSync0001'};
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json({code:'APPLIED',revision:{...catalog[1],enabled:false}}):syncRead(url,[op]));
 vi.stubGlobal('fetch',request);await readySync();expect(host.textContent).toContain(op.razorpayPlanId);
 const form=host.querySelector('form')!;(form.elements.namedItem('factor') as HTMLSelectElement).value=factorId;(form.elements.namedItem('code') as HTMLInputElement).value='123456';
 await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(JSON.parse(request.mock.calls.find(([,init])=>init?.method==='POST')![1]!.body as string)).toEqual({action:'RECONCILE_TEST_PLAN',operationId:op.operationId,factorId,code:'123456',input:{razorpayPlanId:op.razorpayPlanId}});
});
it('lost plan response stays locked when an immediate catalog read has not found the durable operation yet',async()=>{
 const request=vi.fn(async(url:RequestInfo|URL,init?:RequestInit)=>init?.method==='POST'?Response.json({error:'private-provider-payload'},{status:503}):syncRead(url));
 vi.stubGlobal('fetch',request);await readySync();const form=fillAdminForm();await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await act(async()=>button('Refresh Test plan sync').click());expect(host.textContent).toContain('Unresolved operation:');
 expect(button('Reconcile original Test plan')).toBeDefined();expect(request.mock.calls.filter(([,init])=>init?.method==='POST')).toHaveLength(1);
 expect(host.textContent).not.toContain('private-provider-payload');
});
it('Live Admin never mounts Test creation controls',async()=>{
 await act(async()=>root.render(createElement(BillingCatalog,{mode:'live'})));expect(button('Refresh Test plan sync')).toBeUndefined();
});

