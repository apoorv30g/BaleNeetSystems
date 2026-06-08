const { spawn } = require("child_process");
const ffmpegPath = resolveFfmpegPath();
const WebSocket = require("ws");

const apiKey = process.env.SARVAM_API_KEY;

if (!apiKey) {
  throw new Error("SARVAM_API_KEY is required");
}

const probeText = process.env.SARVAM_STT_PROBE_TEXT || "Namaste hello LoanConnect.";
const languageCode = process.env.SARVAM_STT_LANGUAGE_CODE || "hi-IN";
const model = process.env.SARVAM_STT_MODEL || "saaras:v3";
const mode = process.env.SARVAM_STT_MODE || "codemix";

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }));
  process.exitCode = 1;
});

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

async function main() {
  const tts = await synthesizeProbeAudio(probeText);
  const wav16 = await convertAudio(tts, ["-ac", "1", "-ar", "16000", "-f", "wav", "pipe:1"]);
  const raw16 = await convertAudio(tts, ["-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1"]);
  const wav8 = await convertAudio(tts, ["-ac", "1", "-ar", "8000", "-f", "wav", "pipe:1"]);
  const raw8 = await convertAudio(tts, ["-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"]);

  const variants = [
    {
      name: "wav16_input_wav_msg_audio_wav",
      audio: wav16,
      connectionSampleRate: "16000",
      inputAudioCodec: "wav",
      messageSampleRate: "16000",
      messageEncoding: "audio/wav"
    },
    {
      name: "wav16_no_codec_msg_audio_wav",
      audio: wav16,
      connectionSampleRate: "16000",
      inputAudioCodec: "",
      messageSampleRate: "16000",
      messageEncoding: "audio/wav"
    },
    {
      name: "raw16_input_pcm_msg_audio_wav",
      audio: raw16,
      connectionSampleRate: "16000",
      inputAudioCodec: "pcm_s16le",
      messageSampleRate: "16000",
      messageEncoding: "audio/wav"
    },
    {
      name: "raw16_input_pcm_msg_pcm",
      audio: raw16,
      connectionSampleRate: "16000",
      inputAudioCodec: "pcm_s16le",
      messageSampleRate: "16000",
      messageEncoding: "pcm_s16le"
    },
    {
      name: "wav8_input_wav_msg_16000_audio_wav",
      audio: wav8,
      connectionSampleRate: "8000",
      inputAudioCodec: "wav",
      messageSampleRate: "16000",
      messageEncoding: "audio/wav"
    },
    {
      name: "raw8_input_pcm_msg_16000_audio_wav",
      audio: raw8,
      connectionSampleRate: "8000",
      inputAudioCodec: "pcm_s16le",
      messageSampleRate: "16000",
      messageEncoding: "audio/wav"
    }
  ];

  const results = [];
  for (const variant of variants) {
    results.push(await runVariant(variant));
  }

  console.log(JSON.stringify({
    ok: results.some(result => Boolean(result.transcript)),
    probeText,
    languageCode,
    model,
    mode,
    results
  }, null, 2));
}

async function synthesizeProbeAudio(text) {
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": apiKey
    },
    body: JSON.stringify({
      text,
      target_language_code: process.env.SARVAM_TTS_LANGUAGE || "hi-IN",
      speaker: process.env.SARVAM_TTS_SPEAKER || "shubh",
      model: process.env.SARVAM_TTS_MODEL || "bulbul:v3"
    })
  });

  if (!res.ok) {
    throw new Error(`Sarvam TTS failed: ${await res.text()}`);
  }

  const data = await res.json();
  const audio = data.audio || data.audioContent || data?.data?.audio || (Array.isArray(data.audios) ? data.audios.join("") : "");
  if (!audio) throw new Error("Sarvam TTS returned no audio");
  return Buffer.from(audio, "base64");
}

function convertAudio(input, outputArgs) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not available"));

    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", "pipe:0",
      ...outputArgs
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(Buffer.concat(stderr).toString("utf8") || `ffmpeg exited with ${code}`));
        return;
      }
      resolve(Buffer.concat(stdout));
    });

    child.stdin.end(input);
  });
}

function runVariant(variant) {
  return new Promise(resolve => {
    const params = new URLSearchParams({
      "language-code": languageCode,
      model,
      mode,
      sample_rate: variant.connectionSampleRate,
      high_vad_sensitivity: "true",
      vad_signals: "true",
      flush_signal: "true"
    });
    if (variant.inputAudioCodec) params.set("input_audio_codec", variant.inputAudioCodec);

    const startedAt = Date.now();
    const messages = [];
    let transcript = "";
    let done = false;
    let opened = false;

    const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
      headers: { "Api-Subscription-Key": apiKey }
    });

    const timer = setTimeout(() => finish({ closeCode: null, closeReason: "timeout" }), 8000);

    ws.on("open", () => {
      opened = true;
      ws.send(JSON.stringify({
        audio: {
          data: variant.audio.toString("base64"),
          sample_rate: variant.messageSampleRate,
          encoding: variant.messageEncoding
        }
      }));
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "flush" }));
      }, 250);
    });

    ws.on("message", data => {
      const payload = parseJson(data.toString());
      const summary = summarizeMessage(payload);
      messages.push(summary);
      const text = payload?.data?.transcript || payload?.data?.text || payload?.transcript || payload?.text || "";
      if (text) {
        transcript = String(text).trim();
        finish({ closeCode: null, closeReason: "transcript" });
      }
    });

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", chunk => { body += chunk.toString(); });
      res.on("end", () => finish({
        statusCode: res.statusCode,
        closeCode: null,
        closeReason: body.slice(0, 300) || `unexpected_response_${res.statusCode}`
      }));
    });

    ws.on("error", err => finish({ closeCode: null, closeReason: err.message }));
    ws.on("close", (code, reason) => finish({ closeCode: code, closeReason: reason?.toString() || "" }));

    function finish(extra) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve({
        name: variant.name,
        opened,
        transcript,
        elapsedMs: Date.now() - startedAt,
        audioBytes: variant.audio.length,
        connectionSampleRate: variant.connectionSampleRate,
        inputAudioCodec: variant.inputAudioCodec || null,
        messageSampleRate: variant.messageSampleRate,
        messageEncoding: variant.messageEncoding,
        messages,
        ...extra
      });
    }
  });
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

function summarizeMessage(payload) {
  return {
    type: payload?.type || "",
    signalType: payload?.data?.signal_type || payload?.signal_type || "",
    transcript: payload?.data?.transcript || payload?.data?.text || payload?.transcript || payload?.text || "",
    error: payload?.data?.error || payload?.error || "",
    code: payload?.data?.code || payload?.code || ""
  };
}
