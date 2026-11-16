const searchPath = '/api/community-prices/search';
const consentPath = '/api/receipt-community/consent';
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const consentFields = ['outcome', 'revision', 'observation_count', 'eligible_count', 'preview_token'];
const exclusionReasons = [
  'store_missing', 'store_unverified', 'date_invalid', 'discounts', 'no_items',
  'subtotal', 'review', 'package_unverified', 'package_price', 'on_hold'
];
const maxBodyBytes = 1024;
const priceFields = [
  'retailer', 'receipt_item_code', 'package_name', 'package_gtin',
  'store_id', 'location_name', 'purchase_date', 'package_price_cents'
];

const ownerPriceFields = [...priceFields, 'on_hold'];

function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers }
  });
}

async function readJsonBody(request) {
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
    const search = validateSearch(await readJsonBody(request));
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

function validateConsent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['receiptId', 'action', 'revision', 'previewToken'].includes(key))) {
    return null;
  }
  const { receiptId, action, revision = null, previewToken = null } = input;
  if (typeof receiptId !== 'string' || !uuidPattern.test(receiptId)) return null;
  const validRevision = Number.isInteger(revision) && revision >= 0 && revision <= 2147483647;
  const validPreview = typeof previewToken === 'string' && /^[a-f0-9]{32}$/.test(previewToken);
  const request = { receiptId, action, revision, previewToken };
  if (action === 'status' && revision === null && previewToken === null) return request;
  if (action === 'withdraw' && validRevision && previewToken === null) return request;
  if (action === 'share' && validRevision && validPreview) return request;
  return null;
}

// authenticate verifies the access token with the identity provider and returns its user.
// setConsent runs the RPC under that user's authenticated database context.
export function createReceiptConsentHandler({ authenticate, setConsent }) {
  return async request => {
    if (new URL(request.url).pathname !== consentPath) return json({ error: 'Not found.' }, 404);
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405, { Allow: 'POST' });
    const contentType = request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase();
    if (contentType !== 'application/json') return json({ error: 'Use JSON.' }, 415);
    const token = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
    const signIn = () => json({ error: 'Sign in to check receipt sharing.' }, 401, { 'WWW-Authenticate': 'Bearer' });
    if (!token) return signIn();
    const input = validateConsent(await readJsonBody(request));
    if (!input) return json({ error: 'Invalid receipt sharing request.' }, 400);

    const unavailable = () => json({ error: 'Receipt sharing status could not be confirmed. Try again.' }, 503);
    let user;
    try {
      user = await authenticate(token);
    } catch {
      return unavailable();
    }
    if (typeof user?.id !== 'string' || !uuidPattern.test(user.id)) return signIn();

    try {
      const consent = await setConsent(input, { ownerId: user.id, accessToken: token });
      const exclusions = consent.exclusion_counts ?? {};
      return json({
        ...Object.fromEntries(consentFields.map(field => [field, consent[field]])),
        price_rows: consent.price_rows.map(price => Object.fromEntries(ownerPriceFields.map(field => [field, price[field]]))),
        exclusion_counts: Object.fromEntries(exclusionReasons
          .filter(reason => Object.hasOwn(exclusions, reason))
          .map(reason => [reason, exclusions[reason]]))
      });
    } catch (error) {
      if (error?.code === '42501') return json({ error: 'Receipt sharing is unavailable for this receipt.' }, 403);
      return unavailable();
    }
  };
}

export async function requestReceiptConsent(input, { getAccessToken, fetchConsent = globalThis.fetch }) {
  const accessToken = await getAccessToken();
  if (!accessToken) throw new Error('Sign in to check receipt sharing.');
  const response = await fetchConsent(consentPath, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error('Receipt sharing status could not be confirmed.');
  return response.json();
}
