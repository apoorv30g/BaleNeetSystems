const WebSocket = require("ws");
const config = require("../config");

function createSarvamLive({ languageCode = "hi-IN", onTranscript, onOpen, onClose, onStatus, onError }) {
  if (!config.ai.sarvamApiKey) {
    return { provider: "sarvam", ready: false, sendAudio() {}, close() {} };
  }

  const sampleRate = Number(process.env.SARVAM_STT_SAMPLE_RATE || 8000);
  const audioEncoding = process.env.SARVAM_STT_AUDIO_ENCODING || "pcm_s16le";
  const targetChunkBytes = normalizeChunkBytes(process.env.SARVAM_STT_CHUNK_BYTES || 1600);
  const flushMs = Number(process.env.SARVAM_STT_FLUSH_MS || 100);
  const connectBufferLimit = Number(process.env.SARVAM_STT_CONNECT_BUFFER_BYTES || 160000);
  const params = sarvamParams({ languageCode, sampleRate, audioEncoding });
  const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
    headers: { "Api-Subscription-Key": config.ai.sarvamApiKey }
  });

  const connectBuffer = [];
  const pendingAudio = [];
  let connectBufferedBytes = 0;
  let pendingBytes = 0;
  let flushTimer = null;
  let opened = false;
  let closedByClient = false;

  const client = {
    provider: "sarvam",
    ready: false,
    sendAudio(buffer) {
      if (!buffer?.length) return;
      if (ws.readyState === WebSocket.OPEN) {
        enqueueAudio(buffer);
        return;
      }
      if (ws.readyState === WebSocket.CONNECTING && connectBufferLimit > 0) {
        connectBuffer.push(buffer);
        connectBufferedBytes += buffer.length;
        while (connectBufferedBytes > connectBufferLimit && connectBuffer.length) {
          connectBufferedBytes -= connectBuffer.shift().length;
        }
      }
    },
    close() {
      closedByClient = true;
      flushAudio();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  };

  onStatus?.({
    provider: "sarvam",
    type: "ConnectAttempt",
    model: process.env.SARVAM_STT_MODEL || "saaras:v3",
    mode: process.env.SARVAM_STT_MODE || "codemix",
    languageCode,
    sampleRate,
    inputAudioCodec: audioEncoding
  });

  ws.on("open", () => {
    opened = true;
    client.ready = true;
    const flushedBytes = connectBufferedBytes;
    for (const buffer of connectBuffer.splice(0)) enqueueAudio(buffer);
    connectBufferedBytes = 0;
    onOpen?.({
      provider: "sarvam",
      flushedBytes,
      model: process.env.SARVAM_STT_MODEL || "saaras:v3",
      mode: process.env.SARVAM_STT_MODE || "codemix",
      languageCode,
      sampleRate,
      urlParams: params.toString()
    });
  });

  ws.on("message", data => {
    try {
      const payload = JSON.parse(data.toString());
      const normalized = normalizeSarvamMessage(payload);
      if (normalized.status) {
        onStatus?.({ provider: "sarvam", ...normalized.status, payload });
      }
      if (!normalized.transcript) return;

      onTranscript?.({
        provider: "sarvam",
        transcript: normalized.transcript,
        isFinal: true,
        speechFinal: true,
        confidence: normalized.confidence,
        words: [],
        languages: normalized.languageCode ? [normalized.languageCode] : [],
        source: "sarvam_final",
        metrics: normalized.metrics || null
      });
    } catch (err) {
      onError?.(err);
    }
  });

  ws.on("unexpected-response", (req, res) => {
    let body = "";
    res.on("data", chunk => { body += chunk.toString(); });
    res.on("end", () => {
      onStatus?.({
        provider: "sarvam",
        type: "UnexpectedResponse",
        statusCode: res.statusCode,
        body: body.slice(0, 500)
      });
      onError?.(new Error(`Sarvam STT unexpected response ${res.statusCode}: ${body.slice(0, 500)}`));
    });
  });

  ws.on("error", err => onError?.(err));
  ws.on("close", (code, reason) => {
    clearFlushTimer();
    client.ready = false;
    onClose?.({
      provider: "sarvam",
      code,
      reason: reason?.toString() || "",
      opened,
      closedByClient
    });
  });

  return client;

  function enqueueAudio(buffer) {
    pendingAudio.push(buffer);
    pendingBytes += buffer.length;
    if (pendingBytes >= targetChunkBytes) {
      flushAudio();
      return;
    }
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || flushMs <= 0) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushAudio();
    }, flushMs);
  }

  function flushAudio() {
    clearFlushTimer();
    if (!pendingBytes || ws.readyState !== WebSocket.OPEN) return;
    const audio = Buffer.concat(pendingAudio.splice(0), pendingBytes);
    pendingBytes = 0;
    ws.send(JSON.stringify({
      audio: {
        data: audio.toString("base64"),
        sample_rate: String(sampleRate),
        encoding: audioEncoding
      }
    }));
  }

  function clearFlushTimer() {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

function sarvamParams({ languageCode, sampleRate, audioEncoding }) {
  const params = new URLSearchParams({
    "language-code": languageCode,
    model: process.env.SARVAM_STT_MODEL || "saaras:v3",
    mode: process.env.SARVAM_STT_MODE || "codemix",
    sample_rate: String(sampleRate),
    input_audio_codec: audioEncoding,
    high_vad_sensitivity: process.env.SARVAM_STT_HIGH_VAD_SENSITIVITY || "true",
    vad_signals: process.env.SARVAM_STT_VAD_SIGNALS || "true"
  });

  for (const key of [
    "positive_speech_threshold",
    "negative_speech_threshold",
    "min_speech_frames",
    "first_turn_min_speech_frames",
    "negative_frames_count",
    "negative_frames_window",
    "start_speech_volume_threshold",
    "interrupt_min_speech_frames",
    "pre_speech_pad_frames",
    "num_initial_ignored_frames"
  ]) {
    const envKey = `SARVAM_STT_${key.toUpperCase()}`;
    if (process.env[envKey]) params.set(key, process.env[envKey]);
  }

  return params;
}

function normalizeSarvamMessage(payload) {
  const type = String(payload?.type || "").toLowerCase();
  const data = payload?.data || {};
  const transcript = data.transcript || payload?.transcript || "";
  const signalType = data.signal_type || payload?.signal_type || "";

  if (type === "events" || signalType || type === "speech_start" || type === "speech_end") {
    return {
      status: {
        type: normalizeSignalType(signalType || type),
        signalType: signalType || type
      }
    };
  }

  return {
    transcript: String(transcript || "").trim(),
    confidence: data.confidence ?? payload?.confidence ?? null,
    languageCode: data.language_code || payload?.language_code || "",
    metrics: data.metrics || payload?.metrics || null
  };
}

function normalizeSignalType(signalType) {
  const value = String(signalType || "").toUpperCase();
  if (value.includes("START")) return "SpeechStarted";
  if (value.includes("END")) return "UtteranceEnd";
  return signalType || "Status";
}

function normalizeChunkBytes(value) {
  const configured = Number(value);
  if (!Number.isFinite(configured) || configured <= 0) return 1600;
  return Math.max(320, Math.floor(configured / 320) * 320);
}

module.exports = { createSarvamLive };
