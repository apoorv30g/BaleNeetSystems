const test = require("node:test");
const assert = require("node:assert/strict");
const { createPcmVad, computePcmStats } = require("../src/services/vad");

test("VAD suppresses silence and forwards speech with pre-roll", () => {
  const vad = createPcmVad({
    sampleRate: 8000,
    minRms: 260,
    minPeak: 900,
    preRollMs: 40,
    hangoverMs: 80,
    initialNoiseRms: 80
  });

  const silence = pcmFrame(0, 20);
  const quiet = vad.process(silence);
  assert.equal(quiet.forwarded.length, 0);
  assert.equal(quiet.reason, "silence");

  const speech = vad.process(pcmFrame(3200, 20));
  assert.equal(speech.started, true);
  assert.equal(speech.forwarded.length, 2);
  assert.equal(speech.forwarded.reduce((sum, chunk) => sum + chunk.length, 0), silence.length + pcmFrame(3200, 20).length);
});

test("VAD keeps short trailing silence as hangover", () => {
  const vad = createPcmVad({
    sampleRate: 8000,
    minRms: 260,
    minPeak: 900,
    preRollMs: 0,
    hangoverMs: 80
  });

  vad.process(pcmFrame(3000, 20));
  const trailing = vad.process(pcmFrame(0, 20));
  assert.equal(trailing.forwarded.length, 1);
  assert.equal(trailing.reason, "hangover");
});

test("PCM stats reports RMS and peak", () => {
  const stats = computePcmStats(pcmFrame(1000, 20), 8000);
  assert.equal(stats.peak, 1000);
  assert.equal(stats.rms, 1000);
  assert.equal(stats.durationMs, 20);
});

function pcmFrame(amplitude, durationMs, sampleRate = 8000) {
  const samples = Math.round((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(amplitude, i * 2);
  }
  return buffer;
}
