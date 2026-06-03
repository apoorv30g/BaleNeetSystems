const WebSocket = require("ws");
const config = require("../config");

const DEFAULT_KEYTERMS = [
  "LoanConnect",
  "Baleneet Systems",
  "loan",
  "loan eligibility",
  "final offer",
  "documents",
  "document upload",
  "approved",
  "not approved",
  "CIBIL",
  "EMI",
  "payment",
  "callback",
  "not interested"
];

function createDeepgramLive({ language = "multi", onTranscript, onError }) {
  if (!config.ai.deepgramApiKey) {
    return { ready: false, sendAudio() {}, close() {} };
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-3",
    encoding: "linear16",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING || "350",
    utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS || "900",
    smart_format: "true",
    punctuate: "true",
    language
  });
  for (const keyterm of deepgramKeyterms()) {
    params.append("keyterm", keyterm);
  }

  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
    headers: { Authorization: `Token ${config.ai.deepgramApiKey}` }
  });

  const client = {
    ready: false,
    sendAudio(buffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer);
    },
    close() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  };

  ws.on("open", () => { client.ready = true; });
  ws.on("message", data => {
    try {
      const payload = JSON.parse(data.toString());
      const alternative = payload?.channel?.alternatives?.[0];
      const transcript = alternative?.transcript || "";
      if (!transcript) return;

      onTranscript?.({
        transcript,
        isFinal: Boolean(payload.is_final),
        speechFinal: Boolean(payload.speech_final),
        confidence: alternative?.confidence ?? null,
        words: alternative?.words || [],
        languages: alternative?.languages || []
      });
    } catch (err) {
      onError?.(err);
    }
  });
  ws.on("error", err => onError?.(err));

  return client;
}

function deepgramKeyterms() {
  const configured = process.env.DEEPGRAM_KEYTERMS || DEFAULT_KEYTERMS.join(",");
  return configured
    .split(",")
    .map(term => term.trim())
    .filter(Boolean)
    .slice(0, 100);
}

module.exports = { createDeepgramLive };
