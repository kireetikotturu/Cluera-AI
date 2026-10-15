'use strict';
// Read-only compatibility inspection of the existing public Admin page.
// Fixed destinations; no cookies, sessions, emails, POSTs or credential output.
const ORIGIN='https://sigmaround-account-staging.vercel.app';
const PROJECT='dwqltsqumiwsxtkzdoaa';
const SETTINGS=`https://${PROJECT}.supabase.co/auth/v1/settings`;

function inspect(text,found){
 for(const m of text.matchAll(/https:\/\/([a-z]{20})\.supabase\.co/g))found.projects.add(m[1]);
 for(const m of text.matchAll(/\bsb_publishable_[A-Za-z0-9_-]{16,256}\b/g))found.keys.add(m[0]);
 if(/\bsb_secret_[A-Za-z0-9_-]{16,256}\b/.test(text))found.unsafe=true;
 for(const m of text.matchAll(/\beyJ[A-Za-z0-9_-]{2,1024}\.[A-Za-z0-9_-]{2,4096}\.[A-Za-z0-9_-]{2,1024}\b/g)){
  try{
   const claim=JSON.parse(Buffer.from(m[0].split('.')[1],'base64url').toString('utf8'));
   if(claim?.role==='service_role')found.unsafe=true;
   if(claim?.role==='anon'){
    if(claim.ref===PROJECT)found.keys.add(m[0]);else found.foreign=true;
   }
  }catch{/* Non-key public source tokens are not authority. */}
 }
}

async function run(fetcher=fetch){
 const result={pageRead:false,assetsRead:0,projectMatches:false,keyFamily:'not-observed',
  publicAuthAccepted:false,unsafePublicCredential:false,ambiguous:false,readOnlyRequests:0,mutations:0};
 let total=0;
 async function read(url,limit=2*1024*1024,headers={}){
  const u=new URL(url);
  if(url!==SETTINGS&&(u.origin!==ORIGIN||!(u.pathname==='/admin'||u.pathname.startsWith('/_next/static/'))))throw Error('Fixed target required');
  result.readOnlyRequests++;
  const r=await fetcher(url,{method:'GET',headers,redirect:'manual',credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(url===SETTINGS?5000:10000)});
  try{
   if(r.status!==200||!r.body)throw Error('Unavailable');
   if(url===SETTINGS&&r.headers.get('content-type')?.split(';')[0].trim()!=='application/json')throw Error('Invalid settings');
   const reader=r.body.getReader(),chunks=[];let size=0;
   try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;total+=part.value.length;
    if(size>limit||total>12*1024*1024)throw Error('Body bound');chunks.push(part.value);}}
   finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
   return Buffer.concat(chunks).toString('utf8');
  }finally{await r.body?.cancel().catch(()=>{});}
 }
 try{
  const page=await read(ORIGIN+'/admin');result.pageRead=true;
  const found={projects:new Set(),keys:new Set(),unsafe:false,foreign:false};inspect(page,found);
  const assets=[...new Set([...page.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)]
   .map(m=>new URL(m[1],ORIGIN)).filter(u=>u.origin===ORIGIN&&u.pathname.startsWith('/_next/static/')&&u.pathname.endsWith('.js')&&!u.username&&!u.password&&!u.hash).map(u=>u.href))];
  if(assets.length>20)throw Error('Asset count bound');
  // Three reads at a time, never arbitrary recursively discovered dependencies.
  for(let i=0;i<assets.length;i+=3){
   const texts=await Promise.all(assets.slice(i,i+3).map(url=>read(url)));
   for(const text of texts){result.assetsRead++;inspect(text,found);}
  }
  result.projectMatches=found.projects.size===1&&found.projects.has(PROJECT)&&!found.foreign;
  result.unsafePublicCredential=found.unsafe;result.ambiguous=found.keys.size>1;
  if(!result.projectMatches||found.unsafe||found.keys.size!==1)return result;
  const key=[...found.keys][0];result.keyFamily=key.startsWith('sb_publishable_')?'modern-publishable':'legacy-anon';
  // This key was already public. Never submit a secret/service-role value.
  const settings=JSON.parse(await read(SETTINGS,65536,{apikey:key,Accept:'application/json'}));
  result.publicAuthAccepted=!!settings&&typeof settings==='object'&&!Array.isArray(settings)
   &&!!settings.external&&typeof settings.external==='object'&&!Array.isArray(settings.external);
 }catch{/* Fixed categories only: no upstream errors, bodies, keys or identities. */}
 return result;
}
module.exports={run,ORIGIN,SETTINGS};
if(require.main===module)run().then(result=>{
 console.log('ACCOUNT_PUBLIC_AUTH_COMPATIBILITY '+JSON.stringify(result));
 if(!result.publicAuthAccepted||result.unsafePublicCredential||result.ambiguous)process.exitCode=1;
}).catch(()=>{console.error('Public Auth compatibility inspection unavailable.');process.exitCode=1;});
