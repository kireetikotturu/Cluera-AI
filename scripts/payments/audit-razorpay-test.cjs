"use strict";
const { createHash, timingSafeEqual } = require("node:crypto");
const path = require("node:path"),
  { createRequire, Module } = require("node:module");
let config;
function paymentConfig() {
  if (config) return config;
  const root = path.resolve(__dirname, "../.."),
    webRequire = createRequire(path.join(root, "web/package.json"));
  const { buildSync } = webRequire("esbuild");
  const output = buildSync({
    entryPoints: [path.join(root, "web/lib/payments/core/config.ts")],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
  }).outputFiles[0].text;
  const filename = path.join(__dirname, "payment-config.cjs"),
    loaded = new Module(filename, module);
  loaded._compile(output, filename);
  return (config = loaded.exports);
}
const ENDPOINT =
  "https://cluera-ai-staging.vercel.app/api/payments/razorpay/test/webhook";
const requiredEvents = ["payment.captured", "order.paid", "refund.processed"];
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
// Primary-merchant v1 and linked-account v2 responses have distinct representations.
// Never use truthiness ("false" or an arbitrary nonzero number must not enable anything).
const flag = (value) =>
  value === true || value === 1 || value === "true"
    ? true
    : value === false || value === 0 || value === "false"
      ? false
      : null;
function eventSelection(value) {
  if (Array.isArray(value))
    return {
      shape: "array",
      valid:
        value.every((x) => typeof x === "string") &&
        new Set(value).size === value.length,
      names: value.filter((x) => typeof x === "string"),
    };
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return {
      shape: "flag-map",
      valid: entries.every(([, enabled]) => flag(enabled) !== null),
      names: entries
        .filter(([, enabled]) => flag(enabled) === true)
        .map(([name]) => name),
    };
  }
  return { shape: "unknown", valid: false, names: [] };
}
async function audit(env = process.env, request = fetch, options = {}) {
  const report = {
    component: "razorpay-test-owner-readonly",
    mutations: 0,
    requests: 0,
  };
  const phase = options?.phase ?? "disabled";
  const validOptions =
    options &&
    typeof options === "object" &&
    !Array.isArray(options) &&
    Object.keys(options).every((key) =>
      ["phase", "expectedTesterDigest"].includes(key),
    );
  report.phase = ["disabled", "intake-only"].includes(phase)
    ? phase
    : "unknown";
  try {
    paymentConfig().assertPaymentStaging(env);
    report.exactStaging = env.SIGMAROUND_PAYMENT_PROVIDER === "razorpay";
  } catch {
    report.exactStaging = false;
  }
  report.disabled =
    env.SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED === "false" &&
    env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED === "false" &&
    env.SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED === "false";
  report.switchesMatch =
    phase === "disabled"
      ? report.disabled
      : phase === "intake-only" &&
        env.SIGMAROUND_RAZORPAY_TEST_CHECKOUT_ENABLED === "false" &&
        env.SIGMAROUND_RAZORPAY_TEST_INTAKE_ENABLED === "true" &&
        env.SIGMAROUND_PADDLE_SANDBOX_CHECKOUT_ENABLED === "false";
  let testerVerified =
    phase === "disabled" && options?.expectedTesterDigest === undefined;
  if (phase === "intake-only") {
    const testers = (env.SIGMAROUND_PAYMENT_TESTER_IDS ?? "")
      .split(",")
      .map((value) => value.trim());
    const validSingle =
      testers.length === 1 &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        testers[0],
      );
    const pinned =
      typeof options.expectedTesterDigest === "string" &&
      /^[a-f0-9]{64}$/.test(options.expectedTesterDigest);
    const approvedMatch =
      validSingle &&
      pinned &&
      same(
        createHash("sha256").update(testers[0]).digest("hex"),
        options.expectedTesterDigest,
      );
    report.tester = { validSingle, approvedMatch };
    testerVerified = approvedMatch;
  }
  const key = env.RAZORPAY_TEST_KEY_ID ?? "",
    secret = env.RAZORPAY_TEST_KEY_SECRET ?? "",
    signer = env.RAZORPAY_TEST_WEBHOOK_SECRET ?? "",
    account = env.RAZORPAY_TEST_ACCOUNT_ID ?? "";
  report.formats = {
    testKeyId: /^rzp_test_[A-Za-z0-9]{8,64}$/.test(key),
    apiSecret: secret.length >= 16 && secret.length <= 256,
    webhookSecret: signer.length >= 32 && signer.length <= 256,
    merchantId: /^acc_[A-Za-z0-9]{8,64}$/.test(account),
  };
  let credentialsValid = false;
  try {
    paymentConfig().razorpayConfig(env);
    credentialsValid = true;
  } catch {}
  if (
    !validOptions ||
    !report.exactStaging ||
    !report.switchesMatch ||
    !testerVerified ||
    !credentialsValid ||
    Object.values(report.formats).some((x) => !x)
  )
    return {
      ...report,
      stopped: "CONFIGURATION",
      completedAt: new Date().toISOString(),
    };
  async function get(path) {
    if (
      !/^\/v1\/(?:orders\?count=1&skip=0|webhooks\?count=100&skip=(?:0|100|200|300|400|500|600|700|800|900))$/.test(
        path,
      )
    )
      throw Error("BOUND");
    report.requests++;
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000);
    let reader;
    try {
      const res = await request("https://api.razorpay.com" + path, {
        method: "GET",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Authorization:
            "Basic " + Buffer.from(key + ":" + secret).toString("base64"),
          Accept: "application/json",
        },
      });
      if (!res.body) throw Error("BODY");
      reader = res.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.length;
        if (size > 262144) throw Error("BOUND");
        chunks.push(result.value);
      }
      if (res.status !== 200) return { status: res.status };
      return {
        status: res.status,
        value: JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      };
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
  try {
    const orders = await get("/v1/orders?count=1&skip=0");
    report.ordersHttp = orders.status;
    report.testAuthentication =
      orders.status === 200 &&
      orders.value?.entity === "collection" &&
      Array.isArray(orders.value.items) &&
      orders.value.items.length <= 1 &&
      orders.value.count === orders.value.items.length;
    if (!report.testAuthentication)
      return {
        ...report,
        stopped: "API_AUTHENTICATION",
        completedAt: new Date().toISOString(),
      };
    report.orderSampleCount = orders.value.items.length; // A bounded sample, not an unlimited absence claim.
    report.webhooks = {
      complete: false,
      pages: 0,
      total: 0,
      exactMatches: 0,
      matches: [],
    };
    const ids = new Set();
    for (let page = 0; page < 10; page++) {
      const result = await get("/v1/webhooks?count=100&skip=" + page * 100);
      report.webhooks.httpStatus = result.status;
      if (result.status !== 200) {
        report.stopped = "WEBHOOK_READ_UNAVAILABLE";
        break;
      }
      const rows = Array.isArray(result.value?.items)
        ? result.value.items
        : Array.isArray(result.value)
          ? result.value
          : null;
      if (!rows || rows.length > 100) throw Error("SHAPE");
      report.webhooks.pages++;
      report.webhooks.total += rows.length;
      for (const row of rows) {
        if (typeof row?.id !== "string" || ids.has(row.id))
          throw Error("SHAPE");
        ids.add(row.id);
        if (row.url !== ENDPOINT) continue;
        const selection = eventSelection(row.events),
          subscriptions = new Set(selection.names),
          rawSecret = typeof row.secret === "string" ? row.secret : undefined;
        const secretReadable =
          !!rawSecret && !/^\*+$/.test(rawSecret) && rawSecret !== "[REDACTED]";
        report.webhooks.exactMatches++;
        // Report the provider's active flag separately, never a derived status labelled "active".
        const disabledMarkerZero =
          row.disabled_at === 0 || row.disabled_at === "0";
        report.webhooks.matches.push({
          active: flag(row.active) === true,
          disabledAtRepresentation: typeof row.disabled_at,
          disabledMarkerZero,
          activationRepresentation: typeof row.active,
          activationKnown: flag(row.active) !== null,
          eventsRepresentation: selection.shape,
          eventsKnown: selection.valid,
          testService: ["beta-api-test", "api-test"].includes(row.service),
          serviceKnown: [
            "beta-api-test",
            "api-test",
            "beta-api-live",
            "api-live",
          ].includes(row.service),
          merchantOwner: row.owner_type === "merchant",
          accountIdMatchesWebhookOwner:
            same(row.owner_id, account) || same(row.owner_id, account.slice(4)),
          secretExists: row.secret_exists === true || secretReadable,
          secretReadable,
          secretMatches: secretReadable ? same(rawSecret, signer) : null,
          requiredEvents:
            selection.valid &&
            requiredEvents.every((name) => subscriptions.has(name)),
          exactEvents:
            selection.valid &&
            subscriptions.size === 3 &&
            requiredEvents.every((name) => subscriptions.has(name)),
          eventCount: subscriptions.size,
          eventsPresent: requiredEvents.filter((name) =>
            subscriptions.has(name),
          ),
        });
      }
      if (rows.length < 100) {
        report.webhooks.complete = true;
        break;
      }
    }
  } catch {
    report.unavailable = true;
  }
  report.completedAt = new Date().toISOString();
  return report;
}
// Never part of the website build; explicitly run only in a protected full-source diagnostic build.
// Intentional failure prevents producing a website artifact or changing the stable alias.
if (require.main === module) {
  audit()
    .then((report) => {
      console.log("SIGMAROUND_SAFE_RAZORPAY_AUDIT " + JSON.stringify(report));
      process.exitCode = 1;
    })
    .catch(() => {
      console.log(
        "SIGMAROUND_SAFE_RAZORPAY_AUDIT " +
          JSON.stringify({
            component: "razorpay-test-owner-readonly",
            stopped: "UNAVAILABLE",
            requests: 0,
            mutations: 0,
          }),
      );
      process.exitCode = 1;
    });
}
module.exports = { audit };
