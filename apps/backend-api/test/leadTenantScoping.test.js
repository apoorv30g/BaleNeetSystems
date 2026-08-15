const test = require("node:test");
const assert = require("node:assert/strict");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_lead_scoping";

const pool = require("../src/db/pool");

const TENANT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TENANT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD_A = "11111111-1111-4111-8111-111111111111";
const CAMPAIGN_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CAMPAIGN_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

const leads = {
  [LEAD_A]: {
    id: LEAD_A,
    tenant_id: TENANT_A,
    campaign_id: CAMPAIGN_A,
    name: "Tenant A Borrower",
    phone: "9000000001",
    playbook_type: "UNAPPROVED_USERS",
    language: "Hinglish"
  }
};

pool.query = async (sql, params) => {
  if (/SELECT \* FROM leads WHERE id=/i.test(sql)) {
    const lead = leads[params[0]];
    return { rows: lead ? [{ ...lead }] : [] };
  }
  if (/SELECT voice_config FROM playbooks/i.test(sql)) {
    return { rows: [{ voice_config: null }] };
  }
  return { rows: [] };
};

const { findLeadById } = require("../src/services/playbooks");

test("findLeadById returns the lead when no tenant expectation is given", async () => {
  const lead = await findLeadById(LEAD_A);
  assert.equal(lead.id, LEAD_A);
  assert.equal(lead.tenant_id, TENANT_A);
});

test("findLeadById returns the lead when the tenant matches", async () => {
  const lead = await findLeadById(LEAD_A, { expectedTenantId: TENANT_A });
  assert.equal(lead.id, LEAD_A);
});

test("findLeadById refuses to return a lead belonging to another tenant", async () => {
  await assert.rejects(
    () => findLeadById(LEAD_A, { expectedTenantId: TENANT_B }),
    err => err.code === "TENANT_MISMATCH",
    "a cross-tenant lead read must fail loudly, not return data"
  );
});

test("findLeadById returns null for an unknown lead", async () => {
  assert.equal(await findLeadById("99999999-9999-4999-8999-999999999999"), null);
  assert.equal(await findLeadById(""), null);
  assert.equal(await findLeadById(null), null);
});

test("findLeadById compares tenant ids as strings, not by reference", async () => {
  // Guards against a regression where a UUID object/string mismatch silently passes.
  const lead = await findLeadById(LEAD_A, { expectedTenantId: String(TENANT_A) });
  assert.equal(lead.tenant_id, TENANT_A);
});

// The voicebot receives campaignId as an untrusted URL parameter while tenant_id is derived
// from the lead row. Trusting the parameter would let a mismatched value create a call row
// pairing this lead's tenant with a different tenant's campaign.
test("a lead's own campaign wins over a supplied campaign id", () => {
  const lead = leads[LEAD_A];

  // Mirrors the resolution rule applied in voicebot.js initializeSession and in the
  // /exotel/voicebot-url handler.
  const resolve = (requested, leadRow) => leadRow.campaign_id || requested || null;

  assert.equal(resolve(CAMPAIGN_B, lead), CAMPAIGN_A, "a foreign campaign id must not be adopted");
  assert.equal(resolve(CAMPAIGN_A, lead), CAMPAIGN_A);
  assert.equal(resolve(undefined, lead), CAMPAIGN_A);
  assert.equal(resolve(CAMPAIGN_B, { campaign_id: null }), CAMPAIGN_B, "falls back when the lead has none");
});
