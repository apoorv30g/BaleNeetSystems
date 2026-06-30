const test = require("node:test");
const assert = require("node:assert/strict");
const { _test } = require("../src/providers/sarvamChat");

test("Sarvam chat reply guard completes dangling Hindi final-offer sentence", () => {
  const reply = _test.ensureCompleteReply(
    "ठीक है, मैं आपको पात्रता की जाँच करने में मदद करूँगा। कृपया अपने अंतिम ऋण प्रस्ताव को देखने",
    { language: "Hinglish", playbook_type: "UNAPPROVED_USERS" }
  );

  assert.match(reply, /सुरक्षित लिंक खोलिए।$/);
});

test("Sarvam chat reply guard completes dangling English link sentence", () => {
  const reply = _test.ensureCompleteReply(
    "Please open it to check",
    { language: "English", playbook_type: "UNAPPROVED_USERS" }
  );

  assert.match(reply, /secure link\.$/);
});

test("Sarvam chat reply guard repairs malformed safe-link sentence", () => {
  const reply = _test.ensureCompleteReply(
    "ठीक है, मैं आपको पात्रता की जांच करने में मदद कर सकता हूं। कृपया अपने ऐप में सुरक्षित।",
    { language: "Hinglish", playbook_type: "UNAPPROVED_USERS" }
  );

  assert.match(reply, /ऐप में सुरक्षित लिंक खोलिए।$/);
});
