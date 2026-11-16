const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createCommunityLookup } = require('../../supabase/drafts/community-product-lookup.mjs');
const { createCommunityPriceHandler, requestCommunityPrices } = require('../../supabase/drafts/community-price-transport.mjs');

const read = file => fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');

async function readCommunityPrices(db, { name, packageGtin }) {
  const { rows } = await db.transaction(async tx => {
    await tx.exec('set local role receipt_community_reader');
    return tx.query('select * from receipt_community.search_package_prices($1,$2)', [name, packageGtin]);
  });
  return rows.map(row => ({ ...row, purchase_date: row.purchase_date.toISOString().slice(0, 10) }));
}

function buildProductPage(t, {
  userId = null, enabled = true, request, fetchPrice, personalReceipts = [],
  pageUrl = 'https://basketpilot.test/products.html', html = read('public/products.html')
}) {
  const dom = new JSDOM(html, {
    url: pageUrl,
    runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const byId = id => window.document.getElementById(id);
  const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: async () => ({ data: personalReceipts }) };
  window.fixture = {
    createClient: () => ({
      auth: { onAuthStateChange: callback => callback('INITIAL_SESSION', userId ? { user: { id: userId } } : null) },
      from: () => chain
    })
  };

  for (const script of window.document.querySelectorAll('script[src]:not([type])')) {
    window.eval(read('public' + script.getAttribute('src')));
  }
  const handleRequest = request && createCommunityPriceHandler(request);
  window.fixture.community = createCommunityLookup(byId('community-results'), {
    request: input => requestCommunityPrices(input, (url, options) => {
      const target = new URL(url, window.location);
      return fetchPrice ? fetchPrice(target, options) : handleRequest(new Request(target, options));
    }),
    normalizeBarcode: window.BasketPilotProductLookup.normalizeBarcode,
    retailerNames: { sams: "Sam's Club", costco: 'Costco' }
  });
  let code = read('public/product-lookup.js').replace(/^import .*;$/m, 'const { createClient } = window.fixture;');
  assert.ok(code.includes('const communityLookup = null;'));
  if (enabled) code = code.replace('const communityLookup = null;', 'const communityLookup = window.fixture.community;');
  window.eval(code);
  return {
    byId,
    search(query) {
      byId('product-query').value = query;
      byId('product-search').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    }
  };
}

module.exports = { buildProductPage, readCommunityPrices };
