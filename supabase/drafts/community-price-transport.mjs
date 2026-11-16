const searchPath = '/api/community-prices/search';
const maxBodyBytes = 1024;
const priceFields = [
  'retailer', 'receipt_item_code', 'package_name', 'package_gtin',
  'store_id', 'location_name', 'purchase_date', 'package_price_cents'
];

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

async function readSearchBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode());
      total += value.byteLength;
      if (total > maxBodyBytes) return null;
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateSearch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => key !== 'name' && key !== 'packageGtin')) return null;
  const { name = null, packageGtin = null } = input;
  if (name === null && typeof packageGtin === 'string' && /^[0-9]{14}$/.test(packageGtin)) {
    return { name, packageGtin };
  }
  if (packageGtin === null && typeof name === 'string') {
    const trimmed = name.trim();
    if (trimmed.length >= 2 && trimmed.length <= 120) return { name: trimmed, packageGtin };
  }
  return null;
}

// A future server must supply lookup using the receipt_community_reader role.
export function createCommunityPriceHandler(lookup) {
  return async request => {
    if (new URL(request.url).pathname !== searchPath) return json({ error: 'Not found.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
    const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return json({ error: 'Use JSON.' }, 415);
    const search = validateSearch(await readSearchBody(request));
    if (!search) return json({ error: 'Enter a product name or a package barcode.' }, 400);

    try {
      const prices = await lookup(search);
      return json(prices.map(price => Object.fromEntries(priceFields.map(field => [field, price[field]]))));
    } catch {
      return json({ error: 'Community receipt prices could not load. Try searching again.' }, 503);
    }
  };
}

export async function requestCommunityPrices(input, fetchPrice = globalThis.fetch) {
  const response = await fetchPrice(searchPath, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error('Community receipt prices could not load.');
  return response.json();
}
