const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const { createServer } = require('node:http');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');
const { createClient } = require('@supabase/supabase-js');
const { createSupabaseReceiptConsentHandler } = require('../../supabase/drafts/supabase-receipt-consent.mjs');

const ownerId = '10000000-0000-0000-0000-000000000001';
const otherId = '10000000-0000-0000-0000-000000000002';
const receiptId = '20000000-0000-0000-0000-000000000001';
const missingId = '20000000-0000-0000-0000-000000000002';
const publishableKey = 'sb_publishable_fixture';
const seen = [];
let db, provider, handleConsent, transactions = 0;

before(async () => {
  db = await PGlite.create();
  for (const file of ['tests/community/receipt-schema.sql', 'supabase/drafts/receipt_community.sql']) {
    await db.exec(fs.readFileSync(path.join(__dirname, '../..', file), 'utf8'));
  }
  await db.exec(`
    create role fixture_consent_login login noinherit;
    grant receipt_community_consent to fixture_consent_login;
    insert into receipt_community.verified_stores values
      ('sams', '0101', 'Synthetic club', 'https://example.test/store');
    insert into receipt_community.verified_packages values
      ('sams', '000111', 'Fixture Oats, 24 ct', 'https://example.test/items');
  `);
  await db.query(
    "insert into receipts (id, owner_id, retailer, store_id, purchase_date, subtotal) values ($1, $2, 'sams', '0101', '2024-11-10', 20)",
    [receiptId, ownerId]
  );
  await db.query(
    "insert into receipt_items (id, receipt_id, retailer_item_code, quantity, gross_line_total) values (gen_random_uuid(), $1, '000111', 2, 20)",
    [receiptId]
  );

  const users = new Map([
    ['fixture-owner-token', { id: ownerId, aud: 'authenticated' }],
    ['fixture-other-token', { id: otherId, aud: 'authenticated', user_metadata: { owner_id: ownerId } }],
    ['fixture-anonymous-token', { id: ownerId, aud: 'authenticated', is_anonymous: true }]
  ]);
  provider = createServer((request, response) => {
    const { authorization, apikey } = request.headers;
    seen.push({ method: request.method, path: request.url, authorization, apikey });
    const token = authorization?.replace(/^Bearer /, '');
    const user = users.get(token);
    const errors = {
      'fixture-revoked-token': [403, 'session_not_found'],
      'fixture-outage-token': [503, 'unexpected_failure']
    };
    const [status, code] = user ? [200] : errors[token] ?? [403, 'bad_jwt'];
    response.writeHead(status, {
      'Content-Type': 'application/json', 'X-Supabase-Api-Version': '2024-01-01'
    }).end(JSON.stringify(user ?? { code, message: 'Synthetic provider details' }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const { auth } = createClient('http://127.0.0.1:' + provider.address().port, publishableKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false }
  });

  await db.exec('set session authorization fixture_consent_login');
  handleConsent = createSupabaseReceiptConsentHandler({
    auth,
    database: {
      transaction(run) {
        transactions++;
        return db.transaction(run);
      }
    }
  });
});

after(async () => {
  await db?.close();
  if (provider) await new Promise(resolve => provider.close(resolve));
});

function send(token, input) {
  return handleConsent(new Request('https://basketpilot.test/api/receipt-community/consent', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  }));
}

async function assertCleanConnection() {
  const { rows } = await db.query(`
    select current_user as actor,
      nullif(current_setting('request.jwt.claim.sub', true), '') as sub,
      nullif(current_setting('request.jwt.claims', true), '') as claims
  `);
  assert.deepEqual(rows, [{ actor: 'fixture_consent_login', sub: null, claims: null }]);
}

test('Supabase Auth SDK verification supplies the only owner identity for preview, share and withdrawal', async () => {
  const token = 'fixture-owner-token';
  const previewResponse = await send(token, { receiptId, action: 'status' });
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.headers.get('Cache-Control'), 'no-store');
  const preview = await previewResponse.json();
  assert.equal(preview.observation_count, 0);
  assert.deepEqual(preview.price_rows.map(row => [row.package_name, row.package_price_cents]), [['Fixture Oats, 24 ct', 1000]]);
  assert.deepEqual(seen[0], {
    method: 'GET', path: '/auth/v1/user', authorization: 'Bearer ' + token, apikey: publishableKey
  });

  const share = { receiptId, action: 'share', revision: preview.revision, previewToken: preview.preview_token };
  const published = await (await send(token, share)).json();
  assert.equal(published.outcome, 'shared');
  assert.equal(published.observation_count, 1);
  const retry = await (await send(token, share)).json();
  assert.equal(retry.outcome, 'stale');
  assert.equal(retry.observation_count, 1);

  const withheld = await (await send('fixture-other-token', {
    receiptId, action: 'withdraw', revision: published.revision
  }));
  const missing = await send('fixture-other-token', { receiptId: missingId, action: 'status' });
  assert.equal(withheld.status, 403);
  assert.equal(missing.status, 403);
  assert.deepEqual(await withheld.json(), await missing.json());
  await assertCleanConnection();

  const withdrawal = await (await send(token, { receiptId, action: 'withdraw', revision: published.revision })).json();
  assert.equal(withdrawal.outcome, 'withdrawn');
  assert.equal(withdrawal.observation_count, 0);
  await assertCleanConnection();
});

test('rejected, anonymous, and unavailable identity checks do not open a consent transaction', async () => {
  const startingTransactions = transactions;
  for (const [token, expectedStatus] of [
    ['fixture-invalid-token', 401], ['fixture-revoked-token', 401],
    ['fixture-anonymous-token', 401], ['fixture-outage-token', 503]
  ]) {
    const response = await send(token, { receiptId, action: 'status' });
    assert.equal(response.status, expectedStatus, token);
    assert.doesNotMatch(JSON.stringify(await response.json()), /Synthetic|fixture|owner_id/);
  }
  assert.equal(transactions, startingTransactions);
});

test('the dedicated consent login cannot directly read or change receipts or observations', async () => {
  await assert.rejects(db.query('select id from receipts'), { code: '42501' });
  for (const statement of [
    'select id from receipts',
    'select * from receipt_community.observations',
    'delete from receipt_community.observations',
    "select * from receipt_community.search_package_prices('Oats', null)"
  ]) {
    await assert.rejects(db.transaction(async tx => {
      await tx.query('set local role receipt_community_consent');
      await tx.query(statement);
    }), { code: '42501' });
  }
  await assertCleanConnection();
});
