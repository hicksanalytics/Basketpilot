const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { setImmediate: settle } = require('node:timers/promises');
const vm = require('node:vm');

const read = file => fs.readFileSync(path.join(__dirname, '../public', file), 'utf8');
const page = read('receipts.html');
const receipt = (item, price) =>
  ['PUBLIX', '11/14/2026', item + ' ' + price, 'SUBTOTAL ' + price, 'TOTAL ' + price].join('\n');

function openReceiptPage() {
  let focused;
  class Element {
    constructor() {
      this.value = '';
      this.children = [];
      this.listeners = new Map();
      const classes = new Set();
      this.classList = {
        add: name => classes.add(name),
        remove: name => classes.delete(name),
        contains: name => classes.has(name)
      };
    }

    addEventListener(event, handler) { this.listeners.set(event, handler); }
    dispatch(event) { this.listeners.get(event)({ target: this }); }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
    removeAttribute(name) { delete this[name]; }
    setAttribute(name, value) { this[name] = value; }
    scrollIntoView() {}
    reportValidity() { return this.value !== ''; }
    focus() { focused = this; }
  }

  const nodes = new Map();
  for (const [, id] of page.matchAll(/id="([^"]+)"/g)) nodes.set(id, new Element());
  const byId = id => nodes.get(id);
  const filesRead = [];
  const engineLoads = [];
  const document = {
    getElementById: byId,
    createElement: () => new Element(),
    querySelectorAll: () => [],
    head: { appendChild(script) { engineLoads.push(script); } }
  };
  const context = vm.createContext({
    document,
    URL: { createObjectURL: file => 'blob:' + file.name, revokeObjectURL() {} }
  });
  context.window = context;
  const engine = {
    async createWorker(language, mode, { logger }) {
      const attempt = { logger, terminated: false };
      return {
        recognize(file) {
          attempt.file = file;
          filesRead.push(attempt);
          return new Promise(resolve => { attempt.finish = text => resolve({ data: { text } }); });
        },
        async terminate() { attempt.terminated = true; }
      };
    }
  };
  for (const [, src, source] of page.matchAll(/<script(?: src="\/([\w-]+\.js)")?>([\s\S]*?)<\/script>/g)) {
    vm.runInContext(src ? read(src) : source, context, { filename: src || 'receipts.html' });
  }
  return {
    byId, engine, filesRead, engineLoads,
    installEngine() { context.Tesseract = engine; },
    get focused() { return focused; },
    get draft() { return context.BasketPilotReceiptBridge.getPayload(); },
    choose(name, picker = 'receipt-file', type = 'image/jpeg') {
      const file = name && { name, type, size: 65536 };
      byId(picker).files = file ? [file] : [];
      byId(picker).dispatch('change');
      return file;
    }
  };
}

test('selecting another photo ignores stale OCR progress and reviews only the latest photo', async () => {
  const app = openReceiptPage();
  app.installEngine();
  app.choose('first.jpg');
  await settle();
  app.choose('second.jpg');
  const latest = app.choose('latest.jpg', 'receipt-camera');
  app.filesRead[0].logger({ status: 'stale progress' });
  assert.match(app.byId('scan-status').textContent, /new photo/);
  app.filesRead[0].finish(receipt('OLD PRODUCT', '1.99'));
  await settle();
  assert.equal(app.filesRead[0].terminated, true);
  assert.equal(app.draft.parsed, null);
  assert.deepEqual(app.filesRead.map(attempt => attempt.file.name), ['first.jpg', 'latest.jpg']);
  app.filesRead[1].finish(receipt('LATEST PRODUCT', '2.99'));
  await settle();
  assert.equal(app.draft.parsed.items[0].description, 'LATEST PRODUCT');
  assert.equal(app.draft.file, latest);
  assert.equal(app.byId('scan').disabled, false);
});

test('a blocked OCR download can be retried and an empty scan offers the direct text fallback', async () => {
  const app = openReceiptPage();
  app.choose('retry.jpg', 'receipt-camera');
  app.engineLoads[0].onerror();
  await settle();
  assert.match(app.byId('scan-status').textContent, /Try again or tap Paste receipt text/);
  app.byId('scan').dispatch('click');
  app.installEngine();
  app.engineLoads[1].onload();
  await settle();
  app.filesRead[0].finish('   ');
  await settle();
  assert.equal(app.draft.parsed, null);
  assert.match(app.byId('scan-status').textContent, /No text found/);
  app.byId('paste-receipt').dispatch('click');
  assert.equal(app.byId('receipt-text-editor').open, true);
  assert.equal(app.focused, app.byId('receipt-text'));
  app.byId('receipt-text').value = receipt('PASTED PRODUCT', '5.99');
  app.byId('parse').dispatch('click');
  assert.equal(app.draft.parsed.items[0].description, 'PASTED PRODUCT');
  assert.equal(app.draft.valid, true);
});

test('pasting while OCR is running preserves the edited review through a late response and canceled picker', async () => {
  const app = openReceiptPage();
  app.installEngine();
  app.choose('photo.jpg');
  await settle();
  app.byId('paste-receipt').dispatch('click');
  app.byId('receipt-text').value = receipt('TYPED PRODUCT', '3.99');
  app.byId('parse').dispatch('click');
  app.filesRead[0].finish(receipt('LATE PRODUCT', '4.99'));
  await settle();
  app.choose(null, 'receipt-camera');
  app.choose('invalid.pdf', 'receipt-file', 'application/pdf');
  assert.equal(app.draft.parsed.items[0].description, 'TYPED PRODUCT');
  assert.equal(app.filesRead[0].terminated, true);
  assert.equal(app.byId('scan').disabled, false);
});

test('switching from the fictional sample to the paste action starts a fresh private draft', () => {
  const app = openReceiptPage();
  app.byId('sample').dispatch('click');
  assert.equal(app.draft.isSample, true);
  app.byId('paste-receipt').dispatch('click');
  assert.equal(app.draft.parsed, null);
  assert.equal(app.byId('receipt-text').value, '');
  app.byId('receipt-text').value = receipt('REAL PRODUCT', '2.49');
  app.byId('parse').dispatch('click');
  assert.equal(app.draft.isSample, false);
  assert.equal(app.draft.valid, true);
});
