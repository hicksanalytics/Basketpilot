// Consumes the isolated set_consent contract. The caller supplies the transport.
export function createReceiptCommunity(request) {
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

    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'button secondary';
    button.classList.add('hidden');
    panel.append(summary, description, status, button);
    parent.append(panel);

    let state = null;
    let busy = false;
    const label = count => count === 1 ? '1 item price' : count + ' item prices';

    function render(data, action) {
      state = data;
      const shared = data.observation_count > 0;
      button.classList.toggle('hidden', !shared && !data.eligible_count);
      button.textContent = shared ? 'Withdraw shared prices' : data.eligible_count ? 'Share ' + label(data.eligible_count) : '';
      if (data.outcome === 'stale') {
        status.textContent = shared
          ? 'Sharing changed elsewhere. ' + label(data.observation_count) + ' shared.'
          : 'Sharing changed elsewhere. This receipt is currently private.';
      } else if (shared) {
        status.textContent = label(data.observation_count) + ' shared.';
      } else if (action === 'withdraw') {
        status.textContent = 'Shared prices withdrawn. Your saved receipt is still in your private history.';
        // A fresh status is required before another opt-in.
        button.textContent = 'Check eligible prices';
        button.classList.remove('hidden');
        state = null;
      } else {
        status.textContent = data.eligible_count
          ? label(data.eligible_count) + ' can be shared.'
          : 'No item prices qualify for sharing. Eligible lines need an exact package match, a known store, and a receipt subtotal that adds up without discounts.';
      }
    }

    async function run(action) {
      if (busy || !panel.isConnected) return;
      busy = true;
      button.disabled = true;
      status.textContent = action === 'status' ? 'Checking eligible prices…' : 'Updating sharing…';
      try {
        const data = await request(receiptId, action, action === 'status' ? null : state.revision);
        if (panel.isConnected) render(data, action);
      } catch {
        if (!panel.isConnected) return;
        state = null;
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
