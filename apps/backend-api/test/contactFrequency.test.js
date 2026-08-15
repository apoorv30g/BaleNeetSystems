const test = require("node:test");
const assert = require("node:assert/strict");

const pool = require("../src/db/pool");

let counts = { today: 0, week: 0 };
let lastParams = null;
let lastSql = "";

pool.query = async (sql, params) => {
  lastSql = sql;
  lastParams = params;
  return { rows: [{ today: counts.today, week: counts.week }] };
};

const { checkContactFrequency, CONNECTED_STATUSES } = require("../src/services/contactFrequency");

const TENANT = "tenant-1";
const PHONE = "9876543210";

test.beforeEach(() => {
  counts = { today: 0, week: 0 };
});

test("allows a call when no prior contact exists", async () => {
  const result = await checkContactFrequency(TENANT, PHONE, { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(result.allowed, true);
});

test("blocks once the daily cap is reached", async () => {
  counts = { today: 1, week: 1 };
  const result = await checkContactFrequency(TENANT, PHONE, { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /daily_contact_cap_reached/);
});

test("blocks once the weekly cap is reached even if today is clear", async () => {
  // The scenario that per-campaign attempt counts miss entirely: spread across days AND
  // across different campaigns, so no single campaign counter ever trips.
  counts = { today: 0, week: 3 };
  const result = await checkContactFrequency(TENANT, PHONE, { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /weekly_contact_cap_reached/);
});

test("a cap of 0 means no cap", async () => {
  counts = { today: 99, week: 99 };
  const result = await checkContactFrequency(TENANT, PHONE, { maxPerDay: 0, maxPerWeek: 0 });
  assert.equal(result.allowed, true, "0 must mean unlimited, not 'block everything'");
});

test("counts only connected calls, not failed dials", () => {
  // A failed dial did not bother anyone; counting it would strand borrowers whose number is
  // briefly unreachable.
  assert.deepEqual(CONNECTED_STATUSES, ["completed", "streaming"]);
  assert.ok(!CONNECTED_STATUSES.includes("failed"));
  assert.ok(!CONNECTED_STATUSES.includes("no-answer"));
  assert.ok(!CONNECTED_STATUSES.includes("busy"));
});

test("matches on the last 10 digits so country-code formatting does not bypass the cap", async () => {
  counts = { today: 1, week: 1 };
  const result = await checkContactFrequency(TENANT, "+919876543210", { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(result.allowed, false, "a +91-prefixed number must match the same person");
  assert.match(lastSql, /RIGHT\(l\.phone, 10\) = RIGHT\(\$2, 10\)/);
});

test("the cap is scoped by tenant and spans campaigns", async () => {
  await checkContactFrequency(TENANT, PHONE, { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(lastParams[0], TENANT, "must be tenant-scoped");
  assert.doesNotMatch(lastSql, /campaign_id/, "must NOT filter by campaign — that is the whole point");
});

test("a missing phone number does not block the call", async () => {
  const result = await checkContactFrequency(TENANT, "", { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(result.allowed, true);
});

test("reported counts and limits accompany a block, for the audit trail", async () => {
  counts = { today: 2, week: 5 };
  const result = await checkContactFrequency(TENANT, PHONE, { maxPerDay: 1, maxPerWeek: 3 });
  assert.equal(result.allowed, false);
  assert.equal(result.counts.today, 2);
  assert.equal(result.counts.week, 5);
  assert.equal(result.limits.maxPerDay, 1);
});
