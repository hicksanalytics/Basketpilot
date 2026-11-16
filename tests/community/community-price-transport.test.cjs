const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCommunityPriceHandler, requestCommunityPrices } = require('../../supabase/drafts/community-price-transport.mjs');

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
