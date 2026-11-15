const assert = require('node:assert/strict');
const { test } = require('node:test');
const { rankBasket } = require('../public/basket-planner-core.js');

const store = (retailer, price, packSize = 1, bogo = false) => ({
  retailer, price, packSize, bogo, channel: 'store'
});
const ship = (retailer, price) => ({ retailer, price, packSize: 1, channel: 'ship' });
const costs = {
  tripCost: 400,
  extraStopCost: 500,
  shipping: { costco: { fee: 400, freeAt: 3500 }, sams: { fee: 800, freeAt: 5000 } }
};

test('sums shipping per retailer order and waives it at the threshold', () => {
  const [plan] = rankBasket({ sauce: 1, towels: 1, detergent: 1 }, {
    sauce: [ship('sams', 2000)],
    towels: [ship('sams', 3000)],
    detergent: [ship('costco', 1000)]
  }, costs);
  assert.deepEqual(
    { mode: plan.mode, orders: plan.orders, driving: plan.driving, shipping: plan.delivery, total: plan.total },
    { mode: 'ship', orders: 2, driving: 0, shipping: 400, total: 6400 }
  );
});

test('a higher item subtotal can win when it qualifies for free shipping', () => {
  const [plan] = rankBasket({ towels: 1, sauce: 1 }, {
    towels: [ship('sams', 3500)],
    sauce: [ship('sams', 1200), ship('sams', 1500)]
  }, costs);
  assert.equal(plan.total, 5000);
  assert.equal(plan.delivery, 0);
});

test('a mixed basket includes every item and pays driving and shipping once', () => {
  const [plan] = rankBasket({ eggs: 1, towels: 1, sauce: 1 }, {
    eggs: [store('costco', 100)],
    towels: [store('sams', 2200), ship('sams', 1300)],
    sauce: [ship('sams', 400)]
  }, costs);
  assert.equal(plan.mode, 'mixed');
  assert.equal(plan.lines.length, 3);
  assert.equal(plan.driving, 400);
  assert.equal(plan.delivery, 800);
  assert.equal(plan.total, 3000);
});

test('keeps whole packages and the existing in-store BOGO rule', () => {
  const [plan] = rankBasket({ sauce: 49, berries: 1 }, {
    sauce: [store('publix', 899, 24, true)],
    berries: [store('kroger', 389)]
  }, costs);
  assert.equal(plan.lines[0].packs, 3);
  assert.equal(plan.items, 2187);
  assert.equal(plan.driving, 900);
});

test('does not return a partial plan or create an empty order', () => {
  assert.deepEqual(rankBasket({ eggs: 2, towels: 1 }, { towels: [ship('sams', 1700)] }, costs), []);
  assert.deepEqual(rankBasket({ eggs: 0 }, {}, costs), []);
});
