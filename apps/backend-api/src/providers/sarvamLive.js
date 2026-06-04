const WebSocket = require("ws");
const config = require("../config");

function createSarvamLive({ languageCode = "hi-IN", onTranscript, onOpen, onClose, onStatus, onError }) {
  if (!config.ai.sarvamApiKey) {
    return { provider: "sarvam", ready: false, sendAudio() {}, close() {} };
  }

  const sampleRate = Number(process.env.SARVAM_STT_SAMPLE_RATE || 8000);
  const sourceSampleRate = Number(process.env.SARVAM_STT_SOURCE_SAMPLE_RATE || process.env.EXOTEL_AUDIO_SAMPLE_RATE || 8000);
  const audioEncoding = process.env.SARVAM_STT_AUDIO_ENCODING || "pcm_s16le";
  const messageSampleRate = Number(process.env.SARVAM_STT_MESSAGE_SAMPLE_RATE || sampleRate);
  const messageEncoding = process.env.SARVAM_STT_MESSAGE_ENCODING || audioEncoding;
  const targetChunkBytes = normalizeChunkBytes(
    process.env.SARVAM_STT_CHUNK_BYTES || pcmBytesForDuration(sampleRate, Number(process.env.SARVAM_STT_CHUNK_MS || 100))
  );
  const flushMs = Number(process.env.SARVAM_STT_FLUSH_MS || 100);
  const connectBufferLimit = Number(process.env.SARVAM_STT_CONNECT_BUFFER_BYTES || 160000);
  const logMessages = process.env.SARVAM_STT_LOG_MESSAGES === "true";
  const resampleAudio = process.env.SARVAM_STT_RESAMPLE_AUDIO !== "false";
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
  let audioMessagesSent = 0;
  let audioBytesSent = 0;

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
    sourceSampleRate,
    messageSampleRate,
    messageEncoding,
    inputAudioCodec: audioEncoding,
    targetChunkBytes
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
      sourceSampleRate,
      messageSampleRate,
      messageEncoding,
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
      if (logMessages && !normalized.status && !normalized.transcript) {
        onStatus?.({ provider: "sarvam", type: "Message", payload });
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
      closedByClient,
      audioMessagesSent,
      audioBytesSent,
      sampleRate,
      sourceSampleRate,
      messageSampleRate,
      messageEncoding
    });
  });

  return client;

  function enqueueAudio(buffer) {
    const audio = normalizeIncomingAudio(buffer);
    if (!audio.length) return;
    pendingAudio.push(audio);
    pendingBytes += audio.length;
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
        sample_rate: messageSampleRate,
        encoding: messageEncoding
      }
    }));
    audioMessagesSent++;
    audioBytesSent += audio.length;
  }

  function clearFlushTimer() {
    if (!flushTimer) return;
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function normalizeIncomingAudio(buffer) {
    if (!resampleAudio || audioEncoding !== "pcm_s16le" || sourceSampleRate === sampleRate) return buffer;
    return resamplePcm16Le(buffer, sourceSampleRate, sampleRate);
  }
}

function sarvamParams({ languageCode, sampleRate, audioEncoding }) {
  const params = new URLSearchParams({
    language_code: languageCode,
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
  const transcript = data.transcript || data.text || payload?.transcript || payload?.text || "";
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

function pcmBytesForDuration(sampleRate, durationMs) {
  const rate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 8000;
  const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 100;
  return Math.max(320, Math.round(rate * 2 * ms / 1000));
}

function resamplePcm16Le(buffer, sourceRate, targetRate) {
  if (!buffer?.length || sourceRate <= 0 || targetRate <= 0 || sourceRate === targetRate) return buffer || Buffer.alloc(0);

  const inputSamples = Math.floor(buffer.length / 2);
  if (!inputSamples) return Buffer.alloc(0);

  const outputSamples = Math.max(1, Math.round(inputSamples * targetRate / sourceRate));
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index++) {
    const sourceIndex = index * sourceRate / targetRate;
    const lowerIndex = Math.min(inputSamples - 1, Math.floor(sourceIndex));
    const upperIndex = Math.min(inputSamples - 1, lowerIndex + 1);
    const ratio = sourceIndex - lowerIndex;
    const lower = buffer.readInt16LE(lowerIndex * 2);
    const upper = buffer.readInt16LE(upperIndex * 2);
    const sample = Math.round(lower + (upper - lower) * ratio);
    output.writeInt16LE(clampPcm16(sample), index * 2);
  }
  return output;
}

function clampPcm16(value) {
  return Math.max(-32768, Math.min(32767, value));
}

module.exports = { createSarvamLive };
