import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,it,expect,vi} from 'vitest';
import {AccountPricing} from '../app/AccountPricing';
import PricingPage from '../app/pricing/page';
import {sandboxOffers} from '../lib/billing/sandboxCatalog';
import {offerDisplay} from '../lib/billing/offerDisplay';
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
afterEach(()=>vi.unstubAllEnvs());
it('shows four reviewed prices/hours, honest terms and no payment SDK or promised Remote Desktop',()=>{
 const html=renderToStaticMarkup(AccountPricing());
 for(const offer of sandboxOffers){const display=offerDisplay(offer);expect(html).toContain(offer.name);expect(html).toContain(display.label);expect(html).toContain(display.terms);}
 expect(html).toContain('do not roll over');expect(html).toContain('before packs');expect(html).toContain('not collecting live payments');
 expect(html).toContain('Remote Desktop and Mobile are not included');expect(html).not.toMatch(/<script|<iframe|<form|100 Hours/);
 expect((html.match(/href="\/account\/checkout"/g)||[])).toHaveLength(4);
 expect(html).toContain('purchases link to your account automatically');expect(html).not.toContain('Checkout remains paused');
});
it('always presents Cluera pricing without enabling a financial route',()=>{
 vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','false');const html=renderToStaticMarkup(PricingPage());expect(html).toContain('SigmaPro 3 Hours');expect(html).not.toMatch(/<form|<script|<iframe/);
});
