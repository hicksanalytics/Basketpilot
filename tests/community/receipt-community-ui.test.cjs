const assert = require('node:assert/strict');
const { randomUUID, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { PGlite } = require('@electric-sql/pglite');
const { JSDOM } = require('jsdom');
const { buildProductPage, readCommunityPrices } = require('./product-page-fixture.cjs');

const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
const owner = '10000000-0000-0000-0000-000000000001';
const store = '0101';
const code = '0000000421';
let db, createReceiptCommunity;

before(async () => {
  ({ createReceiptCommunity } = await import('../../supabase/drafts/receipt-community-ui.mjs'));
  db = await PGlite.create();
  await db.exec(read('tests/community/receipt-schema.sql'));
  await db.exec(read('supabase/drafts/receipt_community.sql'));
  await db.query('insert into receipt_community.verified_stores values ($1,$2,$3,$4)',
    ['sams', store, 'Synthetic club', 'https://example.com/store']);
  await db.query('insert into receipt_community.verified_packages values ($1,$2,$3,$4)',
    ['sams', code, 'Synthetic package, 24 ct', 'https://example.com/item']);
});

after(async () => {
  await db?.close();
});

async function until(predicate, message) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await predicate()) return;
    await sleep(10);
  }
  assert.fail(message);
}

async function writeReceipt({ id = randomUUID(), owner_id = owner, retailer = 'sams',
  store_id = store, purchase_date = '2024-10-01', subtotal = 20 } = {}) {
  await db.query('insert into receipts (id, owner_id, retailer, store_id, purchase_date, subtotal) values ($1,$2,$3,$4,$5,$6)',
    [id, owner_id, retailer, store_id, purchase_date, subtotal]);
  return id;
}

async function writeLine({ receipt_id, retailer_item_code = code, quantity = 2, gross_line_total = 20,
  receipt_description = 'SYNTHETIC PURCHASE' }) {
  await db.query('insert into receipt_items (id, receipt_id, retailer_item_code, quantity, gross_line_total, receipt_description) values ($1,$2,$3,$4,$5,$6)',
    [randomUUID(), receipt_id, retailer_item_code, quantity, gross_line_total, receipt_description]);
}

async function asUser(userId, run) {
  return db.transaction(async tx => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [userId ?? '']);
    return run(tx);
  });
}

async function countObservations(id) {
  const { rows } = await db.query('select count(*)::int as count from receipt_community.observations where receipt_id = $1', [id]);
  return rows[0].count;
}

function build(t, { sharing = true, signedIn = true } = {}) {
  const dom = new JSDOM(read('public/receipts.html'), {
    url: 'https://basketpilot.test/receipts.html',
    runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const byId = id => window.document.getElementById(id);
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.TextEncoder = TextEncoder;
  Object.defineProperty(window.crypto, 'subtle', { value: webcrypto.subtle });

  let user = signedIn ? { id: owner, email: 'fixture@example.test' } : null;
  const controls = { operations: [], lastSaved: null, loseShareResponse: false, beforeLines: null };
  const client = {
    auth: {
      async getUser() { return { data: { user } }; },
      async signOut() { user = null; return {}; },
      async signInWithPassword() { user = { id: owner, email: 'fixture@example.test' }; return {}; },
      onAuthStateChange() {}
    },
    from(table) {
      return {
        insert(payload) {
          if (table === 'receipts') {
            assert.equal(payload.owner_id, user?.id);
            assert.equal(payload.contribution_opt_in, false);
            return { select: () => ({ single: async () => {
              const id = await writeReceipt(payload);
              controls.lastSaved = id;
              return { data: { id } };
            } }) };
          }
          assert.equal(table, 'receipt_items');
          return (async () => {
            await controls.beforeLines?.();
            for (const line of payload) await writeLine(line);
            return {};
          })();
        },
        select() {
          assert.equal(table, 'receipts');
          const userId = user?.id;
          return { order: () => ({ limit: async () => {
            const { rows } = await asUser(userId, tx => tx.query(
              'select id, retailer, store_id, purchase_date::text, subtotal as total from receipts order by purchase_date desc'
            ));
            return { data: rows };
          } }) };
        }
      };
    }
  };

  window.fixture = {
    createClient: () => client,
    community: createReceiptCommunity(async (id, action, revision, token) => {
      controls.operations.push({ id, action, revision });
      const { rows } = await asUser(user?.id, tx => tx.query(
        'select * from receipt_community.set_consent($1,$2,$3,$4)', [id, action, revision, token]
      ));
      if (action === 'share' && controls.loseShareResponse) throw new Error('Synthetic lost response');
      return rows[0];
    })
  };
  for (const script of window.document.querySelectorAll('script:not([type])')) {
    window.eval(script.hasAttribute('src') ? read('public' + script.getAttribute('src')) : script.textContent);
  }
  let cloud = read('public/receipt-cloud.js').replace(/^import .*;$/m, 'const { createClient } = window.fixture;');
  assert.ok(cloud.includes('const receiptCommunity = null;'));
  if (sharing) cloud = cloud.replace('const receiptCommunity = null;', 'const receiptCommunity = window.fixture.community;');
  window.eval(cloud);

  function review(date = '10/10/2024') {
    byId('receipt-text').value = [
      "SAM'S CLUB", date + ' 14:05 1047 ' + store + ' 07', code + ' FIXTURE PRODUCT 20.00', 'SUBTOTAL 20.00', 'TOTAL 20.00'
    ].join('\n');
    byId('parse').click();
    assert.equal(byId('store-id').value, store);
    assert.equal(window.BasketPilotReceiptBridge.getPayload().valid, true);
  }

  return { window, byId, controls, review };
}

function panelIn(parent) {
  return [...parent.querySelectorAll('details')].find(panel => panel.querySelector('summary')?.textContent === 'Community prices');
}

async function action(panel, text) {
  const button = panel.querySelector('button');
  await until(() => !button.disabled && !button.classList.contains('hidden') && button.textContent === text, 'Missing action: ' + text);
  return button;
}

test('a new receipt saves privately through sign-in before review can explicitly share it', async t => {
  const { byId, controls, review } = build(t, { signedIn: false });
  review();
  byId('quick-save').click();
  assert.match(byId('cloud-status').textContent, /Sign in/);
  assert.equal(byId('review-community').hidden, true);
  byId('auth-email').value = 'fixture@example.test';
  byId('auth-password').value = 'fixture-pass';
  byId('auth-login').click();

  await until(() => !byId('review-community').hidden, 'Review sharing panel should appear after a private save');
  const share = await action(panelIn(byId('review-community')), 'Share 1 item price');
  assert.equal(await countObservations(controls.lastSaved), 0);
  assert.deepEqual(controls.operations.map(op => op.action), ['status']);
  share.click();
  share.click();
  await action(panelIn(byId('review-community')), 'Withdraw shared prices');
  assert.equal(await countObservations(controls.lastSaved), 1);
  assert.deepEqual(controls.operations.map(op => op.action), ['status', 'share']);

  byId('sample').click();
  assert.equal(byId('review-community').hidden, true);
  byId('quick-save').click();
  assert.match(byId('finalstatus').textContent, /fictional/);
});

test('history can share a previously saved receipt and recover a lost response before withdrawal', async t => {
  const id = await writeReceipt({ purchase_date: '2024-11-01' });
  await writeLine({ receipt_id: id });
  const { byId, controls } = build(t);
  const history = byId('cloud-history');

  await until(() => history.textContent.includes('2024-11-01'), 'Previously saved receipt should load');
  const card = [...history.children].find(child => child.textContent.includes('2024-11-01'));
  const panel = panelIn(card);
  assert.deepEqual(controls.operations, []);
  panel.querySelector('summary').click();
  const share = await action(panel, 'Share 1 item price');
  assert.match(panel.querySelector('li').textContent, /Synthetic package, 24 ctSynthetic club · Nov 1, 2024 · \$10\.00 per package/);
  assert.equal(panel.querySelector('time').dateTime, '2024-11-01');
  assert.doesNotMatch(panel.querySelector('li').textContent, /SYNTHETIC PURCHASE/);
  controls.loseShareResponse = true;
  share.click();
  const check = await action(panel, 'Check sharing status');
  assert.equal(await countObservations(id), 1);
  check.click();
  (await action(panel, 'Withdraw shared prices')).click();
  await action(panel, 'Check eligible prices');
  assert.equal(await countObservations(id), 0);
  const { rows } = await db.query('select id from receipts where id = $1', [id]);
  assert.deepEqual(rows, [{ id }]);
  assert.deepEqual(controls.operations, [
    { id, action: 'status', revision: null }, { id, action: 'share', revision: 0 },
    { id, action: 'status', revision: null }, { id, action: 'withdraw', revision: 1 }
  ]);
  byId('auth-logout').click();
  await until(() => !panel.isConnected && !byId('cloud-auth').classList.contains('hidden'), 'Signing out should remove saved receipt controls');
});

test('edits during an in-flight save cannot attach sharing to the changed review', async t => {
  const { byId, controls, window, review } = build(t);
  await until(() => !byId('cloud-signed-in').classList.contains('hidden'), 'Fixture should be signed in');
  review('10/15/2024');
  const pending = Promise.withResolvers();
  let reachedLines = false;
  controls.beforeLines = () => {
    reachedLines = true;
    return pending.promise;
  };
  byId('quick-save').click();
  await until(() => reachedLines, 'Private save should reach the line write');
  const amount = byId('items').querySelector('[aria-label="Paid amount"]');
  amount.value = '12.34';
  amount.dispatchEvent(new window.Event('input', { bubbles: true }));
  pending.resolve();
  await until(() => byId('cloud-status').textContent.startsWith('Saved 1'), 'Private save should finish');
  assert.equal(byId('review-community').hidden, true);
  assert.deepEqual(controls.operations, []);
  const { rows } = await db.query('select gross_line_total::int as paid from receipt_items where receipt_id = $1', [controls.lastSaved]);
  assert.deepEqual(rows, [{ paid: 20 }]);
});

test('the published configuration stays off for new and previously saved receipts', async t => {
  const { byId, controls, review } = build(t, { sharing: false });
  await until(() => byId('cloud-history').querySelector('.cloud-history-card'), 'Private history should still work');
  assert.equal(panelIn(byId('cloud-history')), undefined);
  review('10/21/2024');
  byId('quick-save').click();
  await until(() => byId('cloud-status').textContent.startsWith('Saved 1'), 'Private save should still work');
  assert.equal(byId('review-community').hidden, true);
  assert.deepEqual(controls.operations, []);
  assert.equal(await countObservations(controls.lastSaved), 0);
});

test('history hides sharing for an ineligible receipt and reports stale consent without applying it again', async t => {
  const eligibleId = await writeReceipt({ purchase_date: '2024-11-02' });
  await writeLine({ receipt_id: eligibleId });
  const ineligibleId = await writeReceipt({ purchase_date: '2024-11-03', store_id: '9999' });
  await writeLine({ receipt_id: ineligibleId });
  const { byId, controls } = build(t);
  const history = byId('cloud-history');
  await until(() => history.textContent.includes('2024-11-03'), 'Synthetic receipts should load');
  const cardOn = date => [...history.children].find(child => child.textContent.includes(date));

  const ineligible = panelIn(cardOn('2024-11-03'));
  ineligible.querySelector('summary').click();
  await until(() => ineligible.textContent.includes('No item prices qualify'), 'Ineligible receipt should explain sharing is unavailable');
  assert.match(ineligible.textContent, /exact package match, a known store/);
  assert.ok(ineligible.querySelector('button').classList.contains('hidden'));

  const eligible = panelIn(cardOn('2024-11-02'));
  eligible.querySelector('summary').click();
  const share = await action(eligible, 'Share 1 item price');
  await asUser(owner, async tx => {
    const { rows: [preview] } = await tx.query("select preview_token from receipt_community.set_consent($1,'status')", [eligibleId]);
    await tx.query("select * from receipt_community.set_consent($1,'share',0,$2)", [eligibleId, preview.preview_token]);
  });
  share.click();
  await action(eligible, 'Withdraw shared prices');
  assert.match(eligible.textContent, /Sharing changed elsewhere/);
  assert.equal(await countObservations(eligibleId), 1);
  assert.deepEqual(controls.operations.filter(op => op.id === eligibleId).map(op => op.action), ['status', 'share']);
});

test('history shows a changed preview and requires a new tap before publishing', async t => {
  const id = await writeReceipt({ purchase_date: '2024-11-04' });
  await writeLine({ receipt_id: id });
  const { byId } = build(t);
  const history = byId('cloud-history');
  await until(() => history.textContent.includes('2024-11-04'), 'Saved receipt should load');
  const card = [...history.children].find(child => child.textContent.includes('2024-11-04'));
  const panel = panelIn(card);
  panel.querySelector('summary').click();
  const share = await action(panel, 'Share 1 item price');
  assert.match(panel.querySelector('li').textContent, /\$10\.00 per package/);

  await db.query('update public.receipt_items set quantity = 1 where receipt_id = $1', [id]);
  share.click();
  await until(() => panel.textContent.includes('Review the updated prices'), 'Changed price should require fresh approval');
  assert.match(panel.querySelector('li').textContent, /\$20\.00 per package/);
  assert.equal(await countObservations(id), 0);

  (await action(panel, 'Share 1 item price')).click();
  await action(panel, 'Withdraw shared prices');
  assert.equal(panel.querySelector('ul').getAttribute('aria-label'), 'Shared item prices');
  assert.equal(await countObservations(id), 1);
});

test('an opt-in on receipt review appears in signed-out product search and a history withdrawal removes it', async t => {
  const receiptCode = '0000000954';
  const title = 'Synthetic pantry oats, 52 packets';
  const price = '13.46';
  await db.query('insert into receipt_community.verified_packages values ($1,$2,$3,$4)',
    ['sams', receiptCode, title, 'https://example.com/oats']);
  const receiptPage = build(t);
  const productPage = buildProductPage(t, { request: input => readCommunityPrices(db, input) });
  const { byId, window, controls } = receiptPage;
  await until(() => !byId('cloud-signed-in').classList.contains('hidden'), 'Receipt owner should be signed in');
  await until(() => !productPage.byId('sign-in').hidden, 'Search should be signed out');

  byId('receipt-text').value = [
    "SAM'S CLUB", '10/27/2024 14:05 1047 0101 07',
    receiptCode + ' PRIVATE FIXTURE LABEL ' + price,
    'SUBTOTAL ' + price, 'TOTAL ' + price
  ].join('\n');
  byId('parse').click();
  const payload = window.BasketPilotReceiptBridge.getPayload();
  assert.equal(payload.storeId, '0101');
  assert.equal(payload.parsed.items[0].sku, receiptCode);
  byId('quick-save').click();
  await until(() => !byId('review-community').hidden, 'Review sharing panel should appear');
  const reviewPanel = panelIn(byId('review-community'));
  const share = await action(reviewPanel, 'Share 1 item price');
  assert.equal(reviewPanel.querySelector('li strong').textContent, title);
  assert.equal(reviewPanel.querySelector('time').dateTime, '2024-10-27');
  assert.match(reviewPanel.querySelector('li').textContent, /\$13\.46 per package/);

  const sharedPrices = productPage.byId('community-prices');
  const searchStatus = productPage.byId('community-status');
  const query = 'pantry oats';
  productPage.search(query);
  await until(() => searchStatus.textContent.includes('No shared receipt prices'), 'Private save should not appear in guest search');
  assert.equal(sharedPrices.children.length, 0);
  share.click();
  await action(reviewPanel, 'Withdraw shared prices');

  productPage.search(query);
  await until(() => sharedPrices.textContent.includes(price), 'Consented price should appear in guest search');
  assert.equal(sharedPrices.querySelector('h3').textContent, title);
  assert.equal(sharedPrices.querySelector('time').dateTime, '2024-10-27');
  assert.match(sharedPrices.textContent, /Synthetic club.*\$13\.46 per package/);
  assert.doesNotMatch(sharedPrices.textContent, /PRIVATE FIXTURE LABEL/);

  const history = byId('cloud-history');
  await until(() => history.textContent.includes('2024-10-27'), 'Saved receipt should be available in history');
  const card = [...history.children].find(row => row.textContent.includes('2024-10-27'));
  const historyPanel = panelIn(card);
  historyPanel.querySelector('summary').click();
  (await action(historyPanel, 'Withdraw shared prices')).click();
  await action(historyPanel, 'Check eligible prices');

  productPage.search(query);
  await until(() => searchStatus.textContent.includes('No shared receipt prices'), 'Withdrawal should remove the price from guest search');
  assert.equal(sharedPrices.children.length, 0);
  assert.deepEqual((await db.query('select id from receipts where id = $1', [controls.lastSaved])).rows,
    [{ id: controls.lastSaved }]);
});
