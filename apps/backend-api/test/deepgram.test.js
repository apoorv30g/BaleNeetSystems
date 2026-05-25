const test = require("node:test");
const assert = require("node:assert/strict");

test("deepgram provider returns disabled without api key", async () => {
  const previous = process.env.DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  delete require.cache[require.resolve("../src/config")];
  delete require.cache[require.resolve("../src/providers/deepgram")];

  const { transcribeAudioUrl } = require("../src/providers/deepgram");
  const result = await transcribeAudioUrl("https://example.com/audio.wav");
  assert.equal(result.mode, "disabled");

  if (previous) process.env.DEEPGRAM_API_KEY = previous;
});
