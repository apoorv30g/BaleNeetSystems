const WebSocket = require("ws");
const config = require("../config");

function createDeepgramLive({ language = "multi", onTranscript, onError }) {
  if (!config.ai.deepgramApiKey) {
    return { ready: false, sendAudio() {}, close() {} };
  }

  const params = new URLSearchParams({
    model: process.env.DEEPGRAM_MODEL || "nova-2",
    encoding: "linear16",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING || "800",
    smart_format: "true",
    punctuate: "true",
    language
  });

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
        confidence: alternative?.confidence ?? null
      });
    } catch (err) {
      onError?.(err);
    }
  });
  ws.on("error", err => onError?.(err));

  return client;
}

module.exports = { createDeepgramLive };
