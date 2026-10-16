'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {prepare,PROJECT,FILE,KEY_FILE}=require('../scripts/migrations/prepare-clean-infrastructure.cjs');
const {loadKnownSecrets,detectSecrets}=require('../scripts/security/source-secret-scan.cjs');
test('generates separate fresh scoped secrets with no old secret, API key, provider, worker or signing import',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-settings-'));
 const first=prepare(root),file=path.join(root,'.local-secrets',FILE),bytes=fs.readFileSync(file),data=JSON.parse(bytes);
 assert.equal(first.status,'prepared');assert.equal(first.valuesDisplayed,false);assert.equal(data.projectRef,PROJECT);
 assert.notEqual(data.web.SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64,data.web.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64);
 assert.equal(data.relay.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64,data.web.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64);
 for(const value of Object.values(data.web))assert.equal(Buffer.from(value,'base64').length,32);
 assert.deepEqual(Object.keys(data.web).sort(),['SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64','SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64']);
 assert.deepEqual(Object.keys(data.relay),['SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64']);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root,'.local-secrets',KEY_FILE))),{projectRef:PROJECT,webSecretKey:'',relaySecretKey:''});
 assert.equal(prepare(root).status,'retained');assert.deepEqual(fs.readFileSync(file),bytes);
 const second=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-settings-'));prepare(second);
 assert.notEqual(JSON.parse(fs.readFileSync(path.join(second,'.local-secrets',FILE))).web.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64,data.web.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64);
});
test('retains separately owner-filled modern key slots privately, refusing same-key or legacy content',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-keyslots-'));prepare(root);
 const file=path.join(root,'.local-secrets',KEY_FILE),data={projectRef:PROJECT,webSecretKey:'sb_secret_'+'w'.repeat(24),relaySecretKey:'sb_secret_'+'r'.repeat(24)};
 fs.writeFileSync(file,JSON.stringify(data));const before=fs.readFileSync(file);assert.equal(prepare(root).status,'retained');assert.deepEqual(fs.readFileSync(file),before);
 data.relaySecretKey=data.webSecretKey;fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>prepare(root));
 data.relaySecretKey='eyJsynthetic.legacy.signature';fs.writeFileSync(file,JSON.stringify(data));assert.throws(()=>prepare(root));
});
test('rejects wrong projects and conflicting existing files without overwrite',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-refuse-'));
 assert.throws(()=>prepare(root,'dwqltsqumiwsxtkzdoaa'));
 assert.equal(fs.existsSync(path.join(root,'.local-secrets')),false);
 fs.mkdirSync(path.join(root,'.local-secrets'));const file=path.join(root,'.local-secrets',FILE);
 fs.writeFileSync(file,'{}');assert.throws(()=>prepare(root));assert.equal(fs.readFileSync(file,'utf8'),'{}');
});
test('fixed private scanner inputs reject leakage of every fresh cookie/rate/server credential without returning bytes',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-scan-'));prepare(root);
 const infrastructure=JSON.parse(fs.readFileSync(path.join(root,'.local-secrets',FILE)));
 const keys={projectRef:PROJECT,webSecretKey:'sb_secret_'+'w'.repeat(24),relaySecretKey:'sb_secret_'+'r'.repeat(24)};
 const file=path.join(root,'.local-secrets',KEY_FILE);fs.writeFileSync(file,JSON.stringify(keys));
 const known=loadKnownSecrets(root,{});
 for(const secret of [...Object.values(infrastructure.web),keys.webSecretKey,keys.relaySecretKey]) {
  const categories=detectSecrets(Buffer.from(secret),known);assert(categories.length>0);assert(!JSON.stringify(categories).includes(secret));
  assert(detectSecrets(Buffer.from(secret,'utf16le'),known).length>0);
 }
 fs.writeFileSync(file,'{"projectRef":"wrong"}');assert.throws(()=>loadKnownSecrets(root,{}),/^Error: Clean private scan input unavailable\.$/);
});
test('private preparation rejects oversized, malformed and linked inputs; scanner includes even a mismatched relay rate',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-private-bounds-'));prepare(root);
 const keyFile=path.join(root,'.local-secrets',KEY_FILE);
 fs.writeFileSync(keyFile,'x'.repeat(16385));assert.throws(()=>prepare(root),/^Error: Private clean input unavailable\.$/);
 fs.writeFileSync(keyFile,'{"projectRef":');assert.throws(()=>prepare(root),/^Error: Private clean input unavailable\.$/);
 fs.writeFileSync(keyFile,JSON.stringify({projectRef:PROJECT,webSecretKey:'',relaySecretKey:''}));
 const file=path.join(root,'.local-secrets',FILE),data=JSON.parse(fs.readFileSync(file));
 const separate=Buffer.alloc(32,111).toString('base64');data.relay.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64=separate;fs.writeFileSync(file,JSON.stringify(data));
 assert.throws(()=>prepare(root));assert(detectSecrets(Buffer.from(separate),loadKnownSecrets(root,{})).length>0);
 const second=fs.mkdtempSync(path.join(os.tmpdir(),'cluera-clean-private-link-'));
 fs.symlinkSync(path.join(root,'.local-secrets'),path.join(second,'.local-secrets'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>prepare(second),/^Error: Private clean directory refused\.$/);
});
