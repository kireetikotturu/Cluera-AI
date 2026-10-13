'use strict';
// Owner-only dashboard copy. Never logs values, reads old product secrets,
// provisions provider keys, or rotates an existing output.
const fs=require('node:fs'),path=require('node:path'),{randomBytes,createPublicKey}=require('node:crypto');
function prepare(root=path.resolve(__dirname,'..')){
 const directory=path.join(root,'.local-secrets'),output=path.join(directory,'cluera-vercel-settings.private.txt');
 if(fs.existsSync(output))return {status:'retained',file:output};
 const privatePath=path.join(directory,'cluera-release-private.pem');
 const privatePem=fs.readFileSync(privatePath),publicPem=fs.readFileSync(path.join(root,'desktop/resources/cluera-public-key.pem'));
 const derived=createPublicKey(privatePem).export({type:'spki',format:'der'}),expected=createPublicKey(publicPem).export({type:'spki',format:'der'});
 if(!derived.equals(expected))throw Error('Cluera signing trust mismatch.');
 const settings={SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64:randomBytes(32).toString('base64'),SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64:randomBytes(32).toString('base64'),CLUERA_RELEASE_PRIVATE_KEY_BASE64:privatePem.toString('base64'),CLUERA_RELEASE_PUBLIC_KEY_BASE64:derived.toString('base64')};
 fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(output,Object.entries(settings).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{flag:'wx',mode:0o600});
 return {status:'prepared',file:output};
}
module.exports={prepare};
if(require.main===module)try{const result=prepare();console.log(JSON.stringify({status:result.status,privateFilePrepared:true,valuesDisplayed:false}));}catch{console.error('Cluera private settings preparation failed.');process.exitCode=1;}
