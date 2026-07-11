const { spawn } = require("node:child_process");
const path = require("node:path");
const WebSocket = require("ws");

const ffmpegPath = require("ffmpeg-static");
const apiKey = process.env.SARVAM_API_KEY;

if (!apiKey) {
  console.error("SARVAM_API_KEY is required");
  process.exit(1);
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error("Usage: node scripts/transcribe-local-audio.js <audio-file> [...]");
  process.exit(1);
}

const languageCode = process.env.SARVAM_STT_LANGUAGE_CODE || "hi-IN";
const model = process.env.SARVAM_STT_MODEL || "saaras:v3";
const mode = process.env.SARVAM_STT_MODE || "codemix";
const sampleRate = process.env.SARVAM_STT_SAMPLE_RATE || "16000";
const chunkBytes = Number(process.env.SARVAM_STT_FILE_CHUNK_BYTES || 32000);
const compact = process.env.TRANSCRIBE_COMPACT === "true";

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message }, null, 2));
  process.exit(1);
});

async function main() {
  const results = [];
  for (const file of files) {
    const startedAt = Date.now();
    try {
      const wav = await convertToWav(file);
      const transcript = await transcribeWav(wav);
      results.push({
        ok: Boolean(transcript.text),
        file: path.basename(file),
        path: file,
        audioBytes: wav.length,
        elapsedMs: Date.now() - startedAt,
        ...transcript
      });
    } catch (err) {
      results.push({
        ok: false,
        file: path.basename(file),
        path: file,
        elapsedMs: Date.now() - startedAt,
        error: err.message
      });
    }
  }

  console.log(JSON.stringify({
    ok: results.some(result => result.ok),
    provider: "sarvam",
    model,
    mode,
    languageCode,
    sampleRate,
    results
  }, null, 2));
}

function convertToWav(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner",
      "-loglevel", "error",
      "-i", file,
      "-ac", "1",
      "-ar", sampleRate,
      "-f", "wav",
      "pipe:1"
    ], { stdio: ["ignore", "pipe", "pipe"] });

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
  });
}

function transcribeWav(audio) {
  return new Promise(resolve => {
    const params = new URLSearchParams({
      "language-code": languageCode,
      model,
      mode,
      sample_rate: sampleRate,
      input_audio_codec: "wav",
      high_vad_sensitivity: "true",
      vad_signals: "true",
      flush_signal: "true"
    });

    const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
      headers: { "Api-Subscription-Key": apiKey }
    });

    const messages = [];
    const transcripts = [];
    let done = false;
    const startedAt = Date.now();
    const timeout = setTimeout(() => finish({ closeReason: "timeout" }), 20000);

    ws.on("open", async () => {
      for (let offset = 0; offset < audio.length; offset += chunkBytes) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const chunk = audio.subarray(offset, offset + chunkBytes);
        ws.send(JSON.stringify({
          audio: {
            data: chunk.toString("base64"),
            sample_rate: sampleRate,
            encoding: "audio/wav"
          }
        }));
        await sleep(40);
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "flush" }));
        setTimeout(() => finish({ closeReason: "flushed" }), 2500);
      }
    });

    ws.on("message", data => {
      const payload = parseJson(data.toString());
      const text = String(payload?.data?.transcript || payload?.data?.text || payload?.transcript || payload?.text || "").trim();
      const summary = {
        type: payload?.type || "",
        signalType: payload?.data?.signal_type || payload?.signal_type || "",
        transcript: text,
        isFinal: payload?.data?.is_final ?? payload?.is_final ?? null,
        error: payload?.data?.error || payload?.error || ""
      };
      messages.push(summary);
      if (text) transcripts.push(text);
    });

    ws.on("unexpected-response", (req, res) => {
      let body = "";
      res.on("data", chunk => { body += chunk.toString(); });
      res.on("end", () => finish({
        statusCode: res.statusCode,
        closeReason: body.slice(0, 500) || `unexpected_response_${res.statusCode}`
      }));
    });
    ws.on("error", err => finish({ closeReason: err.message }));
    ws.on("close", (code, reason) => finish({ closeCode: code, closeReason: reason?.toString() || "" }));

    function finish(extra = {}) {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve({
        text: mergeTranscripts(transcripts),
        transcripts,
        messages: compact ? undefined : messages,
        sttElapsedMs: Date.now() - startedAt,
        ...extra
      });
    }
  });
}

function mergeTranscripts(items) {
  const result = [];
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text) continue;
    if (result[result.length - 1] === text) continue;
    result.push(text);
  }
  return result.join(" ").replace(/\s+/g, " ").trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
