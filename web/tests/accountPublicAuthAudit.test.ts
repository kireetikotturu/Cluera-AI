import {createRequire} from 'node:module';
import {expect,it,vi} from 'vitest';
const {run,ORIGIN,SETTINGS}=createRequire(import.meta.url)('../../scripts/security/audit-account-public-auth.cjs');
const project='dwqltsqumiwsxtkzdoaa';
const jwt=(role='anon',ref=project)=>Buffer.from('{"alg":"HS256"}').toString('base64url')+'.'+Buffer.from(JSON.stringify({role,ref})).toString('base64url')+'.c3ludGhldGlj';
function fixture(key=jwt(),ref=project){
 const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
  if(url===ORIGIN+'/admin')return new Response('<script src="/_next/static/admin.js"></script><script src="https://foreign.invalid/never.js"></script>');
  if(url===ORIGIN+'/_next/static/admin.js')return new Response(JSON.stringify({url:`https://${ref}.supabase.co`,key}));
  if(url===SETTINGS){expect(init.headers).toEqual({apikey:key,Accept:'application/json'});return Response.json({external:{google:true},privateMarker:'synthetic-do-not-output'});}
  throw Error('Unexpected target');
 });return fetcher;
}
it.each([jwt(),'sb_publishable_'+'x'.repeat(32)])('authenticates only one public key and outputs fixed categories (%s)',async key=>{
 const f=fixture(key),r=await run(f);
 expect(r).toMatchObject({pageRead:true,assetsRead:1,projectMatches:true,keyFamily:key.startsWith('sb_')?'modern-publishable':'legacy-anon',publicAuthAccepted:true,readOnlyRequests:3,mutations:0});
 expect(JSON.stringify(r)).not.toContain(key);expect(JSON.stringify(r)).not.toContain('synthetic-do-not-output');
 for(const [url,init] of f.mock.calls){expect([ORIGIN+'/admin',ORIGIN+'/_next/static/admin.js',SETTINGS]).toContain(url);expect(init).toMatchObject({method:'GET',redirect:'manual',credentials:'omit',cache:'no-store'});expect(new Headers(init.headers).has('Authorization')).toBe(false);expect(new Headers(init.headers).has('Cookie')).toBe(false);expect(init.body).toBeUndefined();}
});
it.each([jwt('service_role'),'sb_secret_'+'x'.repeat(32)])('refuses any observed privileged public credential without sending it',async key=>{
 const f=fixture(key),r=await run(f);expect(r.unsafePublicCredential).toBe(true);expect(r.publicAuthAccepted).toBe(false);expect(f).toHaveBeenCalledTimes(2);expect(JSON.stringify(r)).not.toContain(key);
});
it('refuses foreign project, missing keys and conflicting public keys without auth requests',async()=>{
 for(const f of [fixture(jwt('anon','aaaaaaaaaaaaaaaaaaaa'),'aaaaaaaaaaaaaaaaaaaa'),fixture('missing'),fixture(jwt()+' sb_publishable_'+'x'.repeat(32))]){
  const r=await run(f);expect(r.publicAuthAccepted).toBe(false);expect(f).toHaveBeenCalledTimes(2);
 }
});
it.each(['redirect','html','malformed','oversized','private-error'])('never accepts or reflects invalid settings (%s)',async mode=>{
 const f=fixture(),normal=f.getMockImplementation()!;
 f.mockImplementation(async(url,init)=>{
  if(url!==SETTINGS)return normal(url,init);
  if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://foreign.invalid'}});
  if(mode==='html')return new Response('<html>private body</html>');
  if(mode==='malformed')return Response.json({external:null});
  if(mode==='oversized')return Response.json({external:{},private:'x'.repeat(65537)});
  throw Error('synthetic-sensitive-upstream-error');
 });const r=await run(f);expect(r.publicAuthAccepted).toBe(false);expect(JSON.stringify(r)).not.toMatch(/private body|synthetic-sensitive|foreign.invalid/);
});
it('enforces bounded script counts and never follows an arbitrary page URL',async()=>{
 const f=vi.fn(async()=>new Response(Array.from({length:21},(_,i)=>`<script src="/_next/static/${i}.js"></script>`).join('')));
 expect((await run(f)).publicAuthAccepted).toBe(false);expect(f).toHaveBeenCalledOnce();
});
