'use strict';
// Fixed Cluera staging targets, credential-free GETs only. Passing this audit
// proves public boundaries, never private customer/payment/provider acceptance.
const path = require('node:path');
const { detectSecrets, loadKnownSecrets } = require('./security/source-secret-scan.cjs');
const WEB = 'https://cluera-ai-staging.vercel.app';
const RELAY = 'https://cluera-ai-relay-staging.onrender.com';
const checks = Object.freeze([
  ['home', WEB, '/', [200]], ['pricing', WEB, '/pricing', [200]],
  ['account', WEB, '/account', [200]], ['checkout', WEB, '/account/checkout', [200]],
  ['download', WEB, '/download', [200]], ['admin-page', WEB, '/account/admin', [200]],
  ['auth-options', WEB, '/api/account/auth-options', [200]],
  ['catalog', WEB, '/api/account/payments/cluera/catalog', [200]],
  ['credits-denied', WEB, '/api/account/credits', [401]],
  ['native-credits-denied', WEB, '/api/account/native/credits', [401]],
  ['admin-denied', WEB, '/api/account/admin', [401]],
  ['admin-access-denied', WEB, '/api/account/admin/access', [401]],
  ['checkout-denied', WEB, '/api/account/payments/cluera/checkout', [401]],
  ['history-denied', WEB, '/api/account/payments/cluera/history?expectedAccountId=00000000-0000-4000-8000-000000000001', [401, 404]],
  ['release-unapproved', WEB, '/api/cluera/update/test', [404]],
  ['relay-health', RELAY, '/healthz', [200]],
]);
const expectedCatalog = Object.freeze({
  cluera_pack_3h_v2: [54900, 10800, 'PACK'],
  cluera_monthly_40h_v2: [549900, 144000, 'RECURRING'],
  cluera_monthly_100h_v2: [959900, 360000, 'RECURRING'],
  cluera_monthly_200h_v2: [1954900, 720000, 'RECURRING'],
});
const pageMarkers = Object.freeze({
  home: ['Your interview workspace.', 'One Cluera account.'],
  pricing: ['Cluera plans and pricing', 'Your next great conversation starts here.'],
  account: ['Your Cluera account', 'Checking your account'],
  checkout: ['Buy Cluera credits'],
  download: ['Download Cluera AI.', 'Cluera TEST installer awaiting approval'],
  'admin-page': ['Verify access to continue', 'Checking your current session...', '/account#login'],
});
const expectedErrors = Object.freeze({
  'credits-denied': { 401: 'UNAUTHENTICATED' },
  'native-credits-denied': { 401: 'UNAUTHENTICATED' },
  'admin-denied': { 401: 'ADMIN_SIGN_IN_REQUIRED' },
  'admin-access-denied': { 401: 'Sign in to continue.' },
  'checkout-denied': { 401: 'Sign in with a verified email.' },
  'history-denied': { 401: 'Sign in with a verified Cluera account.', 404: 'Billing history is unavailable.' },
  'release-unapproved': { 404: 'No approved Cluera AI test installer is available.' },
});
const catalogFields = ['revisionId','offerCode','name','version','amountPaise','currency','allowanceSeconds','kind','interval','totalCount','testPlanValidated','enabled'].sort().join(',');
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);

function inspect(name, response, body, known, revision) {
  try {
  if (detectSecrets(Buffer.from(body), known).length) return false;
  const html = Object.hasOwn(pageMarkers,name);
  if (!(html ? /^text\/html(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i).test(response.headers.get('content-type') ?? '')) return false;
  if (html) {
    if (!/<html\b/i.test(body) || !/<main\b/i.test(body) || !pageMarkers[name].every(marker => body.includes(marker))) return false;
    // The actual anonymous server gate must be present. Merely omitting one
    // protected heading does not distinguish a login/error/empty HTML page.
    return name !== 'admin-page' || !['Account administration','ACCOUNT CONTROL CENTER','account-admin-users'].some(marker => body.includes(marker));
  }
  const value = JSON.parse(body);
  if (!plainObject(value)) return false;
  if (Object.hasOwn(expectedErrors,name)) return Object.keys(value).length === 1
    && typeof value.error === 'string' && value.error === expectedErrors[name][response.status];
  if (name === 'auth-options') {
    return Object.keys(value).length === 1 && ['enabled', 'disabled'].includes(value.google);
  }
  if (name === 'catalog') {
    if (Object.keys(value).length !== 1 || !Array.isArray(value.catalog) || value.catalog.length !== 4) return false;
    const seen = new Set();
    return value.catalog.every(row => {
      if (!plainObject(row) || Object.keys(row).sort().join(',') !== catalogFields) return false;
      const expected = expectedCatalog[row.offerCode];
      if (!expected || seen.has(row.offerCode)) return false;
      seen.add(row.offerCode);
      return uuid(row.revisionId) && typeof row.name === 'string' && row.name.trim() === row.name && row.name.length >= 2 && row.name.length <= 80
        && Number.isSafeInteger(row.version) && row.version > 0 && typeof row.enabled === 'boolean' && typeof row.testPlanValidated === 'boolean'
        && row.amountPaise === expected[0] && row.allowanceSeconds === expected[1]
        && row.kind === expected[2] && row.currency === 'INR'
        && (row.kind === 'PACK' ? row.interval === null && row.totalCount === null
          : row.interval === 'MONTH' && Number.isSafeInteger(row.totalCount) && row.totalCount >= 1 && row.totalCount <= 120)
        && (row.kind !== 'RECURRING' || row.enabled === false);
    });
  }
  if (name === 'relay-health') {
    return Object.keys(value).length === 1 && value.ok === true
      && /^[a-f0-9]{40}$/.test(response.headers.get('x-cluera-revision') ?? '')
      && (!revision || response.headers.get('x-cluera-revision') === revision);
  }
  return false;
  } catch { return false; }
}

async function run(request = fetch, known = [], revision) {
  if (revision !== undefined && (typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision))) throw Error('Invalid expected revision.');
  const results = [];
  let google = 'unavailable';
  for (const [name, origin, route, statuses] of checks) {
    const controller = new AbortController();
    let reader, timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { reject(Error('Bounded request failed.')); controller.abort(); }, 20000);
    });
    try {
      const url = origin + route;
      const response = await Promise.race([request(url, {
        method: 'GET', headers: { Accept: name === 'catalog' || name === 'auth-options' || name === 'relay-health' ? 'application/json' : '*/*' },
        redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: controller.signal,
      }), deadline]);
      if (!response.body) throw Error('Missing body.');
      const maximum = Object.hasOwn(pageMarkers,name) ? 2097152 : name === 'catalog' ? 32768 : 4096;
      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declaredLength) || Number(declaredLength) > maximum)) throw Error('Body bound.');
      const chunks = []; let size = 0;
      reader = response.body.getReader();
      for (;;) {
        const part = await Promise.race([reader.read(), deadline]);
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maximum) throw Error('Body bound.');
        chunks.push(part.value);
      }
      const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
      const pass = statuses.includes(response.status) && !response.redirected
        && (!response.url || response.url === url) && !response.headers.has('location')
        && response.headers.get('cache-control')?.split(',').some(token => token.trim().toLowerCase() === 'no-store')
        && response.headers.get('x-content-type-options') === 'nosniff'
        && inspect(name, response, body, known, revision);
      if (name === 'auth-options' && pass) google = JSON.parse(body).google;
      results.push({ name, status: response.status, pass: !!pass });
    } catch { results.push({ name, status: null, pass: false }); }
    finally {
      clearTimeout(timer); controller.abort();
      void reader?.cancel().catch(() => {});
      try { reader?.releaseLock(); } catch { /* No unbounded cleanup wait. */ }
    }
  }
  return { observedAt: new Date().toISOString(), scope: 'CLUERA_STAGING_PUBLIC_GET_ONLY',
    financialMutations: 0, privateAcceptance: 'NOT_TESTED', productionReady: false,
    google, checks: results, passed: results.filter(row => row.pass).length,
    failed: results.filter(row => !row.pass).length };
}
module.exports = { run, inspect, checks };
if (require.main === module) {
  if (process.argv.length > 3) { console.error('Expected only an optional exact relay commit SHA.'); process.exitCode = 1; }
  else run(fetch, loadKnownSecrets(path.resolve(__dirname, '..')), process.argv[2]).then(report => {
    console.log(JSON.stringify(report)); if (report.failed) process.exitCode = 1;
  }).catch(() => { console.error('Cluera public boundary verification failed.'); process.exitCode = 1; });
}
