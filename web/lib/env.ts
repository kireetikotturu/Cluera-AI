import {assertPublishableKey} from './supabase/publicKey';
/** Public configuration only. Private service keys never enter the browser. */
export function getBrowserEnv(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(url!=='https://dwqltsqumiwsxtkzdoaa.supabase.co'||!key||key.length<20)throw new Error('Cluera account configuration is unavailable.');
 assertPublishableKey(key);return {url,key};
}
