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

function openReview() {
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

  node('receipt-text').value = receipt;
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
