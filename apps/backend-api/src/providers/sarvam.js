const config = require("../config");

function isBulbulV3(model) {
  return /^bulbul:v3(?:$|[-.])/i.test(String(model || "").trim());
}

function buildTtsPayload(text, options = {}) {
  const targetLanguageCode = options.languageCode || process.env.SARVAM_TTS_LANGUAGE || "hi-IN";
  const speaker = options.speaker || process.env.SARVAM_TTS_SPEAKER || "shubh";
  const model = options.model || process.env.SARVAM_TTS_MODEL || "bulbul:v3";
  const pace = Number(options.pace ?? process.env.SARVAM_TTS_PACE ?? 1.0);
  const loudness = Number(options.loudness ?? process.env.SARVAM_TTS_LOUDNESS ?? 1.5);
  const payload = {
    text,
    target_language_code: targetLanguageCode,
    speaker,
    model,
    enable_preprocessing: true
  };

  if (Number.isFinite(pace)) payload.pace = pace;
  if (!isBulbulV3(model) && Number.isFinite(loudness)) payload.loudness = loudness;

  return payload;
}

async function synthesizeSpeech(text, options = {}) {
  if (!config.ai.sarvamApiKey) return { mode: "text_only", text };

  const payload = buildTtsPayload(text, options);

  const timeoutMs = Number(process.env.SARVAM_TTS_TIMEOUT_MS || 12000);
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": config.ai.sarvamApiKey
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!res.ok) {
    throw new Error(`Sarvam TTS failed: ${await res.text()}`);
  }

  const data = await res.json();
  const audioBase64 = data.audio || data.audioContent || data?.audios?.join("") || data?.data?.audio;

  if (!audioBase64) return { mode: "text_only", text, raw: data };

  return {
    mode: "audio",
    audioBase64,
    mimeType: data.mimeType || data.mime_type || "audio/wav",
    model: payload.model,
    speaker: payload.speaker,
    languageCode: payload.target_language_code,
    charCount: [...String(text || "")].length
  };
}

module.exports = { synthesizeSpeech, buildTtsPayload, _test: { isBulbulV3 } };
