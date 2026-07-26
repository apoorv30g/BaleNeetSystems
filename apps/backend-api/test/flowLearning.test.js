const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/services/flowLearning");
const { _test: playbooksTest } = require("../src/services/playbooks");

test("sanitizePhrases lowercases, dedupes, strips dangerous chars, and caps length", () => {
  const phrases = _test.sanitizePhrases([
    "CIBIL Score",
    "cibil score",
    "  cibil score  ",
    "ab",
    "x".repeat(80),
    "credit {score}",
    ...Array.from({ length: 30 }, (_, i) => `phrase number ${i}`)
  ]);
  assert.ok(phrases.includes("cibil score"));
  assert.equal(phrases.filter(p => p === "cibil score").length, 1);
  assert.ok(!phrases.includes("ab"));
  assert.ok(phrases.every(p => p.length <= 60));
  assert.ok(phrases.every(p => !/[{}]/.test(p)));
  assert.ok(phrases.length <= 12);
});

test("extractJsonArray pulls the array out of prose and code fences", () => {
  const wrapped = 'Here are my suggestions:\n```json\n[{"phrases":["cibil"],"answer_hi":"x"}]\n```\nHope this helps!';
  const parsed = _test.extractJsonArray(wrapped);
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].phrases, ["cibil"]);
  assert.deepEqual(_test.extractJsonArray("no json here"), []);
  assert.deepEqual(_test.extractJsonArray("[{broken"), []);
});

test("mergeFaqProposalIntoVoiceConfig prepends a tagged learned entry, preserving brand", () => {
  const merged = _test.mergeFaqProposalIntoVoiceConfig(
    { brand: { name: "ASAP Finance" }, flow: { faqs: [{ intent: "amount", answer: { hi: "old" } }] } },
    { phrases: ["Cibil Kharab"], answer: { hi: "जवाब", en: "answer" } }
  );
  assert.equal(merged.brand.name, "ASAP Finance");
  assert.equal(merged.flow.faqs.length, 2);
  assert.equal(merged.flow.faqs[0].learned, true);
  assert.deepEqual(merged.flow.faqs[0].phrases, ["cibil kharab"]);
  assert.equal(merged.flow.faqs[1].intent, "amount");
});

test("merge works from an empty voice_config too", () => {
  const merged = _test.mergeFaqProposalIntoVoiceConfig(null, { phrases: ["emi kab se"], answer: { hi: "जवाब" } });
  assert.equal(merged.flow.faqs.length, 1);
  assert.deepEqual(merged.flow.faqs[0].phrases, ["emi kab se"]);
});

test("shareablePhrases drops digit-bearing phrases (no phone numbers / amounts leak)", () => {
  const shared = _test.shareablePhrases(["cibil kharab", "50000 loan", "credit score", "otp 1234"]);
  assert.ok(shared.includes("cibil kharab"));
  assert.ok(shared.includes("credit score"));
  assert.ok(!shared.some(p => /\d/.test(p)));
});

test("normalizeTopic slugifies and falls back to general", () => {
  assert.equal(_test.normalizeTopic("CIBIL Impact!"), "cibil_impact");
  assert.equal(_test.normalizeTopic(""), "general");
  assert.equal(_test.normalizeTopic("  link not opening  "), "link_not_opening");
});

test("filterOutLearnedFaq removes only the matching learned entry", () => {
  const faqs = [
    { intent: "amount", answer: { hi: "authored" } },
    { learned: true, phrases: ["cibil kharab", "credit score"], answer: { hi: "learned1" } },
    { learned: true, phrases: ["emi kab se"], answer: { hi: "learned2" } }
  ];
  const next = playbooksTest.filterOutLearnedFaq(faqs, ["credit score", "CIBIL KHARAB"]);
  assert.equal(next.length, 2);
  assert.ok(next.some(f => f.intent === "amount"));
  assert.ok(next.some(f => f.answer?.hi === "learned2"));
  // Non-matching phrase set or authored (non-learned) entries: no removal.
  assert.equal(playbooksTest.filterOutLearnedFaq(faqs, ["something else"]), null);
  assert.equal(playbooksTest.filterOutLearnedFaq([{ intent: "amount", phrases: ["x"] }], ["x"]), null);
});
