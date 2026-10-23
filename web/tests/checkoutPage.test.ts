import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {afterEach,describe,it,expect,vi} from 'vitest';
import CheckoutPage from '../app/account/checkout/page';
import {readAccountCatalog} from '../lib/accounts/catalog';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
vi.mock('../lib/accounts/catalog',()=>({readAccountCatalog:vi.fn()}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('NOT_FOUND');}}));
afterEach(()=>{vi.unstubAllEnvs();vi.mocked(readAccountCatalog).mockReset();});
function staging(){
  for(const [key,value] of Object.entries({CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED:'true',SIGMAROUND_ACCOUNTS_ENABLED:'true',PADDLE_ENVIRONMENT:'sandbox',
    SIGMAROUND_ACCOUNT_ORIGIN:'https://cluera-ai-staging.vercel.app',NEXT_PUBLIC_SUPABASE_URL:'https://yhnqlfcgrmckhyjdxegg.supabase.co',
    SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF:'yhnqlfcgrmckhyjdxegg'}))vi.stubEnv(key,value);
}
describe('disabled staging checkout landing page',()=>{
  it('renders a paused Cluera page without provisioning Paddle or Razorpay configuration',async()=>{
    staging();vi.stubEnv('CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','false');
    for(const name of ['PADDLE_ENVIRONMENT','SIGMAROUND_PADDLE_SANDBOX_PROJECT_REF','RAZORPAY_ENVIRONMENT','RAZORPAY_TEST_KEY_ID','NEXT_PUBLIC_PADDLE_CLIENT_TOKEN'])vi.stubEnv(name,'');
    vi.mocked(readAccountCatalog).mockResolvedValue(sandboxOffers.map((offer,priority)=>({...offer,enabled:true,priority})));
    const html=renderToStaticMarkup(await CheckoutPage());expect(html).toContain('Test payments are paused');
    expect((html.match(/<button[^>]*disabled[^>]*>(Buy Now|Subscribe)<\/button>/g)||[])).toHaveLength(4);
    expect((html.match(/<button[^>]*disabled[^>]*>Refresh billing history<\/button>/g)||[])).toHaveLength(1);
    expect((html.match(/disabled=""/g)||[])).toHaveLength(5);
    expect(html).not.toMatch(/<script|<iframe|<form/);expect(html).toContain('Recurring offers and Stripe are unavailable');
    expect(html).toContain('not active catalog offers');expect(html).toContain('100 hours per month');
    expect(readAccountCatalog).not.toHaveBeenCalled();
  });
  it('does not expose even paused presentation on a wrong Account target',async()=>{
    staging();vi.stubEnv('CLUERA_TEST_PAYMENT_ROLLOUT_APPROVED','false');vi.stubEnv('SIGMAROUND_ACCOUNT_ORIGIN','https://foreign.invalid');
    await expect(CheckoutPage()).rejects.toThrow('NOT_FOUND');expect(readAccountCatalog).not.toHaveBeenCalled();
  });
  it('stays disabled even when client token exists and exposes no value or SDK',async()=>{
    staging();vi.stubEnv('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN','test_syntheticneverexpose0123456');
    vi.mocked(readAccountCatalog).mockResolvedValue(sandboxOffers.map((offer,priority)=>({...offer,enabled:true,priority})));
    const request=vi.spyOn(globalThis,'fetch');
    try{
      const html=renderToStaticMarkup(await CheckoutPage());
      expect(html).toContain('Sandbox payments are paused');expect(html).toContain('href="/account"');
      expect(html).not.toContain('syntheticneverexpose');expect(html).not.toMatch(/<script|<iframe|<form/);
      expect((html.match(/Checkout unavailable/g)||[])).toHaveLength(4);
      for(const price of ['₹549','₹5,499','₹19,549'])expect(html).toContain(price);
      expect(request).not.toHaveBeenCalled();
      expect(readAccountCatalog).toHaveBeenCalledTimes(1);
    }finally{request.mockRestore();}
  });
  it('rejects live mode, wrong project and disabled accounts',async()=>{
    staging();vi.stubEnv('PADDLE_ENVIRONMENT','live');await expect(CheckoutPage()).rejects.toThrow('NOT_FOUND');
    staging();vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://bzccuqforilpifhiysjk.supabase.co');await expect(CheckoutPage()).rejects.toThrow('NOT_FOUND');
    staging();vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','false');await expect(CheckoutPage()).rejects.toThrow('NOT_FOUND');
  });
  it('never consumes transaction query parameters or loads checkout code',()=>{
    const source=readFileSync(new URL('../app/account/checkout/page.tsx',import.meta.url),'utf8');
    expect(source).not.toMatch(/searchParams|next\/script|Paddle\.Initialize\(|Checkout\.open\(/);
  });
  it('keeps all four choices paused when the global opt-in lacks the pause and tester prerequisites',async()=>{
    staging();vi.stubEnv('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN','test_syntheticpublicclient000000');
    vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','true');
    vi.mocked(readAccountCatalog).mockResolvedValue(sandboxOffers.map((offer,priority)=>({...offer,enabled:true,priority})));
    const request=vi.spyOn(globalThis,'fetch');
    try{const html=renderToStaticMarkup(await CheckoutPage());
      expect((html.match(/Checkout unavailable/g)||[])).toHaveLength(4);
      expect(html).not.toContain('100 Hours');expect(html).toContain('Sandbox payments are paused');
      expect(request).not.toHaveBeenCalled();
    }finally{request.mockRestore();}
  });
  it('enabled staging still waits for independent verified customer authentication before offering checkout',async()=>{
    staging();vi.stubEnv('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN','test_syntheticpublicclient000000');
    vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','true');vi.stubEnv('SIGMAROUND_ACCOUNT_PAYMENTS_PAUSED','false');
    vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_TESTER_IDS','00000000-0000-4000-8000-000000000001');
    vi.mocked(readAccountCatalog).mockResolvedValue(sandboxOffers.map((offer,priority)=>({...offer,enabled:true,priority})));
    const request=vi.spyOn(globalThis,'fetch');
    try{const html=renderToStaticMarkup(await CheckoutPage());
      expect(html).toContain('Checking your sign-in and server payment status');expect(html).not.toContain('Sandbox payments are paused');
      expect((html.match(/Checkout unavailable/g)||[])).toHaveLength(4);expect(html).not.toMatch(/<script|<iframe|<form/);
      expect(request).not.toHaveBeenCalled();
    }finally{request.mockRestore();}
  });
  it('hides disabled offers and fails closed when catalog approval cannot be read',async()=>{
    staging();vi.stubEnv('NEXT_PUBLIC_PADDLE_CLIENT_TOKEN','test_syntheticpublicclient000000');vi.stubEnv('SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED','true');
    vi.mocked(readAccountCatalog).mockResolvedValue(sandboxOffers.map((offer,priority)=>({...offer,enabled:priority!==0,priority})));
    const html=renderToStaticMarkup(await CheckoutPage());expect((html.match(/Checkout unavailable/g)||[])).toHaveLength(3);expect(html).not.toContain('SigmaPro 3 Hours');
    vi.mocked(readAccountCatalog).mockRejectedValue(new Error('synthetic'));const unavailable=renderToStaticMarkup(await CheckoutPage());
    expect(unavailable).toContain('approved catalog is unavailable');expect(unavailable).not.toContain('Continue in sandbox');
  });
});
