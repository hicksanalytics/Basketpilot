// Consumes the isolated set_consent contract. The caller supplies the transport.
export function createReceiptCommunity(request) {
  const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });
  const receiptReasons = {
    store_missing: 'The receipt needs a store or club number.',
    store_unverified: 'BasketPilot has not verified this store or club number. Check it against the receipt.',
    date_invalid: 'The receipt needs a valid purchase date.',
    discounts: 'This receipt has discounts. Prices on discounted receipts are currently skipped.',
    no_items: 'This receipt has no saved item lines.',
    subtotal: 'The saved item prices need to add up to the receipt subtotal.'
  };
  const lineReasons = {
    review: 'receipt review.',
    package_unverified: 'an exact package match.',
    package_price: 'a positive whole-cent price per package.'
  };

  function mount(parent, receiptId, { expanded = false } = {}) {
    const doc = parent.ownerDocument;
    const panel = doc.createElement('details');
    const summary = doc.createElement('summary');
    summary.textContent = 'Community prices';

    const description = doc.createElement('p');
    description.className = 'muted';
    description.textContent = 'Sharing shows the exact package, store, purchase date, and price paid. Your receipt and account stay private.';

    const status = doc.createElement('p');
    status.className = 'status';
    status.setAttribute('role', 'status');

    const prices = doc.createElement('ul');
    prices.setAttribute('aria-label', 'Item prices in this sharing preview');
    const exclusions = doc.createElement('ul');
    exclusions.setAttribute('aria-label', 'Why prices were skipped');
    exclusions.hidden = true;

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.classList.add('hidden');
    panel.append(summary, description, status, prices, exclusions, button);
    parent.append(panel);

    let state = null;
    let busy = false;
    const label = count => count === 1 ? '1 item price' : count + ' item prices';

    function renderPrices(rows, shared) {
      prices.setAttribute('aria-label', shared ? 'Shared item prices' : 'Item prices you can share');
      prices.replaceChildren();
      for (const price of rows) {
        const item = doc.createElement('li');
        const name = doc.createElement('strong');
        name.textContent = price.package_name;
        const details = doc.createElement('div');
        details.className = 'muted';
        const time = doc.createElement('time');
        time.dateTime = price.purchase_date;
        time.textContent = date.format(new Date(price.purchase_date + 'T00:00:00Z'));
        details.append(price.location_name, ' · ', time, ' · ', money.format(price.package_price_cents / 100), ' per package');
        item.append(name, details);
        prices.append(item);
      }
      prices.hidden = rows.length === 0;
    }

    function renderExclusions(counts) {
      exclusions.replaceChildren();
      const add = text => {
        const row = doc.createElement('li');
        row.textContent = text;
        exclusions.append(row);
      };
      for (const [reason, message] of Object.entries(receiptReasons)) {
        if (counts[reason]) add(message);
      }
      for (const [reason, message] of Object.entries(lineReasons)) {
        const count = counts[reason];
        if (count) add(label(count) + (count === 1 ? ' needs ' : ' need ') + message);
      }
      exclusions.hidden = !exclusions.childElementCount;
    }

    function render(data, action) {
      state = data;
      const shared = data.observation_count > 0;
      const canShare = !shared && data.eligible_count > 0 && data.preview_token;
      renderPrices(data.price_rows, shared);
      renderExclusions(shared ? {} : data.exclusion_counts ?? {});
      button.classList.toggle('hidden', !shared && !canShare);
      button.textContent = shared ? 'Withdraw shared prices' : canShare ? 'Share ' + label(data.eligible_count) : '';
      if (data.outcome === 'stale') {
        status.textContent = shared
          ? 'Sharing changed elsewhere. ' + label(data.observation_count) + ' shared.'
          : 'Sharing changed elsewhere. This receipt is currently private.';
      } else if (data.outcome === 'preview_changed' && canShare) {
        status.textContent = 'The eligible prices changed. Review the updated prices before sharing.';
      } else if (shared) {
        status.textContent = label(data.observation_count) + ' shared.';
      } else if (action === 'withdraw') {
        status.textContent = 'Shared prices withdrawn. Your saved receipt is still in your private history.';
        // A fresh status is required before another opt-in.
        button.textContent = 'Check eligible prices';
        button.classList.remove('hidden');
        state = null;
      } else {
        status.textContent = canShare
          ? label(data.eligible_count) + ' can be shared.'
          : 'No item prices qualify for sharing. Your receipt stays private.';
      }
    }

    async function run(action) {
      if (busy || !panel.isConnected) return;
      busy = true;
      button.disabled = true;
      status.textContent = action === 'status' ? 'Checking eligible prices…' : 'Updating sharing…';
      try {
        const data = await request(
          receiptId, action, action === 'status' ? null : state.revision,
          action === 'share' ? state.preview_token : null
        );
        if (panel.isConnected) render(data, action);
      } catch {
        if (!panel.isConnected) return;
        state = null;
        renderPrices([], false);
        renderExclusions({});
        button.textContent = 'Check sharing status';
        button.classList.remove('hidden');
        status.textContent = 'Could not confirm sharing status. Check again before taking another action.';
      } finally {
        busy = false;
        button.disabled = false;
      }
    }

    button.addEventListener('click', event => {
      if (event.detail > 1) return;
      void run(!state ? 'status' : state.observation_count > 0 ? 'withdraw' : 'share');
    });
    panel.addEventListener('toggle', () => {
      if (panel.open) void run('status');
    });
    panel.open = expanded;
  }

  return { mount };
}
