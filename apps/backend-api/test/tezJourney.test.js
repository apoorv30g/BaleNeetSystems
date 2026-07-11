const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyTezJourneyProgress,
  buildTezJourneyTransitionReply,
  detectTezJourneyProgress,
  tezJourneyContext
} = require("../src/services/tezJourney");

function lead(stage = "SELFIE_PENDING", playbookType = "TEZ_SELFIE_PENDING") {
  return {
    id: "lead-1",
    playbook_type: playbookType,
    drop_stage: stage,
    status: "pending",
    source_status: "Active",
    source_metadata: { productName: "TezCredit" }
  };
}

test("TezCredit journey starts at the imported stage and treats earlier stages as complete", () => {
  const context = tezJourneyContext(lead("BANK_VERIFICATION_PENDING", "TEZ_BANK_VERIFICATION_PENDING"));

  assert.equal(context.currentStage, "BANK_VERIFICATION_PENDING");
  assert.deepEqual(context.completedStages, ["SELFIE_PENDING", "AADHAAR_PENDING", "PROFILE_PENDING"]);
  assert.equal(context.next.stage, "E_SIGN_PENDING");
});

test("drop stage is authoritative when stale metadata disagrees", () => {
  const current = lead("BANK_VERIFICATION_PENDING", "TEZ_BANK_VERIFICATION_PENDING");
  current.source_metadata.journeyProgress = { currentStage: "APPROVED_NOT_DISBURSED" };

  const context = tezJourneyContext(current);

  assert.equal(context.currentStage, "BANK_VERIFICATION_PENDING");
});

test("a bare yes does not falsely complete a TezCredit stage", () => {
  const progress = detectTezJourneyProgress(lead(), "yes", {
    lastSpokenText: "Can you complete the live selfie now?"
  });

  assert.equal(progress, null);
});

test("yes advances after the agent explicitly asks whether the active stage is complete", () => {
  const progress = detectTezJourneyProgress(lead(), "हाँ जी", {
    lastSpokenText: "क्या selfie complete हो गई?"
  });

  assert.equal(progress.nextStage, "AADHAAR_PENDING");
  assert.equal(progress.reason, "completion_question_confirmed");
});

test("yes after asking whether the next screen merely opened does not skip that stage", () => {
  const progress = detectTezJourneyProgress(
    lead("AADHAAR_PENDING", "TEZ_AADHAAR_PENDING"),
    "yes",
    { lastSpokenText: "Has the Aadhaar KYC screen opened now?" }
  );

  assert.equal(progress, null);
});

test("clear completion advances from selfie to Aadhaar KYC", () => {
  const progress = detectTezJourneyProgress(lead(), "हाँ, selfie हो गई", {
    lastSpokenText: "क्या live selfie complete हुई?"
  });

  assert.equal(progress.completedStage, "SELFIE_PENDING");
  assert.equal(progress.nextStage, "AADHAAR_PENDING");
  assert.equal(progress.nextPlaybookType, "TEZ_AADHAAR_PENDING");
  assert.equal(progress.journeyComplete, false);
});

test("reporting the next app screen advances the active stage", () => {
  const progress = detectTezJourneyProgress(lead(), "अब Aadhaar KYC screen खुल गया", {
    lastSpokenText: "Please complete the live selfie."
  });

  assert.equal(progress.completedStage, "SELFIE_PENDING");
  assert.equal(progress.nextStage, "AADHAAR_PENDING");
  assert.equal(progress.reason, "next_screen_reported");
});

test("failed or pending messages never advance the journey", () => {
  const progress = detectTezJourneyProgress(lead("AADHAAR_PENDING", "TEZ_AADHAAR_PENDING"), "KYC नहीं हुआ, error आ रहा है", {
    lastSpokenText: "Complete Aadhaar KYC in DigiLocker."
  });

  assert.equal(progress, null);
});

test("journey progress persists the next playbook and can resume", () => {
  const original = lead("E_SIGN_PENDING", "TEZ_ESIGN_PENDING");
  const progress = detectTezJourneyProgress(original, "e-sign completed", {
    lastSpokenText: "Please review and e-sign the agreement."
  });
  const updated = applyTezJourneyProgress(original, progress, new Date("2026-07-01T10:00:00.000Z"));
  const resumed = tezJourneyContext(updated);

  assert.equal(updated.drop_stage, "APPROVED_NOT_DISBURSED");
  assert.equal(updated.playbook_type, "TEZ_APPROVED_NOT_DISBURSED");
  assert.equal(resumed.currentStage, "APPROVED_NOT_DISBURSED");
  assert.ok(updated.source_metadata.journeyProgress.completedStages.includes("E_SIGN_PENDING"));
  assert.match(buildTezJourneyTransitionReply(progress, true), /approval or disbursal/i);
});

test("journey completes only after disbursal is explicitly confirmed", () => {
  const current = lead("APPROVED_NOT_DISBURSED", "TEZ_APPROVED_NOT_DISBURSED");
  const vague = detectTezJourneyProgress(current, "done", {
    lastSpokenText: "What disbursal status do you see?"
  });
  const confirmed = detectTezJourneyProgress(current, "The money is credited in my account", {
    lastSpokenText: "What disbursal status do you see?"
  });
  const updated = applyTezJourneyProgress(current, confirmed, new Date("2026-07-01T10:00:00.000Z"));

  assert.equal(vague, null);
  assert.equal(confirmed.journeyComplete, true);
  assert.equal(updated.drop_stage, "JOURNEY_COMPLETED");
  assert.equal(updated.status, "completed");
  assert.equal(updated.source_metadata.journeyProgress.journeyCompleted, true);
});

test("Hindi credit confirmation completes approved-not-disbursed journey", () => {
  const current = lead("APPROVED_NOT_DISBURSED", "TEZ_APPROVED_NOT_DISBURSED");
  const progress = detectTezJourneyProgress(current, "क्रेडिट हो गया।", {
    lastSpokenText: "कृपया disbursal status देखिए। क्या loan amount आपके account में credit हो गया?"
  });

  assert.equal(progress.journeyComplete, true);
  assert.equal(progress.reason, "disbursal_confirmed");
});

test("complete ho gaya confirms disbursal only after explicit credit question", () => {
  const current = lead("APPROVED_NOT_DISBURSED", "TEZ_APPROVED_NOT_DISBURSED");
  const vague = detectTezJourneyProgress(current, "हो गया complete", {
    lastSpokenText: "What disbursal status do you see?"
  });
  const confirmed = detectTezJourneyProgress(current, "हो गया complete", {
    lastSpokenText: "क्या loan amount आपके account में credit हो गया?"
  });

  assert.equal(vague, null);
  assert.equal(confirmed.journeyComplete, true);
});

test("yes completes the journey after an explicit disbursal-credit question", () => {
  const current = lead("APPROVED_NOT_DISBURSED", "TEZ_APPROVED_NOT_DISBURSED");
  const progress = detectTezJourneyProgress(current, "yes", {
    lastSpokenText: "Has the loan amount been credited to your account?"
  });

  assert.equal(progress.journeyComplete, true);
});
