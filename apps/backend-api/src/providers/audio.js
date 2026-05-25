const { spawn } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

async function toExotelPcmBase64(inputBase64) {
  const input = Buffer.from(inputBase64, "base64");
  const output = await runFfmpeg(input, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", "8000",
    "-f", "s16le",
    "pipe:1"
  ]);

  return output.toString("base64");
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
