const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create, returnHash } = require('../public/product-search-resume.js');

function tab() {
  const entries = new Map();
  let time = 1_000_000;
  const storage = {
    setItem: (key, value) => entries.set(key, value),
    getItem: key => entries.get(key) ?? null,
    removeItem: key => entries.delete(key)
  };
  return {
    entries,
    page: () => create(() => storage, () => time),
    advance: ms => { time += ms; }
  };
}

test('a submitted search returns only after the signed-in shopper chooses to resume it', () => {
  const guest = tab();
  assert.equal(returnHash, '#resume-search');
  assert.ok(guest.page().remember('   olive oil 2 L  '));
  assert.equal(guest.page().hasPending(), true);
  assert.equal(guest.page().take('shopper-a'), null);
  assert.ok(guest.page().remember('olive oil 2 L'));
  assert.ok(guest.page().prepareReturn('shopper-a'));
  assert.equal(guest.page().take('shopper-a'), 'olive oil 2 L');
  assert.equal(guest.page().take('shopper-a'), null);
  assert.equal(guest.entries.size, 0);
});

test('a handoff cannot follow a different account or be carried into a fresh page session', () => {
  const original = tab();
  assert.ok(original.page().remember('0036 0002-91452'));
  assert.ok(original.page().prepareReturn('shopper-a'));
  assert.equal(original.page().prepareReturn('shopper-b'), false);
  assert.equal(tab().page().take('shopper-a'), null);
  assert.equal(original.page().take('shopper-b'), null);
  assert.equal(original.page().take('shopper-a'), null);
});

test('the exact barcode is restored without altering leading zeros or separators', () => {
  const { page } = tab();
  page().remember('0036 0002-91452');
  page().prepareReturn('shopper-a');
  assert.equal(page().take('shopper-a'), '0036 0002-91452');
});

test('a new search replaces the previous one, and blank, expired, or signed-out searches are discarded', () => {
  const { page, advance, entries } = tab();
  page().remember('olive oil');
  page().remember('milk');
  page().prepareReturn('shopper-a');
  assert.equal(page().take('shopper-a'), 'milk');
  page().remember('olive oil');
  page().remember('  ');
  assert.equal(page().hasPending(), false);
  page().remember('olive oil');
  page().prepareReturn('shopper-a');
  advance(15 * 60 * 1000);
  assert.equal(page().take('shopper-a'), null);
  page().remember('olive oil');
  page().clear();
  assert.equal(entries.size, 0);
});

test('unavailable or malformed session storage falls back to normal navigation', () => {
  const blocked = create(() => { throw new Error('Storage unavailable'); });
  assert.equal(blocked.remember('milk'), false);
  assert.equal(blocked.hasPending(), false);
  assert.equal(blocked.prepareReturn('shopper-a'), false);
  assert.equal(blocked.take('shopper-a'), null);
  const { page, entries } = tab();
  page().remember('milk');
  const [key] = entries.keys();
  entries.set(key, 'not a pending search');
  assert.equal(page().hasPending(), false);
  assert.equal(entries.size, 0);
});
