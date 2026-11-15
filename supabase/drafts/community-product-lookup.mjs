export function createCommunityLookup(root, { request, normalizeBarcode, retailerNames }) {
  const document = root.ownerDocument;
  const status = root.querySelector('#community-status');
  const results = root.querySelector('#community-prices');
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  let lastRequest = 0;

  function append(parent, tag, text = '', className = '') {
    const node = document.createElement(tag);
    node.textContent = text;
    node.className = className;
    parent.append(node);
    return node;
  }

  function render(rows) {
    const packages = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.retailer, row.receipt_item_code]);
      if (!packages.has(key)) packages.set(key, []);
      packages.get(key).push(row);
    }
    for (const prices of packages.values()) {
      const pkg = prices[0];
      const retailer = retailerNames[pkg.retailer] || pkg.retailer;
      const card = append(results, 'article', '', 'product');
      append(card, 'h3', pkg.package_name);
      append(card, 'p', retailer + ' item #' + pkg.receipt_item_code, 'muted');
      const list = append(card, 'ul', '', 'price-list');
      for (const price of prices) {
        const row = append(list, 'li', '', 'price-row');
        const location = append(row, 'div');
        append(location, 'strong', price.location_name);
        const purchaseDate = date.format(new Date(price.purchase_date + 'T00:00:00Z'));
        const time = append(location, 'time', 'Purchased ' + purchaseDate, 'price-meta');
        time.dateTime = price.purchase_date;
        append(row, 'span', money.format(price.package_price_cents / 100) + ' per package');
      }
    }
  }

  async function search(query) {
    const id = ++lastRequest;
    root.hidden = !query;
    status.textContent = '';
    results.replaceChildren();
    if (!query) return;

    const isBarcode = /^[\d\s-]+$/.test(query);
    const gtin = isBarcode ? normalizeBarcode(query) : null;
    if (isBarcode && !gtin) {
      status.textContent = 'Check the digits under the barcode or try scanning it again.';
      return;
    }
    if (!isBarcode && query.length < 2) {
      status.textContent = 'Enter at least two characters to search.';
      return;
    }
    status.textContent = 'Looking up shared receipt prices…';
    try {
      const rows = await request({ name: isBarcode ? null : query, packageGtin: gtin });
      if (id !== lastRequest) return;
      render(rows);
      status.textContent = rows.length ? '' : 'No shared receipt prices found for this search.';
    } catch {
      if (id !== lastRequest) return;
      results.replaceChildren();
      status.textContent = 'Community receipt prices could not load. Try searching again.';
    }
  }

  return { search };
}
