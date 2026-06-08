const { spawn } = require("child_process");
const ffmpegPath = resolveFfmpegPath();

async function toExotelPcmBase64(inputBase64, options = {}) {
  const input = Buffer.from(inputBase64, "base64");
  const sampleRate = normalizeSampleRate(options.sampleRate);
  const volume = normalizeVolume(options.volume);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", String(sampleRate),
    ...(volume === 1 ? [] : ["-filter:a", `volume=${volume}`]),
    "-f", "s16le",
    "pipe:1"
  ];
  const output = await runFfmpeg(input, args);

  return output.toString("base64");
}

function normalizeSampleRate(value) {
  const sampleRate = Number(value || process.env.EXOTEL_MEDIA_SAMPLE_RATE || 8000);
  if ([8000, 16000, 24000].includes(sampleRate)) return sampleRate;
  return 8000;
}

function normalizeVolume(value) {
  const volume = Number(value || process.env.VOICEBOT_TTS_VOLUME || 1.6);
  if (!Number.isFinite(volume) || volume <= 0) return 1;
  return Math.min(volume, 3);
}

function runFfmpeg(input, args) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not available"));

    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];

    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        return reject(new Error(Buffer.concat(stderr).toString("utf8") || `ffmpeg exited with ${code}`));
      }
      resolve(Buffer.concat(stdout));
    });

    child.stdin.end(input);
  });
}

module.exports = { toExotelPcmBase64 };

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}
