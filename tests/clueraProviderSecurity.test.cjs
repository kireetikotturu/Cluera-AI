'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadKnownSecrets,detectSecrets}=require('../scripts/security/source-secret-scan.cjs');
test('artifact scan includes configured vault keyring and decoded root-key material without echoing either',()=>{
 const key=Buffer.alloc(32,99).toString('base64'),ring=Buffer.from(JSON.stringify({active:'synthetic',keys:{synthetic:key}})).toString('base64');
 const known=loadKnownSecrets(__dirname,{CLUERA_PROVIDER_VAULT_KEYRING_BASE64:ring});
 const found=detectSecrets(Buffer.from(`synthetic artifact ${ring} ${key}`),known);
 assert.deepEqual(found.sort(),['CLUERA_PROVIDER_VAULT_KEYRING_BASE64','provider vault root key'].sort());
 assert.equal(JSON.stringify(found).includes(key),false);assert.equal(JSON.stringify(found).includes(ring),false);
});
