'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MANIFEST_SHA256 = '42b0d68be6c537d07d883be6d36e50efb349575192caca3f7b5be46725aee5da';
const PREFIX = 'desktop/vendor/global-agent/';
const MANIFEST_NAME = 'CLUERA_MANIFEST.json';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitSha = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.packageVersion !== '4.1.3-cluera.1'
    || manifest.upstreamCommit !== 'e9138f654826f9a82e0ac4f3abdb9541ac988286'
    || manifest.registryIntegrity !== 'sha512-KUJEViiuFT3I97t+GYMikLPJS2Lfo/S2F+DQuBWzuzaMPnvt5yyZePzArx36fBzpGTxZjIpDbXLeySLgh+k76g=='
    || !Array.isArray(manifest.files) || manifest.files.length !== 76) throw Error('Proxy fork manifest refused.');
  const seen = new Set(); let total = 0;
  for (const row of manifest.files) {
    if (typeof row.path !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(row.path)
      || row.path.split('/').some(part => part === '.' || part === '..' || ['node_modules', '.git', '.local-secrets'].includes(part))
      || row.path === MANIFEST_NAME || seen.has(row.path)
      || !Number.isSafeInteger(row.size) || row.size < 0 || row.size > 65536
      || !/^[a-f0-9]{64}$/.test(row.sha256) || !/^[a-f0-9]{40}$/.test(row.gitSha)) throw Error('Proxy fork file pin refused.');
    seen.add(row.path); total += row.size;
  }
  if (total > 200000) throw Error('Proxy fork size refused.');
  return manifest.files;
}

function verifyProxyFork(forkRoot = path.resolve(__dirname, '../desktop/vendor/global-agent')) {
  const root = path.resolve(forkRoot), rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error('Proxy fork root refused.');
  const manifestPath = path.join(root, MANIFEST_NAME), manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 32000) throw Error('Proxy fork manifest refused.');
  const manifestBytes = fs.readFileSync(manifestPath);
  if (hash(manifestBytes) !== MANIFEST_SHA256) throw Error('Proxy fork manifest pin mismatch.');
  const manifest = JSON.parse(manifestBytes), files = validateManifest(manifest);
  const found = new Set(); let directories = 0;
  function walk(directory, depth) {
    if (++directories > 100 || depth > 8) throw Error('Proxy fork directory bound exceeded.');
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name), stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw Error('Proxy fork symlink refused.');
      if (stat.isDirectory()) walk(target, depth + 1);
      else if (stat.isFile()) {
        found.add(path.relative(root, target).replaceAll('\\', '/'));
        if (found.size > 77) throw Error('Proxy fork extra file refused.');
      } else throw Error('Proxy fork non-regular file refused.');
    }
  }
  walk(root, 0);
  if (found.size !== 77 || !found.has(MANIFEST_NAME) || files.some(row => !found.has(row.path))) throw Error('Proxy fork file set mismatch.');
  const pins = new Map();
  for (const row of files) {
    const target = path.resolve(root, row.path), relative = path.relative(root, target), stat = fs.lstatSync(target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !stat.isFile() || stat.isSymbolicLink() || stat.size !== row.size) throw Error('Proxy fork path refused.');
    const bytes = fs.readFileSync(target);
    if (hash(bytes) !== row.sha256 || gitSha(bytes) !== row.gitSha) throw Error('Proxy fork file pin mismatch.');
    pins.set(PREFIX + row.path, { size: row.size, sha256: row.sha256, gitSha: row.gitSha });
  }
  pins.set(PREFIX + MANIFEST_NAME, { size: manifestBytes.length, sha256: MANIFEST_SHA256, gitSha: gitSha(manifestBytes) });
  return pins;
}

if (require.main === module) {
  try { console.log(JSON.stringify({ status: 'passed', files: verifyProxyFork().size, manifestSha256: MANIFEST_SHA256 })); }
  catch { console.error('Reviewed Cluera proxy fork verification failed.'); process.exitCode = 1; }
}
module.exports = { verifyProxyFork, validateManifest, MANIFEST_SHA256, PREFIX };
