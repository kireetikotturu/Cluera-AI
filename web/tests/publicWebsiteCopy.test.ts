import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import Home from '../app/page';
import Setup from '../app/setup/page';
import Support from '../app/support/page';
it('presents one Cluera account, managed services and honest staging limits',()=>{
 const html=renderToStaticMarkup(createElement(Home));
 expect(html).toContain('One Cluera account');expect(html).toContain('shared account balance');
 expect(html).toContain('no personal provider credentials');expect(html).toContain('Not commercially approved');
 expect(html).not.toMatch(/Bring your own|SigmaRound AI|License &amp; Support|<iframe|<script/);
});
it('explains separate installation, Windows secure storage and opt-in local history',()=>{
 const html=renderToStaticMarkup(createElement(Setup));
 for(const text of ['ClueraAITestSetup-','Windows secure storage','saving transcripts is opt-in','PDF, DOCX, TXT and Markdown'])expect(html).toContain(text);
 expect(html).not.toMatch(/Activate your device|API key field|Connect your AI and audio services/);
});
it('offers bounded safe support without a promised response SLA or private data in links',()=>{
 const html=renderToStaticMarkup(createElement(Support));
 expect(html).toContain('clueraaisupport@gmail.com');expect(html).toContain('Cluera%20Support');expect(html).toContain('/account#resend-verification');
 expect(html).toContain('Never send passwords, API keys, tokens, payment details or private interview content');
 expect(html).toContain('Support cannot bypass verification or MFA');
 expect(html).not.toMatch(/15 minutes during active support|body=|license_key=|token=/);
});
