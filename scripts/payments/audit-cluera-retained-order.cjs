'use strict';
// Protected build diagnostic. Reads one fixed order and SELECT-only RPCs.
// Deliberately produces no website artifact and must never receive an alias.
const path = require('node:path');
const { createRequire, Module } = require('node:module');
async function main() {
  const [sha, ...extra] = process.argv.slice(2);
  if (extra.length || !/^[a-f0-9]{40}$/.test(sha || '')
    || process.env.VERCEL_ENV !== 'production'
    || process.env.VERCEL_PROJECT_ID && process.env.VERCEL_PROJECT_ID !== 'prj_VnxFJLhlCrIXLZk6JYywWUlC5E2B'
    || process.env.VERCEL_ORG_ID && process.env.VERCEL_ORG_ID !== 'team_AksnPXhi2VBXI5UsY2xBIakc'
    || process.env.VERCEL_GIT_COMMIT_SHA && process.env.VERCEL_GIT_COMMIT_SHA !== sha) throw Error('CONTEXT');
  const web = path.resolve(__dirname, '../../web'), req = createRequire(path.join(web, 'package.json'));
  const output = req('esbuild').buildSync({ stdin: { contents:
    "export {auditRetainedTestOrder} from './lib/payments/cluera/retainedOrderAudit';",
    resolveDir: web, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' }).outputFiles[0].text;
  const mod = new Module(path.join(web, 'retained-order-audit-memory.cjs'), module);
  mod.paths = Module._nodeModulePaths(web); mod._compile(output, mod.id);
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!/^sb_secret_[A-Za-z0-9_-]{16,256}$/.test(key || '')
    || process.env.NEXT_PUBLIC_SUPABASE_URL !== 'https://yhnqlfcgrmckhyjdxegg.supabase.co') throw Error('CONFIGURATION');
  const service = req('@supabase/supabase-js').createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, key,
    { auth: { persistSession: false, autoRefreshToken: false }, global: {
      fetch: (url, init) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) }),
    } });
  const rpc = async (name, args) => {
    if (!['cluera_billing_owner', 'cluera_billing_binding'].includes(name)) throw Error('READ_ONLY_BOUNDARY');
    return service.rpc(name, args);
  };
  const report = await mod.exports.auditRetainedTestOrder(rpc);
  console.log('CLUERA_RETAINED_ORDER ' + JSON.stringify(report));
}
if (require.main === module) main().catch(() => {
  console.log('CLUERA_RETAINED_ORDER {"stopped":"UNAVAILABLE","financialMutations":0}');
}).finally(() => { process.exitCode = 2; });
