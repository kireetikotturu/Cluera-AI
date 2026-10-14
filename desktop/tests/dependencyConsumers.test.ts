import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../', import.meta.url));
const temporaryBase = path.resolve(desktop, '../.test-output');
const temporaryRoots: string[] = [];
const childEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test', TEMP: temporaryBase, TMP: temporaryBase };
for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR']) {
  if (process.env[name]) childEnv[name] = process.env[name];
}

function temporaryRoot() {
  fs.mkdirSync(temporaryBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(temporaryBase, 'cluera-dependency-'));
  temporaryRoots.push(root);
  return root;
}
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    // Only remove this test's exclusive, resolved directory inside the fixture root.
    if (path.dirname(root) !== temporaryBase || !path.basename(root).startsWith('cluera-dependency-')) throw Error('Unexpected fixture path.');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('scoped dependency consumer compatibility', () => {
  it('resolves only the reviewed parser/proxy overrides and retains the cache isolation fix', () => {
    const mammothRequire = createRequire(require.resolve('mammoth'));
    const packagingRequire = createRequire(require.resolve('app-builder-lib/package.json'));
    const downloaderRequire = createRequire(packagingRequire.resolve('@electron/get'));
    expect(mammothRequire('argparse/package.json').version).toBe('2.0.1');
    expect(packagingRequire('@electron/get/package.json').version).toBe('3.1.0');
    expect(downloaderRequire('global-agent/package.json').version).toBe('4.1.3-cluera.1');
    expect(createRequire(require.resolve('cacheable-request'))('http-cache-semantics/package.json').version).toBe('4.3.0-cluera.1');
    expect(() => mammothRequire.resolve('sprintf-js')).toThrow();
    expect(() => downloaderRequire.resolve('roarr')).toThrow();
  });

  it('uses the actual Mammoth library and CLI with valid/invalid arguments', async () => {
    const root = temporaryRoot();
    const mammoth = require('mammoth');
    const mammothRequire = createRequire(require.resolve('mammoth'));
    const zip = new (mammothRequire('jszip'))();
    zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
    zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Cluera dependency document</w:t></w:r></w:p></w:body></w:document>');
    const bytes: Buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const input = path.join(root, 'input.docx');
    fs.writeFileSync(input, bytes);
    expect((await mammoth.extractRawText({ buffer: bytes })).value.trim()).toBe('Synthetic Cluera dependency document');
    const cli = path.join(path.dirname(require.resolve('mammoth/package.json')), 'bin/mammoth');
    const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args], {
      cwd: root, env: childEnv, encoding: 'utf8', timeout: 15_000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    const help = invoke(['--help']);
    expect(help.error).toBeUndefined(); expect(help.status).toBe(0); expect(help.stdout).toContain('--output-format');
    const stdout = invoke([input]);
    expect(stdout.error).toBeUndefined(); expect(stdout.status).toBe(0); expect(stdout.stdout).toContain('<p>Synthetic Cluera dependency document</p>');
    const output = path.join(root, 'output.md');
    const markdown = invoke([input, output, '--output-format', 'markdown']);
    expect(markdown.error).toBeUndefined(); expect(markdown.status).toBe(0); expect(fs.readFileSync(output, 'utf8').trim()).toBe('Synthetic Cluera dependency document');
    for (const args of [[], [input, '--output-format', 'pdf'], [input, output, '--output-dir', root]]) {
      const rejected = invoke(args);
      expect(rejected.error).toBeUndefined(); expect(rejected.status).toBe(2);
      expect(rejected.stderr).toContain('error:');
    }
  }, 20_000);

  it('preserves actual packaging-download proxy, NO_PROXY, certificate validation and checksums', () => {
    const root = temporaryRoot();
    const candidates = process.platform === 'win32'
      ? ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe', 'C:/Program Files/Git/mingw64/bin/openssl.exe'] : ['openssl'];
    const openssl = candidates.find(command => spawnSync(command, ['version'], { env: childEnv, windowsHide: true, timeout: 5_000 }).status === 0);
    expect(openssl, 'OpenSSL is required for ephemeral TLS fixture generation; this test must not silently skip.').toBeDefined();
    const key = path.join(root, 'synthetic-key.pem'), cert = path.join(root, 'synthetic-cert.pem');
    const generated = spawnSync(openssl!, ['req', '-newkey', 'rsa:2048', '-nodes', '-x509', '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert],
    { env: childEnv, windowsHide: true, timeout: 15_000, encoding: 'utf8' });
    expect(generated.error).toBeUndefined(); expect(generated.status).toBe(0);
    const fixture = fileURLToPath(new URL('./fixtures/dependency-proxy.cjs', import.meta.url));
    const result = spawnSync(process.execPath, [fixture, path.join(desktop, 'package.json'), root, key, cert], {
      env: childEnv, cwd: root, encoding: 'utf8', timeout: 20_000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      packagingConsumer: 'app-builder-lib/@electron/get@3.1.0', proxy: true, noProxy: true,
      tlsUntrustedRejected: true, tlsExplicitCaVerified: true, downloadedChecksumVerified: true,
      wrongChecksumRejected: true, externalRequests: 0,
    });
  }, 45_000);
});
