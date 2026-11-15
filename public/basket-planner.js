(() => {
  'use strict';

  const names = { costco: 'Costco', sams: "Sam's Club", publix: 'Publix', kroger: 'Kroger' };
  const products = {
    eggs: 'Eggs',
    sauce: 'Marinara sauce',
    berries: 'Frozen berries',
    towels: 'Paper towels'
  };
  const units = { eggs: 'eggs', sauce: 'oz', berries: 'lb', towels: 'rolls' };
  const storeOffers = {
    eggs: { costco: [480, 24], sams: [450, 24], publix: [310, 12], kroger: [295, 12] },
    sauce: { costco: [1350, 64], sams: [999, 44], publix: [899, 24], kroger: [749, 24] },
    berries: { costco: [1199, 4], sams: [1149, 4], publix: [449, 1], kroger: [389, 1] },
    towels: { costco: [2299, 12], sams: [2499, 15], publix: [1099, 6], kroger: [999, 6] }
  };
  const shippedOffers = {
    sauce: [{ retailer: 'sams', price: 1049, packSize: 44,
      url: 'https://www.samsclub.com/ip/Rao-s-Homemade-Marinara-Sauce-22-oz-2-pk/13898155759' }],
    towels: [
      { retailer: 'costco', price: 2299, packSize: 12,
        url: 'https://www.costco.com/p/-/kirkland-signature-paper-towels-2-ply-160-sheets-12-count/100234271' },
      { retailer: 'sams', price: 1999, packSize: 15,
        url: 'https://www.samsclub.com/ip/members-mark-super-premium-2-ply-select-tear-paper-towels-15rolls/15390012477' }
    ]
  };
  const shipping = { costco: { fee: 399, freeAt: 3500 }, sams: { fee: 800, freeAt: 5000 } };
  const modeLabels = { store: 'In-store only', mixed: 'Store trip + shipping', ship: 'Shipping only' };
  const get = id => document.getElementById(id);
  const results = get('results');
  const money = cents => '$' + (cents / 100).toFixed(2);

  function render(plans) {
    const fragment = document.createDocumentFragment();
    plans.forEach((plan, index) => {
      const card = document.createElement('article');
      card.className = 'basket-plan';
      const heading = document.createElement('h3');
      heading.className = 'flex';
      heading.textContent = modeLabels[plan.mode];
      const total = document.createElement('span');
      total.className = 'amount' + (index === 0 ? ' win' : '');
      total.textContent = money(plan.total);
      heading.append(total);

      const details = document.createElement('p');
      details.className = 'note';
      details.textContent = [
        index === 0 && 'Lowest demo total',
        'Items ' + money(plan.items),
        plan.stops > 0 && 'Driving ' + money(plan.driving),
        plan.orders > 0 && 'Shipping ' + money(plan.delivery)
      ].filter(Boolean).join(' · ');

      const lines = document.createElement('ul');
      lines.className = 'basket-lines';
      for (const line of plan.lines) {
        const item = document.createElement('li');
        const quantity = line.packs + (line.packs === 1 ? ' pack' : ' packs');
        item.textContent = products[line.product] + ' · ' + quantity + ' (' + line.packSize + ' ' + units[line.product] + ' each) · ' +
          (line.channel === 'ship' ? 'Ship from ' : 'Buy at ') + names[line.retailer];
        if (line.url) {
          const link = document.createElement('a');
          link.href = line.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = 'Open ' + products[line.product].toLowerCase() + ' at ' + names[line.retailer] + ' (new tab)';
          item.append(link);
        }
        lines.append(item);
      }
      card.append(heading, details, lines);
      fragment.append(card);
    });
    results.replaceChildren(fragment);
  }

  function recalc() {
    const includeShipping = get('include-shipping').checked;
    get('shipping-assumptions').hidden = !includeShipping;
    const quantities = Object.fromEntries(Object.keys(products).map(product => [product, Number(get(product).value)]));
    if (Object.keys(products).some(product => !Number.isFinite(quantities[product]) ||
        quantities[product] < 0 || quantities[product] > Number(get(product).max))) {
      results.textContent = 'Enter quantities within the ranges shown.';
      return;
    }
    if (!Object.values(quantities).some(Boolean)) {
      results.textContent = 'Enter at least one item to compare.';
      return;
    }
    const offers = Object.fromEntries(Object.entries(storeOffers).map(([product, retailers]) => {
      const inStore = Object.entries(retailers).map(([retailer, [price, packSize]]) => ({
        retailer, channel: 'store', price, packSize,
        bogo: retailer === 'publix' && product === 'sauce' && get('bogo').checked
      }));
      const shipped = includeShipping ? (shippedOffers[product] || []).map(offer => ({ ...offer, channel: 'ship' })) : [];
      return [product, [...inStore, ...shipped]];
    }));
    const ranked = BasketPlanner.rankBasket(quantities, offers, {
      tripCost: Number(get('trip-cost').value) * 100,
      extraStopCost: Number(get('detour').value) * 100,
      shipping
    });
    const bestByMode = ranked.filter((plan, index) => ranked.findIndex(other => other.mode === plan.mode) === index);
    if (!includeShipping) {
      render(ranked.slice(0, 3));
      return;
    }
    render(bestByMode);
    if (!bestByMode.some(plan => plan.mode === 'ship')) {
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = 'Shipping-only plans require a shipping option for every item. This sample ships marinara sauce and paper towels.';
      results.append(note);
    }
  }

  get('calculate').addEventListener('click', recalc);
  get('basket-inputs').addEventListener('change', recalc);
  recalc();
})();
