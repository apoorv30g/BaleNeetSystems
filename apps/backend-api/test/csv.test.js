const test = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv } = require("../src/utils/csv");

test("parseCsv handles quoted commas", () => {
  const rows = parseCsv('name,phone,notes\n"A, B",987,"hello, world"\n');
  assert.equal(rows[0].name, "A, B");
  assert.equal(rows[0].notes, "hello, world");
});

test("parseCsv ignores blank lines", () => {
  const rows = parseCsv("name,phone\n\nRahul,987\n");
  assert.deepEqual(rows, [{ name: "Rahul", phone: "987" }]);
});
