const crypto = require("crypto");
const { query } = require("../db/pool");

const ENABLED = process.env.VOICEBOT_AUDIO_CACHE_ENABLED !== "false";
const MAX_TEXT_CHARS = Number(process.env.VOICEBOT_AUDIO_CACHE_MAX_TEXT_CHARS || 360);
const MAX_PCM_BYTES = Number(process.env.VOICEBOT_AUDIO_CACHE_MAX_PCM_BYTES || 240000);

function buildAudioCacheKey({ text, languageCode, speaker, model, sampleRate, volume }) {
  const normalized = [
    process.env.VOICEBOT_AUDIO_CACHE_VERSION || "v1",
    String(model || ""),
    String(speaker || ""),
    String(languageCode || ""),
    String(sampleRate || ""),
    String(volume || ""),
    normalizeText(text)
  ].join("|");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

async function getCachedAudio(cacheKey) {
  if (!ENABLED || !cacheKey) return null;
  try {
    const result = await query(
      `UPDATE voice_audio_cache
       SET hit_count=hit_count + 1, last_used_at=NOW()
       WHERE cache_key=$1 AND is_active=true
       RETURNING pcm_base64, char_count, model, speaker, language_code, sample_rate, volume`,
      [cacheKey]
    );
    return result.rows[0] || null;
  } catch (err) {
    if (isSchemaMissing(err)) return null;
    throw err;
  }
}

async function saveCachedAudio({ cacheKey, text, languageCode, speaker, model, sampleRate, volume, pcmBase64, mimeType = "audio/pcm", source = "dynamic_tts" }) {
  if (!ENABLED || !cacheKey || !pcmBase64) return false;
  const charCount = charLength(text);
  if (charCount > MAX_TEXT_CHARS) return false;
  if (Buffer.byteLength(pcmBase64, "base64") > MAX_PCM_BYTES) return false;

  try {
    await query(
      `INSERT INTO voice_audio_cache
         (cache_key, text, language_code, speaker, model, sample_rate, volume, mime_type, pcm_base64, char_count, source, last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (cache_key) DO UPDATE SET
         hit_count=voice_audio_cache.hit_count + 1,
         last_used_at=NOW(),
         updated_at=NOW()`,
      [
        cacheKey,
        String(text || ""),
        String(languageCode || ""),
        String(speaker || ""),
        String(model || ""),
        Number(sampleRate || 8000),
        Number(volume || 1),
        mimeType,
        pcmBase64,
        charCount,
        source
      ]
    );
    return true;
  } catch (err) {
    if (isSchemaMissing(err)) return false;
    throw err;
  }
}

function charLength(value) {
  return [...String(value || "")].length;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isSchemaMissing(err) {
  return ["42P01", "42703"].includes(err?.code);
}

module.exports = {
  buildAudioCacheKey,
  charLength,
  getCachedAudio,
  saveCachedAudio
};
