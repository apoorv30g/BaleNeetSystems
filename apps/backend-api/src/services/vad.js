function createPcmVad(options = {}) {
  const enabled = options.enabled !== false;
  const sampleRate = Number(options.sampleRate || 8000);
  const bytesPerMs = Math.max(1, (sampleRate * 2) / 1000);
  const minRms = Number(options.minRms ?? process.env.VOICEBOT_VAD_MIN_RMS ?? 260);
  const minPeak = Number(options.minPeak ?? process.env.VOICEBOT_VAD_MIN_PEAK ?? 900);
  const noiseRatio = Number(options.noiseRatio ?? process.env.VOICEBOT_VAD_NOISE_RATIO ?? 2.8);
  const preRollMs = Number(options.preRollMs ?? process.env.VOICEBOT_VAD_PREROLL_MS ?? 240);
  const hangoverMs = Number(options.hangoverMs ?? process.env.VOICEBOT_VAD_HANGOVER_MS ?? 520);
  const minSpeechMs = Number(options.minSpeechMs ?? process.env.VOICEBOT_VAD_MIN_SPEECH_MS ?? 80);
  const noiseAlpha = Number(options.noiseAlpha ?? process.env.VOICEBOT_VAD_NOISE_ALPHA ?? 0.96);
  const maxPreRollBytes = Math.max(0, Math.round(preRollMs * bytesPerMs));

  let speechActive = false;
  let speechMs = 0;
  let silenceMs = 0;
  let noiseRms = Number(options.initialNoiseRms ?? process.env.VOICEBOT_VAD_INITIAL_NOISE_RMS ?? 120);
  let preRoll = [];
  let preRollBytes = 0;

  return {
    process(buffer) {
      const audio = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
      const stats = computePcmStats(audio, sampleRate);
      if (!enabled || !audio.length) {
        return {
          forwarded: audio.length ? [audio] : [],
          speech: true,
          started: false,
          ended: false,
          reason: enabled ? "empty" : "disabled",
          stats
        };
      }

      const threshold = Math.max(minRms, noiseRms * noiseRatio);
      const speech = stats.rms >= threshold || stats.peak >= minPeak;
      const forwarded = [];
      let started = false;
      let ended = false;
      let reason = "silence";

      if (speech) {
        if (!speechActive) {
          started = true;
          speechActive = true;
          speechMs = 0;
          silenceMs = 0;
          if (preRoll.length) forwarded.push(...preRoll.map(item => item.buffer));
          preRoll = [];
          preRollBytes = 0;
        }
        speechMs += stats.durationMs;
        silenceMs = 0;
        forwarded.push(audio);
        reason = "speech";
      } else if (speechActive) {
        silenceMs += stats.durationMs;
        if (silenceMs <= hangoverMs || speechMs < minSpeechMs) {
          forwarded.push(audio);
          reason = "hangover";
        } else {
          speechActive = false;
          speechMs = 0;
          silenceMs = 0;
          ended = true;
          rememberPreRoll(audio);
          reason = "speech_end";
        }
      } else {
        updateNoise(stats.rms);
        rememberPreRoll(audio);
      }

      return {
        forwarded,
        speech,
        started,
        ended,
        reason,
        stats: { ...stats, threshold: Math.round(threshold), noiseRms: Math.round(noiseRms) }
      };
    },
    snapshot() {
      return {
        enabled,
        speechActive,
        speechMs: Math.round(speechMs),
        silenceMs: Math.round(silenceMs),
        noiseRms: Math.round(noiseRms),
        preRollBytes
      };
    }
  };

  function updateNoise(rms) {
    const value = Number(rms || 0);
    if (!Number.isFinite(value) || value <= 0) return;
    noiseRms = Math.max(20, Math.min(1200, noiseRms * noiseAlpha + value * (1 - noiseAlpha)));
  }

  function rememberPreRoll(buffer) {
    if (!maxPreRollBytes || !buffer.length) return;
    preRoll.push({ buffer, bytes: buffer.length });
    preRollBytes += buffer.length;
    while (preRollBytes > maxPreRollBytes && preRoll.length) {
      preRollBytes -= preRoll.shift().bytes;
    }
  }
}

function computePcmStats(buffer, sampleRate = 8000) {
  const audio = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || []);
  const sampleCount = Math.floor(audio.length / 2);
  if (!sampleCount) {
    return { rms: 0, peak: 0, samples: 0, durationMs: 0 };
  }

  let sumSquares = 0;
  let peak = 0;
  for (let offset = 0; offset + 1 < audio.length; offset += 2) {
    const sample = audio.readInt16LE(offset);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }

  return {
    rms: Math.round(Math.sqrt(sumSquares / sampleCount)),
    peak,
    samples: sampleCount,
    durationMs: Math.round((sampleCount / Number(sampleRate || 8000)) * 1000)
  };
}

module.exports = { createPcmVad, computePcmStats };
