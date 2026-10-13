import {createHash,createPrivateKey,createPublicKey,sign} from 'node:crypto';
import {z} from 'zod';
import {AccountError} from './config';
import {CLUERA_UPDATE_KEY_SHA256} from './releaseTrust';
import {stagingAccountConfig} from './workspace';
import {accountClients} from './clients';
import {assertTrustedInstallerUrl,compareVersions} from '../releases/policy';
import {SupabaseOperationError} from '../supabase/diagnostics';
import {json} from '../http';

const version=z.string().regex(/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/);
export const accountReleaseInput=z.object({version,minimumSupportedVersion:version,
 downloadUrl:z.string().regex(/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[A-Za-z0-9_.-]+\/ClueraAITestSetup-[0-9.]+\.exe$/),
 sha256:z.string().regex(/^[a-f0-9]{64}$/),fileSizeBytes:z.number().int().min(1).max(512*1024*1024),
 updateType:z.enum(['OPTIONAL','RECOMMENDED','REQUIRED']),releaseNotes:z.string().max(2000),
}).strict().refine(v=>version.safeParse(v.minimumSupportedVersion).success&&version.safeParse(v.version).success
 &&compareVersions(v.minimumSupportedVersion,v.version)<=0,{path:['minimumSupportedVersion']})
 .refine(v=>v.downloadUrl.endsWith(`/ClueraAITestSetup-${v.version}.exe`),{path:['downloadUrl']});
export const accountReleaseRecord=accountReleaseInput.safeExtend({id:z.uuid(),state:z.enum(['DRAFT','PUBLISHED','WITHDRAWN']),publishedAt:z.string().nullable()});
export const accountReleasePublish=z.object({id:z.uuid(),verifiedHostedSha256:z.string().regex(/^[a-f0-9]{64}$/),
 verifiedFileSizeBytes:z.number().int().min(1).max(512*1024*1024),confirmedAccountInstaller:z.literal(true)}).strict();
export type AccountRelease=z.infer<typeof accountReleaseRecord>;

export function accountReleaseSigningKey(env:NodeJS.ProcessEnv=process.env){
 try{
  const encoded=env.CLUERA_RELEASE_PRIVATE_KEY_BASE64??'';
  if(!encoded||encoded.length>8192)throw Error();
  const bytes=Buffer.from(encoded,'base64');if(bytes.toString('base64')!==encoded)throw Error();
  const key=createPrivateKey(bytes);if(key.asymmetricKeyType!=='ed25519')throw Error();
  const pub=createPublicKey(key).export({format:'der',type:'spki'});
  const pin=env.CLUERA_RELEASE_PUBLIC_KEY_BASE64??'';
  if(!pin||pub.toString('base64')!==pin||createHash('sha256').update(pub).digest('hex')!==CLUERA_UPDATE_KEY_SHA256)throw Error();
  if(env.LICENSE_SIGNING_PRIVATE_KEY_BASE64){
   const legacy=createPublicKey(createPrivateKey(Buffer.from(env.LICENSE_SIGNING_PRIVATE_KEY_BASE64,'base64'))).export({format:'der',type:'spki'});
   if(pub.equals(legacy))throw Error();
  }
  return key;
 }catch{throw new AccountError('UNAVAILABLE',503);}
}
export function signAccountRelease(value:AccountRelease,now=Math.floor(Date.now()/1000),env=process.env){
 const r=accountReleaseRecord.parse(value);if(r.state!=='PUBLISHED'||!r.publishedAt)throw new AccountError('UNAVAILABLE',503);
 assertTrustedInstallerUrl(r.downloadUrl);
 const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'CLUERA-RELEASE'})).toString('base64url');
 const payload=Buffer.from(JSON.stringify({iss:'cluera.ai',aud:'cluera-ai-desktop-test-update',product:'cluera-ai',
  releaseId:r.id,channel:'cluera-beta',platform:'win32-x64',version:r.version,minimumSupportedVersion:r.minimumSupportedVersion,
  downloadUrl:r.downloadUrl,sha256:r.sha256,fileSizeBytes:r.fileSizeBytes,releaseNotes:r.releaseNotes,updateType:r.updateType,iat:now,exp:now+86400})).toString('base64url');
 const input=`${header}.${payload}`;return `${input}.${sign(null,Buffer.from(input),accountReleaseSigningKey(env)).toString('base64url')}`;
}
export async function latestAccountRelease():Promise<AccountRelease|null>{
 const clients=accountClients(stagingAccountConfig());
 const {data,error,status}=await clients.service.rpc('cluera_release_latest');
 if(error)throw new SupabaseOperationError('release.latest',error,status);
 if(!data)return null;
 const record=accountReleaseRecord.parse(data);if(record.state!=='PUBLISHED')throw new AccountError('UNAVAILABLE',503);
 assertTrustedInstallerUrl(record.downloadUrl);return record;
}
export async function approvedAccountRelease():Promise<AccountRelease|null>{
 // Validate configuration even with no rows; never invent a legacy fallback.
 stagingAccountConfig();accountReleaseSigningKey();
 return latestAccountRelease();
}
export async function accountDistributionResponse(download=false):Promise<Response>{
 try{
  // No legacy key/feed/demo fallback, even when release configuration is absent.
  const release=await approvedAccountRelease();
  if(!release)return json({error:'No approved Cluera AI test installer is available.'},404);
  const signedManifest=signAccountRelease(release);
  return download?new Response(null,{status:302,headers:{Location:release.downloadUrl,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}}):json({signedManifest});
 }catch{return json({error:'Account release distribution is temporarily unavailable.'},503);}
}
