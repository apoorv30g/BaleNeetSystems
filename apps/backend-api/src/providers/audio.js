const { spawn } = require("child_process");
const ffmpegPath = resolveFfmpegPath();

async function toExotelPcmBase64(inputBase64, options = {}) {
  const input = Buffer.from(inputBase64, "base64");
  const sampleRate = normalizeSampleRate(options.sampleRate);
  const volume = normalizeVolume(options.volume);

  const nativePcm = toNativeExotelPcm(input, { sampleRate, volume });
  if (nativePcm) return nativePcm.toString("base64");

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

function toNativeExotelPcm(input, options = {}) {
  const wav = parseWav(input);
  if (!wav) {
    // Sarvam normally returns WAV, but accept raw 16-bit mono PCM as a last
    // mile fallback so Railway does not need an ffmpeg binary for telephony.
    if (input.length > 0 && input.length % 2 === 0) return applyVolumeToPcm16(input, options.volume);
    return null;
  }

  const samples = decodeWavSamples(wav);
  if (!samples.length) return null;
  const resampled = wav.sampleRate === options.sampleRate
    ? samples
    : resampleLinear(samples, wav.sampleRate, options.sampleRate);
  return encodePcm16(resampled, options.volume);
}

function parseWav(input) {
  if (input.length < 44) return null;
  if (input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= input.length) {
    const id = input.toString("ascii", offset, offset + 4);
    const size = input.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(start + size, input.length);

    if (id === "fmt " && size >= 16) {
      fmt = {
        audioFormat: input.readUInt16LE(start),
        channels: input.readUInt16LE(start + 2),
        sampleRate: input.readUInt32LE(start + 4),
        bitsPerSample: input.readUInt16LE(start + 14)
      };
    } else if (id === "data") {
      data = input.subarray(start, end);
    }

    offset = start + size + (size % 2);
  }

  if (!fmt || !data || !fmt.channels || !fmt.sampleRate || !fmt.bitsPerSample) return null;
  if (![1, 3].includes(fmt.audioFormat)) return null;
  return { ...fmt, data };
}

function decodeWavSamples(wav) {
  const bytesPerSample = wav.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) return [];
  const frameSize = bytesPerSample * wav.channels;
  const frameCount = Math.floor(wav.data.length / frameSize);
  const samples = new Float32Array(frameCount);

  for (let frame = 0; frame < frameCount; frame++) {
    let mixed = 0;
    for (let channel = 0; channel < wav.channels; channel++) {
      const offset = (frame * frameSize) + (channel * bytesPerSample);
      mixed += readSample(wav.data, offset, wav.bitsPerSample, wav.audioFormat);
    }
    samples[frame] = mixed / wav.channels;
  }

  return samples;
}

function readSample(buffer, offset, bitsPerSample, audioFormat) {
  if (audioFormat === 3 && bitsPerSample === 32) return clamp(buffer.readFloatLE(offset), -1, 1);
  if (bitsPerSample === 8) return (buffer.readUInt8(offset) - 128) / 128;
  if (bitsPerSample === 16) return buffer.readInt16LE(offset) / 32768;
  if (bitsPerSample === 24) return buffer.readIntLE(offset, 3) / 8388608;
  if (bitsPerSample === 32) return buffer.readInt32LE(offset) / 2147483648;
  return 0;
}

function resampleLinear(samples, sourceRate, targetRate) {
  if (!samples.length || sourceRate <= 0 || targetRate <= 0) return samples;
  const targetLength = Math.max(1, Math.round(samples.length * (targetRate / sourceRate)));
  const output = new Float32Array(targetLength);
  const ratio = sourceRate / targetRate;

  for (let i = 0; i < targetLength; i++) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const fraction = sourceIndex - left;
    output[i] = samples[left] + ((samples[right] - samples[left]) * fraction);
  }

  return output;
}

function encodePcm16(samples, volume = 1) {
  const output = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.round(clamp(samples[i] * volume, -1, 1) * 32767);
    output.writeInt16LE(value, i * 2);
  }
  return output;
}

function applyVolumeToPcm16(input, volume = 1) {
  if (volume === 1) return input;
  const output = Buffer.alloc(input.length);
  for (let offset = 0; offset + 1 < input.length; offset += 2) {
    const value = Math.round(clamp((input.readInt16LE(offset) / 32768) * volume, -1, 1) * 32767);
    output.writeInt16LE(value, offset);
  }
  return output;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(max, Math.max(min, value));
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
