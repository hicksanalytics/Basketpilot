const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeBarcode, expandUpce, buildProducts, searchProducts } = require('../public/product-lookup-core.js');

const upc = '036000291452';
const gtin = '00036000291452';
const item = (id, overrides = {}) => ({
  id, receipt_description: 'BEEF FRANKS 24 CT', retailer_item_code: '0000123456',
  quantity: 1, gross_line_total: 9.98, ...overrides
});
const receipt = (retailer, store_id, purchase_date, ...receipt_items) =>
  ({ retailer, store_id, purchase_date, receipt_items });

test('checks UPC/EAN digits, preserves leading zeros and expands scanned UPC-E', () => {
  assert.equal(normalizeBarcode(upc), gtin);
  assert.equal(normalizeBarcode('0036 0002-91452'), gtin);
  assert.equal(normalizeBarcode('96385074'), '00000096385074');
  assert.equal(normalizeBarcode(expandUpce('01234565')), '00012345000065');
  assert.equal(normalizeBarcode('036000291451'), null);
  assert.equal(normalizeBarcode('0000123456'), null);
  assert.equal(normalizeBarcode('00000000000000'), null);
});

test('finds names across retailers without merging different packages or retailer IDs', () => {
  const products = buildProducts([
    receipt('sams', '1000', '2026-11-13', item('1', {
      receipt_description: 'BP BEEF', match_status: 'verified', matched_product_id: '123456',
      matched_title: 'Ball Park Beef Franks, 24 ct'
    })),
    receipt('kroger', '2000', '2026-11-12', item('2', { receipt_description: 'Ball Park Beef Franks, 8 ct' })),
    receipt('publix', '', '2026-11-12', item('3', { receipt_description: 'Beef Franks' }))
  ]);
  assert.equal(searchProducts(products, 'ball park beef frank').length, 2);
  assert.equal(searchProducts(products, 'ball park 24').length, 1);
  assert.equal(searchProducts(products, 'beef franks').length, 3);
  assert.equal(searchProducts(products, upc).length, 0);
});

test('linked packages compare latest per-store prices and flag unallocated coupons', () => {
  const newest = receipt('sams', '1000', '2026-11-13', item('1', { quantity: 2, gross_line_total: 19.98 }));
  newest.receipt_discounts = [{ allocation_status: 'unallocated' }];
  const products = buildProducts([
    newest,
    receipt('sams', '1000', '2026-11-10', item('2', { package_gtin: gtin, gross_line_total: 7.50 })),
    receipt('kroger', '2000', '2026-11-12', item('3', { package_gtin: gtin, gross_line_total: 8.49 })),
    receipt('costco', '3000', '2026-11-12', item('4', { gross_line_total: 6.99 })),
    receipt('sams', '4000', null, item('5', { gross_line_total: 1 })),
    receipt('sams', '5000', '2026-11-14', item('6', { quantity: 0.5, gross_line_total: 4 }))
  ]);
  const [product] = searchProducts(products, upc);
  assert.deepEqual(product.prices.map(price => [price.retailer, price.price, price.discountPending]),
    [['kroger', 8.49, false], ['sams', 9.99, true]]);
  assert.deepEqual(product.links.map(link => link.id), ['3', '2']);
});

test('conflicting barcode links prevent inferred assignment to other lines', () => {
  const products = buildProducts([
    receipt('sams', '1000', '2026-11-13', item('1', { package_gtin: gtin })),
    receipt('sams', '2000', '2026-11-12', item('2', { package_gtin: '00000096385074' })),
    receipt('sams', '3000', '2026-11-11', item('3'))
  ]);
  assert.deepEqual(searchProducts(products, upc)[0].prices.map(price => price.store), ['1000']);
  assert.equal(searchProducts(products, 'beef franks').filter(product => product.candidate).length, 0);
});
