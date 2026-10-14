"use strict";

// Byte-preserving source preparation only. No install, build, Git write, database,
// deployment, credential transfer or executable launch. The Account reference tree
// is ignored and is NOT the final Cluera publication/deployment source.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const PINNED = Object.freeze({
  license: {
    commit: "d7477fd00bd11f16484f6e25c9cd3df124a2b74d",
    tree: "8e6d80c2356ef737eedaa634af37297430ed7f34",
    files: 260,
  },
  account: {
    commit: "6e3a4d45111d0f9916881314d5ea8b08b22eef4b",
    tree: "5ee82f8338368c041d3fd2918400015973f20bad",
    files: 581,
  },
});
const UI_OVERLAY = Object.freeze([
  "resources/account-version.json",
  "scripts/verify-account-ui.cjs",
  "scripts/preview-account-ui.cjs",
  "scripts/check-account-ui-layout.cjs",
  "scripts/fixtures/account-ui-preview.tsx",
  "src/main/accounts/registerAccountIpc.ts",
  "src/renderer/App.tsx",
  "src/renderer/components/AccountRoot.tsx",
  "src/renderer/components/AccountLogin.tsx",
  "src/renderer/main.tsx",
  "src/renderer/pages/SessionEditorPage.tsx",
  "src/renderer/styles/account.css",
  "tests/accountDistribution.test.ts",
  "tests/accountIpc.test.ts",
  "tests/contracts.test.ts",
  "tests/accountLoginUi.test.ts",
  "tests/accountSessionEditorUi.test.ts",
  "web/app/account/AccountPanel.tsx",
  "web/app/account/account-ui.css",
  "web/app/account/admin/AccountAdmin.tsx",
  "web/app/account/admin/page.tsx",
  "web/tests/accountAuthUi.test.ts",
  "web/tests/accountAdminUi.test.ts",
  "web/tests/fixtures/accountUiPreview.tsx",
]);

function assert(ok, category) {
  if (!ok) throw new Error(category);
}
function gitHash(bytes) {
  return crypto
    .createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}
function sourcePath(file, reviewedGeneratedPaths = new Set()) {
  assert(
    typeof file === "string" &&
      file.length > 0 &&
      file.length < 1024 &&
      !/[\\:\x00-\x1f]/.test(file),
    "SOURCE_PATH",
  );
  const parts = file.split("/");
  assert(
    parts.every(
      (p) =>
        p &&
        p !== "." &&
        p !== ".." &&
        !/[. ]$/.test(p) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    ),
    "SOURCE_PATH",
  );
  assert(
    !parts.some((p) =>
      /^(?:\.git|node_modules|\.next|\.local-secrets|secrets|release(?:-.*)?)$/i.test(p),
    ) && (!parts.some((p) => /^dist(?:-.*)?$/i.test(p)) || reviewedGeneratedPaths.has(file)),
    "GENERATED_OR_PRIVATE_SOURCE",
  );
  assert(
    !parts.some((p) => /^\.env/i.test(p) && p !== ".env.example"),
    "ENV_SOURCE",
  );
  assert(
    !/\.(?:exe|pfx|p12|key|sqlite(?:3)?|db)$/i.test(file),
    "PRIVATE_OR_BINARY_OUTPUT",
  );
  return file;
}
function beneath(parent, target) {
  const rel = path.relative(path.resolve(parent), path.resolve(target));
  assert(
    rel &&
      rel !== ".." &&
      !rel.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(rel),
    "TARGET_SCOPE",
  );
  return path.resolve(target);
}
function noLinks(file) {
  let current = path.resolve(file);
  for (;;) {
    if (fs.existsSync(current))
      assert(!fs.lstatSync(current).isSymbolicLink(), "SOURCE_OR_TARGET_LINK");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function decode(record) {
  assert(
    record &&
      record.encoding === "base64" &&
      typeof record.content === "string",
    "BLOB_ENCODING",
  );
  const encoded = record.content.replace(/[\r\n]/g, "");
  assert(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    ),
    "BLOB_ENCODING",
  );
  const bytes = Buffer.from(encoded, "base64");
  assert(bytes.toString("base64") === encoded, "BLOB_ENCODING");
  return bytes;
}
function sensitiveKinds(bytes, known = []) {
  const text = bytes.toString("utf8");
  const kinds = [];
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]{32,}-----END/.test(
      text,
    )
  )
    kinds.push("private-key");
  if (
    /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/.test(text)
  )
    kinds.push("github-token");
  if (/\bAIza[\w-]{35}\b/.test(text)) kinds.push("provider-key");
  for (const value of known)
    if (
      value.length >= 16 &&
      (bytes.includes(Buffer.from(value)) ||
        bytes.includes(Buffer.from(value, "utf16le")))
    )
      kinds.push("known-secret");
  return [...new Set(kinds)];
}
function validateEntries(tree, reviewedGeneratedPaths = new Set()) {
  assert(Array.isArray(tree) && tree.length > 0, "TREE_SHAPE");
  const seen = new Set();
  return tree
    .filter((e) => e.type === "blob")
    .map((e) => {
      sourcePath(e.path, reviewedGeneratedPaths);
      assert(
        e.mode === "100644" &&
          /^[a-f0-9]{40}$/.test(e.sha) &&
          Number.isSafeInteger(e.size) &&
          e.size >= 0 &&
          e.size <= 16 * 1024 * 1024,
        "BLOB_PIN",
      );
      const normalized = e.path.toLowerCase();
      assert(!seen.has(normalized), "DUPLICATE_PATH");
      seen.add(normalized);
      return e;
    });
}
function verifyTree(tree, expectedRoot, reviewedGeneratedPaths = new Set()) {
  // Default remains deny-all generated/private paths for historical reference
  // clones. The Cluera deploy preparer alone supplies exact manifest-verified
  // runtime paths and their known parent directories, never a prefix wildcard.
  assert(reviewedGeneratedPaths instanceof Set, "REVIEWED_PATHS_SHAPE");
  validateEntries(tree, reviewedGeneratedPaths);
  const entries = new Map(),
    children = new Map();
  for (const e of tree) {
    sourcePath(e.path, reviewedGeneratedPaths);
    assert(
      e.type === "blob" ||
        (e.type === "tree" &&
          e.mode === "040000" &&
          /^[a-f0-9]{40}$/.test(e.sha)),
      "TREE_ENTRY",
    );
    assert(!entries.has(e.path.toLowerCase()), "DUPLICATE_PATH");
    entries.set(e.path.toLowerCase(), e);
    const parent =
      path.posix.dirname(e.path) === "." ? "" : path.posix.dirname(e.path);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(e);
  }
  for (const e of tree) {
    const parent = path.posix.dirname(e.path);
    if (parent !== ".")
      assert(entries.get(parent.toLowerCase())?.type === "tree", "TREE_PARENT");
  }
  const directoryHash = (dir) => {
    const ordered = (children.get(dir) || [])
      .slice()
      .sort((a, b) =>
        Buffer.compare(
          Buffer.from(
            path.posix.basename(a.path) + (a.type === "tree" ? "/" : ""),
          ),
          Buffer.from(
            path.posix.basename(b.path) + (b.type === "tree" ? "/" : ""),
          ),
        ),
      );
    const bytes = Buffer.concat(
      ordered.map((e) =>
        Buffer.concat([
          Buffer.from(
            `${e.type === "tree" ? "40000" : e.mode} ${path.posix.basename(e.path)}\0`,
          ),
          Buffer.from(e.sha, "hex"),
        ]),
      ),
    );
    return crypto
      .createHash("sha1")
      .update(`tree ${bytes.length}\0`)
      .update(bytes)
      .digest("hex");
  };
  for (const e of tree.filter((e) => e.type === "tree"))
    assert(directoryHash(e.path) === e.sha, "TREE_CONTENT_PIN");
  assert(directoryHash("") === expectedRoot, "TREE_CONTENT_PIN");
}
function pinManifest(manifest, kind) {
  const expected = PINNED[kind],
    item = manifest[kind];
  assert(
    expected &&
      item &&
      item.commit === expected.commit &&
      item.sha === expected.tree &&
      item.truncated === false,
    "TREE_PIN",
  );
  const entries = validateEntries(item.tree);
  assert(entries.length === expected.files, "TREE_COMPLETENESS");
  verifyTree(item.tree, expected.tree);
  return entries;
}
function prepare(entries, getBytes, known = []) {
  return entries.map((e) => {
    const bytes = getBytes(e);
    assert(
      Buffer.isBuffer(bytes) &&
        bytes.length === e.size &&
        gitHash(bytes) === e.sha,
      "SOURCE_BYTE_PIN",
    );
    assert(sensitiveKinds(bytes, known).length === 0, "SOURCE_SECRET");
    return { path: e.path, sha: e.sha, bytes };
  });
}
function exportNew(parent, target, plan) {
  target = beneath(parent, target);
  noLinks(target);
  assert(!fs.existsSync(target), "TARGET_EXISTS");
  assert(plan.length > 0, "EMPTY_EXPORT");
  validateEntries(
    plan.map((p) => ({
      ...p,
      type: "blob",
      mode: "100644",
      size: p.bytes.length,
    })),
  );
  // Validate all bytes BEFORE the first directory or file is created.
  assert(
    plan.every(
      (p) =>
        Buffer.isBuffer(p.bytes) &&
        gitHash(p.bytes) === p.sha &&
        sensitiveKinds(p.bytes).length === 0,
    ),
    "EXPORT_PIN",
  );
  fs.mkdirSync(target); // exclusive root; never merge into a user-owned tree
  for (const p of plan) {
    const dest = beneath(target, path.join(target, p.path));
    noLinks(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, p.bytes, { flag: "wx" });
    assert(gitHash(fs.readFileSync(dest)) === p.sha, "EXPORT_READBACK");
  }
  return { files: plan.length, bytePinsVerified: true };
}
function loadBundles(directory) {
  noLinks(directory);
  const map = new Map();
  for (const name of fs
    .readdirSync(directory)
    .filter((n) => /^source-bundle-\d+\.json$/.test(n))
    .sort()) {
    const records = JSON.parse(
      fs.readFileSync(path.join(directory, name), "utf8"),
    );
    assert(Array.isArray(records), "BUNDLE_SHAPE");
    for (const r of records) {
      sourcePath(r.path);
      assert(!map.has(r.path), "DUPLICATE_BLOB");
      map.set(r.path, r);
    }
  }
  return map;
}
function regularBytes(root, file) {
  const location = beneath(root, path.join(root, sourcePath(file)));
  noLinks(location);
  assert(fs.lstatSync(location).isFile(), "SOURCE_NOT_REGULAR");
  return fs.readFileSync(location);
}
function main(args) {
  assert(args.length === 4, "USAGE");
  const [manifestPath, bundleDir, reviewedDir, localUiDir] = args.map((v) =>
    path.resolve(v),
  );
  noLinks(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const licenseEntries = pinManifest(manifest, "license"),
    accountEntries = pinManifest(manifest, "account");
  const bundles = loadBundles(bundleDir);
  const known = [
    "RAZORPAY_TEST_KEY_SECRET",
    "RAZORPAY_TEST_WEBHOOK_SECRET",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]
    .map((name) => process.env[name])
    .filter(Boolean);
  const license = prepare(
    licenseEntries,
    (e) => {
      const record = bundles.get(`license/${e.path}`);
      assert(record?.sha === e.sha, "REMOTE_BYTE_PIN");
      return decode(record);
    },
    known,
  );
  const account = prepare(
    accountEntries,
    (e) => {
      const record = bundles.get(`account/${e.path}`);
      if (record) {
        assert(record.sha === e.sha, "REMOTE_BYTE_PIN");
        return decode(record);
      }
      return regularBytes(reviewedDir, e.path);
    },
    known,
  );
  const overlaid = new Map(account.map((p) => [p.path, p]));
  const uiPins = [];
  for (const file of UI_OVERLAY) {
    const bytes = regularBytes(localUiDir, file);
    assert(sensitiveKinds(bytes, known).length === 0, "SOURCE_SECRET");
    const sha = gitHash(bytes);
    overlaid.set(file, { path: file, sha, bytes });
    uiPins.push({ path: file, sha, bytes: bytes.length });
  }
  const root = path.resolve(__dirname, ".."),
    products = path.dirname(root);
  const referenceParent = path.join(root, ".migration-source");
  noLinks(referenceParent);
  // Preflight both targets before exporting either tree.
  const licenseTarget = path.join(products, "sigmaround-license");
  const accountTarget = path.join(referenceParent, "account-with-ui");
  for (const target of [licenseTarget, accountTarget]) {
    noLinks(target);
    assert(!fs.existsSync(target), "TARGET_EXISTS");
  }
  fs.mkdirSync(referenceParent, { recursive: true });
  const licenseResult = exportNew(products, licenseTarget, license);
  const accountResult = exportNew(referenceParent, accountTarget, [
    ...overlaid.values(),
  ]);
  const report = {
    status: "reference-sources-only-not-deployable",
    license: { ...PINNED.license, ...licenseResult },
    account: { ...PINNED.account, ...accountResult },
    uiOverlay: uiPins,
    paymentOrDatabaseActions: 0,
    originalSourceWrites: 0,
  };
  fs.writeFileSync(
    path.join(referenceParent, "source-provenance.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  console.log(
    JSON.stringify({
      status: report.status,
      licenseFiles: licenseResult.files,
      accountWithUiFiles: accountResult.files,
      uiOverlayFiles: uiPins.length,
      bytePinsVerified: true,
      paymentOrDatabaseActions: 0,
    }),
  );
}
if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // Fixed categories only; no source snippets, values, child output or file contents.
    const code =
      error instanceof Error && /^[A-Z_]+$/.test(error.message)
        ? error.message
        : "PREPARATION_FAILED";
    console.error(JSON.stringify({ status: "failed", category: code }));
    process.exitCode = 1;
  }
}
module.exports = {
  PINNED,
  UI_OVERLAY,
  gitHash,
  sourcePath,
  beneath,
  decode,
  sensitiveKinds,
  validateEntries,
  verifyTree,
  pinManifest,
  prepare,
  exportNew,
};
