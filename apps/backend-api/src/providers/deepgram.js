const config = require("../config");

async function transcribeAudioUrl(audioUrl, options = {}) {
  if (!config.ai.deepgramApiKey) {
    return { mode: "disabled", transcript: "", confidence: null };
  }

  if (!audioUrl) {
    return { mode: "missing_audio", transcript: "", confidence: null };
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-2",
    smart_format: "true",
    punctuate: "true",
    language: options.language || process.env.DEEPGRAM_LANGUAGE || "multi"
  });

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${config.ai.deepgramApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url: audioUrl })
  });

  if (!res.ok) throw new Error(`Deepgram failed: ${await res.text()}`);

  const data = await res.json();
  const alternative = data?.results?.channels?.[0]?.alternatives?.[0];

  return {
    mode: "deepgram",
    transcript: alternative?.transcript || "",
    confidence: typeof alternative?.confidence === "number" ? alternative.confidence : null,
    raw: data
  };
}

module.exports = { transcribeAudioUrl };
