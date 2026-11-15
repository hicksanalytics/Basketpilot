(function (root) {
  'use strict';

  function rankBasket(quantities, offers, { tripCost, extraStopCost, shipping }) {
    const requested = Object.entries(quantities).filter(([, quantity]) => quantity > 0);
    if (!requested.length) return [];

    let baskets = [{ lines: [], subtotals: {} }];
    for (const [product, quantity] of requested) {
      const lineOptions = (offers[product] || []).map(offer => {
        const packs = Math.ceil(quantity / offer.packSize);
        const paidPacks = offer.bogo ? packs - Math.floor(packs / 2) : packs;
        return { ...offer, product, packs, cost: paidPacks * offer.price };
      });

      // Keep the retailer subtotals until the complete basket is known.
      // A higher item subtotal can qualify for free shipping and cost less overall.
      baskets = baskets.flatMap(basket => lineOptions.map(line => {
        const key = line.channel + ':' + line.retailer;
        return {
          lines: [...basket.lines, line],
          subtotals: {
            ...basket.subtotals,
            [key]: (basket.subtotals[key] || 0) + line.cost
          }
        };
      }));
    }

    return baskets.map(({ lines, subtotals }) => {
      const stores = new Set(lines.filter(line => line.channel === 'store').map(line => line.retailer));
      const shipments = new Set(lines.filter(line => line.channel === 'ship').map(line => line.retailer));
      const items = Object.values(subtotals).reduce((sum, subtotal) => sum + subtotal, 0);
      const driving = stores.size ? tripCost + (stores.size - 1) * extraStopCost : 0;
      const delivery = Array.from(shipments).reduce((sum, retailer) => {
        const { fee, freeAt } = shipping[retailer];
        return sum + (subtotals['ship:' + retailer] < freeAt ? fee : 0);
      }, 0);
      const mode = shipments.size === 0 ? 'store' : stores.size === 0 ? 'ship' : 'mixed';
      return { lines, mode, items, driving, delivery, stops: stores.size, orders: shipments.size, total: items + driving + delivery };
    }).sort((a, b) => a.total - b.total || a.stops + a.orders - b.stops - b.orders || a.stops - b.stops);
  }

  if (typeof module === 'object' && module.exports) module.exports = { rankBasket };
  else root.BasketPlanner = { rankBasket };
})(globalThis);
