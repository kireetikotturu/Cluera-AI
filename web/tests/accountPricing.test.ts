import {renderToStaticMarkup} from 'react-dom/server';
import {afterEach,it,expect,vi} from 'vitest';
import {AccountPricing} from '../app/AccountPricing';
import PricingPage from '../app/pricing/page';
import {clueraTargetPlans} from '../lib/cluera/targetPlans';
import {offerDisplay} from '../lib/billing/offerDisplay';
import type {ClueraPublicRevision} from '../lib/payments/cluera/publicCatalog';
vi.mock('next/navigation',()=>({notFound:()=>{throw Error('NOT_FOUND');}}));
afterEach(()=>vi.unstubAllEnvs());
it('shows four reviewed prices/hours, honest terms and no payment SDK or promised Remote Desktop',()=>{
 const html=renderToStaticMarkup(AccountPricing());
 for(const offer of clueraTargetPlans){const display=offerDisplay(offer);expect(html).toContain(offer.name);expect(html).toContain(display.label);expect(html).toContain(display.terms);}
 expect(html).toContain('do not roll over');expect(html).toContain('before packs');expect(html).toContain('not active payment offers');
 expect(html).toContain('Remote Desktop and Mobile are not included');expect(html).not.toMatch(/<script|<iframe|<form|SigmaEnterprise Weekly/);
 expect((html.match(/href="\/account\/checkout"/g)||[])).toHaveLength(4);
 expect(html).toContain('Checkout unavailable');expect(html).toContain('100 hours per month');
});
it('always presents Cluera pricing without enabling a financial route',()=>{
 vi.stubEnv('SIGMAROUND_ACCOUNTS_ENABLED','false');const html=renderToStaticMarkup(PricingPage());expect(html).toContain('Cluera 3 Hours');expect(html).toContain('not active payment offers');expect(html).not.toMatch(/<form|<script|<iframe/);
});
it('uses current immutable Admin revisions for future presentation without changing target/history aliases or starting checkout',()=>{
 const codes=['cluera_pack_3h_v2','cluera_monthly_40h_v2','cluera_monthly_100h_v2','cluera_monthly_200h_v2'] as const;
 const catalog:ClueraPublicRevision[]=codes.map((offerCode,index)=>({offerCode,revisionId:`00000000-0000-4000-8000-00000000080${index}`,name:`Future revision ${index}`,
  amountPaise:59900+index*10000,currency:'INR',allowanceSeconds:14400,kind:index?'RECURRING':'PACK',interval:index?'MONTH':null,totalCount:index?120:null,
  enabled:false,version:2,testPlanValidated:!index}));
 const html=renderToStaticMarkup(AccountPricing({catalog}));
 expect(html).toContain('₹599');expect(html).toContain('4 hours');expect(html).toContain('Revision 2');
 expect(html).toContain('historical prices never change');expect(html).not.toContain('₹549');expect(html).not.toMatch(/<script|<iframe|<form/);
 expect(clueraTargetPlans[0].amount).toBe('54900');
});
