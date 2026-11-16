const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { AuthClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const { buildProductPage } = require('./product-page-fixture.cjs');
const { createSupabaseReceiptConsentHandler } = require('../../supabase/drafts/supabase-receipt-consent.mjs');

const read = file => readFileSync(path.join(__dirname, '../..', file), 'utf8');
const secret = () => randomBytes(24).toString('hex');
const loopback = '127.0.0.1';
const programs = [];
const pools = [];
let scratch, admin, consentPool, guestPool, authUrl, handle, transactionCount = 0;

async function freePort() {
  const server = createServer();
  server.listen(0, loopback);
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function start(executable, args, options) {
  const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
  programs.unshift(child);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', chunk => { output = (output + chunk).slice(-4000); });
  }
  child.once('error', error => { output = error.message; });
  return () => output;
}

async function ready(check, description, output) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check().catch(() => false)) return;
    await wait(100);
  }
  assert.fail(description + ' did not start.\n' + output());
}

function addPool(port, user, password) {
  const pool = new Pool({
    host: loopback, port, database: 'postgres', user, password, max: user === 'postgres' ? 1 : 2,
    connectionTimeoutMillis: 1000
  });
  pools.push(pool);
  return pool;
}

function authClient() {
  return new AuthClient({
    url: authUrl, autoRefreshToken: false, detectSessionInUrl: false, persistSession: false
  });
}

before(async () => {
  const pgBin = process.env.BASKETPILOT_TEST_PG_BIN;
  const authBin = process.env.BASKETPILOT_TEST_AUTH_BIN;
  assert.ok(pgBin && authBin, 'Set BASKETPILOT_TEST_PG_BIN and BASKETPILOT_TEST_AUTH_BIN to local binaries.');
  const authPath = path.resolve(authBin);
  const authDir = path.dirname(authPath);
  scratch = mkdtempSync(path.join(tmpdir(), 'basketpilot-consent-'));
  const data = path.join(scratch, 'pg');
  const passwordFile = path.join(scratch, 'password');
  const adminPassword = secret();
  const authPassword = secret();
  const consentPassword = secret();
  const guestPassword = secret();
  const pgPort = await freePort();
  const env = { PATH: process.env.PATH, LANG: 'C', LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH ?? '' };
  writeFileSync(passwordFile, adminPassword + '\n', { mode: 0o600 });
  execFileSync(path.resolve(pgBin, 'initdb'), [
    '-D', data, '-U', 'postgres', '--pwfile=' + passwordFile, '--auth=scram-sha-256', '--no-sync', '--encoding=UTF8'
  ], { env });
  rmSync(passwordFile);
  const pgOutput = start(path.resolve(pgBin, 'postgres'), [
    '-D', data, '-h', loopback, '-p', String(pgPort), '-c', 'unix_socket_directories='
  ], { env });
  admin = addPool(pgPort, 'postgres', adminPassword);
  await ready(() => admin.query('select 1'), 'Fixture PostgreSQL', pgOutput);

  await admin.query(`
    create role auth_fixture login password '${authPassword}';
    create schema auth authorization auth_fixture;
    alter role auth_fixture set search_path = auth, public;
    create role consent_fixture login noinherit password '${consentPassword}';
    create role guest_fixture login password '${guestPassword}';
  `);
  const authPort = await freePort();
  authUrl = 'http://' + loopback + ':' + authPort;
  const authEnv = {
    ...env,
    GOTRUE_DB_DRIVER: 'postgres',
    DB_NAMESPACE: 'auth',
    DATABASE_URL: 'postgresql://auth_fixture:' + authPassword + '@' + loopback + ':' + pgPort + '/postgres?sslmode=disable',
    API_EXTERNAL_URL: authUrl,
    GOTRUE_API_HOST: loopback,
    PORT: String(authPort),
    GOTRUE_SITE_URL: authUrl,
    GOTRUE_JWT_SECRET: secret(),
    GOTRUE_JWT_EXP: '300',
    GOTRUE_JWT_AUD: 'authenticated',
    GOTRUE_JWT_DEFAULT_GROUP_NAME: 'authenticated',
    GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true',
    GOTRUE_MAILER_AUTOCONFIRM: 'true'
  };
  execFileSync(authPath, ['migrate'], { cwd: authDir, env: authEnv, stdio: 'pipe' });
  const authOutput = start(authPath, ['serve'], { cwd: authDir, env: authEnv });
  await ready(async () => (await fetch(authUrl + '/health', { signal: AbortSignal.timeout(1000) })).ok,
    'Fixture Supabase Auth', authOutput);
  const { rows: [authFunction] } = await admin.query("select to_regprocedure('auth.uid()') is not null as installed");
  assert.equal(authFunction.installed, true, 'Use the function installed by Auth migrations');

  await admin.query('create role anon; create role authenticated');
  const receiptSchema = read('tests/community/receipt-schema.sql');
  const tableStart = receiptSchema.indexOf('create table public.receipts');
  assert.ok(tableStart > 0, 'Receipt fixtures should follow the simulated Auth setup');
  await admin.query(receiptSchema.slice(tableStart));
  await admin.query(read('supabase/drafts/receipt_community.sql'));
  await admin.query(`
    grant receipt_community_consent to consent_fixture;
    grant receipt_community_reader to guest_fixture;
    insert into receipt_community.verified_stores values
      ('sams', '0101', 'Synthetic club', 'https://example.test/store');
    insert into receipt_community.verified_packages values
      ('sams', '000111', 'Fixture Oats, 24 ct', 'https://example.test/items');
  `);

  consentPool = addPool(pgPort, 'consent_fixture', consentPassword);
  guestPool = addPool(pgPort, 'guest_fixture', guestPassword);
  handle = createSupabaseReceiptConsentHandler({
    auth: authClient(),
    database: {
      async transaction(run) {
        transactionCount++;
        const client = await consentPool.connect();
        try {
          await client.query('begin');
          const result = await run(client);
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback');
          throw error;
        } finally {
          client.release();
        }
      }
    }
  });
});

after(async () => {
  await Promise.all(pools.map(pool => pool.end()));
  for (const child of programs) {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      const exited = once(child, 'exit');
      child.kill('SIGINT');
      await exited;
    }
  }
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function createShopper(label) {
  const client = authClient();
  const credentials = { email: label + '@example.test', password: secret() };
  const { error: signupError } = await client.signUp(credentials);
  assert.ifError(signupError);
  const { data, error } = await client.signInWithPassword(credentials);
  assert.ifError(error);
  return { client, id: data.user.id, token: data.session.access_token };
}

function send(token, receiptId, action, fields = {}) {
  return handle(new Request('http://basketpilot.test/api/receipt-community/consent', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ receiptId, action, ...fields })
  }));
}

async function assertPoolReset() {
  const clients = await Promise.all([consentPool.connect(), consentPool.connect()]);
  try {
    for (const client of clients) {
      const { rows } = await client.query(`
        select current_user as actor,
          nullif(current_setting('request.jwt.claim.sub', true), '') as sub,
          nullif(current_setting('request.jwt.claims', true), '') as claims
      `);
      assert.deepEqual(rows, [{ actor: 'consent_fixture', sub: null, claims: null }]);
      await assert.rejects(client.query('select id from receipts'), { code: '42501' });
    }
  } finally {
    for (const client of clients) client.release();
  }
}

test('native Auth and pooled PostgreSQL preserve owner-only consent through concurrent retries and revocation', async t => {
  const owner = await createShopper('owner');
  const other = await createShopper('other');
  const receiptId = randomUUID();
  await admin.query(
    "insert into receipts (id, owner_id, retailer, store_id, purchase_date, subtotal) values ($1, $2, 'sams', '0101', '2024-11-10', 20)",
    [receiptId, owner.id]
  );
  await admin.query(
    "insert into receipt_items (id, receipt_id, retailer_item_code, quantity, gross_line_total) values ($1, $2, '000111', 2, 20)",
    [randomUUID(), receiptId]
  );

  const guest = buildProductPage(t, {
    async request({ name, packageGtin }) {
      const { rows } = await guestPool.query(
        `select retailer, receipt_item_code, package_name, package_gtin, store_id, location_name,
          purchase_date::text, package_price_cents
         from receipt_community.search_package_prices($1, $2)`,
        [name, packageGtin]
      );
      return rows;
    }
  });
  const guestStatus = guest.byId('community-status');
  const guestPrices = guest.byId('community-prices');
  const lookup = () => guest.search('Fixture Oats 24 ct');
  const awaitPricesAbsent = () => ready(
    async () => guestStatus.textContent.includes('No shared receipt prices'),
    'Guest lookup with no prices', () => guestStatus.textContent
  );
  lookup();
  await awaitPricesAbsent();

  const status = await send(owner.token, receiptId, 'status');
  assert.equal(status.status, 200);
  const preview = await status.json();
  assert.equal(preview.observation_count, 0);
  assert.equal(preview.price_rows[0].package_price_cents, 1000);
  const share = { revision: preview.revision, previewToken: preview.preview_token };
  const replies = await Promise.all([
    send(owner.token, receiptId, 'share', share),
    send(owner.token, receiptId, 'share', share)
  ]);
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  const results = await Promise.all(replies.map(reply => reply.json()));
  assert.deepEqual(results.map(result => result.outcome).sort(), ['shared', 'stale']);
  assert.deepEqual(results.map(result => result.observation_count), [1, 1]);
  const revision = results[0].revision;

  lookup();
  await ready(async () => guestPrices.querySelector('h3')?.textContent === 'Fixture Oats, 24 ct',
    'Guest lookup with shared price', () => guestStatus.textContent);
  assert.equal(guestPrices.querySelectorAll('li').length, 1);
  assert.match(guestPrices.textContent, /Synthetic club.*Purchased Nov 10, 2024.*[$]10[.]00 per package/);


  const denied = await send(other.token, receiptId, 'withdraw', { revision });
  assert.equal(denied.status, 403);
  await assertPoolReset();

  const withdrawn = await send(owner.token, receiptId, 'withdraw', { revision });
  assert.equal(withdrawn.status, 200);
  assert.equal((await withdrawn.json()).observation_count, 0);
  lookup();
  await awaitPricesAbsent();
  assert.equal(guestPrices.children.length, 0);
  const { rows } = await admin.query('select id from receipts where id = $1', [receiptId]);
  assert.deepEqual(rows, [{ id: receiptId }]);

  const { error } = await owner.client.signOut();
  assert.ifError(error);
  const beforeAuthRejects = transactionCount;
  for (const token of ['invalid-token', owner.token]) {
    const response = await send(token, receiptId, 'status');
    assert.equal(response.status, 401, JSON.stringify(await response.json()));
  }
  assert.equal(transactionCount, beforeAuthRejects);
  await assertPoolReset();
});
