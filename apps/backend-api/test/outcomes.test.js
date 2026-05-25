const test = require("node:test");
const assert = require("node:assert/strict");
const { inferOutcome, isOptOut } = require("../src/services/outcomes");

test("inferOutcome detects promise to pay", () => {
  assert.equal(inferOutcome("I will pay tomorrow"), "PROMISE_TO_PAY");
});

test("inferOutcome detects disputes", () => {
  assert.equal(inferOutcome("The amount is wrong, I have an issue"), "DISPUTE");
});

test("isOptOut detects do-not-call language", () => {
  assert.equal(isOptOut("please do not call me again"), true);
});
