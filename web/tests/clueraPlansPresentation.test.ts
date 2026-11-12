import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ClueraCheckoutClient from '../app/account/checkout/ClueraCheckoutClient';
import { AccountPricing } from '../app/AccountPricing';
import type { ClueraPublicRevision } from '../lib/payments/cluera/publicCatalog';

const plan = (n: number, name: string, amountPaise: number, hours: number): ClueraPublicRevision => ({
  revisionId: `00000000-0000-4000-8000-00000000030${n}`, offerCode: 'cluera_pack_3h_v2', name, version: n, amountPaise, currency: 'INR',
  allowanceSeconds: hours * 3600, kind: 'PACK', interval: null, totalCount: null, testPlanValidated: true, enabled: true });
const checkout = (props: object) => renderToStaticMarkup(createElement(ClueraCheckoutClient, { enabled: true, mode: 'live', ...props } as never));

describe('website pricing and checkout show only the plans that are On, from the catalog', () => {
  it('checkout lists exactly the plans given, with their real prices and hours, and invents none', () => {
    const html = checkout({ offers: [plan(1, 'Starter Pack', 19900, 2), plan(2, 'Big Pack', 249900, 25)], catalogKnown: true });
    expect(html).toContain('Starter Pack'); expect(html).toContain('₹199'); expect(html).toContain('2 hours');
    expect(html).toContain('Big Pack'); expect(html).toContain('₹2,499'); expect(html).toContain('25 hours');
    expect(html).not.toContain('Cluera 3 Hours'); expect(html).not.toContain('₹549'); expect(html).not.toContain('Presentation only');
  });
  it('checkout says nothing is on sale instead of showing invented preview prices when every plan is Off', () => {
    const html = checkout({ offers: [], catalogKnown: true });
    expect(html).toContain('No plans are on sale right now');
    expect(html).not.toContain('₹549'); expect(html).not.toContain('Presentation only'); expect(html).not.toContain('Buy Now');
    expect(html).not.toContain('Monthly plans and changes');
  });
  it('the home-page pricing block follows the same rule and no longer says "Test"', () => {
    const none = renderToStaticMarkup(createElement(AccountPricing, { catalog: [] }));
    expect(none).toContain('No plans are on sale right now'); expect(none).not.toContain('₹549');
    const one = renderToStaticMarkup(createElement(AccountPricing, { catalog: [plan(1, 'Only Plan', 99900, 10)] }));
    expect(one).toContain('Only Plan'); expect(one).toContain('₹999'); expect(one).toContain('10 hours');
    expect(one).not.toMatch(/Test catalog|Approved Test|Razorpay Test/); expect(one).toContain('Buy Now');
    expect(renderToStaticMarkup(createElement(AccountPricing))).toContain('Paid plans are not yet available');
  });
});
