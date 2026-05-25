const test = require("node:test");
const assert = require("node:assert/strict");
const { PLAYBOOKS } = require("../src/services/playbooks");

test("default playbooks remain available", () => {
  assert.ok(PLAYBOOKS.FRESH_LEAD);
  assert.ok(Array.isArray(PLAYBOOKS.FRESH_LEAD.steps));
});
