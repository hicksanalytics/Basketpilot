const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { PGlite } = require('@electric-sql/pglite');
const { buildProductPage, readCommunityPrices } = require('./product-page-fixture.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const owner = '10000000-0000-0000-0000-000000000001';
const upc = '036000291452';
const gtin = '00036000291452';
const otherUpc = '012345678905';
const otherGtin = '00012345678905';
let db;

async function consent(id, action, revision) {
  return db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [owner]);
    const token = action === 'share'
      ? (await tx.query("select preview_token from receipt_community.set_consent($1,'status')", [id])).rows[0].preview_token
      : null;
    const { rows } = await tx.query('select * from receipt_community.set_consent($1,$2,$3,$4)', [id, action, revision, token]);
    assert.equal(rows[0].outcome, action === 'share' ? 'shared' : 'withdrawn');
  });
}

async function save({ retailer, store, date, code, price, privateGtin = null, share = true }) {
  const id = randomUUID();
  await db.query('insert into receipts (id, owner_id, retailer, store_id, purchase_date, subtotal) values ($1,$2,$3,$4,$5,$6)',
    [id, owner, retailer, store, date, price]);
  await db.query('insert into receipt_items (id, receipt_id, retailer_item_code, quantity, gross_line_total, package_gtin) values ($1,$2,$3,1,$4,$5)',
    [randomUUID(), id, code, price, privateGtin]);
  if (share) await consent(id, 'share', 0);
  return id;
}

before(async () => {
  db = await PGlite.create();
  await db.exec(read('tests/community/receipt-schema.sql'));
  await db.exec(read('supabase/drafts/receipt_community.sql'));
  await db.exec(`
    insert into receipt_community.verified_stores values
      ('sams', '0101', 'Synthetic Franklin Club', 'https://example.com/club'),
      ('costco', '0202', 'Synthetic Brentwood Warehouse', 'https://example.com/warehouse');
    insert into receipt_community.verified_packages values
      ('sams', '000111', 'Fixture Oats, 24 ct', 'https://example.com/large', '${gtin}', 'https://example.com/large-barcode'),
      ('costco', '000111', 'Fixture Oats, 12 ct', 'https://example.com/small', '${otherGtin}', 'https://example.com/small-barcode'),
      ('sams', '000333', 'Fixture Oats, 6 ct', 'https://example.com/trial', null, null),
      ('sams', '000444', 'Fixture Oats, 48 ct', 'https://example.com/bulk', null, null);
  `);
  await save({ retailer: 'sams', store: '0101', date: '2024-11-10', code: '000111', price: 19.95 });
  await save({ retailer: 'sams', store: '0101', date: '2024-10-03', code: '000111', price: 17.95 });
  await save({ retailer: 'costco', store: '0202', date: '2024-11-09', code: '000111', price: 11.99 });
  await save({ retailer: 'sams', store: '0101', date: '2024-11-06', code: '000333', price: 7.49, privateGtin: gtin });
  await save({ retailer: 'sams', store: '0101', date: '2024-11-12', code: '000444', price: 21.99, share: false });
});

after(async () => db?.close());

const packagePrices = input => readCommunityPrices(db, input);

async function until(predicate, message) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail(message);
}

function build(t, { signedIn = false, enabled = true, request = packagePrices } = {}) {
  const personalReceipts = [{
    retailer: 'sams', store_id: '0101', purchase_date: '2024-11-12',
    receipt_items: [{
      id: 'private-item', retailer_item_code: '000111', receipt_description: 'Personal fixture oats 24 ct',
      package_gtin: gtin, quantity: 1, gross_line_total: 18.25
    }]
  }];
  return buildProductPage(t, { userId: signedIn ? owner : null, enabled, request, personalReceipts });
}

test('a signed-out name search displays dated prices for distinct packages and omits unshared receipts', async t => {
  const { byId, search } = build(t);
  await until(() => !byId('sign-in').hidden, 'Guest view should be ready');
  assert.equal(byId('account-status').textContent, 'You can search shared receipt prices now.');
  search(' Fixture Oats ');
  const community = byId('community-results');
  const cards = () => [...community.querySelectorAll('article')];
  await until(() => cards().length === 3, 'Three independently verified packages should appear');
  assert.deepEqual(cards().map(card => card.querySelector('h3').textContent),
    ['Fixture Oats, 12 ct', 'Fixture Oats, 24 ct', 'Fixture Oats, 6 ct']);
  const large = cards()[1];
  assert.deepEqual([...large.querySelectorAll('time')].map(time => time.dateTime), ['2024-11-10', '2024-10-03']);
  assert.match(large.textContent, /Synthetic Franklin Club.*Purchased Nov 10, 2024.*\$19\.95 per package/);
  assert.doesNotMatch(community.textContent, /48 ct|PRIVATE PRINTED LABEL|\$21\.99/);
  assert.match(community.textContent, /Shopper-reported prices from past purchases/);
  assert.match(byId('lookup-description').textContent, /Current retailer prices are unavailable/);
});

test('barcode search uses only the curated exact package barcode and keeps personal prices separate', async t => {
  const { byId, search } = build(t, { signedIn: true });
  await until(() => byId('account-status').textContent.includes('Latest 1'), 'Personal history should be ready');
  search(upc);
  await until(() => byId('community-prices').querySelectorAll('article').length === 1, 'Exact package should appear');
  assert.match(byId('community-prices').textContent, /24 ct/);
  assert.doesNotMatch(byId('community-prices').textContent, /12 ct|6 ct|\$18\.25/);
  assert.match(byId('product-results').textContent, /\$18\.25/);
  assert.doesNotMatch(byId('product-results').textContent, /\$19\.95/);
  assert.equal(byId('results-title').textContent, 'Your receipt prices');
  search(otherUpc);
  await until(() => byId('community-prices').textContent.includes('12 ct'), 'Barcode for smaller package should appear');
  assert.doesNotMatch(byId('community-prices').textContent, /24 ct/);
});

test('a bottle UPC cannot retrieve a case price and the shopper can switch to name search', async t => {
  await db.query('insert into receipt_community.verified_packages values ($1,$2,$3,$4)',
    ['costco', '782796', 'Kirkland Signature Purified Drinking Water, 40 × 16.9 fl oz',
      'https://www.costcobusinessdelivery.com/kirkland-signature-purified-drinking-water%2C-16.9-fl-oz%2C-40-ct-.product.11982447.html']);
  await save({ retailer: 'costco', store: '0202', date: '2024-11-10', code: '782796', price: 4.25,
    privateGtin: '00096619756803' });
  const { byId, search } = build(t);
  for (const bottleUpc of ['096619879045', '096619756803']) {
    search(bottleUpc);
    await until(() => byId('community-status').textContent.includes('whole pack'), 'Bottle UPC should show the recovery path');
    assert.equal(byId('community-prices').children.length, 0);
  }
  search('purified drinking water');
  await until(() => byId('community-prices').textContent.includes('40 × 16.9 fl oz'), 'The case should appear by name');
  assert.match(byId('community-prices').textContent, /\$4\.25 per package/);
});

test('withdrawal removes a price from a fresh lookup and the response contains no source identifiers', async () => {
  const id = await save({ retailer: 'sams', store: '0101', date: '2024-11-13', code: '000111', price: 14.25 });
  const query = { name: null, packageGtin: gtin };
  const rows = await packagePrices(query);
  assert.deepEqual(rows[0], {
    retailer: 'sams', receipt_item_code: '000111', package_name: 'Fixture Oats, 24 ct', package_gtin: gtin,
    store_id: '0101', location_name: 'Synthetic Franklin Club', purchase_date: '2024-11-13', package_price_cents: 1425
  });
  await consent(id, 'withdraw', 1);
  assert.deepEqual((await packagePrices(query)).map(row => row.package_price_cents), [1995, 1795]);
  assert.deepEqual(await packagePrices({ name: '%%', packageGtin: null }), []);
});

test('an outdated lookup cannot overwrite a new search and invalid barcodes stay local', async t => {
  const pending = Promise.withResolvers();
  const requests = [];
  const { byId, search } = build(t, {
    request: input => {
      requests.push(input);
      return input.name ? pending.promise : packagePrices(input);
    }
  });
  search('Oats');
  search(otherUpc);
  await until(() => byId('community-prices').textContent.includes('12 ct'), 'Second search should finish first');
  pending.resolve(await packagePrices({ name: 'Oats', packageGtin: null }));
  await pending.promise;
  assert.equal(byId('community-prices').querySelectorAll('article').length, 1);
  search('036000291451');
  assert.match(byId('community-status').textContent, /Check the digits/);
  assert.equal(byId('community-prices').children.length, 0);
  assert.equal(requests.length, 2);
});

test('the published configuration keeps community lookup dormant', async t => {
  const { byId, search } = build(t, { enabled: false, request: () => assert.fail('Community transport is disabled') });
  await until(() => !byId('sign-in').hidden, 'Guest view should be ready');
  search(upc);
  assert.equal(byId('community-results').hidden, true);
  assert.match(byId('search-status').textContent, /Sign in to see your receipt matches/);
});

test('price lookup keeps a quieter store visible and groups older prices behind a disclosure', async t => {
  const code = '000990';
  const title = 'Fixture pantry oil, 24 fl oz';
  await db.query('insert into receipt_community.verified_stores values ($1,$2,$3,$4)',
    ['sams', '0102', 'Synthetic Quiet Club', 'https://example.com/quiet-club']);
  await db.query('insert into receipt_community.verified_packages values ($1,$2,$3,$4)',
    ['sams', code, title, 'https://example.com/pantry-oil']);
  const purchase = (store, date, price) => save({ retailer: 'sams', store, date, code, price });
  const quieter = await purchase('0102', '2024-08-01', 13.75);
  for (let day = 1; day <= 52; day++) {
    const date = new Date(Date.UTC(2024, 8, day)).toISOString().slice(0, 10);
    await purchase('0101', date, 16);
  }
  await purchase('0101', '2024-11-01', 15.99);
  await purchase('0101', '2024-11-01', 15.99);
  await purchase('0101', '2024-11-01', 16.49);

  const query = 'pantry oil';
  const rows = await packagePrices({ name: query, packageGtin: null });
  assert.equal(rows.length, 10);
  assert.deepEqual([...new Set(rows.map(row => row.store_id))], ['0101', '0102']);
  assert.deepEqual(rows.filter(row => row.purchase_date === '2024-11-01').map(row => row.package_price_cents), [1599, 1649]);

  const { byId, search } = build(t);
  const prices = byId('community-prices');
  search(query);
  await until(() => prices.querySelectorAll('.community-store').length === 2, 'Both stores should be visible');
  const [busyStore, quietStore] = prices.querySelectorAll('.community-store');
  assert.equal(busyStore.querySelector('h4').textContent, 'Synthetic Franklin Club');
  assert.deepEqual([...busyStore.querySelectorAll(':scope > ul time')].map(time => time.dateTime), ['2024-11-01', '2024-11-01']);
  assert.match(quietStore.textContent, /Synthetic Quiet Club.*Purchased Aug 1, 2024.*\$13\.75 per package/);
  const earlier = busyStore.querySelector('details');
  assert.equal(earlier.open, false);
  assert.equal(earlier.querySelector('summary').textContent, 'Earlier receipts');
  earlier.querySelector('summary').click();
  assert.equal(earlier.open, true);
  assert.equal(earlier.querySelector('time').dateTime, '2024-10-22');

  await consent(quieter, 'withdraw', 1);
  search(query);
  await until(() => prices.querySelectorAll('.community-store').length === 1, 'A withdrawn observation should disappear');
  assert.doesNotMatch(prices.textContent, /Synthetic Quiet Club/);
});

test('a temporary lookup failure leaves guest search available for a retry', async t => {
  let available = false;
  const { byId, search } = build(t, {
    request: input => {
      if (!available) throw new Error('Synthetic connection failure');
      return packagePrices(input);
    }
  });
  search(upc);
  await until(() => byId('community-status').textContent.includes('Try searching again'), 'Guest should see a retry message');
  assert.equal(byId('community-prices').children.length, 0);
  available = true;
  search(upc);
  await until(() => byId('community-prices').textContent.includes('24 ct'), 'Retry should find the verified package');
});
