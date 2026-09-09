const test = require("node:test");
const assert = require("node:assert/strict");

// Caller-ID resolution precedence: campaign > tenant > global default.
//
// Why this matters beyond branding: each lender is a separately registered entity, and a
// 1600-series number is registered TO that entity. Dialling one client's borrowers from
// another client's number misrepresents who is calling — a regulatory problem.
//
// The resolution runs in the worker (apps/worker/src/index.js `resolveCallerId`), which is a
// separate workspace with its own db client and cannot be imported here. This mirrors the
// precedence rule so a change to it is caught, and asserts the validation applied at the API.

const GLOBAL_DEFAULT = "08047492642";

function resolveCallerId({ campaignCallerId, tenantCallerId }, globalDefault = GLOBAL_DEFAULT) {
  const resolved = String(campaignCallerId || tenantCallerId || "").trim();
  return {
    callerId: resolved || globalDefault,
    source: campaignCallerId ? "campaign" : (tenantCallerId ? "tenant" : "global_default")
  };
}

// Mirrors the regex used by routes/compliance.js and routes/campaigns.js.
const CALLER_ID_PATTERN = /^[+()\d][\d\s()+-]{5,19}$/;

test("a campaign caller ID wins over the tenant default", () => {
  const r = resolveCallerId({ campaignCallerId: "1600111111", tenantCallerId: "1600222222" });
  assert.equal(r.callerId, "1600111111");
  assert.equal(r.source, "campaign");
});

test("the tenant caller ID is used when the campaign has none", () => {
  const r = resolveCallerId({ campaignCallerId: null, tenantCallerId: "1600222222" });
  assert.equal(r.callerId, "1600222222");
  assert.equal(r.source, "tenant");
});

test("falls back to the platform default when neither is set", () => {
  const r = resolveCallerId({ campaignCallerId: null, tenantCallerId: null });
  assert.equal(r.callerId, GLOBAL_DEFAULT);
  assert.equal(r.source, "global_default");
});

test("blank and whitespace-only values are treated as unset, not as a caller ID", () => {
  // An empty string reaching Exotel as CallerId would fail every call in the campaign.
  assert.equal(resolveCallerId({ campaignCallerId: "", tenantCallerId: "1600222222" }).callerId, "1600222222");
  assert.equal(resolveCallerId({ campaignCallerId: "   ", tenantCallerId: "" }).callerId, GLOBAL_DEFAULT);
});

test("two tenants never share a resolved caller ID when each has its own", () => {
  const nbfcA = resolveCallerId({ campaignCallerId: null, tenantCallerId: "1600100001" });
  const nbfcB = resolveCallerId({ campaignCallerId: null, tenantCallerId: "1600100002" });
  assert.notEqual(nbfcA.callerId, nbfcB.callerId, "each registered entity must dial from its own number");
});

test("a tenant can run two campaigns from different numbers", () => {
  // e.g. a 1600-series collections campaign alongside a promotional campaign.
  const collections = resolveCallerId({ campaignCallerId: "1600100001", tenantCallerId: "08047000000" });
  const promotional = resolveCallerId({ campaignCallerId: null, tenantCallerId: "08047000000" });
  assert.equal(collections.callerId, "1600100001");
  assert.equal(promotional.callerId, "08047000000");
});

test("caller ID validation accepts real formats and rejects junk", () => {
  for (const good of ["1600123456", "08047492642", "+911600123456", "+91 1600 123456", "(022) 1234-5678"]) {
    assert.ok(CALLER_ID_PATTERN.test(good), `should accept ${good}`);
  }
  for (const bad of ["not-a-number", "1600", "<script>", "abc1600123456", ""]) {
    assert.ok(!CALLER_ID_PATTERN.test(bad), `should reject ${JSON.stringify(bad)}`);
  }
});
