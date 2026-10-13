import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const require=createRequire(import.meta.url);
const packagingRequire=createRequire(require.resolve('cacheable-request'));
const CachePolicy=packagingRequire('http-cache-semantics');

describe('packaging HTTP cache isolation',()=>{
 it.each(['private','no-store'])('never serves a security-zeroed %s response with max-stale',directive=>{
  const policy=new CachePolicy({url:'https://cache.invalid/profile',method:'GET',headers:{cookie:'user=synthetic-owner'}},
   {status:200,headers:{'set-cookie':'session=synthetic-owner','cache-control':directive}},{shared:true});
  expect(policy.storable()).toBe(false);
  for(const stale of ['max-stale=999999999','max-stale']){
   expect(policy.satisfiesWithoutRevalidation({url:'https://cache.invalid/profile',method:'GET',headers:{'cache-control':stale}})).toBe(false);
  }
 });
 it('still permits a public fresh cache entry and pins the reviewed supported patch',()=>{
  expect(packagingRequire('http-cache-semantics/package.json').version).toBe('4.3.0-cluera.1');
  const policy=new CachePolicy({url:'https://cache.invalid/public',method:'GET',headers:{}},
   {status:200,headers:{'cache-control':'public,max-age=60'}},{shared:true});
  expect(policy.storable()).toBe(true);expect(policy.satisfiesWithoutRevalidation({url:'https://cache.invalid/public',method:'GET',headers:{}})).toBe(true);
 });
});
