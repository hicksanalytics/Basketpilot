const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
const page = read('receipts.html');
const receipt = [
  "Sam's Club",
  '11/14/26 11:51 7332 6249 83',
  '0000385385 BALL PARK 9.99 T',
  'COUPON 1.00-',
  'SUBTOTAL 8.99'
].join('\n');

function openReview(text = receipt) {
  class Element {
    constructor() {
      this.value = '';
      this.children = [];
      this.listeners = new Map();
      this.classList = { add() {}, remove() {} };
    }

    addEventListener(type, callback) { this.listeners.set(type, callback); }
    dispatch(type) { this.listeners.get(type)({ target: this }); }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    setAttribute(name, value) { this[name] = String(value); }
    scrollIntoView() {}
    reportValidity() { return Boolean(this.value.trim()); }
  }

  const nodes = new Map(Array.from(page.matchAll(/id="([^"]+)"/g), ([, id]) => [id, new Element()]));
  const node = id => nodes.get(id);
  const context = vm.createContext({
    document: {
      getElementById: node,
      createElement: () => new Element(),
      querySelectorAll: () => []
    }
  });
  context.window = context;
  let saved = 0;
  context.BasketPilotCloud = { saveOrPrompt() { saved++; } };
  for (const [, src, source] of page.matchAll(/<script(?: src="\/([\w-]+\.js)")?>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(src ? read(src) : source, context, { filename: src || 'receipts.html' });
  }

  node('receipt-text').value = text;
  node('parse').dispatch('click');

  function find(parent, label) {
    for (const child of parent.children) {
      if (child['aria-label'] === label) return child;
      const nested = find(child, label);
      if (nested) return nested;
    }
  }

  return {
    node,
    field(id, label) { return find(node(id), label); },
    fill(field, value) {
      field.value = value;
      field.dispatch('input');
    },
    metric(label) {
      return node('summary').children.find(metric => metric.children[0].textContent === label).children[1].textContent;
    },
    get payload() { return context.BasketPilotReceiptBridge.getPayload(); },
    get saved() { return saved; },
    save() { node('quick-save').dispatch('click'); }
  };
}

test('an empty price fails review, while an explicit zero can save', () => {
  const app = openReview();
  const price = app.field('items', 'Paid amount');
  app.fill(price, '');
  assert.equal(price['aria-invalid'], 'true');
  assert.equal(app.metric('Estimated merchandise net'), 'Not found');
  assert.equal(app.payload.valid, false);
  app.node('export-json').dispatch('click');
  assert.match(app.node('finalstatus').textContent, /Enter the paid amount/);
  app.save();
  assert.equal(app.saved, 0);
  assert.match(app.node('finalstatus').textContent, /Enter the paid amount/);

  for (const invalid of ['-0.01', '8.991', '20000.01']) {
    app.fill(price, invalid);
    assert.equal(app.payload.valid, false);
  }

  app.fill(price, '0.00');
  assert.equal(price['aria-invalid'], 'false');
  assert.equal(app.payload.parsed.items[0].lineTotal, 0);
  assert.equal(app.node('finalstatus').textContent, '');
  assert.equal(app.payload.valid, true);
  app.save();
  assert.equal(app.saved, 1);
});

test('an empty discount remains invalid across a retailer change', () => {
  const app = openReview();
  const amount = app.field('discounts', 'Savings amount');
  app.fill(amount, '');
  assert.equal(amount['aria-invalid'], 'true');
  assert.equal(app.metric('Unallocated discounts'), 'Not found');
  app.node('store').value = 'costco';
  app.node('store').dispatch('change');
  assert.equal(app.payload.valid, false);
  app.fill(amount, '1.25');
  assert.equal(app.payload.valid, true);
});

test('malformed retailer item IDs cannot turn into a catalog match', () => {
  const app = openReview();
  const sku = app.field('items', 'Retailer item ID');
  assert.equal(app.metric('Exact SKU matches'), '1 of 1');
  for (const invalid of ['0000385385O', '0000-385385', '000038538500000']) {
    app.fill(sku, invalid);
    assert.equal(sku['aria-invalid'], 'true');
    assert.equal(app.metric('Exact SKU matches'), '0 of 1');
    assert.equal(app.payload.parsed.items[0].sku, invalid);
    app.save();
    assert.equal(app.saved, 0);
    assert.match(app.node('finalstatus').textContent, /4–14 digits/);
  }

  app.fill(sku, '');
  assert.equal(app.payload.valid, true);
  assert.equal(app.metric('Exact SKU matches'), '0 of 1');
  app.fill(sku, '0000385385');
  assert.equal(sku['aria-invalid'], 'false');
  assert.equal(app.metric('Exact SKU matches'), '1 of 1');
  assert.equal(app.payload.parsed.items[0].sku, '0000385385');
  app.save();
  assert.equal(app.saved, 1);
});

test('Costco review verifies the 40-bottle case and distinct egg packs from the printed item number', () => {
  const app = openReview([
    'COSTCO WHOLESALE',
    '11/14/2026',
    'E 782796 WATER 4.25 A',
    'E 1068080 ORG EGGS 9.50',
    '1068083 ORG EGGS 8.00',
    '2075900 WATER PALLET 100.00',
    'SUBTOTAL 121.75'
  ].join('\n'));
  assert.equal(app.metric('Exact SKU matches'), '3 of 4');
  const lines = app.payload.parsed.items;
  assert.deepEqual(Array.from(lines, line => line.sku), ['782796', '1068080', '1068083', '2075900']);
  assert.match(lines[0].catalogMatch.title, /40 × 16\.9 fl oz/);
  assert.match(lines[1].catalogMatch.title, /Pasture-Raised/);
  assert.match(lines[2].catalogMatch.title, /Free-Range/);
  assert.equal(lines[3].catalogMatch, null);
  const itemCode = app.field('items', 'Retailer item ID');
  app.fill(itemCode, '0782796');
  assert.equal(app.metric('Exact SKU matches'), '2 of 4');
  app.fill(itemCode, '782796');
  app.save();
  assert.equal(app.saved, 1);
});
