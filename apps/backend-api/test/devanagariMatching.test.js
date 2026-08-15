const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/routes/voicebot");

// REGRESSION GUARD.
//
// JavaScript's \b is defined against \w, which is ASCII-only. There is therefore NEVER a word
// boundary adjacent to a Devanagari character, so a pattern like /\b(मेरा नाम)\b/ silently
// never matches -- it does not error, it just always returns false.
//
// Four production patterns had this bug: Hindi name extraction and Hindi filler-stripping in
// voicebot.js, and the Hindi name-intent check in playbooks.js. Since Sarvam STT sometimes
// returns native script (see the Punjabi-script transliteration test in voicebot.test.js),
// customers answering in Devanagari were not having their name recognised at all.

test("the \\b-with-Devanagari hazard is real and still worth guarding against", () => {
  // If this ever starts matching, the JS engine changed and these workarounds can be revisited.
  assert.equal(/\b(मेरा नाम)\b/u.test("मेरा नाम राहुल"), false,
    "\\b beside Devanagari must be assumed non-matching");
  assert.equal(/\b(?:आज)\b/u.test("आज"), false);
});

test("Hindi name statements are extracted in full, not truncated at the first matra", () => {
  const extracted = _test.extractNameAnswer("मेरा नाम राहुल");
  assert.ok(extracted, "a Hindi 'my name is X' statement must yield a name");
  // The whole name, not just "र" -- Devanagari vowel marks are Unicode category Mark, so a
  // \p{L}-only character class stops at the first matra.
  assert.equal(extracted, "राहुल");
});

test("Hindi name extraction still works mid-sentence", () => {
  const extracted = _test.extractNameAnswer("जी मेरा नाम सुनीता");
  assert.ok(extracted, "must match when preceded by other words");
  assert.match(extracted, /सुनीता/);
});

test("Latin-script name statements continue to work", () => {
  assert.match(_test.extractNameAnswer("mera naam Rahul"), /Rahul/i);
  assert.match(_test.extractNameAnswer("my name is Priya"), /Priya/i);
});

test("no name statement yields nothing", () => {
  assert.equal(_test.extractNameAnswer("haan ji theek hai"), "");
  assert.equal(_test.extractNameAnswer(""), "");
});
