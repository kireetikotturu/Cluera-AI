'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PINNED, UI_OVERLAY, gitHash, sourcePath, beneath, decode, sensitiveKinds, validateEntries, verifyTree, pinManifest, prepare, exportNew } = require('../scripts/prepare-reviewed-sources.cjs');
const bytes = Buffer.from('Synthetic source\r\n');
const entry = { path: 'src/example.ts', type: 'blob', mode: '100644', sha: gitHash(bytes), size: bytes.length };
const sandbox = path.resolve(__dirname, '../.test-output'); fs.mkdirSync(sandbox, { recursive: true });
test('Git blob pins preserve CRLF and binary bytes', () => {
  assert.notEqual(gitHash(bytes), gitHash(Buffer.from('Synthetic source\n')));
  assert.deepEqual(decode({ encoding: 'base64', content: Buffer.from([0,255,10,1]).toString('base64') }), Buffer.from([0,255,10,1]));
});
test('valid source paths retain neutral Account contracts and public trust', () => {
  for (const file of ['web/lib/accounts/config.ts','supabase/migrations/test.sql','.env.example','resources/account-public-key.pem']) assert.equal(sourcePath(file), file);
});
test('unsafe paths, credentials, generated outputs and Windows collisions reject', () => {
  for (const file of ['../source','src/../../escape','C:/escape','/escape','src\\escape','src/CON.ts','src/NUL','src/name.','src/name ','src//file','.git/config','web/node_modules/package.json','release/account.exe','.env.local','web/.env.production','.local-secrets/private.pem','src/secret.key']) assert.throws(() => sourcePath(file));
});
test('base64 decoding rejects malformed/noncanonical or missing encoding', () => {
  for (const record of [{encoding:'utf-8',content:'text'}, {encoding:'base64',content:'%%%='},{encoding:'base64',content:'AB=='},{encoding:'base64',content:'YQ'},{}]) assert.throws(() => decode(record));
});
test('incomplete, wrong-SHA and truncated manifests reject', () => {
  for (const item of [{}, {commit:PINNED.account.commit,sha:PINNED.account.tree,truncated:true,tree:[entry]}, {commit:PINNED.account.commit,sha:PINNED.account.tree,truncated:false,tree:[entry]}]) assert.throws(() => pinManifest({account:item}, 'account'));
});
test('link modes, wrong size and case-insensitive duplicate entries reject', () => {
  for (const tree of [[{...entry,mode:'120000'}],[{...entry,size:-1}],[entry,{...entry,path:'SRC/EXAMPLE.ts'}]]) assert.throws(() => validateEntries(tree));
});
test('source-byte mismatch fails before export', () => {
  assert.throws(() => prepare([entry], () => Buffer.from('changed')));
  assert.equal(prepare([entry], () => bytes)[0].sha, entry.sha);
});
test('secret detection uses fixed categories, not values', () => {
  const synthetic = 'synthetic-secret-never-a-real-credential';
  assert.deepEqual(sensitiveKinds(Buffer.from(synthetic), [synthetic]), ['known-secret']);
  assert.deepEqual(sensitiveKinds(Buffer.from(synthetic, 'utf16le'), [synthetic]), ['known-secret']);
  assert.throws(() => prepare([{...entry,size:synthetic.length,sha:gitHash(Buffer.from(synthetic))}], () => Buffer.from(synthetic), [synthetic]), /SOURCE_SECRET/);
});
test('scope checking denies parent/root and escaping targets', () => {
  assert.throws(() => beneath(sandbox,sandbox)); assert.throws(() => beneath(sandbox,path.join(sandbox,'..','escape')));
  assert.equal(beneath(sandbox,path.join(sandbox,'safe')),path.join(sandbox,'safe'));
});
test('export is exclusive and retains exact bytes without overwriting', () => {
  const parent = fs.mkdtempSync(path.join(sandbox,'export-')), target = path.join(parent,'snapshot');
  const result = exportNew(parent,target,prepare([entry],()=>bytes));
  assert.equal(result.bytePinsVerified,true); assert.deepEqual(fs.readFileSync(path.join(target,entry.path)),bytes);
  assert.throws(() => exportNew(parent,target,prepare([entry],()=>bytes)),/TARGET_EXISTS/);
  assert.deepEqual(fs.readFileSync(path.join(target,entry.path)),bytes);
});
test('invalid export has no filesystem mutation', () => {
  const parent = fs.mkdtempSync(path.join(sandbox,'invalid-')), target = path.join(parent,'snapshot');
  assert.throws(() => exportNew(parent,target,[{path:entry.path,sha:entry.sha,bytes:Buffer.from('wrong')}]),/EXPORT_PIN/);
  assert.equal(fs.existsSync(target),false);
});
test('UI overlay excludes protected Paddle source and historical guides', () => {
  assert.equal(new Set(UI_OVERLAY).size,UI_OVERLAY.length);
  for (const file of ['web/lib/billing/checkout/service.ts','web/lib/billing/lifecycle/policy.ts','docs/operations/2026-10-04-checkout-recovery.md','temporyguide.md','render.yaml','package-lock.json']) assert.equal(UI_OVERLAY.includes(file),false);
  assert.ok(UI_OVERLAY.includes('src/renderer/components/AccountLogin.tsx'));
  assert.ok(UI_OVERLAY.includes('web/tests/fixtures/accountUiPreview.tsx'));
});
test('tree verification rejects a forged root pin and a missing directory', () => {
  assert.throws(() => verifyTree([entry], 'a'.repeat(40)), /TREE_PARENT/);
  assert.throws(() => verifyTree([{...entry,path:'example.ts'}], 'a'.repeat(40)), /TREE_CONTENT_PIN/);
});
test('tree verification binds paths as well as bytes and uses Git ordering', () => {
  const crypto = require('node:crypto');
  const e = {...entry,path:'example.ts'};
  const raw = Buffer.concat([Buffer.from('100644 example.ts\0'),Buffer.from(e.sha,'hex')]);
  const root = crypto.createHash('sha1').update(`tree ${raw.length}\0`).update(raw).digest('hex');
  assert.doesNotThrow(() => verifyTree([e],root));
  assert.throws(() => verifyTree([{...e,path:'renamed.ts'}],root),/TREE_CONTENT_PIN/);
});
