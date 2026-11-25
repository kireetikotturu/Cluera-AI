import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it,vi} from 'vitest';
vi.mock('../lib/accounts/releases',()=>({approvedAccountRelease:vi.fn(async()=>({version:'1.4.0',releaseNotes:'Phone test notes',fileSizeBytes:122_000_000}))}));
import Home from '../app/page';
import Download from '../app/download/page';
import Layout from '../app/layout';

const tags=(html:string,pattern:RegExp):string[]=>html.match(pattern)??[];
/** Every opening tag whose text mentions Download for Windows, with its class list. */
const windowsDownloads=(html:string)=>tags(html,/<a\b[^>]*>Download for Windows/g);

it('hides every Download for Windows button on phones and shows Create session instead',()=>{
 const home=renderToStaticMarkup(Home());
 const downloads=windowsDownloads(home);
 expect(downloads.length).toBeGreaterThanOrEqual(2);
 for(const tag of downloads)expect(tag).toMatch(/class="[^"]*\bon-desktop\b/);
 const create=tags(home,/<a\b[^>]*>Create session/g);
 expect(create.length).toBeGreaterThanOrEqual(4);
 for(const tag of create)expect(tag).toMatch(/class="[^"]*\bon-mobile\b/);
 // signed-in visitors go straight to the live page; signed-out visitors sign in first
 expect(create.filter(tag=>tag.includes('when-signed-in')).every(tag=>tag.includes('href="/account/live"'))).toBe(true);
 expect(create.filter(tag=>tag.includes('when-signed-out')).every(tag=>tag.includes('href="/account?next=live'))).toBe(true);
 expect(home).toContain('Sign in first. Your first 15 minutes are free.');
 // the computer version is untouched
 expect(home).toContain('Download Cluera for Windows');expect(home).toContain('href="/download"');
});
it('shows phone steps instead of the install step on phones',()=>{
 const home=renderToStaticMarkup(Home());
 const steps=tags(home,/<li class="[^"]*"[^>]*><span>\d<\/span><div><b>[^<]*<\/b>/g);
 const mobile=steps.filter(step=>step.includes('on-mobile')),desktop=steps.filter(step=>step.includes('on-desktop'));
 expect(mobile.map(step=>step.replace(/.*<b>|<\/b>/g,''))).toEqual(['Add your context','Create a session']);
 expect(desktop.map(step=>step.replace(/.*<b>|<\/b>/g,''))).toEqual(['Download Cluera for Windows','Start a session']);
});
it('keeps Windows out of the phone header, menu and footer',()=>{
 const layout=renderToStaticMarkup(Layout({children:createElement('main',null,'test')}));
 expect(layout).toMatch(/<a[^>]*class="[^"]*\bon-desktop\b[^"]*"[^>]*href="\/download"[^>]*>Download<\/a>|<a[^>]*href="\/download"[^>]*class="[^"]*\bon-desktop\b[^"]*"[^>]*>Download<\/a>/);
 const downloadLinks=tags(layout,/<a\b[^>]*href="\/download[^"]*"[^>]*>(?:Download)/g);
 expect(downloadLinks.length).toBeGreaterThanOrEqual(3);
 for(const tag of downloadLinks)expect(tag).toMatch(/\bon-desktop\b/);
 expect(layout).toContain('nav-cta');expect(layout).toContain('>Create session<');
});
it('the download page tells a phone there is nothing to install',async()=>{
 const html=renderToStaticMarkup(await Download());
 expect(html).toContain('Nothing to install');
 for(const tag of windowsDownloads(html))expect(tag).toMatch(/\bon-desktop\b/);
 // the version details are for computers only
 expect(html).toMatch(/<h2 class="on-desktop">Latest version 1\.4\.0/);expect(html).toContain('Phone test notes');
 expect(html).toMatch(/<a class="button on-mobile when-signed-in" href="\/account\/live">Create session/);
});

const css=readFileSync(new URL('../app/premium.css',import.meta.url),'utf8');
it('the phone layout rules that keep the home page from shifting are in place',()=>{
 expect(css).toContain('.cluera-site .hero{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}');
 expect(css).toMatch(/@media\(max-width:1000px\)\{[^}]*\.cluera-site \.hero\{grid-template-columns:minmax\(0,1fr\)\}/);
 expect(css).toMatch(/\.typing\{width:auto;white-space:normal;border-right:0;overflow:visible;animation:none\}/);
 expect(css).toContain('@media(max-width:820px),(pointer:coarse){.on-desktop{display:none!important}}');
 expect(css).toContain('.on-mobile{display:none!important}');
 // one 16px side margin everywhere on phones
 expect(css).toMatch(/\.site-header\{width:calc\(100% - 32px\)\}/);
 expect(css).toMatch(/\.cluera-site\.account-site footer\{width:calc\(100% - 32px\)/);
});
