const config = require("../config");

async function synthesizeSpeech(text, options = {}) {
  if (!config.ai.sarvamApiKey) return { mode: "text_only", text };

  const targetLanguageCode = options.languageCode || process.env.SARVAM_TTS_LANGUAGE || "hi-IN";
  const speaker = process.env.SARVAM_TTS_SPEAKER || "shubh";
  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
  const pace = Number(process.env.SARVAM_TTS_PACE || 1.0);
  const loudness = Number(process.env.SARVAM_TTS_LOUDNESS || 1.5);

  const timeoutMs = Number(process.env.SARVAM_TTS_TIMEOUT_MS || 12000);
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": config.ai.sarvamApiKey
    },
    body: JSON.stringify({
      text,
      target_language_code: targetLanguageCode,
      speaker,
      model,
      pace,
      loudness,
      enable_preprocessing: true
    }),
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
    model,
    speaker,
    languageCode: targetLanguageCode,
    charCount: [...String(text || "")].length
  };
}

module.exports = { synthesizeSpeech };
