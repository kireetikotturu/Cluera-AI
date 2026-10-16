import {assertPublishableKey} from './supabase/publicKey';
import {CLUERA_SUPABASE_URL} from './supabase/target';
/** Public configuration only. Private service keys never enter the browser. */
export function getBrowserEnv(){
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL,key=process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
 if(url!==CLUERA_SUPABASE_URL||!key||key.length<20)throw new Error('Cluera account configuration is unavailable.');
 assertPublishableKey(key);return {url,key};
}
