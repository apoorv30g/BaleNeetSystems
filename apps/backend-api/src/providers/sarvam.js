const config = require("../config");

async function synthesizeSpeech(text) {
  if (!config.ai.sarvamApiKey) return { mode: "text_only", text };

  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": config.ai.sarvamApiKey
    },
    body: JSON.stringify({
      text,
      target_language_code: "hi-IN",
      speaker: "meera"
    })
  });

  if (!res.ok) {
    throw new Error(`Sarvam TTS failed: ${await res.text()}`);
  }

  return res.json();
}

module.exports = { synthesizeSpeech };
