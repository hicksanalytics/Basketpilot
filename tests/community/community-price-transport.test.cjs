const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createCommunityPriceHandler, requestCommunityPrices, createReceiptConsentHandler, requestReceiptConsent
} = require('../../supabase/drafts/community-price-transport.mjs');

const origin = 'https://basketpilot.test';
const path = '/api/community-prices/search';

function post(body, contentType = 'application/json') {
  return new Request(origin + path, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body
  });
}

test('guest search sends a credential-free request and returns the allowlisted price fields', async () => {
  const shared = {
    retailer: 'sams', receipt_item_code: '000111', package_name: 'Fixture Oats, 24 ct',
    package_gtin: '00036000291452', store_id: '0101', location_name: 'Synthetic club',
    purchase_date: '2024-11-10', package_price_cents: 1995
  };
  const handle = createCommunityPriceHandler(async input => {
    assert.deepEqual(input, { name: 'oats', packageGtin: null });
    return [{ ...shared, receipt_id: 'synthetic private ID', receipt_description: 'private fixture text' }];
  });
  const prices = await requestCommunityPrices({ name: ' oats ', packageGtin: null }, async (url, options) => {
    assert.equal(url, path);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers.Authorization, undefined);
    const response = await handle(new Request(origin + url, options));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response;
  });
  assert.deepEqual(prices, [shared]);
});

test('invalid methods, content types, and oversized or ambiguous queries skip the database lookup', async () => {
  const handle = createCommunityPriceHandler(async () => assert.fail('Invalid search must never query the database'));
  const wrongPath = await handle(new Request(origin + '/other'));
  assert.equal(wrongPath.status, 404);
  const wrongMethod = await handle(new Request(origin + path));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('Allow'), 'POST');
  assert.equal((await handle(post('{"name":"oats"}', 'text/plain'))).status, 415);

  for (const invalid of [
    '{',
    '[]',
    '{"name":"x"}',
    '{"name":"oats","packageGtin":"00036000291452"}',
    '{"packageGtin":"036000291452"}',
    '{"name":"oats","owner_id":"synthetic"}',
    ' '.repeat(1024) + '{"name":"oats"}'
  ]) assert.equal((await handle(post(invalid))).status, 400);
});

test('an unavailable lookup returns a safe, uncached error', async () => {
  const handle = createCommunityPriceHandler(async () => {
    throw new Error('synthetic internal connection details');
  });
  const response = await handle(post('{"packageGtin":"00036000291452"}'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { error: 'Community receipt prices could not load. Try searching again.' });
});

const consentPath = '/api/receipt-community/consent';
const ownerId = '10000000-0000-0000-0000-000000000001';
const receiptId = '20000000-0000-0000-0000-000000000001';
const previewToken = 'f2345678901234567890123456789012';
const accessToken = 'synthetic.access.token';

function postConsent(input, authorization = 'Bearer ' + accessToken) {
  const headers = { 'Content-Type': 'application/json' };
  if (authorization) headers.Authorization = authorization;
  return new Request(origin + consentPath, { method: 'POST', headers, body: JSON.stringify(input) });
}

test('owner consent uses a verified bearer and returns an uncached, projected response', async () => {
  const input = { receiptId, action: 'share', revision: 0, previewToken };
  const price = {
    package_name: 'Synthetic case, 40 ct', location_name: 'Synthetic club',
    purchase_date: '2024-11-10', package_price_cents: 1299, on_hold: false
  };
  const consent = {
    outcome: 'shared', revision: 1, observation_count: 1, eligible_count: null, preview_token: null,
    price_rows: [price], exclusion_counts: { package_unverified: 2 }
  };
  const handle = createReceiptConsentHandler({
    async authenticate(token) {
      assert.equal(token, accessToken);
      return { id: ownerId, email: 'synthetic@example.test' };
    },
    async setConsent(received, auth) {
      assert.deepEqual(received, input);
      assert.deepEqual(auth, { ownerId, accessToken });
      return {
        ...consent, receipt_id: receiptId, owner_id: ownerId,
        price_rows: [{ ...price, receipt_item_id: 'synthetic line', receipt_description: 'synthetic private text' }],
        exclusion_counts: { ...consent.exclusion_counts, private_diagnostic: 1 }
      };
    }
  });

  const result = await requestReceiptConsent(input, {
    getAccessToken: async () => accessToken,
    async fetchConsent(url, options) {
      assert.equal(url, consentPath);
      assert.equal(options.headers.Authorization, 'Bearer ' + accessToken);
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), input);
      const response = await handle(new Request(origin + url, options));
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      return response;
    }
  });
  assert.deepEqual(result, consent);
});

test('missing and rejected bearer tokens never reach owner consent', async () => {
  const attemptedTokens = [];
  const handle = createReceiptConsentHandler({
    async authenticate(token) {
      attemptedTokens.push(token);
      return token === 'invalid-user' ? { id: 'synthetic' } : null;
    },
    async setConsent() { assert.fail('Unauthenticated request reached consent'); }
  });
  for (const header of [null, 'Basic dGVzdA==', 'Bearer expired-token', 'Bearer invalid-user']) {
    const response = await handle(postConsent({ receiptId, action: 'status' }, header));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(attemptedTokens, ['expired-token', 'invalid-user']);
  await assert.rejects(requestReceiptConsent({ receiptId, action: 'status' }, {
    getAccessToken: async () => null,
    fetchConsent: async () => assert.fail('A signed-out client attempted a fetch')
  }), /Sign in/);
});

test('the owner route rejects extra fields and inconsistent actions before any provider call', async () => {
  const unexpected = async () => assert.fail('Malformed input triggered a provider call');
  const handle = createReceiptConsentHandler({ authenticate: unexpected, setConsent: unexpected });
  assert.equal((await handle(new Request(origin + path))).status, 404);
  const get = await handle(new Request(origin + consentPath));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
  assert.equal((await handle(new Request(origin + consentPath, { method: 'POST', body: 'text' }))).status, 415);

  for (const invalid of [
    { receiptId, action: 'status', ownerId },
    { receiptId, action: 'status', revision: 0 },
    { receiptId: 'wrong', action: 'status' },
    { receiptId, action: 'delete' },
    { receiptId, action: 'share', revision: 0 },
    { receiptId, action: 'share', revision: -1, previewToken },
    { receiptId, action: 'share', revision: 1.5, previewToken },
    { receiptId, action: 'share', revision: 2147483648, previewToken },
    { receiptId, action: 'share', revision: 0, previewToken: previewToken.toUpperCase() },
    { receiptId, action: 'withdraw', revision: 1, previewToken },
    { receiptId, action: 'withdraw', revision: '1' },
    ' '.repeat(1024)
  ]) assert.equal((await handle(postConsent(invalid))).status, 400);
});

test('the owner route redacts auth failures, unavailable receipts, and database errors', async () => {
  for (const [source, code, expectedStatus, errorMessage] of [
    ['auth', 'unavailable', 503, 'Receipt sharing status could not be confirmed. Try again.'],
    ['database', '42501', 403, 'Receipt sharing is unavailable for this receipt.'],
    ['database', 'unavailable', 503, 'Receipt sharing status could not be confirmed. Try again.']
  ]) {
    const fail = () => { throw Object.assign(new Error('synthetic private details'), { code }); };
    const handle = createReceiptConsentHandler({
      authenticate: source === 'auth' ? fail : async () => ({ id: ownerId }),
      setConsent: source === 'database' ? fail : async () => assert.fail('Unavailable auth must block consent')
    });
    const response = await handle(postConsent({ receiptId, action: 'status' }));
    assert.equal(response.status, expectedStatus);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { error: errorMessage });
  }
});
