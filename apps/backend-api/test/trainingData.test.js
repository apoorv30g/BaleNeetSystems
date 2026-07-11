const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/trainingData");

test("training extraction detects amount and website handling", () => {
  const analysis = _test.extractTrainingInsights(
    "Customer: mera loan amount kitna hai? Agent: Please open www.tezcredit.com and click Apply Now."
  );

  const intents = analysis.examples.map(example => example.intentKey);
  assert.ok(intents.includes("amount_query"));
  assert.ok(intents.includes("website_help"));
});

test("training extraction detects Hindi stuck and completion phrases", () => {
  const analysis = _test.extractTrainingInsights(
    "मुझे स्क्रीन नहीं दिख रही है। अब selfie हो गया, आगे क्या करना है?"
  );

  const intents = analysis.examples.map(example => example.intentKey);
  assert.ok(intents.includes("not_visible_or_stuck"));
  assert.ok(intents.includes("step_completed"));
});

test("training normalization keeps Devanagari and removes punctuation", () => {
  assert.equal(_test.normalizePhrase("Amount कितना है??"), "amount कितना है");
});
