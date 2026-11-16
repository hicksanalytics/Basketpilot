(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./verified-receipt-catalog.js'));
  if (root) root.BasketPilotProductLookup = factory(root.BasketPilotVerifiedCatalog);
})(typeof window !== 'undefined' ? window : null, function (catalog) {
  'use strict';

  function normalizeBarcode(value) {
    const code = String(value ?? '').trim().replace(/[\s-]/g, '');
    if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length) || !/[1-9]/.test(code)) return null;
    const sum = [...code].reverse().reduce((total, digit, index) => total + Number(digit) * (index % 2 ? 3 : 1), 0);
    return sum % 10 === 0 ? code.padStart(14, '0') : null;
  }

  function expandUpce(value) {
    const code = String(value ?? '');
    if (!/^[01]\d{7}$/.test(code)) return null;
    const [system, a, b, c, d, e, last, check] = code;
    if (last <= '2') return system + a + b + last + '0000' + c + d + e + check;
    if (last === '3') return system + a + b + c + '00000' + d + e + check;
    if (last === '4') return system + a + b + c + d + '00000' + e + check;
    return system + a + b + c + d + e + '0000' + last + check;
  }

  function words(value) {
    return String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '')
      .toLowerCase().match(/[a-z0-9]+/g) ?? [];
  }

  function receiptSku(retailer, item) {
    const code = item.match_status === 'verified' && item.matched_product_id
      ? 'catalog:' + item.matched_product_id
      : item.retailer_item_code && 'printed:' + item.retailer_item_code;
    return retailer && code ? retailer + ':' + code : null;
  }

  function buildProducts(receipts, categoryLabel = () => '') {
    const lines = [];
    const skuBarcodes = new Map();
    for (const receipt of receipts) {
      for (const item of receipt.receipt_items ?? []) {
        const sku = receiptSku(receipt.retailer, item);
        const barcode = normalizeBarcode(item.package_gtin);
        const catalogTitle = catalog?.resolveSavedItem(receipt.retailer, item)?.title;
        const title = catalogTitle || item.receipt_description;
        lines.push({ receipt, item, sku, barcode, title, catalogTitle });
        if (sku && barcode) {
          if (!skuBarcodes.has(sku)) skuBarcodes.set(sku, new Set());
          skuBarcodes.get(sku).add(barcode);
        }
      }
    }

    const products = new Map();
    for (const line of lines) {
      const linked = skuBarcodes.get(line.sku);
      const barcode = line.barcode || (linked?.size === 1 ? linked.values().next().value : null);
      const sku = linked?.size > 1 ? null : line.sku;
      const key = barcode ? 'gtin:' + barcode : sku || 'line:' + line.item.id;
      if (!products.has(key)) products.set(key, { barcode, lines: [] });
      products.get(key).lines.push(line);
    }

    return [...products.values()].map(product => {
      const sorted = product.lines.sort((a, b) => String(b.receipt.purchase_date ?? '').localeCompare(String(a.receipt.purchase_date ?? ''))
        || String(b.receipt.created_at ?? '').localeCompare(String(a.receipt.created_at ?? '')));
      const latest = new Map();
      for (const { receipt, item, title } of sorted) {
        const qty = Number(item.quantity);
        const paid = item.gross_line_total == null ? NaN : Number(item.gross_line_total);
        if (!receipt.purchase_date || !Number.isInteger(qty) || qty < 1 || !Number.isFinite(paid) || paid < 0) continue;
        const location = JSON.stringify([receipt.retailer, receipt.store_id || '']);
        if (!latest.has(location)) {
          latest.set(location, {
            retailer: receipt.retailer, store: receipt.store_id, date: receipt.purchase_date,
            title, price: Math.round(paid * 100 / qty) / 100,
            discountPending: (receipt.receipt_discounts ?? []).some(discount => discount.allocation_status !== 'confirmed')
          });
        }
      }

      const describe = line => ({
        id: line.item.id, title: line.title, retailer: line.receipt.retailer, date: line.receipt.purchase_date,
        sku: line.item.retailer_item_code
      });
      const savedTitle = sorted.find(line => line.item.match_status === 'verified' && line.catalogTitle)?.catalogTitle;
      return {
        barcode: product.barcode,
        title: savedTitle || sorted.find(line => line.catalogTitle)?.catalogTitle || sorted[0].title,
        prices: [...latest.values()].sort((a, b) => a.price - b.price),
        terms: new Set(sorted.flatMap(({ title, item, receipt }) =>
          words([title, item.receipt_description, categoryLabel(item, receipt.retailer)].join(' ')))),
        links: sorted.filter(line => line.barcode).map(describe),
        candidate: product.barcode || skuBarcodes.get(sorted[0].sku)?.size > 1 ? null : describe(sorted[0])
      };
    });
  }

  function searchProducts(products, query) {
    if (/^[\d\s-]+$/.test(query.trim())) {
      const barcode = normalizeBarcode(query);
      return barcode ? products.filter(product => product.barcode === barcode) : [];
    }
    const terms = words(query);
    if (!terms.length) return [];
    return products.filter(product => terms.every(term => product.terms.has(term)
      || (term.length >= 3 && [...product.terms].some(word => word.startsWith(term) ||
        (term.endsWith('s') && word === term.slice(0, -1))))));
  }

  return { normalizeBarcode, expandUpce, buildProducts, searchProducts };
});
