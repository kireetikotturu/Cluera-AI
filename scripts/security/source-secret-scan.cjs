const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const secretNames = new Set(['GEMINI_API_KEY', 'DEEPGRAM_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'SIGMAROUND_MANAGED_GEMINI_API_KEY', 'SIGMAROUND_MANAGED_DEEPGRAM_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
  'LICENSE_HASH_PEPPER_BASE64', 'LICENSE_SIGNING_PRIVATE_KEY_BASE64', 'PADDLE_API_KEY', 'PADDLE_WEBHOOK_SECRET',
  'TURN_SHARED_SECRET', 'CLOUDFLARE_API_TOKEN', 'CSC_KEY_PASSWORD', 'ADMIN_PASSWORD']);
secretNames.add('SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64');
secretNames.add('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64');
secretNames.add('SIGMAROUND_BILLING_WORKER_SECRET');
secretNames.add('CLUERA_RELEASE_PRIVATE_KEY_BASE64');
secretNames.add('RAZORPAY_TEST_KEY_SECRET');
secretNames.add('RAZORPAY_TEST_WEBHOOK_SECRET');
secretNames.add('CLUERA_PROVIDER_VAULT_KEYRING_BASE64');

function loadKnownSecrets(root, env = process.env) {
  const secrets = [];
  const add = (name, value) => {
    if (secretNames.has(name) && value && value.length >= 16 && !/^(?:YOUR_|GENERATE_|PLACEHOLDER|BASE64_ENCODED_|<)/i.test(value)) {
      secrets.push({ type: name, value });
    }
  };
  for (const name of secretNames) add(name, env[name]);
  // Scan both the sealed-settings representation and each root key without
  // ever returning their bytes or JSON parse errors to the caller.
  try {
    const ring=JSON.parse(Buffer.from(env.CLUERA_PROVIDER_VAULT_KEYRING_BASE64??'','base64').toString('utf8'));
    for(const value of Object.values(ring.keys??{}))if(typeof value==='string'&&Buffer.from(value,'base64').length===32){
      secrets.push({type:'provider vault root key',value});
    }
  }catch{/* Absent/malformed root configuration is checked by the actual vault guard. */}
  for (const file of ['.env', 'web/.env.local', 'web/.env.production', '.local-secrets/cluera-owner-settings.private.txt', '.local-secrets/cluera-vercel-settings.private.txt']) {
    const location = path.join(root, file);
    if (!fs.existsSync(location)) continue;
    for (const line of fs.readFileSync(location, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (match) add(match[1], match[2].replace(/^['"]|['"]$/g, ''));
    }
  }
  // Fixed clean-project inputs only. No directory discovery or value-bearing
  // parse errors. Newly generated material must also be checked in artifacts.
  for (const name of ['infrastructure','server-keys']) {
    const location=path.join(root,`.local-secrets/cluera-yhnqlfcgrmckhyjdxegg-${name}.private.json`);
    if(!fs.existsSync(location))continue;
    try {
      const stat=fs.lstatSync(location);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384)throw Error();
      const data=JSON.parse(fs.readFileSync(location,'utf8'));
      if(data.projectRef!=='yhnqlfcgrmckhyjdxegg')throw Error();
      if(name==='infrastructure') {
        for(const setting of ['SIGMAROUND_ACCOUNT_COOKIE_KEY_BASE64','SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64']) {
          if(typeof data.web?.[setting]!=='string')throw Error();
          add(setting,data.web[setting]);
        }
        if(typeof data.relay?.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64!=='string')throw Error();
        add('SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64',data.relay.SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64);
      } else {
        for(const setting of ['webSecretKey','relaySecretKey']) {
          if(typeof data[setting]!=='string')throw Error();
          add('SUPABASE_SERVICE_ROLE_KEY',data[setting]);
        }
      }
    } catch { throw Error('Clean private scan input unavailable.'); }
  }
  // New scheduler material is one fixed ignored file, not a directory search.
  // Reject unsafe paths/shape before adding its shared secret to scan memory.
  const schedulerPrivate=path.join(root,'.local-secrets/cluera-billing-scheduler.private.json');
  try {
    let present=false;
    try{fs.lstatSync(schedulerPrivate,{bigint:true});present=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(present){
      const directory=fs.lstatSync(path.dirname(schedulerPrivate),{bigint:true}),before=fs.lstatSync(schedulerPrivate,{bigint:true});
      if(!directory.isDirectory()||directory.isSymbolicLink()||!before.isFile()||before.isSymbolicLink()
        ||before.nlink!==1n||before.size<1n||before.size>8192n)throw Error();
      const descriptor=fs.openSync(schedulerPrivate,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
      try {
        const opened=fs.fstatSync(descriptor,{bigint:true});
        if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1n)throw Error();
        const data=JSON.parse(fs.readFileSync(descriptor,'utf8'));
        require('../payments/prepare-cluera-billing-scheduler-private.cjs').validate(data);
        const after=fs.lstatSync(schedulerPrivate,{bigint:true});
        if(after.isSymbolicLink()||after.nlink!==1n||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size)throw Error();
        add('SIGMAROUND_BILLING_WORKER_SECRET',data.web.SIGMAROUND_BILLING_WORKER_SECRET);
      } finally {fs.closeSync(descriptor);}
    }
  } catch {throw Error('Cluera scheduler private scan input unavailable.');}
  const accountPrivate=path.join(root,'.local-secrets/cluera-release-private.pem');
  if(fs.existsSync(accountPrivate)){
    const pem=fs.readFileSync(accountPrivate,'utf8');
    secrets.push({type:'account signing private key',value:pem.trim()},{type:'account signing private key base64',value:Buffer.from(pem).toString('base64')});
  }
  return secrets;
}

/** Results never contain matched values, snippets, credentials or source lines. */
function detectSecrets(bytes, known = []) {
  const kinds = new Set();
  for (const { type, value } of known) {
    if (bytes.includes(Buffer.from(value)) || bytes.includes(Buffer.from(value, 'utf16le'))) kinds.add(type);
  }
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{32,}-----END/.test(text)) kinds.add('private key');
  if (/\bAIza[\w-]{35}\b/.test(text)) kinds.add('Google API key pattern');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/.test(text)) kinds.add('GitHub token pattern');
  if (/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{40,}\b/.test(text)) kinds.add('provider secret pattern');
  return [...kinds];
}

function scan(root, history = false) {
  const git = args => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args],
    { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const known = loadKnownSecrets(root);
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean))];
  const findings = [];
  let count = 0;
  for (const file of files) {
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid source path.');
    if (!fs.existsSync(absolute)) continue; // a deleted tracked file is checked in history
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) throw new Error('Source contains a symlink or non-file requiring review.');
    if (stat.size > 16 * 1024 * 1024) throw new Error('Oversized source artifact requires separate scanning.');
    const types = detectSecrets(fs.readFileSync(absolute), known);
    count++;
    if (types.length) findings.push({ location: `working file #${count}`, types });
  }
  let blobs = 0;
  if (history) {
    if (git(['rev-parse', '--is-shallow-repository']).toString().trim() !== 'false') {
      throw new Error('Full history requires a non-shallow repository.');
    }
    const ids = git(['rev-list', '--objects', '--all']).toString().split('\n').filter(Boolean).map(line => line.split(' ')[0]);
    if (!ids.length) return { files: count, blobs, findings };
    const result = execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'cat-file', '--batch'], {
      cwd: root, input: ids.join('\n') + '\n', windowsHide: true, maxBuffer: 128 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let offset = 0;
    while (offset < result.length) {
      const newline = result.indexOf(10, offset);
      if (newline < 0) throw new Error('Incomplete Git object scan.');
      const [id, type, length] = result.subarray(offset, newline).toString().split(' ');
      const size = Number(length); offset = newline + 1;
      if (!/^[a-f0-9]{40,64}$/.test(id) || !Number.isSafeInteger(size) || size < 0 || offset + size >= result.length) throw new Error('Invalid Git object scan.');
      if (type === 'blob') {
        blobs++;
        const types = detectSecrets(result.subarray(offset, offset + size), known);
        if (types.length) findings.push({ location: `Git blob ${id}`, types });
      }
      offset += size + 1;
    }
  }
  return { files: count, blobs, findings };
}

if (require.main === module) {
  try {
    const report = scan(path.resolve(__dirname, '../..'), process.argv.includes('--history'));
    console.log(JSON.stringify(report, null, 2));
    if (report.findings.length) process.exitCode = 1;
  } catch {
    // Child-process stderr can contain scanned content; never echo the exception.
    console.error('Source/history secret scan could not complete. Review access, source artifact sizes and Git integrity.');
    process.exitCode = 1;
  }
}
module.exports = { detectSecrets, loadKnownSecrets, scan };
