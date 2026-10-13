// @vitest-environment jsdom
import {createElement,act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import CheckoutClient from '../app/account/checkout/CheckoutClient';

const offers=[
  {code:'pro_3_hours',name:'SigmaPro 3 Hours',label:'3 hours'},
  {code:'pro_40_hours',name:'SigmaPro 40 Hours',label:'40 hours'},
  {code:'enterprise_weekly',name:'SigmaEnterprise Weekly',label:'Weekly'},
  {code:'enterprise_monthly',name:'SigmaEnterprise Monthly',label:'Monthly'},
];
let host:HTMLDivElement,root:Root;
beforeEach(async()=>{
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(async()=>{root.render(createElement(StrictMode,null,createElement(CheckoutClient,{clientToken:'test_synthetic',offers})));});
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete window.Paddle;vi.unstubAllGlobals();vi.restoreAllMocks();});
function buttons(){return Array.from(host.querySelectorAll('button'));}
function cards(){return Array.from(host.querySelectorAll('[role="group"]'));}
function deferred(){let finish!:(value:Response)=>void;const promise=new Promise<Response>(resolve=>{finish=resolve;});return{promise,finish};}

describe('checkout click isolation with real React events',()=>{
  it('opens only the bound transaction, strips _ptxn, and keeps selection locked through completed/closed/failed browser events',async()=>{
    let event!:(value:{name?:string})=>void;
    const initialized=vi.fn(options=>{event=options.eventCallback;}),opened=vi.fn(),changed=vi.fn();
    window.Paddle={Environment:{set:vi.fn()},Initialize:initialized,Checkout:{open:opened,close:vi.fn()}};
    history.replaceState(null,'','/account/checkout?_ptxn=txn_untrusted&amount=1#untrusted');
    const fetcher=vi.fn(async()=>Response.json({checkout:{code:'BOUND',transactionId:'txn_'+'a'.repeat(26)}}));vi.stubGlobal('fetch',fetcher);
    await act(async()=>root.render(createElement(CheckoutClient,{clientToken:'test_synthetic',offers,onCheckoutEvent:changed})));
    await act(async()=>buttons()[0].click());
    expect(fetcher).toHaveBeenCalledOnce();expect(location.search).toBe('');expect(location.hash).toBe('');
    expect(window.Paddle.Environment.set).toHaveBeenCalledWith('sandbox');expect(opened).toHaveBeenCalledWith({transactionId:'txn_'+'a'.repeat(26),settings:{displayMode:'overlay',showAddDiscounts:false}});
    expect(buttons().every(button=>button.disabled)).toBe(true);
    for(const name of ['checkout.completed','checkout.closed','checkout.payment.failed','checkout.payment.error'])await act(async()=>event({name}));
    expect(changed).toHaveBeenCalledTimes(4);expect(buttons().every(button=>button.disabled)).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();expect(cards()[0].textContent).toContain('Do not retry');
  });
  it('sends only pro_3_hours once, even for rapid same/other-plan clicks; only its card is busy',async()=>{
    const pending=deferred(),fetcher=vi.fn(()=>pending.promise);vi.stubGlobal('fetch',fetcher);
    await act(async()=>{buttons()[0].click();buttons()[0].click();buttons()[1].click();buttons()[2].click();buttons()[3].click();});
    expect(fetcher).toHaveBeenCalledOnce();
    const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];
    expect(url).toBe('/api/account/checkout');expect(init.method).toBe('POST');
    const body=JSON.parse(String(init.body));expect(Object.keys(body).sort()).toEqual(['offerCode','requestId']);
    expect(body.offerCode).toBe('pro_3_hours');expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(buttons().map(button=>button.getAttribute('aria-busy'))).toEqual(['true','false','false','false']);
    expect(buttons()[0].textContent).toBe('Preparing checkout…');
    expect(buttons().slice(1).every(button=>button.textContent==='Continue in sandbox')).toBe(true);
    expect(cards().slice(1).every(card=>!card.querySelector('[role="status"]'))).toBe(true);
    await act(async()=>{pending.finish(Response.json({checkout:{code:'PENDING'}},{status:409}));});
    expect(cards()[0].textContent).toContain('Do not retry');
    expect(cards().slice(1).every(card=>!card.querySelector('[role="status"]'))).toBe(true);
    expect(buttons().every(button=>button.disabled)).toBe(true);
    await act(async()=>{for(const button of buttons())button.click();});
    expect(fetcher).toHaveBeenCalledOnce();
    expect(document.querySelector('script[src*="paddle"]')).toBeNull();
  });
  it.each([0,1,2,3])('maps card %s only to its own offer and keeps authentication errors local',async(index)=>{
    const fetcher=vi.fn(async()=>Response.json({error:'Sign in'},{status:401}));vi.stubGlobal('fetch',fetcher);
    await act(async()=>buttons()[index].click());
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.parse(String((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body)).offerCode).toBe(offers[index].code);
    expect(cards()[index].textContent).toContain('Sign in with your verified Sigma account');
    expect(cards().filter((_,i)=>i!==index).every(card=>!card.querySelector('[role="status"]'))).toBe(true);
    expect(buttons().every(button=>!button.disabled)).toBe(true);
  });
  it('does not auto-retry a network failure, and keeps its error on the clicked card',async()=>{
    const fetcher=vi.fn(async()=>{throw new Error('synthetic network error');});vi.stubGlobal('fetch',fetcher);
    await act(async()=>buttons()[0].click());
    expect(fetcher).toHaveBeenCalledOnce();expect(buttons().every(button=>button.disabled)).toBe(true);
    expect(cards()[0].textContent).toContain('Checkout needs verification');
    expect(cards().slice(1).every(card=>!card.querySelector('[role="status"]'))).toBe(true);
  });
  it('shows an allowlisted provider denial, never raw details, and locks every offer without loading Paddle',async()=>{
    const fetcher=vi.fn(async()=>Response.json({checkout:{code:'PENDING',failure:{stage:'http',httpStatus:403,providerCode:'forbidden',detail:'synthetic-private-token'}}},{status:409}));vi.stubGlobal('fetch',fetcher);
    await act(async()=>buttons()[0].click());
    expect(cards()[0].textContent).toContain('[CHECKOUT_PERMISSION_DENIED]');expect(host.textContent).not.toContain('synthetic-private-token');
    expect(buttons().every(button=>button.disabled)).toBe(true);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
    await act(async()=>buttons().forEach(button=>button.click()));expect(fetcher).toHaveBeenCalledOnce();
  });
  it('blocks every new plan from a server snapshot without making any request or loading the SDK',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await act(async()=>root.render(createElement(CheckoutClient,{clientToken:'test_synthetic',offers,serverBlocked:true,pendingOfferCode:'pro_3_hours',pendingLabel:'Existing checkout pending'})));
    expect(buttons().every(button=>button.disabled)).toBe(true);expect(buttons()[0].textContent).toBe('Existing checkout pending');
    await act(async()=>buttons().forEach(button=>button.click()));expect(fetcher).not.toHaveBeenCalled();expect(document.querySelector('script[src*="paddle"]')).toBeNull();
  });
  it('a server refresh cannot clear an uncertain local write lock or replace its operation',async()=>{
    const fetcher=vi.fn(async()=>{throw new Error('synthetic unknown write');});vi.stubGlobal('fetch',fetcher);
    await act(async()=>buttons()[0].click());expect(fetcher).toHaveBeenCalledOnce();
    const original=String((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body);
    await act(async()=>root.render(createElement(StrictMode,null,createElement(CheckoutClient,{clientToken:'test_synthetic',offers,serverBlocked:true}))));
    await act(async()=>root.render(createElement(StrictMode,null,createElement(CheckoutClient,{clientToken:'test_synthetic',offers,serverBlocked:false}))));
    expect(buttons().every(button=>button.disabled)).toBe(true);await act(async()=>buttons().forEach(button=>button.click()));expect(fetcher).toHaveBeenCalledOnce();
    expect(String((fetcher.mock.calls[0] as unknown as [string,RequestInit])[1].body)).toBe(original);
  });
  it('a coerced non-string bound transaction ID never opens Paddle or permits another attempt',async()=>{
    const open=vi.fn();window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
    const fetcher=vi.fn(async()=>Response.json({checkout:{code:'BOUND',transactionId:['txn_'+'a'.repeat(26)]}}));vi.stubGlobal('fetch',fetcher);
    await act(async()=>buttons()[0].click());expect(fetcher).toHaveBeenCalledOnce();expect(open).not.toHaveBeenCalled();
    expect(buttons().every(button=>button.disabled)).toBe(true);expect(document.querySelector('script[src*="paddle"]')).toBeNull();
  });
  it('a parent owner/epoch refusal fences SDK opening and query stripping before React unmount',async()=>{
    const open=vi.fn(),acknowledge=vi.fn(()=>false);window.Paddle={Environment:{set:vi.fn()},Initialize:vi.fn(),Checkout:{open,close:vi.fn()}};
    const transactionId='txn_'+'z'.repeat(26),fetcher=vi.fn(async()=>Response.json({checkout:{code:'BOUND',transactionId}}));vi.stubGlobal('fetch',fetcher);
    history.replaceState(null,'','/account/checkout?desktopAccount=00000000-0000-4000-8000-000000000001');
    await act(async()=>root.render(createElement(CheckoutClient,{clientToken:'test_synthetic',offers,onBoundCheckout:acknowledge})));
    await act(async()=>buttons()[0].click());
    expect(acknowledge).toHaveBeenCalledWith({transactionId,offerCode:'pro_3_hours'});expect(open).not.toHaveBeenCalled();
    expect(location.search).toContain('desktopAccount=');expect(buttons().every(button=>button.disabled)).toBe(true);expect(fetcher).toHaveBeenCalledOnce();
    expect(document.querySelector('script[src*="paddle"]')).toBeNull();
  });
});
