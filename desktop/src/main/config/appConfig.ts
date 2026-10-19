import path from 'node:path';
import fs from 'node:fs';
import {createHash,createPublicKey} from 'node:crypto';
import {app} from 'electron';
import {bundledResourcePath} from './bundledResourcePath';
import {ACCOUNT_DISTRIBUTION} from '../../shared/accountDistribution';
import {CLUERA_UPDATE_KEY_SHA256} from '../../shared/clueraTrust';
export interface AppConfig {
 accountManaged?:boolean;providerMode?:'managed'|'byok';providerMutationInProgress?:boolean;
 databasePath:string;isProduction:boolean;demoMode:boolean;debugMode:boolean;
 deepgram:{apiKey:string;model:string;language:string;eotThreshold:number;maxReconnects:number;managed?:(source:'system'|'candidate')=>{url:string;headers:Record<string,string>}};
 gemini:{apiKey:string;model:string;timeoutMs:number;managedModelSelection?:boolean;managed?:(body:string,signal:AbortSignal)=>Promise<Response>};
 retrieval:{chunkSize:number;chunkOverlap:number;topK:number};
 screen:{enabled:boolean;maxBytes:number;maxDimension:number;model:string};
 links?:{tutorial:string;support:string};
 // Retained internal shape for the shared update/IPC modules. This is release
 // trust only; there is no License authentication runtime in Cluera.
 licensing:{enforced:boolean;serverUrl:string;publicKeyPem:string;trustedInstallerOrigins?:string[];updateChannel?:'cluera-beta';trustedInstallerRedirectOrigins?:string[];updatePublisher?:string};
}
export function createAppConfig():AppConfig {
 const isProduction=app.isPackaged;
 const product=JSON.parse(fs.readFileSync(bundledResourcePath(app.getAppPath(),'production-config.json'),'utf8')) as Record<string,unknown>;
 if(product.apiOrigin!==ACCOUNT_DISTRIBUTION.apiOrigin||product.publicKeyFile!=='cluera-public-key.pem'||product.updateChannel!=='cluera-beta')throw new Error('Cluera release trust configuration is invalid.');
 const publicKeyPem=fs.readFileSync(bundledResourcePath(app.getAppPath(),'cluera-public-key.pem'),'utf8');
 if(createPublicKey(publicKeyPem).asymmetricKeyType!=='ed25519'||createHash('sha256').update(createPublicKey(publicKeyPem).export({type:'spki',format:'der'})).digest('hex')!==CLUERA_UPDATE_KEY_SHA256)throw new Error('Cluera release verification key is invalid.');
 const origins=product.trustedInstallerOrigins,redirects=product.trustedInstallerRedirectOrigins;
 if(!Array.isArray(origins)||origins.length!==1||origins[0]!=='https://github.com'||!Array.isArray(redirects)||redirects.length!==1||redirects[0]!=='https://release-assets.githubusercontent.com')throw new Error('Cluera installer origins are invalid.');
 // An optional exact Authenticode subject is trusted only from the bundled,
 // integrity-checked config. Never infer it from the downloaded installer or env.
 const publisher=product.updatePublisher;
 if(publisher!==undefined&&(typeof publisher!=='string'||publisher.length>1024||publisher!==publisher.trim()
  ||/[\u0000-\u001f\u007f-\u009f]/.test(publisher)
  ||!/(?:^|,\s*)CN=(?:"[^"]+"|[^,\s][^,]*)(?:,|$)/u.test(publisher)))throw new Error('Cluera update publisher pin is invalid.');
 return {
  accountManaged:true,providerMode:'managed',databasePath:path.join(app.getPath('userData'),ACCOUNT_DISTRIBUTION.database),
  isProduction,demoMode:false,debugMode:!isProduction&&process.env.DEBUG_MODE==='true',
  deepgram:{apiKey:'',model:'flux-general-en',language:'en',eotThreshold:.75,maxReconnects:4},
  gemini:{apiKey:'',model:'gemini-3.5-flash',timeoutMs:30000,managedModelSelection:true},
  retrieval:{chunkSize:850,chunkOverlap:120,topK:5},
  screen:{enabled:true,maxBytes:5000000,maxDimension:2560,model:'gemini-3.5-flash'},
  links:{tutorial:ACCOUNT_DISTRIBUTION.apiOrigin+'/setup',support:ACCOUNT_DISTRIBUTION.apiOrigin+'/support'},
  licensing:{enforced:false,serverUrl:ACCOUNT_DISTRIBUTION.apiOrigin,publicKeyPem,updateChannel:'cluera-beta',trustedInstallerOrigins:origins as string[],trustedInstallerRedirectOrigins:redirects as string[],updatePublisher:publisher as string|undefined},
 };
}
