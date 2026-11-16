const assert = require('node:assert/strict');
const { randomUUID, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { before, after, test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { PGlite } = require('@electric-sql/pglite');
const { JSDOM } = require('jsdom');
const { createReceiptConsentHandler, requestReceiptConsent } = require('../../supabase/drafts/community-price-transport.mjs');
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
  store_id = store, purchase_date = '2024-10-01', subtotal = 20, created_at = null, receipt_fingerprint = null } = {}) {
  await db.query('insert into receipts (id, owner_id, retailer, store_id, purchase_date, subtotal, created_at, receipt_fingerprint) values ($1,$2,$3,$4,$5,$6,coalesce($7,clock_timestamp()),$8)',
    [id, owner_id, retailer, store_id, purchase_date, subtotal, created_at, receipt_fingerprint]);
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

function build(t, { sharing = true, signedIn = true, fixtureOwner = owner } = {}) {
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

  const fixtureUser = { id: fixtureOwner, email: 'fixture@example.test' };
  let user = signedIn ? fixtureUser : null;
  const accessToken = 'fixture-token-' + fixtureOwner;
  const controls = { operations: [], sessionExpired: false, lastSaved: null, loseShareResponse: false, beforeLines: null, beforeHistory: null, beforeDuplicate: null };
  const client = {
    auth: {
      async getUser() { return { data: { user } }; },
      async signOut() { user = null; return {}; },
      async signInWithPassword() { user = fixtureUser; return {}; },
      onAuthStateChange() {}
    },
    from(table) {
      return {
        insert(payload) {
          if (table === 'receipts') {
            assert.equal(payload.owner_id, user?.id);
            assert.equal(payload.contribution_opt_in, false);
            return { select: () => ({ single: async () => {
              try {
                const id = await writeReceipt(payload);
                controls.lastSaved = id;
                return { data: { id } };
              } catch (error) {
                if (error.code !== '23505') throw error;
                return { error };
              }
            } }) };
          }
          assert.equal(table, 'receipt_items');
          return (async () => {
            await controls.beforeLines?.();
            for (const line of payload) await writeLine(line);
            return {};
          })();
        },
        select(columns) {
          assert.equal(table, 'receipts');
          const userId = user?.id;
          const order = [];
          let filterOwner, fingerprint, cursorTime, cursorId;
          const query = {
            eq(column, value) {
              if (column === 'owner_id') filterOwner = value;
              else {
                assert.equal(column, 'receipt_fingerprint');
                assert.match(value, /^[a-f0-9]{64}$/);
                fingerprint = value;
              }
              return query;
            },
            order(column, options) {
              assert.equal(options.ascending, false);
              order.push(column);
              return query;
            },
            or(filter) {
              const match = /^created_at\.lt\.(.+),and\(created_at\.eq\.\1,id\.lt\.([a-f0-9-]+)\)$/.exec(filter);
              assert.ok(match, filter);
              [, cursorTime, cursorId] = match;
              return query;
            },
            async maybeSingle() {
              assert.equal(columns, 'id,receipt_items(id),receipt_discounts(id)');
              assert.equal(filterOwner, userId);
              assert.ok(fingerprint);
              const { rows } = await asUser(userId, tx => tx.query(
                `select r.id,
                   coalesce((select json_agg(json_build_object('id', i.id)) from receipt_items i where i.receipt_id = r.id), '[]') as receipt_items,
                   coalesce((select json_agg(json_build_object('id', d.id)) from receipt_discounts d where d.receipt_id = r.id), '[]') as receipt_discounts
                 from receipts r where r.owner_id = $1 and r.receipt_fingerprint = $2`,
                [filterOwner, fingerprint]
              ));
              await controls.beforeDuplicate?.();
              return { data: rows[0] ?? null };
            },
            async limit(limit) {
              assert.deepEqual(order, ['created_at', 'id']);
              assert.equal(limit, 26);
              const { rows } = await asUser(userId, tx => tx.query(
                `select id, retailer, store_id, purchase_date::text, subtotal as total, created_at::text
                 from receipts
                 where owner_id = $1 and ($2::timestamptz is null or (created_at, id) < ($2, $3))
                 order by created_at desc, id desc limit $4`,
                [filterOwner, cursorTime ?? null, cursorId ?? null, limit]
              ));
              const error = await controls.beforeHistory?.(cursorTime);
              return error ? { error } : { data: rows };
            }
          };
          return query;
        }
      };
    }
  };

  const handleConsent = createReceiptConsentHandler({
    authenticate: async token => token === accessToken && !controls.sessionExpired ? user : null,
    async setConsent({ receiptId: id, action, revision, previewToken }, { ownerId }) {
      controls.operations.push({ id, action, revision });
      const { rows } = await asUser(ownerId, tx => tx.query(
        'select * from receipt_community.set_consent($1,$2,$3,$4)', [id, action, revision, previewToken]
      ));
      if (action === 'share' && controls.loseShareResponse) throw new Error('Synthetic lost response');
      return rows[0];
    }
  });
  const requestConsent = (receiptId, action, revision = null, previewToken = null) => requestReceiptConsent(
    { receiptId, action, revision, previewToken },
    {
      getAccessToken: async () => user ? accessToken : null,
      fetchConsent: (url, options) => handleConsent(new Request(new URL(url, window.location), options))
    }
  );
  window.fixture = {
    createClient: () => client,
    community: createReceiptCommunity(requestConsent)
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

  return { window, byId, controls, review, requestConsent };
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

test('an expired history session cannot share and requires a fresh preview after session renewal', async t => {
  const id = await writeReceipt({ purchase_date: '2024-11-02' });
  await writeLine({ receipt_id: id });
  const { byId, controls } = build(t);
  const history = byId('cloud-history');
  const getCard = () => [...history.children].find(card => card.textContent.includes('2024-11-02'));
  await until(getCard, 'Previously saved receipt should load');
  const panel = panelIn(getCard());
  panel.querySelector('summary').click();
  const share = await action(panel, 'Share 1 item price');

  controls.sessionExpired = true;
  share.click();
  const check = await action(panel, 'Check sharing status');
  assert.match(panel.querySelector('[role=status]').textContent, /Could not confirm sharing status/);
  assert.equal(panel.querySelectorAll('li').length, 0);
  assert.equal(await countObservations(id), 0);
  assert.deepEqual(controls.operations.map(op => op.action), ['status']);

  controls.sessionExpired = false;
  check.click();
  const freshShare = await action(panel, 'Share 1 item price');
  assert.equal(await countObservations(id), 0);
  freshShare.click();
  await action(panel, 'Withdraw shared prices');
  assert.equal(await countObservations(id), 1);
  assert.deepEqual(controls.operations.map(op => op.action), ['status', 'status', 'share']);
});

test('a different signed-in owner cannot inspect or change sharing through the receipt endpoint', async t => {
  const id = await writeReceipt();
  await writeLine({ receipt_id: id });
  const { requestConsent: requestAsOwner } = build(t);
  const { requestConsent: requestAsOther } = build(t, { fixtureOwner: randomUUID() });
  const preview = await requestAsOwner(id, 'status');
  const shared = await requestAsOwner(id, 'share', preview.revision, preview.preview_token);
  assert.equal(shared.observation_count, 1);

  await assert.rejects(requestAsOther(id, 'status'), /sharing status could not be confirmed/);
  await assert.rejects(requestAsOther(id, 'withdraw', shared.revision), /sharing status could not be confirmed/);
  assert.equal(await countObservations(id), 1);
  assert.equal((await requestAsOwner(id, 'status')).revision, shared.revision);
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
  assert.match(ineligible.textContent, /has not verified this store or club number/);
  assert.doesNotMatch(ineligible.textContent, /needs an exact package match/);
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

test('history explains a missing store, discounts and skipped lines without exposing private line text', async t => {
  const fixtureOwner = randomUUID();
  const missingStore = await writeReceipt({ owner_id: fixtureOwner, purchase_date: '2024-08-01', store_id: null });
  await writeLine({ receipt_id: missingStore });
  const discounted = await writeReceipt({ owner_id: fixtureOwner, purchase_date: '2024-08-02' });
  await writeLine({ receipt_id: discounted });
  await db.query('insert into receipt_discounts values ($1, $2)', [randomUUID(), discounted]);
  const partial = await writeReceipt({ owner_id: fixtureOwner, purchase_date: '2024-08-03', subtotal: 25 });
  await writeLine({ receipt_id: partial });
  await writeLine({ receipt_id: partial, retailer_item_code: null, quantity: 1, gross_line_total: 5,
    receipt_description: 'PRIVATE UNMATCHED LABEL' });
  const { byId } = build(t, { fixtureOwner });
  const history = byId('cloud-history');
  await until(() => history.children.length === 3, 'Fixture history should load');
  const openOn = date => {
    const card = [...history.children].find(child => child.textContent.includes(date));
    const panel = panelIn(card);
    panel.querySelector('summary').click();
    return panel;
  };
  for (const [day, text] of [['01', 'needs a store or club number'], ['02', 'Prices on discounted receipts are currently skipped']]) {
    const panel = openOn('2024-08-' + day);
    await until(() => panel.textContent.includes(text), 'Receipt should show its blocking check');
    assert.ok(panel.querySelector('button').classList.contains('hidden'));
  }
  const panel = openOn('2024-08-03');
  const share = await action(panel, 'Share 1 item price');
  assert.match(panel.textContent, /1 item price needs an exact package match/);
  assert.doesNotMatch(panel.textContent, /PRIVATE UNMATCHED LABEL/);
  assert.equal(await countObservations(partial), 0);
  share.click();
  await action(panel, 'Withdraw shared prices');
  assert.equal(await countObservations(partial), 1);
  assert.ok(panel.querySelector('[aria-label="Why prices were skipped"]').hidden);
  assert.equal(await countObservations(missingStore), 0);
  assert.equal(await countObservations(discounted), 0);
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

test('an opted-in Quaker 52-packet receipt appears by exact UPC until the owner withdraws it', async t => {
  const receiptCode = '0000866624';
  const title = 'Quaker Instant Oatmeal Variety Pack, 52 packets';
  const upc = '030000561959';
  const price = '13.46';
  // Real package identity with a synthetic receipt, store label, and price.
  await db.query('insert into receipt_community.verified_packages values ($1,$2,$3,$4,$5,$6)',
    ['sams', receiptCode, title, 'https://www.samsclub.com/ip/quaker-instant-oatmeal-52-ct-variety-pack/3000056195',
      '00030000561959', 'https://smartlabel.pepsico.info/030000561959-0003-en-US/index.html']);
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
  productPage.search(upc);
  await until(() => searchStatus.textContent.includes('No shared receipt prices'), 'Private save should not appear in guest search');
  assert.equal(sharedPrices.children.length, 0);
  share.click();
  await action(reviewPanel, 'Withdraw shared prices');

  productPage.search(upc);
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

  productPage.search(upc);
  await until(() => searchStatus.textContent.includes('No shared receipt prices'), 'Withdrawal should remove the price from guest search');
  assert.equal(sharedPrices.children.length, 0);
  assert.deepEqual((await db.query('select id from receipts where id = $1', [controls.lastSaved])).rows,
    [{ id: controls.lastSaved }]);
});

async function seedOlderHistory(fixtureOwner) {
  const timestamp = '2024-12-01T12:00:00.123456+00:00';
  const newest = await writeReceipt({ owner_id: fixtureOwner,
    purchase_date: '2024-11-30', created_at: '2024-12-01T12:00:00.123457+00:00' });
  for (let day = 1; day <= 25; day++) {
    await writeReceipt({ owner_id: fixtureOwner, created_at: timestamp,
      purchase_date: '2024-11-' + String(day).padStart(2, '0') });
  }
  const oldest = await writeReceipt({ owner_id: fixtureOwner, purchase_date: '2024-01-01',
    created_at: '2024-02-01T12:00:00+00:00' });
  await writeLine({ receipt_id: oldest });
  return { newest, oldest };
}

test('an older shared receipt can be reached and withdrawn after a failed page request', async t => {
  const fixtureOwner = randomUUID();
  const { newest, oldest } = await seedOlderHistory(fixtureOwner);
  await asUser(fixtureOwner, async tx => {
    const { rows: [preview] } = await tx.query("select preview_token from receipt_community.set_consent($1,'status')", [oldest]);
    await tx.query("select * from receipt_community.set_consent($1,'share',0,$2)", [oldest, preview.preview_token]);
  });
  await writeReceipt({ owner_id: randomUUID(), purchase_date: '2024-02-03' });

  const { byId, controls, window } = build(t, { fixtureOwner });
  const history = byId('cloud-history');
  const more = byId('cloud-history-more');
  await until(() => !more.hidden && !more.disabled, 'First page should offer older receipts');
  assert.equal(history.children.length, 25);
  assert.doesNotMatch(history.textContent, /2024-01-01|2024-02-03/);

  controls.beforeHistory = cursor => cursor && new Error('Synthetic request failure');
  more.click();
  await until(() => !more.disabled, 'Failed load should be retryable');
  assert.match(byId('cloud-history-status').textContent, /Could not load older receipts/);
  assert.equal(history.children.length, 25);

  // Changes to a newer page must not shift the older-page boundary.
  await db.query('delete from receipts where id = $1', [newest]);
  await writeReceipt({ owner_id: fixtureOwner, purchase_date: '2024-12-02' });
  controls.beforeHistory = null;
  more.click();
  await until(() => more.hidden && !more.disabled, 'Last page should finish loading');
  const titles = Array.from(history.children, row => row.querySelector('strong').textContent);
  assert.equal(titles.length, 27);
  assert.equal(new Set(titles).size, 27);
  assert.doesNotMatch(history.textContent, /2024-02-03|2024-12-02/);
  assert.equal(window.document.activeElement.textContent, titles[25]);

  const panel = panelIn(history.lastElementChild);
  assert.match(history.lastElementChild.textContent, /2024-01-01/);
  panel.querySelector('summary').click();
  (await action(panel, 'Withdraw shared prices')).click();
  await action(panel, 'Check eligible prices');
  assert.equal(await countObservations(oldest), 0);
  assert.equal((await db.query('select id from receipts where id = $1', [oldest])).rows.length, 1);
});

test('signing out discards a pending older page and clears the history controls', async t => {
  const fixtureOwner = randomUUID();
  await seedOlderHistory(fixtureOwner);
  const { byId, controls } = build(t, { fixtureOwner });
  const more = byId('cloud-history-more');
  await until(() => !more.hidden && !more.disabled, 'First page should offer older receipts');
  const pending = Promise.withResolvers();
  let fetchingOlder = false;
  controls.beforeHistory = cursor => {
    if (!cursor) return null;
    fetchingOlder = true;
    return pending.promise;
  };
  more.click();
  await until(() => fetchingOlder, 'Older page should be in flight');
  byId('auth-logout').click();
  await until(() => !byId('cloud-auth').classList.contains('hidden'), 'Sign-out should complete');
  pending.resolve();
  await sleep(20);
  assert.equal(byId('cloud-history').children.length, 0);
  assert.equal(byId('cloud-history-status').textContent, '');
  assert.equal(more.hidden, true);
  assert.equal(more.ownerDocument.defaultView.getComputedStyle(more).display, 'none');
});

test('history shows a held price privately and keeps withdrawal available', async t => {
  const fixtureOwner = randomUUID();
  const code = '0000000941';
  const id = await writeReceipt({ owner_id: fixtureOwner });
  await db.query('insert into receipt_community.verified_packages values ($1,$2,$3,$4)',
    ['sams', code, 'Fixture coffee, 36 ct', 'https://example.com/coffee']);
  await writeLine({ receipt_id: id, retailer_item_code: code });
  await asUser(fixtureOwner, async tx => {
    const { rows: [preview] } = await tx.query("select preview_token from receipt_community.set_consent($1,'status')", [id]);
    await tx.query("select * from receipt_community.set_consent($1,'share',0,$2)", [id, preview.preview_token]);
  });
  assert.equal((await readCommunityPrices(db, { name: 'Fixture coffee', packageGtin: null })).length, 1);
  await db.query(`insert into receipt_community.observation_holds (receipt_item_id, reason)
    select id, 'package_mismatch' from receipt_items where receipt_id = $1`, [id]);

  const { byId } = build(t, { fixtureOwner });
  const history = byId('cloud-history');
  await until(() => history.querySelector('.cloud-history-card'), 'History should load the held receipt');
  const panel = panelIn(history.firstElementChild);
  panel.querySelector('summary').click();
  const withdraw = await action(panel, 'Withdraw shared prices');
  assert.match(panel.textContent, /Under review and hidden from community lookup/);
  assert.doesNotMatch(panel.textContent, /package_mismatch/);
  assert.deepEqual(await readCommunityPrices(db, { name: 'Fixture coffee', packageGtin: null }), []);
  withdraw.click();
  (await action(panel, 'Check eligible prices')).click();
  await until(() => panel.textContent.includes('1 item price is under review'), 'Held item should remain excluded');
  assert.ok(panel.querySelector('button').classList.contains('hidden'));
  assert.equal(await countObservations(id), 0);
  assert.deepEqual((await db.query('select id from receipts where id = $1', [id])).rows, [{ id }]);
});

test('retrying a saved receipt reopens its consent state without creating or sharing another receipt', async t => {
  const fixtureOwner = randomUUID();
  const original = build(t, { fixtureOwner });
  await until(() => !original.byId('cloud-save').disabled, 'Original page should be signed in');
  original.review('10/30/2024');
  original.byId('quick-save').click();
  await until(() => !original.byId('review-community').hidden, 'Original review should save');
  const id = original.controls.lastSaved;
  assert.equal(await countObservations(id), 0);

  const retry = build(t, { fixtureOwner });
  await until(() => !retry.byId('cloud-save').disabled, 'Retry page should be signed in');
  retry.review('10/30/2024');
  retry.byId('quick-save').click();
  await until(() => !retry.byId('review-community').hidden, 'Retry should reopen the original review');
  assert.match(retry.byId('cloud-status').textContent, /already in your private history/);
  const panel = panelIn(retry.byId('review-community'));
  const share = await action(panel, 'Share 1 item price');
  assert.deepEqual(retry.controls.operations, [{ id, action: 'status', revision: null }]);
  assert.equal(retry.controls.lastSaved, null);
  assert.equal(await countObservations(id), 0);
  share.click();
  await action(panel, 'Withdraw shared prices');
  assert.equal(await countObservations(id), 1);

  // A subsequent retry should reopen the same consent and offer withdrawal.
  await until(() => !retry.byId('cloud-save').disabled, 'The previous retry should finish');
  retry.byId('quick-save').click();
  await until(() => panelIn(retry.byId('review-community')) !== panel && !retry.byId('review-community').hidden,
    'Second retry should open a new panel for the original receipt');
  (await action(panelIn(retry.byId('review-community')), 'Withdraw shared prices')).click();
  await action(panelIn(retry.byId('review-community')), 'Check eligible prices');
  assert.equal(await countObservations(id), 0);
  assert.deepEqual((await db.query('select id from receipts where owner_id = $1', [fixtureOwner])).rows, [{ id }]);
  assert.equal((await db.query('select id from receipt_items where receipt_id = $1', [id])).rows.length, 1);
});

test('an incomplete earlier save or a changed review cannot open consent on retry', async t => {
  const fixtureOwner = randomUUID();
  const original = build(t, { fixtureOwner });
  const linesPending = Promise.withResolvers();
  let writingLines = false;
  original.controls.beforeLines = () => {
    writingLines = true;
    return linesPending.promise;
  };
  await until(() => !original.byId('cloud-save').disabled, 'Original page should be signed in');
  original.review('10/31/2024');
  original.byId('quick-save').click();
  await until(() => writingLines, 'Original save should have reached its line write');

  const retry = build(t, { fixtureOwner });
  await until(() => !retry.byId('cloud-save').disabled, 'Retry page should be signed in');
  retry.review('10/31/2024');
  retry.byId('quick-save').click();
  await until(() => retry.byId('cloud-status').textContent.includes('saved line count differs'),
    'A partial receipt should be explained');
  assert.equal(retry.byId('review-community').hidden, true);
  assert.deepEqual(retry.controls.operations, []);

  linesPending.resolve();
  await until(() => !original.byId('review-community').hidden, 'Original save should finish');
  await until(() => !retry.byId('cloud-save').disabled, 'The partial retry should finish');
  const readPending = Promise.withResolvers();
  let reading = false;
  retry.controls.beforeDuplicate = () => {
    reading = true;
    return readPending.promise;
  };
  retry.byId('quick-save').click();
  await until(() => reading, 'Retry should reach the lookup');
  const amount = retry.byId('items').querySelector('[aria-label="Paid amount"]');
  amount.value = '32.00';
  amount.dispatchEvent(new retry.window.Event('input', { bubbles: true }));
  readPending.resolve();
  await until(() => !retry.byId('cloud-save').disabled, 'Retry should finish');
  assert.equal(retry.byId('review-community').hidden, true);
  assert.deepEqual(retry.controls.operations, []);
  assert.equal(await countObservations(original.controls.lastSaved), 0);
});
