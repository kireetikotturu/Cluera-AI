'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { merchantDigest, plan, sql, secrets } = require('../scripts/payments/razorpay-go-live.cjs');

const keyId = 'rzp_live_SyntheticKey123', accountId = 'acc_SyntheticAcct123';
const expected = createHash('sha256').update(`razorpay:live:${accountId}:${keyId}`).digest('hex');

test('merchant digest matches the application formula and rejects Test or malformed identifiers', () => {
  assert.equal(merchantDigest(keyId, accountId), expected);
  assert.throws(() => merchantDigest('rzp_test_SyntheticKey123', accountId), /LIVE key id/);
  assert.throws(() => merchantDigest(keyId, 'account_1'), /acc_/);
});
test('plan lists every Vercel and Render setting with the digest and no secret values', () => {
  const output = plan({ 'key-id': keyId, 'account-id': accountId, epoch: '2' });
  assert.match(output, new RegExp(`CLUERA_LIVE_MERCHANT_DIGEST=${expected}`));
  assert.match(output, /CLUERA_LIVE_WORKER_EPOCH=2/);
  assert.match(output, /\/api\/account\/payments\/cluera\/live\/webhook/);
  assert.match(output, /RAZORPAY_LIVE_KEY_SECRET=<paste from Razorpay>/);
  for (const name of ['CLUERA_LIVE_OWNER_APPROVED', 'CLUERA_LIVE_INTAKE_ENABLED', 'CLUERA_LIVE_CHECKOUT_ENABLED', 'CLUERA_BILLING_UI_MODE=live']) assert.ok(output.includes(name), name);
});
test('secrets are fresh, long and distinct', () => {
  const [a, b] = [secrets(), secrets()], pick = text => [...text.matchAll(/= (\S{60,})/g)].map(match => match[1]);
  assert.equal(pick(a).length, 2);
  assert.notEqual(pick(a)[0], pick(a)[1]);
  assert.notDeepEqual(pick(a), pick(b));
});
test('each SQL phase is generated for review with the same acceptance label and no execution', () => {
  const profile = sql({ phase: 'profile', 'key-id': keyId, 'account-id': accountId, epoch: '1' });
  const promote = sql({ phase: 'promote', 'key-id': keyId, 'account-id': accountId, epoch: '2' });
  assert.match(profile, /GENERATED REVIEW PROPOSAL ONLY/);
  assert.match(profile, new RegExp(expected));
  assert.match(profile, /cluera_live_billing_cutover/);
  assert.match(promote, /checkout_enabled=true/);
  const label = text => text.match(/acceptance_digest='([a-f0-9]{64})'/)?.[1];
  assert.equal(label(sql({ phase: 'intake', 'key-id': keyId, 'account-id': accountId, epoch: '2' })), label(promote));
  assert.throws(() => sql({ phase: 'drop', 'key-id': keyId, 'account-id': accountId, epoch: '1' }), /--phase/);
  assert.throws(() => sql({ phase: 'intake', 'key-id': keyId, 'account-id': accountId, epoch: '0' }), /--epoch/);
});
