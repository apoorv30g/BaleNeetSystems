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

function createDeepgramLive({ language = "multi", onTranscript, onOpen, onClose, onStatus, onError }) {
  if (!config.ai.deepgramApiKey) {
    return { ready: false, sendAudio() {}, close() {} };
  }

  const audioBuffer = [];
  let bufferedBytes = 0;
  const maxBufferedBytes = Number(process.env.DEEPGRAM_CONNECT_BUFFER_BYTES || 160000);
  const attempts = deepgramAttempts(language);
  let ws = null;
  let activeAttempt = 0;
  let opened = false;
  let closedByClient = false;

  const client = {
    ready: false,
    sendAudio(buffer) {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(buffer);
        return;
      }
      if ((ws?.readyState === WebSocket.CONNECTING || ws?.readyState === WebSocket.CLOSED) && maxBufferedBytes > 0) {
        audioBuffer.push(buffer);
        bufferedBytes += buffer.length;
        while (bufferedBytes > maxBufferedBytes && audioBuffer.length) {
          bufferedBytes -= audioBuffer.shift().length;
        }
      }
    },
    close() {
      closedByClient = true;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) ws.close();
    }
  };

  connect(0);

  return client;

  function connect(attemptIndex) {
    activeAttempt = attemptIndex;
    opened = false;
    const attempt = attempts[attemptIndex] || attempts[0];
    const attemptLanguage = attempt.language || language;
    const params = deepgramParams({ model: attempt.model, language: attemptLanguage, includeKeyterms: attempt.includeKeyterms });
    ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: { Authorization: `Token ${config.ai.deepgramApiKey}` }
    });

    onStatus?.({
      type: "ConnectAttempt",
      attempt: attemptIndex + 1,
      model: attempt.model,
      includeKeyterms: attempt.includeKeyterms,
      language: attemptLanguage
    });

    ws.on("open", () => {
      opened = true;
      client.ready = true;
      for (const buffer of audioBuffer.splice(0)) ws.send(buffer);
      const flushedBytes = bufferedBytes;
      bufferedBytes = 0;
      onOpen?.({
        flushedBytes,
        model: attempt.model,
        attempt: attemptIndex + 1,
        includeKeyterms: attempt.includeKeyterms,
        language: attemptLanguage,
        urlParams: params.toString()
      });
    });

    ws.on("message", data => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.type && payload.type !== "Results") {
          onStatus?.({ type: payload.type, payload, model: attempt.model });
          return;
        }
        const alternative = payload?.channel?.alternatives?.[0];
        const transcript = alternative?.transcript || "";
        if (!transcript) return;

        onTranscript?.({
          transcript,
          isFinal: Boolean(payload.is_final),
          speechFinal: Boolean(payload.speech_final),
          confidence: alternative?.confidence ?? null,
          words: alternative?.words || [],
          languages: alternative?.languages || [],
          model: attempt.model
        });
      } catch (err) {
        onError?.(err);
      }
    });

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", chunk => { body += chunk.toString(); });
      res.on("end", () => {
        onError?.(new Error(`Deepgram unexpected response ${res.statusCode}: ${body.slice(0, 500)}`));
        onStatus?.({
          type: "UnexpectedResponse",
          statusCode: res.statusCode,
          body: body.slice(0, 500),
          model: attempt.model,
          attempt: attemptIndex + 1
        });
        retryIfPossible(attemptIndex, "unexpected_response");
      });
    });

    ws.on("error", err => onError?.(err));
    ws.on("close", (code, reason) => {
      client.ready = false;
      const reasonText = reason?.toString() || "";
      if (!closedByClient && !opened && retryIfPossible(attemptIndex, `close_${code}`)) return;
      onClose?.({
        code,
        reason: reasonText,
        model: attempt.model,
        attempt: attemptIndex + 1,
        opened
      });
    });
  }

  function retryIfPossible(attemptIndex, reason) {
    if (closedByClient || attemptIndex + 1 >= attempts.length) return false;
    const nextIndex = attemptIndex + 1;
    onStatus?.({
      type: "ReconnectAttempt",
      reason,
      nextAttempt: nextIndex + 1,
      nextModel: attempts[nextIndex].model,
      nextLanguage: attempts[nextIndex].language,
      includeKeyterms: attempts[nextIndex].includeKeyterms
    });
    setTimeout(() => connect(nextIndex), Number(process.env.DEEPGRAM_RECONNECT_DELAY_MS || 250));
    return true;
  }
}

function deepgramParams({ model, language, includeKeyterms }) {
  const params = new URLSearchParams({
    model,
    encoding: "linear16",
    sample_rate: "8000",
    channels: "1",
    interim_results: "true",
    endpointing: process.env.DEEPGRAM_ENDPOINTING || "350",
    utterance_end_ms: process.env.DEEPGRAM_UTTERANCE_END_MS || "900",
    vad_events: process.env.DEEPGRAM_VAD_EVENTS || "true",
    smart_format: "true",
    punctuate: "true",
    language
  });
  if (includeKeyterms) {
    for (const keyterm of deepgramKeyterms()) {
      params.append("keyterm", keyterm);
    }
  }
  return params;
}

function deepgramAttempts(language) {
  const preferred = process.env.DEEPGRAM_MODEL || "nova-3";
  const fallbackModels = (process.env.DEEPGRAM_FALLBACK_MODELS || "nova-2")
    .split(",")
    .map(model => model.trim())
    .filter(Boolean);
  const models = [...new Set([preferred, ...fallbackModels])];
  const languages = deepgramLanguageAttempts(language);
  const attempts = [];
  for (const model of models) {
    for (const attemptLanguage of languages) {
      attempts.push({
        model,
        language: attemptLanguage,
        includeKeyterms: attempts.length === 0 && process.env.DEEPGRAM_ENABLE_KEYTERMS === "true"
      });
    }
  }
  if (attempts.length === 1) {
    attempts.push({ model: attempts[0].model, language: attempts[0].language, includeKeyterms: false });
  }
  return attempts;
}

function deepgramLanguageAttempts(language) {
  const configured = process.env.DEEPGRAM_FALLBACK_LANGUAGES;
  if (configured) {
    return uniqueValues(configured.split(",").map(value => value.trim()).filter(Boolean));
  }

  const requested = String(language || "").trim().toLowerCase();
  if (!requested || requested === "multi") return ["en", "hi"];
  if (requested === "hi") return ["hi", "en"];
  if (requested === "en") return ["en", "hi"];
  return uniqueValues([requested, "en", "hi"]);
}

function deepgramKeyterms() {
  const configured = process.env.DEEPGRAM_KEYTERMS || DEFAULT_KEYTERMS.join(",");
  if (/^(false|off|none)$/i.test(configured.trim())) return [];
  return configured
    .split(",")
    .map(term => term.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

module.exports = { createDeepgramLive };
