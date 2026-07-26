const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/variantStats");

test("computeWeight smooths toward 0.5 with no data and rewards success", () => {
  assert.equal(_test.computeWeight(0, 0), 0.5);
  // a strong winner: 40/50 -> ~0.79
  assert.ok(_test.computeWeight(50, 40) > 0.75);
  // a loser: 2/50 -> low
  assert.ok(_test.computeWeight(50, 2) < 0.1);
  // weights stay in [0,1]
  assert.ok(_test.computeWeight(100, 100) <= 1);
});

test("pickVariantIndex returns 0 for single/zero variants", () => {
  assert.equal(_test.pickVariantIndex(1, {}), 0);
  assert.equal(_test.pickVariantIndex(0, {}), 0);
});

test("pickVariantIndex favors the higher-weighted variant over many rolls", () => {
  const stats = { 0: 0.9, 1: 0.1 };
  let zero = 0;
  for (let i = 0; i < 2000; i++) if (_test.pickVariantIndex(2, stats) === 0) zero++;
  assert.ok(zero > 1500, `expected variant 0 to dominate, got ${zero}/2000`);
});

test("pickVariantIndex still gives the weak variant airtime (floor 0.1)", () => {
  const stats = { 0: 0.99, 1: 0.0 };
  let one = 0;
  for (let i = 0; i < 4000; i++) if (_test.pickVariantIndex(2, stats) === 1) one++;
  assert.ok(one > 50, `expected the floored variant to still appear, got ${one}/4000`);
});

test("a deterministic rand selects the expected bucket", () => {
  const stats = { 0: 0.5, 1: 0.5 }; // total 1.0
  assert.equal(_test.pickVariantIndex(2, stats, () => 0.25), 0);
  assert.equal(_test.pickVariantIndex(2, stats, () => 0.75), 1);
});
