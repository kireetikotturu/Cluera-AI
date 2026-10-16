/** Classification only, not authentication. Supabase still verifies the real key.
 * Prevent accidental service-role/secret-key exposure through NEXT_PUBLIC. */
export function isPublishableKey(key:unknown):key is string {
 if(typeof key!=='string'||key.length>8192)return false;
 return /^sb_publishable_[A-Za-z0-9_-]{16,256}$/.test(key);
}
export function assertPublishableKey(key:unknown):asserts key is string {
 if(!isPublishableKey(key))throw new Error('Cluera public Auth key configuration is unavailable.');
}
