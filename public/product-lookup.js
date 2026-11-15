import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm';

const sb = createClient('https://vfctfvbufuvmbxnrfmaj.supabase.co', 'sb_publishable_c_5T1bCL67YOtiHAHvGn_Q_czQOk9sv');
const lookup = window.BasketPilotProductLookup;
const insights = window.BasketPilotInsightsCore;
const $ = id => document.getElementById(id);
const storeNames = { costco: 'Costco', sams: "Sam's Club", publix: 'Publix', kroger: 'Kroger' };
const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
let products = [];
let account = null;
let accountRequest = 0;
let historyReady = false;
let camera = null;
let query = '';
let linkBarcode = null;
let updatingBarcode = false;
const searchResume = window.BasketPilotSearchResume.create();

function element(tag, parent, text, className) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function categoryLabel(item, retailer) {
  const category = item.analytics_group || insights.inferMetadata({ ...item, retailer }).group;
  return insights.groupInfo(category)?.label ?? '';
}

async function loadProducts() {
  const request = ++accountRequest;
  const owner = account;
  const { data, error } = await sb.from('receipts')
    .select('id,retailer,store_id,purchase_date,created_at,receipt_items(id,retailer_item_code,receipt_description,matched_title,match_status,matched_product_id,analytics_group,quantity,gross_line_total,package_gtin),receipt_discounts(allocation_status)')
    .eq('owner_id', owner).order('purchase_date', { ascending: false }).order('created_at', { ascending: false }).limit(300);
  if (request !== accountRequest || owner !== account) return;
  if (error) throw error;
  products = lookup.buildProducts(data, categoryLabel);
  historyReady = true;
  $('account-status').textContent = data.length
    ? 'Personal receipt prices · Latest ' + data.length + (data.length === 1 ? ' receipt' : ' receipts')
    : 'Save a receipt to start comparing your purchases.';
  if (!resumeProductSearch(owner)) renderResults();
}

function resumeProductSearch(owner) {
  if (location.hash !== window.BasketPilotSearchResume.returnHash) return false;
  const pending = searchResume.take(owner);
  history.replaceState(history.state, '', location.pathname + location.search);
  if (!pending || query || $('product-query').value.trim()) return false;
  $('product-query').value = pending;
  setResultQuery(pending);
  $('results-title').focus({ preventScroll: true });
  $('search-results').scrollIntoView({ block: 'start' });
  return true;
}

function reportAccountError() {
  $('search-status').textContent = '';
  $('account-status').textContent = 'Private receipt history could not load. Reload this page to retry.';
}

async function setAccount(user) {
  const id = user?.id ?? null;
  if (id === account && historyReady) return;
  account = id;
  accountRequest++;
  products = [];
  historyReady = false;
  resetLink();
  $('sign-in').hidden = Boolean(account);
  $('account-status').textContent = account ? 'Loading your private receipt history…' : 'Sign in to search your saved purchases.';
  renderResults();
  if (account) await loadProducts();
}

function setResultQuery(value) {
  query = value.trim();
  $('sign-in').textContent = query ? 'Sign in to see matches and return here' : 'Sign in to see your receipts';
  resetLink();
  renderResults();
}

function resetLink() {
  linkBarcode = null;
  $('link-panel').hidden = true;
  $('link-query').value = '';
  $('link-status').textContent = '';
  $('link-results').replaceChildren();
}

function renderResults() {
  const root = $('product-results');
  const status = $('search-status');
  root.replaceChildren();
  $('search-results').hidden = !query;
  if (!query) return;

  const barcodeQuery = /^[\d\s-]+$/.test(query);
  const barcode = barcodeQuery ? lookup.normalizeBarcode(query) : null;
  if (barcodeQuery && !barcode) {
    status.textContent = 'Check the digits under the barcode or try scanning it again.';
    return;
  }
  if (!historyReady) {
    status.textContent = account ? 'Results appear when your receipt history loads.' : 'Sign in to see your receipt matches.';
    return;
  }

  const results = lookup.searchProducts(products, query);
  status.textContent = results.length
    ? 'Latest purchase price per package at each recorded store. Prices are from past receipts.'
    : barcode ? 'No saved purchases are linked to this barcode yet.' : 'No matching purchases. Try the brand, package name, or a shorter search.';
  for (const product of results.slice(0, 40)) renderProduct(root, product);
  if (results.length > 40) element('p', root, 'Showing 40 matches. Search by brand or package size to narrow your results.', 'muted');
  if (barcode && products.length) {
    const controls = element('div', root, null, 'actions');
    const link = element('button', controls, 'Link to a saved purchase', 'secondary');
    link.type = 'button';
    link.addEventListener('click', () => openLink(barcode));
  }
}

function renderProduct(root, product) {
  const card = element('article', root, null, 'product');
  element('h3', card, product.title);
  if (product.barcode) element('p', card, 'Package barcode ' + product.barcode, 'muted');
  else if (product.candidate?.sku) {
    element('p', card, (storeNames[product.candidate.retailer] || product.candidate.retailer) + ' item #' + product.candidate.sku, 'muted');
  }
  const rows = element('ul', card, null, 'price-list');
  for (const [index, price] of product.prices.entries()) {
    const row = element('li', rows, null, 'price-row');
    const location = element('div', row);
    const store = storeNames[price.retailer] || price.retailer;
    element('strong', location, store + (price.store ? ' #' + price.store : ' · Location unspecified'));
    const lowest = index === 0 && product.prices.length > 1 && price.price < product.prices[1].price;
    element('span', location, [price.date, lowest && 'Lowest recorded', price.discountPending && 'Before unallocated discounts']
      .filter(Boolean).join(' · '), 'price-meta');
    element('strong', row, money.format(price.price));
  }
  if (!product.prices.length) element('p', card, 'No per-package purchase price is available for this match.', 'muted');

  if (product.links.length) {
    const details = element('details', card);
    element('summary', details, 'Manage barcode links');
    for (const link of product.links) {
      const row = element('div', details, null, 'actions');
      element('span', row, (storeNames[link.retailer] || link.retailer) + (link.date ? ' · ' + link.date : ''));
      const button = element('button', row, 'Unlink', 'secondary');
      button.type = 'button';
      button.setAttribute('aria-label', 'Unlink barcode from ' + (storeNames[link.retailer] || link.retailer) + (link.date ? ' purchase on ' + link.date : ' purchase'));
      button.addEventListener('click', () => updateBarcode(button, link.id, null, product.barcode));
    }
  }
}

function openLink(barcode) {
  linkBarcode = barcode;
  $('link-panel').hidden = false;
  $('link-copy').textContent = 'Choose a saved purchase only if you recognize it as this exact package.';
  $('link-query').focus();
}

function showCandidates() {
  const root = $('link-results');
  root.replaceChildren();
  if (!linkBarcode) return;
  const matches = lookup.searchProducts(products, $('link-query').value).filter(product => product.candidate);
  $('link-status').textContent = matches.length ? '' : 'No unlinked purchase matches that name.';
  for (const { candidate } of matches.slice(0, 20)) {
    const card = element('article', root, null, 'product');
    element('h3', card, candidate.title);
    element('p', card, [storeNames[candidate.retailer], candidate.date, candidate.sku && 'Item #' + candidate.sku]
      .filter(Boolean).join(' · '), 'muted');
    const actions = element('div', card, null, 'actions');
    const button = element('button', actions, 'Link this package');
    button.type = 'button';
    button.addEventListener('click', () => updateBarcode(button, candidate.id, linkBarcode));
  }
}

async function updateBarcode(button, id, barcode, previousBarcode = null) {
  if (!account || updatingBarcode) return;
  const owner = account;
  const submittedQuery = query;
  const message = barcode ? $('link-status') : $('search-status');
  updatingBarcode = true;
  button.disabled = true;
  message.textContent = barcode ? 'Linking this purchase…' : 'Removing this link…';
  try {
    const update = sb.from('receipt_items').update({ package_gtin: barcode }).eq('id', id);
    const unchanged = barcode ? update.is('package_gtin', null) : update.eq('package_gtin', previousBarcode);
    const { error } = await unchanged.select('id').single();
    if (error) throw error;
    if (owner !== account) return;
    await loadProducts();
    if (owner !== account || query !== submittedQuery) return;
    resetLink();
    $('search-status').textContent = barcode ? 'Barcode linked. Purchase prices updated below.' : 'Barcode link removed.';
  } catch {
    if (owner === account && query === submittedQuery) message.textContent = 'Could not update the barcode link. Reload your history and try again.';
  } finally {
    updatingBarcode = false;
    button.disabled = false;
  }
}

function stopDecoding(controls) {
  if (controls) Promise.resolve().then(() => controls.stop()).catch(() => {});
}

function stopCamera(message = '') {
  const active = camera;
  camera = null;
  stopDecoding(active?.controls);
  active?.stream?.getTracks().forEach(track => track.stop());
  const video = $('barcode-camera');
  video.srcObject = null;
  video.hidden = true;
  $('start-camera').hidden = false;
  $('stop-camera').hidden = true;
  $('scan-status').textContent = message;
}

async function startCamera() {
  if (camera) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    $('scan-status').textContent = 'Camera scanning is unavailable here. Enter the digits below the barcode.';
    return;
  }
  const scan = {};
  camera = scan;
  $('start-camera').hidden = true;
  $('stop-camera').hidden = false;
  $('scan-status').textContent = 'Opening camera…';
  try {
    const { BrowserMultiFormatReader, BarcodeFormat } = await import('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.5/+esm');
    if (camera !== scan) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (camera !== scan) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    scan.stream = stream;
    const video = $('barcode-camera');
    video.hidden = false;
    $('scan-status').textContent = 'Center the barcode in view and hold the package steady.';
    const reader = new BrowserMultiFormatReader();
    reader.possibleFormats = [BarcodeFormat.UPC_A, BarcodeFormat.UPC_E, BarcodeFormat.EAN_8, BarcodeFormat.EAN_13, BarcodeFormat.ITF];
    const controls = await reader.decodeFromStream(stream, video, (result) => {
      if (camera !== scan || !result) return;
      const code = result.getBarcodeFormat() === BarcodeFormat.UPC_E
        ? lookup.expandUpce(result.getText()) : result.getText();
      const barcode = lookup.normalizeBarcode(code);
      if (!barcode) return;
      stopCamera('Package barcode scanned.');
      $('product-query').value = code;
      setResultQuery(code);
    });
    if (camera === scan) scan.controls = controls;
    else stopDecoding(controls);
  } catch {
    if (camera === scan) stopCamera('Could not scan with the camera. Allow camera access or enter the barcode number.');
  }
}

$('product-search').addEventListener('submit', event => {
  event.preventDefault();
  if (camera) stopCamera();
  setResultQuery($('product-query').value);
});
$('link-search').addEventListener('submit', event => {
  event.preventDefault();
  showCandidates();
});
$('start-camera').addEventListener('click', startCamera);
$('stop-camera').addEventListener('click', () => stopCamera());
window.addEventListener('pagehide', () => stopCamera());
document.addEventListener('visibilitychange', () => {
  if (document.hidden && camera) stopCamera();
});

$('sign-in').addEventListener('click', event => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  searchResume.remember(query);
});

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_OUT') searchResume.clear();
  if (['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT'].includes(event)) {
    setTimeout(() => setAccount(session?.user).catch(reportAccountError), 0);
  }
});
