import {STAGING_DATABASE,STAGING_SITE} from '../accountRelay/config';
/** Presentation is always Cluera. This never enables Auth or a financial route. */
export function accountWebsite(env:NodeJS.ProcessEnv=process.env):boolean {
 if(env.SIGMAROUND_ACCOUNTS_ENABLED==='true'&&(env.SIGMAROUND_ACCOUNT_ORIGIN!==STAGING_SITE||env.NEXT_PUBLIC_SUPABASE_URL!==STAGING_DATABASE))throw new Error('Cluera website target configuration is unavailable.');
 return true;
}
