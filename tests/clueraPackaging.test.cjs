'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
test('Cluera package hooks and release output remain within the independent product',()=>{
 const config=require('../desktop/electron-builder.cluera.cjs');
 for(const hook of ['beforePack','afterPack']){assert(!config[hook].startsWith('..'));assert(fs.existsSync(path.join(root,'desktop',config[hook])));}
 assert.equal(config.appId,'ai.cluera.desktop');assert.equal(config.publish,null);assert.equal(config.nsis.allowElevation,false);assert.equal(config.nsis.perMachine,false);assert.equal(config.nsis.deleteAppDataOnUninstall,false);
 assert(config.files.includes('!node_modules/argparse/**/*'));assert(config.files.includes('!node_modules/sprintf-js/**/*'));
});
test('private settings use a separate signer and exclusive retained output without values in the result',()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-settings-'));
 try{fs.mkdirSync(path.join(temporary,'.local-secrets'));fs.mkdirSync(path.join(temporary,'desktop/resources'),{recursive:true});const pair=crypto.generateKeyPairSync('ed25519');
 fs.writeFileSync(path.join(temporary,'.local-secrets/cluera-release-private.pem'),pair.privateKey.export({type:'pkcs8',format:'pem'}));fs.writeFileSync(path.join(temporary,'desktop/resources/cluera-public-key.pem'),pair.publicKey.export({type:'spki',format:'pem'}));
 const {prepare}=require('../scripts/prepare-cluera-private-settings.cjs');const first=prepare(temporary),bytes=fs.readFileSync(first.file);assert.equal(first.status,'prepared');assert.equal(prepare(temporary).status,'retained');assert(fs.readFileSync(first.file).equals(bytes));assert(!JSON.stringify(first).includes('BASE64='));
 const values=Object.fromEntries(bytes.toString().trim().split('\n').map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)]));assert.equal(Buffer.from(values.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64,'base64').length,32);assert.notEqual(values.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64,values.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64);assert.equal(values.CLUERA_RELEASE_PUBLIC_KEY_BASE64,pair.publicKey.export({type:'spki',format:'der'}).toString('base64'));
 }finally{fs.rmSync(temporary,{recursive:true,force:true});}
});
