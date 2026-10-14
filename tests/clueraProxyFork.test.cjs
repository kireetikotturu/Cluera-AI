'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyProxyFork, validateManifest, PREFIX } = require('../scripts/verify-cluera-proxy-fork.cjs');
const { isReviewedVendorRuntime, reviewFile } = require('../scripts/review-cluera-publication.cjs');
const { detectSecrets } = require('../scripts/security/source-secret-scan.cjs');
const root = path.resolve(__dirname, '..');
const fork = path.join(root, PREFIX);
const temporaryBase = path.join(root, '.test-output');
function fixture(run) {
  fs.mkdirSync(temporaryBase, { recursive: true });
  const dir = fs.mkdtempSync(path.join(temporaryBase, 'cluera-fork-review-'));
  try { fs.cpSync(fork, dir, { recursive: true }); return run(dir); }
  finally {
    assert.equal(path.dirname(dir), temporaryBase);
    assert(path.basename(dir).startsWith('cluera-fork-review-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
test('reviewed fork manifest pins the exact complete regular-file source and runtime set', () => {
  const pins = verifyProxyFork(); assert.equal(pins.size, 77);
  assert(pins.has(PREFIX + 'dist/classes/Agent.js')); assert(pins.has(PREFIX + 'src/classes/Agent.ts'));
  assert(pins.has(PREFIX + 'LICENSE')); assert(pins.has(PREFIX + 'UPSTREAM_PACKAGE.json'));
  const runtime = PREFIX + 'dist/classes/Agent.js';
  const row = reviewFile(root, runtime, [], pins);
  assert.equal(row.sha, pins.get(runtime).gitSha);
  assert(isReviewedVendorRuntime(runtime, pins));
  const manifest = JSON.parse(fs.readFileSync(path.join(fork, 'CLUERA_MANIFEST.json')));
  assert.equal(manifest.files.filter(row => row.path.startsWith('src/') && row.path.endsWith('.test.ts')).length, 4);
  const packageJson = JSON.parse(fs.readFileSync(path.join(fork, 'package.json')));
  assert.equal(packageJson.private, true); assert.equal(packageJson.scripts, undefined);
  assert.equal(packageJson.devDependencies, undefined);
});
test('fork review rejects extra files, runtime mutation, missing files and changed manifest hashes', () => {
  fixture(dir => { fs.writeFileSync(path.join(dir, 'dist', 'unreviewed.js'), 'module.exports=1;'); assert.throws(() => verifyProxyFork(dir)); });
  fixture(dir => { fs.appendFileSync(path.join(dir, 'dist/classes/Agent.js'), '\n// unreviewed mutation\n'); assert.throws(() => verifyProxyFork(dir), /pin mismatch|path refused/); });
  fixture(dir => { fs.unlinkSync(path.join(dir, 'dist/classes/Agent.js')); assert.throws(() => verifyProxyFork(dir), /file set mismatch/); });
  fixture(dir => { fs.appendFileSync(path.join(dir, 'CLUERA_MANIFEST.json'), '\n'); assert.throws(() => verifyProxyFork(dir), /manifest pin mismatch/); });
});
test('manifest shape refuses traversal, absolute paths, duplicates, bad hashes and size overflow', () => {
  const original = JSON.parse(fs.readFileSync(path.join(fork, 'CLUERA_MANIFEST.json')));
  for (const mutate of [
    m => { m.files[0].path = '../escape.js'; }, m => { m.files[0].path = '/escape.js'; },
    m => { m.files[0].path = 'dist/../../escape.js'; }, m => { m.files[0].path = 'dist\\escape.js'; },
    m => { m.files[1].path = m.files[0].path; }, m => { m.files[0].sha256 = '0'; },
    m => { m.files[0].gitSha = '0'; }, m => { m.files[0].size = 65537; },
  ]) { const changed = structuredClone(original); mutate(changed); assert.throws(() => validateManifest(changed)); }
});
test('fork review refuses symbolic directory links and publication detects changed pinned bytes', () => {
  fixture(dir => {
    const link = path.join(dir, 'unreviewed-link');
    fs.symlinkSync(path.join(dir, 'src'), link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => verifyProxyFork(dir), /symlink refused/);
  });
  const runtime = PREFIX + 'dist/classes/Agent.js', pins = verifyProxyFork();
  const badPins = new Map(pins); badPins.set(runtime, { ...pins.get(runtime), sha256: '0'.repeat(64) });
  assert.throws(() => reviewFile(root, runtime, [], badPins), /fork pin changed/);
});
test('only exact manifest-bound vendor runtime escapes generated-output denial and remains secret-scanned', () => {
  const pins = verifyProxyFork();
  assert(!isReviewedVendorRuntime('desktop/dist/main/main.js', pins));
  assert(!isReviewedVendorRuntime(PREFIX + 'dist/unreviewed.js', pins));
  assert(!isReviewedVendorRuntime('desktop/vendor/other/dist/index.js', pins));
  assert.throws(() => reviewFile(root, 'desktop/dist/main/main.js', [], pins), /Publication path refused/);
  assert.throws(() => reviewFile(root, 'desktop/dist/never-created.js', [], pins), /Publication path refused/);
  assert.throws(() => reviewFile(root, 'desktop\\dist\\never-created.js', [], pins), /Publication path refused/);
  assert.throws(() => reviewFile(root, '../never-created.js', [], pins), /Publication path refused/);
  const name = PREFIX + 'dist/classes/Agent.js', bytes = fs.readFileSync(path.join(root, name));
  const known = [{ type: 'synthetic leakage probe', value: bytes.subarray(0, 48).toString() }];
  assert(detectSecrets(bytes, known).includes('synthetic leakage probe'));
  assert.throws(() => reviewFile(root, name, known, pins), /Publication secret findings/);
  const visible = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, windowsHide: true }).toString().split('\0');
  for (const file of pins.keys()) assert(visible.includes(file), 'Manifest-bound source must be visible to publication and the shared secret scanner.');
  assert(!visible.includes('desktop/dist/main/main.js'));
  for (const file of pins.keys()) {
    const b = fs.readFileSync(path.join(root, file));
    assert.equal(crypto.createHash('sha256').update(b).digest('hex'), pins.get(file).sha256);
  }
});
