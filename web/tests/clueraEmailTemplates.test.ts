// @vitest-environment jsdom
import {readFileSync,readdirSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';

type Template={file:string;dashboardTemplate:string;subjectField:string;contentField:string;subject:string;
  placeholder:'ConfirmationURL'|'Token';heading:string;action:string|null};
const directory=resolve(dirname(fileURLToPath(import.meta.url)),'../../emails/auth');
const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8')) as {
  version:number;brand:string;supportEmail:string;projectRef:string;installationStatus:string;templates:Template[];
};
const templates=manifest.templates.map(template=>({...template,html:readFileSync(join(directory,template.file),'utf8')}));
const parse=(html:string)=>new DOMParser().parseFromString(html,'text/html');
const placeholders=(html:string)=>Array.from(html.matchAll(/{{\s*\.([A-Za-z]+)\s*}}/g),match=>match[1]);
const support='mailto:clueraaisupport@gmail.com';

it('maps all six Auth templates without an installer, enabled setting or credential',()=>{
  expect(manifest).toMatchObject({version:1,brand:'Cluera AI',supportEmail:'clueraaisupport@gmail.com',
    projectRef:'dwqltsqumiwsxtkzdoaa',installationStatus:'prepared-not-installed'});
  expect(templates.map(t=>[t.file,t.subjectField,t.contentField])).toEqual([
    ['confirm-signup.html','mailer_subjects_confirmation','mailer_templates_confirmation_content'],
    ['recovery.html','mailer_subjects_recovery','mailer_templates_recovery_content'],
    ['magic-link.html','mailer_subjects_magic_link','mailer_templates_magic_link_content'],
    ['invite.html','mailer_subjects_invite','mailer_templates_invite_content'],
    ['email-change.html','mailer_subjects_email_change','mailer_templates_email_change_content'],
    ['reauthentication.html','mailer_subjects_reauthentication','mailer_templates_reauthentication_content'],
  ]);
  expect(readdirSync(directory).filter(file=>file.endsWith('.html')).sort()).toEqual(templates.map(t=>t.file).sort());
  expect(Object.keys(manifest).sort()).toEqual(['brand','installationStatus','projectRef','supportEmail','templates','version']);
  for(const template of templates){
    expect(template.subject.length).toBeLessThanOrEqual(100);
    expect(template.subject).toContain('Cluera AI');
    expect(template.subject).not.toMatch(/{{|\r|\n/);
  }
});

it.each(templates)('keeps $file inert, private and independently readable',template=>{
  const doc=parse(template.html);
  expect(doc.documentElement.lang).toBe('en');
  expect(doc.title).toBe(template.subject);
  expect(doc.querySelectorAll('h1')).toHaveLength(1);
  expect(doc.querySelector('h1')?.textContent).toBe(template.heading);
  expect(doc.body.textContent).toContain('Cluera AI');
  expect(doc.body.textContent).toContain('Never share passwords, verification links, codes or payment details.');
  expect(doc.querySelectorAll('script,iframe,img,picture,video,audio,source,object,embed,form,input,button,link,base')).toHaveLength(0);
  expect(doc.querySelector('[http-equiv]')).toBeNull();
  for(const element of Array.from(doc.querySelectorAll('*'))){
    for(const attribute of element.getAttributeNames())expect(attribute).not.toMatch(/^(?:on|src|srcset|action|formaction)/i);
  }
  expect(template.html).not.toMatch(/url\s*\(|@import|javascript:|data:|sb_secret_|service_role|BEGIN [A-Z ]*PRIVATE KEY/i);
  expect(template.html).not.toMatch(/\.Data|\.Email|\.NewEmail|\.SiteURL|\.RedirectTo|\.TokenHash|sigmaroundsupport|interview workspace/i);
  expect(Array.from(doc.querySelectorAll('a')).map(a=>a.getAttribute('href')))
    .toEqual(template.placeholder==='Token'?[support]:['{{ .ConfirmationURL }}',support]);
  expect(placeholders(template.html)).toEqual([template.placeholder]);
  expect(Array.from(doc.querySelectorAll('a')).every(a=>(a.textContent??'').trim().length>5)).toBe(true);
});

it.each(templates)('keeps $file fluid without clipped content or a remote rendering dependency',template=>{
  const doc=parse(template.html);
  expect(doc.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, initial-scale=1');
  for(const table of Array.from(doc.querySelectorAll('table'))){
    expect(table.getAttribute('role')).toBe('presentation');expect(table.getAttribute('width')).toBe('100%');
  }
  expect(template.html).toContain('max-width:560px');
  expect(template.html).not.toMatch(/min-width|position\s*:\s*(?:absolute|fixed)|(?:^|;)\s*height\s*:\s*\d+px/i);
  expect(doc.querySelector(`a[href="${support}"]`)?.getAttribute('style')).toContain('word-break:break-word');
  if(template.action){
    const action=Array.from(doc.querySelectorAll('a')).find(a=>a.getAttribute('href')==='{{ .ConfirmationURL }}');
    expect(action?.textContent).toBe(template.action);expect(action?.getAttribute('style')).toContain('padding:14px 20px');
  }
});

for(const origin of ['https://cluera-ai-staging.vercel.app','https://sigmaround-account-staging.vercel.app']){
  it.each(templates.filter(t=>t.placeholder==='ConfirmationURL'))(`preserves the complete provider link for $file (${origin})`,template=>{
    const callback=origin+'/api/account/callback?sb_flow_id=synthetic-flow';
    const url=new URL('https://dwqltsqumiwsxtkzdoaa.supabase.co/auth/v1/verify');
    url.searchParams.set('token','synthetic-not-valid');url.searchParams.set('type','email');url.searchParams.set('redirect_to',callback);
    const doc=parse(template.html.replace('{{ .ConfirmationURL }}',url.href.replaceAll('&','&amp;')));
    const action=Array.from(doc.querySelectorAll('a')).find(a=>a.textContent===template.action)!;
    expect(action.getAttribute('href')).toBe(url.href);
    const target=new URL(action.href);expect(target.origin).toBe('https://dwqltsqumiwsxtkzdoaa.supabase.co');
    expect(target.searchParams.get('redirect_to')).toBe(callback);
    expect(Array.from(target.searchParams.keys())).toEqual(['token','type','redirect_to']);
    expect(placeholders(doc.documentElement.outerHTML)).toEqual([]);
  });
}

it('uses a reauthentication code only in the body, never an invented confirmation link or subject token',()=>{
  const template=templates.find(t=>t.file==='reauthentication.html')!;
  const doc=parse(template.html.replace('{{ .Token }}','123456'));
  expect(doc.querySelector('[aria-label="Verification code"]')?.textContent).toBe('123456');
  expect(doc.querySelectorAll('a')).toHaveLength(1);
  expect(doc.title).not.toContain('123456');
  expect(doc.body.textContent).toContain('only in the Cluera AI verification flow you initiated');
  expect(template.html).not.toContain('ConfirmationURL');
});

it('retains action-specific request, recovery and dual-confirmation warnings without promising authorization',()=>{
  const body=(file:string)=>parse(templates.find(t=>t.file===file)!.html).body.textContent!;
  expect(body('confirm-signup.html')).toContain('latest verification link in the same browser');
  expect(body('recovery.html')).toContain('latest recovery link in the same browser');
  expect(body('recovery.html')).toContain('This email alone does not change your password.');
  expect(body('email-change.html')).toContain('additional confirmation may be required');
  expect(body('invite.html')).toContain('does not itself assign an Admin role or add paid credits');
});
