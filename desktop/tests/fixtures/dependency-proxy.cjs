'use strict';
// Isolated real consumer check: loopback only, synthetic content, ephemeral certificate.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const [desktopManifest, fixtureRoot, keyPath, certPath] = process.argv.slice(2);
const ownRequire = createRequire(desktopManifest);
const packagingRequire = createRequire(ownRequire.resolve('app-builder-lib/package.json'));
const downloaderRequire = createRequire(packagingRequire.resolve('@electron/get'));
const payload = Buffer.from('Synthetic Cluera checksum fixture');
const hash = createHash('sha256').update(payload).digest('hex');
const certificate = fs.readFileSync(certPath);
const sockets = new Set();
const servers = [];
const originalRequest = http.request.bind(http);
const directAgent = new http.Agent({ keepAlive: false });
let proxyHits = 0, connectHits = 0, targetHits = 0, externalRequests = 0;
const stage = name => process.stderr.write(`DEPENDENCY_TEST_STAGE_${name}\n`);

function listen(server) {
  servers.push(server);
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}
function read(client, options) {
  return new Promise((resolve, reject) => {
    const request = client.get({ ...options, hostname: '127.0.0.1', path: '/synthetic', timeout: 5_000 }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    request.on('timeout', () => request.destroy(Error('Fixture deadline.')));
    request.on('error', reject);
  });
}
async function check() {
  try {
    assert.equal(packagingRequire('@electron/get/package.json').version, '3.1.0');
    assert.equal(downloaderRequire('global-agent/package.json').version, '4.1.3-cluera.1');
    const targetPort = await listen(http.createServer((_request, response) => {
      targetHits++; response.end(payload);
    }));
    const tlsPort = await listen(https.createServer({ key: fs.readFileSync(keyPath), cert: certificate }, (_request, response) => response.end('verified TLS fixture')));
    const proxy = http.createServer((request, response) => {
      const destination = new URL(request.url);
      if (destination.hostname !== '127.0.0.1' || Number(destination.port) !== targetPort || destination.protocol !== 'http:') {
        externalRequests++; response.writeHead(403).end(); return;
      }
      proxyHits++;
      const forwarded = originalRequest({ hostname: '127.0.0.1', port: targetPort, path: destination.pathname + destination.search, agent: directAgent }, incoming => incoming.pipe(response));
      forwarded.on('error', () => response.destroy()); request.pipe(forwarded);
    });
    proxy.on('connect', (request, client, head) => {
      if (request.url !== `127.0.0.1:${tlsPort}`) { externalRequests++; client.destroy(); return; }
      connectHits++;
      const upstream = net.connect(tlsPort, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client); client.pipe(upstream);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    });
    const proxyPort = await listen(proxy);
    stage('LOOPBACK_LISTENING');
    // Establish that the ephemeral CA/hostname fixture is valid with native HTTPS.
    assert.equal(await read(https, { port: tlsPort, servername: 'localhost', ca: certificate }), 'verified TLS fixture');
    stage('CONTROL_TLS_VERIFIED');
    process.env.GLOBAL_AGENT_HTTP_PROXY = process.env.GLOBAL_AGENT_HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
    process.env.GLOBAL_AGENT_NO_PROXY = '';
    // The same nested downloader called by app-builder-lib initializes the upgraded proxy.
    const downloader = packagingRequire('@electron/get');
    downloader.initializeProxy();
    stage('PROXY_INITIALIZED');
    assert.equal(await read(http, { port: targetPort }), payload.toString());
    assert.equal(proxyHits, 1); assert.equal(targetHits, 1);
    stage('HTTP_PROXIED');
    global.GLOBAL_AGENT.NO_PROXY = '127.0.0.1';
    assert.equal(await read(http, { port: targetPort }), payload.toString());
    assert.equal(proxyHits, 1); assert.equal(targetHits, 2);
    stage('NO_PROXY_PASSED');
    global.GLOBAL_AGENT.NO_PROXY = '';
    await assert.rejects(read(https, { port: tlsPort, servername: 'localhost' }), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.equal(connectHits, 1);
    stage('UNTRUSTED_TLS_REJECTED');
    await assert.rejects(read(https, { port: tlsPort, servername: 'localhost', secureEndpoint: false }), error => error.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || error.code === 'SELF_SIGNED_CERT_IN_CHAIN');
    assert.equal(connectHits, 2);
    await assert.rejects(read(https, { port: tlsPort, servername: 'wrong-host.invalid', ca: certificate }), error => error.code === 'ERR_TLS_CERT_ALTNAME_INVALID');
    assert.equal(connectHits, 3);
    assert.equal(await read(https, { port: tlsPort, servername: 'localhost', ca: certificate }), 'verified TLS fixture');
    assert.equal(connectHits, 4);
    stage('TRUSTED_TLS_PASSED');
    const options = {
      artifactName: 'synthetic.bin', isGeneric: true, version: '1.3.2',
      cacheRoot: path.join(fixtureRoot, 'cache'), tempDirectory: fixtureRoot,
      cacheMode: downloader.ElectronDownloadCacheMode.Bypass,
      mirrorOptions: { mirror: `http://127.0.0.1:${targetPort}/`, customDir: 'fixtures' },
      checksums: { 'synthetic.bin': hash }, downloadOptions: { quiet: true, retry: { limit: 0 }, timeout: { request: 5_000 } },
    };
    const artifact = await downloader.downloadArtifact(options);
    assert.deepEqual(fs.readFileSync(artifact), payload);
    assert.equal(proxyHits, 2);
    stage('DOWNLOAD_CHECKSUM_PASSED');
    await assert.rejects(downloader.downloadArtifact({ ...options, checksums: { 'synthetic.bin': '0'.repeat(64) } }),
      error => error instanceof downloaderRequire('sumchecker').ChecksumMismatchError);
    assert.equal(proxyHits, 3); assert.equal(externalRequests, 0);
    stage('BAD_CHECKSUM_REJECTED');
    console.log(JSON.stringify({ packagingConsumer: 'app-builder-lib/@electron/get@3.1.0', proxy: true, noProxy: true,
      tlsUntrustedRejected: true, tlsExplicitCaVerified: true, downloadedChecksumVerified: true,
      wrongChecksumRejected: true, externalRequests }));
  } finally {
    http.globalAgent.destroy?.(); https.globalAgent.destroy?.(); directAgent.destroy();
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}
check().catch(() => { console.error('Synthetic packaging proxy/checksum check failed.'); process.exitCode = 1; });
