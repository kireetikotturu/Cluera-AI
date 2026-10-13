const PROJECT='dwqltsqumiwsxtkzdoaa';
/** Classification only, not authentication. Supabase still verifies the real key.
 * Prevent accidental service-role/secret-key exposure through NEXT_PUBLIC. */
export function isPublishableKey(key:unknown):key is string {
 if(typeof key!=='string'||key.length>8192)return false;
 if(/^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(key))return true;
 const parts=key.split('.');if(parts.length!==3||parts.some(p=>!/^[A-Za-z0-9_-]+$/.test(p)))return false;
 try{
  const claim=JSON.parse(atob(parts[1].replaceAll('-','+').replaceAll('_','/')));
  return claim?.role==='anon'&&claim?.ref===PROJECT;
 }catch{return false;}
}
export function assertPublishableKey(key:unknown):asserts key is string {
 if(!isPublishableKey(key))throw new Error('Cluera public Auth key configuration is unavailable.');
}
