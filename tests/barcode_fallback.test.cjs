const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const lookup = require('../public/product-lookup-core.js');

const page = fs.readFileSync(require.resolve('../public/products.html'), 'utf8');
const productScript = fs.readFileSync(require.resolve('../public/product-lookup.js'), 'utf8');

function openProductPage(mediaDevices) {
  const nodes = new Map();
  let focused;
  const document = {
    getElementById(id) {
      assert.ok(page.includes('id="' + id + '"'), 'Product page is missing ' + id);
      if (nodes.has(id)) return nodes.get(id);
      const listeners = new Map();
      const node = {
        value: '',
        addEventListener(event, callback) { listeners.set(event, callback); },
        dispatch(event) { return listeners.get(event)({ currentTarget: this, preventDefault() {} }); },
        focus() { focused = this; },
        select() { this.selection = this.value; },
        removeAttribute(name) {
          assert.equal(name, 'inputmode');
          delete this.inputMode;
        },
        replaceChildren() {}
      };
      nodes.set(id, node);
      return node;
    },
    addEventListener() {}
  };
  const scanner = {
    BrowserMultiFormatReader: class {
      decodeFromStream() { throw new Error('Unexpected barcode decoding'); }
    }
  };
  vm.runInNewContext(productScript
    .replace(/^import .*;\n/m, '')
    .replace(/await import\('[^']+@zxing\/browser[^']*'\)/, 'scanner'), {
    document,
    navigator: { mediaDevices },
    window: { BasketPilotProductLookup: lookup, addEventListener() {} },
    createClient: () => ({ auth: { onAuthStateChange() {} } }),
    scanner
  });
  return { $: document.getElementById, focused: () => focused };
}

test('denied camera access leaves manual UPC search ready to use', async () => {
  const { $, focused } = openProductPage({
    async getUserMedia() { throw new DOMException('Permission denied', 'NotAllowedError'); }
  });
  const query = $('product-query');
  query.value = 'milk';

  await $('start-camera').dispatch('click');
  assert.match($('scan-status').textContent, /Camera access was blocked.*Type barcode/);
  assert.equal($('start-camera').hidden, false);
  assert.equal($('barcode-camera').hidden, true);
  assert.equal(query.value, 'milk');

  $('type-barcode').dispatch('click');
  assert.equal(focused(), query);
  assert.equal(query.inputMode, 'numeric');
  assert.equal(query.selection, 'milk');
  query.value = '036000291452';
  $('product-search').dispatch('submit');
  assert.equal(query.value, '036000291452');
  assert.equal($('search-status').textContent, 'Sign in to see your receipt matches.');
  assert.equal($('scan-status').textContent, '');
  query.dispatch('blur');
  assert.equal(query.inputMode, undefined);
});

test('a browser without camera access can still open manual entry', async () => {
  const { $, focused } = openProductPage(undefined);
  await $('start-camera').dispatch('click');
  assert.match($('scan-status').textContent, /Camera scanning is unavailable.*Type barcode/);
  $('type-barcode').dispatch('click');
  assert.equal(focused(), $('product-query'));
});

test('typing instead stops a camera stream that arrives after cancellation', async () => {
  const camera = Promise.withResolvers();
  const requested = Promise.withResolvers();
  let stopped = 0;
  const { $ } = openProductPage({
    getUserMedia() {
      requested.resolve();
      return camera.promise;
    }
  });
  const scan = $('start-camera').dispatch('click');
  await requested.promise;
  $('type-barcode').dispatch('click');
  camera.resolve({ getTracks: () => [{ stop() { stopped++; } }] });
  await scan;
  assert.equal(stopped, 1);
  assert.equal($('barcode-camera').hidden, true);
  assert.match($('scan-status').textContent, /Enter the digits/);
});
