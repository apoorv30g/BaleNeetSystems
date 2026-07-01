const test = require("node:test");
const assert = require("node:assert/strict");
const { buildTtsPayload } = require("../src/providers/sarvam");

test("Bulbul v3 TTS payload omits unsupported loudness", () => {
  const payload = buildTtsPayload("Namaste.", {
    languageCode: "hi-IN",
    speaker: "simran",
    model: "bulbul:v3",
    pace: 1,
    loudness: 1.5
  });

  assert.equal(payload.model, "bulbul:v3");
  assert.equal(payload.speaker, "simran");
  assert.equal(payload.pace, 1);
  assert.equal("loudness" in payload, false);
  assert.equal("pitch" in payload, false);
});

test("legacy Bulbul TTS payload retains loudness control", () => {
  const payload = buildTtsPayload("Namaste.", {
    model: "bulbul:v2",
    loudness: 1.25
  });

  assert.equal(payload.loudness, 1.25);
});
