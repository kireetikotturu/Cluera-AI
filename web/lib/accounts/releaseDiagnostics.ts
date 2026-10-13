import {ZodError} from 'zod';
import {AccountError} from './config';
import {InvalidInputError} from '../http';
import {SupabaseOperationError} from '../supabase/diagnostics';
import type {ReleaseErrorCode} from './releaseErrors';

export class ReleaseInputError extends Error {
 constructor(readonly code:ReleaseErrorCode){super('Account release input rejected.');}
}
export function releaseValidationCode(error:ZodError):ReleaseErrorCode {
 const fields:Record<string,ReleaseErrorCode>={version:'RELEASE_VERSION_INVALID',minimumSupportedVersion:'RELEASE_MINIMUM_INVALID',
  downloadUrl:'RELEASE_URL_INVALID',sha256:'RELEASE_HASH_INVALID',verifiedHostedSha256:'RELEASE_HASH_INVALID',
  fileSizeBytes:'RELEASE_SIZE_INVALID',verifiedFileSizeBytes:'RELEASE_SIZE_INVALID',releaseNotes:'RELEASE_NOTES_INVALID',
  updateType:'RELEASE_POLICY_INVALID',reason:'RELEASE_REASON_INVALID',operationId:'RELEASE_OPERATION_INVALID',
  confirmedAccountInstaller:'RELEASE_CONFIRMATION_REQUIRED'};
 const field=error.issues[0]?.path.at(-1);
 return typeof field==='string' ? fields[field]??'RELEASE_INPUT_INVALID' : 'RELEASE_INPUT_INVALID';
}
const actions=new Set(['RELEASE_DRAFT','RELEASE_PUBLISH','RELEASE_WITHDRAW']);
const stages=new Set(['authorization','read_body','validation','signing','release_rpc']);
const results=new Set(['INVALID','CONFLICT','NOT_FOUND','FORBIDDEN','APPLIED']);
/** Only fixed operation/stage/action/result and pre-sanitized DB code/status.
 * Never log raw errors, SQL, URLs, IDs, reasons, bodies, cookies or tokens. */
export function logReleaseDiagnostic(stage:string,action:string|undefined,result?:string,error?:unknown):void {
 const detail:Record<string,string|number>={operation:'account.admin',stage:stages.has(stage)?stage:'authorization',action:action&&actions.has(action)?action:'UNKNOWN'};
 if(result&&results.has(result))detail.result=result;
 if(error instanceof SupabaseOperationError){
  if(error.code)detail.code=error.code;
  if(error.httpStatus)detail.httpStatus=error.httpStatus;
  detail.cause='DATABASE_SERVICE';
 }else if(error instanceof ReleaseInputError)detail.cause=error.code;
 else if(error instanceof ZodError)detail.cause=releaseValidationCode(error);
 else if(error instanceof AccountError)detail.cause=error.code;
 else if(error instanceof InvalidInputError||error instanceof SyntaxError)detail.cause='INVALID_REQUEST';
 else if(error)detail.cause='UNEXPECTED';
 console.error('[account-release] request rejected',detail);
}
