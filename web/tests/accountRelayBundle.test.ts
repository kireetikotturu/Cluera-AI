import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { expect, it } from 'vitest';

// Exercise the deployed independent ESM entry point, not only TypeScript under Vitest.
// Synthetic configuration; no valid JWT and no provider requests in this test.
it('bundled standalone relay rejects unauthenticated traffic and idle sockets', async () => {
  const backend = fileURLToPath(new URL('../../backend/', import.meta.url));
  fs.mkdirSync(path.join(backend,'.test-output'),{recursive:true});
  const temp=fs.mkdtempSync(path.join(backend,'.test-output/relay-')),outfile=path.join(temp,'main.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../../backend/main.ts', import.meta.url))],
    platform: 'node', target: 'node24', format: 'esm', bundle: true, packages: 'external', outfile });
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = (portProbe.address() as { port: number }).port;
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  const logs: string[] = [];
  const child = spawn(process.execPath, [outfile], { cwd: backend, windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: 'production', PORT: String(port),
      SIGMAROUND_ACCOUNTS_ENABLED: 'true', SIGMAROUND_ACCOUNT_RELAY_ENABLED: 'true',
      SIGMAROUND_ACCOUNT_ORIGIN: 'https://cluera-ai-staging.vercel.app',
      NEXT_PUBLIC_SUPABASE_URL: 'https://yhnqlfcgrmckhyjdxegg.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_synthetic-service-key-not-valid',
      SIGMAROUND_ACCOUNT_RATE_SECRET_BASE64: Buffer.alloc(32, 9).toString('base64'),
      SIGMAROUND_MANAGED_GEMINI_API_KEY: 'synthetic-gemini-key-not-valid',
      SIGMAROUND_MANAGED_DEEPGRAM_API_KEY: 'synthetic-deepgram-key-not-valid',
    } });
  child.stdout.on('data', data => logs.push(data.toString()));
  child.stderr.on('data', data => logs.push(data.toString()));
  const peers: WebSocket[] = [];
  try {
    let ready = false;
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      ready = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) })
        .then(async response => response.status === 200 && (await response.text()) === '{"ok":true}').catch(() => false);
      if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(ready, 'Bundled relay must start with synthetic staging configuration.').toBe(true);
    for (const idle of [false, true]) {
      const peer = new WebSocket(`ws://127.0.0.1:${port}/v1/session`, { handshakeTimeout: 1000 }); peers.push(peer);
      const frames: string[] = []; peer.on('message', data => frames.push(data.toString()));
      const closed = once(peer, 'close', { signal: AbortSignal.timeout(12500) });
      await once(peer, 'open');
      if (!idle) peer.send(JSON.stringify({ type: 'generate', id: 'synthetic', prompt: 'must-not-reach-provider' }));
      const [code, reason] = await closed;
      expect(code).toBe(1008); expect(reason.toString() === 'Account session ended.').toBe(true);
      expect(frames).toEqual(['{"type":"sessionEnded"}']);
    }
    // The client's close can arrive before the child's stdout pipe delivers its
    // last event. Await pipe data, not an arbitrary sleep or an early log count.
    const logDeadline = AbortSignal.timeout(2000);
    while ((logs.join('').match(/"event":"socket_closed"/g) ?? []).length < 2) {
      await once(child.stdout, 'data', { signal: logDeadline });
    }
    const events = logs.join('').trim().split(/\r?\n/).filter(Boolean);
    const allowed = ['authorization_failed', 'terminal_write_complete', 'close_requested', 'socket_closed'];
    expect(events.length).toBe(8);
    expect(events.every(line => allowed.some(event => line === JSON.stringify({ component: 'account-relay', event })))).toBe(true);
  } finally {
    for (const peer of peers) peer.terminate();
    child.kill(); await once(child, 'exit').catch(() => undefined);
    fs.rmSync(temp,{recursive:true,force:true});
  }
}, 20000);
