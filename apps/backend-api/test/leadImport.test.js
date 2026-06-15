const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/leadImport");

test("TezCredit rows map selfie pending to the right playbook", () => {
  const result = _test.normalizeLeadRow({
    "Lead ID": "lead-1",
    Status: "No Input",
    "Mobile Number": "918826522604",
    Name: "Apoorv",
    Selfie: "No",
    Aadhaar: "No",
    Profession: "No",
    Pan: "No",
    "Penny Drop": "No",
    "E-sign": "No",
    "UTM Source": "crednorth"
  }, { campaign: { language: "Hinglish" }, rowNumber: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.lead.phone, "8826522604");
  assert.equal(result.lead.dropStage, "SELFIE_PENDING");
  assert.equal(result.lead.playbookType, "TEZ_SELFIE_PENDING");
  assert.equal(result.lead.sourceMetadata.productName, "TezCredit");
});

test("TezCredit rows map approved bank verification pending", () => {
  const result = _test.normalizeLeadRow({
    "Lead ID": "lead-2",
    Status: "Approve",
    "Mobile Number": "8826522604",
    Name: "Apoorv",
    Selfie: "Yes",
    Aadhaar: "Yes",
    Profession: "Yes",
    Pan: "Yes",
    PinCode: "110001",
    "Penny Drop": "No",
    "E-sign": "No",
    "Loan Amount": "30000",
    "Disbursed Amount": "Not Disbursed"
  }, { campaign: { language: "Hinglish" }, rowNumber: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.lead.dropStage, "BANK_VERIFICATION_PENDING");
  assert.equal(result.lead.playbookType, "TEZ_BANK_VERIFICATION_PENDING");
  assert.equal(result.lead.offerAmount, "30000");
});

test("TezCredit rejected rows are skipped with reason", () => {
  const result = _test.normalizeLeadRow({
    Status: "Reject",
    "Reject Reason": "blacklisted_pincode",
    "Mobile Number": "8826522604",
    Selfie: "Yes",
    Aadhaar: "Yes",
    Profession: "Yes",
    Pan: "Yes",
    "Penny Drop": "No",
    "E-sign": "No"
  }, { rowNumber: 4 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "rejected_blacklisted_pincode");
});
