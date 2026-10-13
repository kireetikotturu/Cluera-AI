import {ZodError} from 'zod';
import {AccountError} from './config';
import {SupabaseOperationError} from '../supabase/diagnostics';
const stages=new Set(['authorization','admin_check','session_restore','mfa_check','read_query','read_rpc','catalog','providers','releases']);
/** Bounded server-only diagnostic: no IDs, SQL, error messages, cookies or bodies. */
export function adminReadFailure(error:unknown,stage:string):{error:string;status:number}{
 const status=error instanceof AccountError?error.status:error instanceof ZodError?400:503;
 const codes:Record<number,string>={401:'ADMIN_SIGN_IN_REQUIRED',403:'ADMIN_ACCESS_DENIED',400:'ADMIN_QUERY_INVALID',429:'ADMIN_RATE_LIMITED'};
 const code=codes[status]??'ADMIN_SERVICE_UNAVAILABLE';
 const detail:Record<string,string|number>={operation:'account.admin.read',stage:stages.has(stage)?stage:'authorization',code,status};
 if(error instanceof SupabaseOperationError){
  if(error.code)detail.databaseCode=error.code;
  if(error.httpStatus)detail.databaseStatus=error.httpStatus;
 }
 console.error('[account-admin] read rejected',detail);
 return {error:code,status};
}
