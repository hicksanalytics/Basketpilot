const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { PGlite } = require('@electric-sql/pglite');

const owner = '10000000-0000-0000-0000-000000000001';
const otherUser = '10000000-0000-0000-0000-000000000002';
const packageCode = '0000000421';
let db;

function receiptId(id) {
  return '20000000-0000-0000-0000-' + String(id).padStart(12, '0');
}

function itemId(id) {
  return '30000000-0000-0000-0000-' + String(id).padStart(12, '0');
}

async function addReceipt(id, { retailer = 'fixture', store = '0101', date = '2024-10-01', subtotal = 20 } = {}) {
  await db.query(
    'insert into public.receipts (id, owner_id, retailer, store_id, purchase_date, subtotal) values ($1,$2,$3,$4,$5,$6)',
    [receiptId(id), owner, retailer, store, date, subtotal]
  );
}

async function addItem(receipt, id, { code = packageCode, qty = 2, gross = 20, reviewed = true } = {}) {
  await db.query(
    'insert into public.receipt_items (id, receipt_id, retailer_item_code, quantity, gross_line_total, user_reviewed) values ($1,$2,$3,$4,$5,$6)',
    [itemId(id), receiptId(receipt), code, qty, gross, reviewed]
  );
}

function asAuthenticated(userId, callback) {
  return db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
    return callback(tx);
  });
}

async function consent(id, action, revision = null, userId = owner) {
  const { rows } = await asAuthenticated(userId, tx => tx.query(
    'select * from receipt_community.set_consent($1, $2, $3)',
    [receiptId(id), action, revision]
  ));
  return rows[0];
}

async function observations(id) {
  const { rows } = await db.query(
    'select * from receipt_community.observations where receipt_id = $1 order by receipt_item_id', [receiptId(id)]
  );
  return rows;
}

function result(outcome, revision, observation_count, eligible_count = null) {
  return { outcome, revision, observation_count, eligible_count };
}

before(async () => {
  db = await PGlite.create();
  await db.exec(fs.readFileSync(path.join(__dirname, 'receipt-schema.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(__dirname, '../../supabase/drafts/receipt_community.sql'), 'utf8'));
  await db.exec(`
    insert into receipt_community.verified_stores values
      ('fixture', '0101', 'Synthetic store', 'https://example.com/location'),
      ('other_fixture', '0101', 'Different retailer with same ID', 'https://example.com/other-location');
    insert into receipt_community.verified_packages values
      ('fixture', '0000000421', 'Synthetic package, 24 ct', 'https://example.com/package'),
      ('other_fixture', '0000000422', 'Other retailer package', 'https://example.com/other-package');
  `);
});

after(async () => {
  await db?.close();
});

test('a previously saved receipt stays private until the owner explicitly shares it', async () => {
  await addReceipt(1);
  await addItem(1, 11);
  assert.deepEqual(await consent(1, 'status'), result('status', 0, 0, 1));
  assert.deepEqual(await observations(1), []);
  assert.deepEqual(await consent(1, 'share', 0), result('shared', 1, 1));
  const [row] = await observations(1);
  assert.deepEqual({ ...row, purchase_date: row.purchase_date.toISOString().slice(0, 10) }, {
    receipt_item_id: itemId(11), receipt_id: receiptId(1), retailer: 'fixture',
    store_id: '0101', receipt_item_code: packageCode, purchase_date: '2024-10-01', package_price_cents: 1000
  });
  assert.deepEqual(await consent(1, 'share', 0), result('stale', 1, 1, 1));
  assert.deepEqual(await consent(1, 'share', 1), result('shared', 1, 1));
  assert.equal((await observations(1)).length, 1);
});

test('withdrawal removes the prices and a delayed share cannot restore them', async () => {
  await addReceipt(2);
  await addItem(2, 21);
  assert.deepEqual(await consent(2, 'share', 0), result('shared', 1, 1));
  assert.deepEqual(await consent(2, 'withdraw', 1), result('withdrawn', 2, 0));
  assert.deepEqual(await consent(2, 'withdraw', 1), result('stale', 2, 0, 1));
  assert.deepEqual(await consent(2, 'share', 0), result('stale', 2, 0, 1));
  assert.deepEqual(await observations(2), []);
  assert.deepEqual(await consent(2, 'share', 2), result('shared', 3, 1));
});

test('another account, missing identity, and anonymous role cannot use receipt consent', async () => {
  await addReceipt(3);
  await addItem(3, 31);
  for (const [action, revision] of [['status', null], ['share', 0], ['withdraw', 0]]) {
    await assert.rejects(consent(3, action, revision, otherUser), { code: '42501', message: 'Receipt unavailable' });
  }
  await assert.rejects(consent(999, 'status'), { code: '42501', message: 'Receipt unavailable' });
  await assert.rejects(consent(3, 'share', 0, ''), { code: '42501' });
  await assert.rejects(db.transaction(async tx => {
    await tx.exec('set local role anon');
    await tx.query("select * from receipt_community.set_consent($1, 'status')", [receiptId(3)]);
  }), { code: '42501' });
  await assert.rejects(consent(3, 'share'), { code: '22023' });
  assert.deepEqual(await observations(3), []);
});

test('owner has no direct access to the observation or allowlist tables', async () => {
  for (const statement of [
    'select * from receipt_community.observations',
    'select * from receipt_community.eligible_lines',
    "select * from receipt_community.package_price_history('fixture', '0000000421')",
    "select * from receipt_community.search_package_prices('Synthetic')",
    'delete from receipt_community.observations',
    "insert into receipt_community.verified_stores values ('fixture', '9999', 'Forged', 'https://example.com')",
    'update receipt_community.verified_packages set package_name = package_name',
    'delete from receipt_community.consent_revisions'
  ]) {
    await assert.rejects(asAuthenticated(owner, tx => tx.exec(statement)), { code: '42501' });
  }
});

test('unverified locations, unreconciled subtotals, discounts, and invalid dates prevent sharing', async () => {
  const cases = [
    [4, { store: '9999' }],
    [5, { store: null }],
    [6, { subtotal: 21 }],
    [7, {}],
    [8, { date: null }],
    [9, { date: '2200-01-01' }],
    [10, { retailer: 'other_fixture' }],
    [13, { date: '-infinity' }]
  ];
  for (const [id, options] of cases) {
    await addReceipt(id, options);
    await addItem(id, id * 10 + 1);
    if (id === 7) {
      await db.query('insert into public.receipt_discounts values ($1, $2)', [itemId(72), receiptId(id)]);
      await db.query('update public.receipts set contribution_opt_in = true where id = $1', [receiptId(id)]);
    }
    assert.deepEqual(await consent(id, 'status'), result('status', 0, 0, 0));
    assert.deepEqual(await consent(id, 'share', 0), result('ineligible', 1, 0));
    assert.deepEqual(await consent(id, 'share', 0), result('stale', 1, 0, 0));
    assert.deepEqual(await observations(id), []);
  }
});

test('only reviewed, exact package matches with a whole-package cent price are shared', async () => {
  await addReceipt(11, { subtotal: 79 });
  await addItem(11, 111);
  await addItem(11, 112, { code: '421', gross: 8 });
  await addItem(11, 113, { code: '0000000422', gross: 7 });
  await addItem(11, 114, { qty: 1.5, gross: 5 });
  await addItem(11, 115, { reviewed: false, gross: 8 });
  await addItem(11, 116, { qty: 3, gross: 10 });
  await addItem(11, 117, { qty: 0, gross: 1 });
  await addItem(11, 118, { gross: 0 });
  await addItem(11, 119);
  await db.query(`
    update public.receipt_items set match_status = 'verified',
      matched_title = 'Synthetic package, 24 ct', package_gtin = '00012345678905' where id = $1
  `, [itemId(112)]);
  assert.deepEqual(await consent(11, 'status'), result('status', 0, 0, 2));
  assert.deepEqual(await observations(11), []);
  assert.deepEqual(await consent(11, 'share', 0), result('shared', 1, 2));
  assert.deepEqual((await observations(11)).map(row => row.receipt_item_id), [itemId(111), itemId(119)]);
});

test('deleting a saved receipt removes its observations and consent revision', async () => {
  await addReceipt(12);
  await addItem(12, 121);
  assert.deepEqual(await consent(12, 'share', 0), result('shared', 1, 1));
  await asAuthenticated(owner, tx => tx.query('delete from public.receipts where id = $1', [receiptId(12)]));
  assert.deepEqual(await observations(12), []);
  const { rows } = await db.query('select * from receipt_community.consent_revisions where receipt_id = $1', [receiptId(12)]);
  assert.deepEqual(rows, []);
  await assert.rejects(consent(12, 'status'), { code: '42501' });
});

test('package history contains only dated, distinct prices for the exact verified package', async () => {
  await db.exec(`
    insert into receipt_community.verified_packages values
      ('fixture', '0000000900', 'Other synthetic package, 12 ct', 'https://example.com/other');
  `);
  const code = '0000000900';
  for (const [id, date] of [[20, '2024-10-05'], [21, '2024-11-09'], [22, '2024-11-09'], [23, '2024-12-01']]) {
    await addReceipt(id, { date });
    await addItem(id, id * 10, { code });
  }
  const history = async (retailer = 'fixture', itemCode = code) => {
    const { rows } = await db.query('select * from receipt_community.package_price_history($1, $2)', [retailer, itemCode]);
    return rows.map(row => ({ ...row, purchase_date: row.purchase_date.toISOString().slice(0, 10) }));
  };
  assert.deepEqual(await history(), []);
  for (const id of [20, 21, 22]) await consent(id, 'share', 0);
  const price = date => ({
    retailer: 'fixture', receipt_item_code: code, package_name: 'Other synthetic package, 12 ct',
    store_id: '0101', location_name: 'Synthetic store', purchase_date: date, package_price_cents: 1000
  });
  const old = price('2024-10-05');
  const recent = price('2024-11-09');
  assert.deepEqual(await history(), [recent, old]);
  assert.deepEqual(await history('other_fixture'), []);
  assert.deepEqual(await history('fixture', '900'), []);
  await consent(21, 'withdraw', 1);
  assert.deepEqual(await history(), [recent, old]);
  await consent(22, 'withdraw', 1);
  assert.deepEqual(await history(), [old]);
  await asAuthenticated(owner, tx => tx.query('delete from public.receipts where id = $1', [receiptId(20)]));
  assert.deepEqual(await history(), []);
});
