const { spawn } = require("child_process");
const WebSocket = require("ws");
const config = require("../config");
const { query } = require("../db/pool");

const DEFAULT_TRAINING_LIMIT = Number(process.env.TRAINING_DAILY_BATCH_LIMIT || 25);
const MAX_PROMPT_EXAMPLES = Number(process.env.TRAINING_PROMPT_EXAMPLE_LIMIT || 8);
const SARVAM_FILE_TIMEOUT_MS = Number(process.env.SARVAM_STT_FILE_TIMEOUT_MS || 60000);
const SARVAM_FILE_CHUNK_BYTES = Number(process.env.SARVAM_STT_FILE_CHUNK_BYTES || 32000);

async function storeTrainingRecording({ tenantId, uploadedBy, file, notes = "" }) {
  if (!file?.buffer?.length) {
    const err = new Error("Recording file is required");
    err.status = 400;
    throw err;
  }

  const result = await query(
    `INSERT INTO voice_training_recordings
      (tenant_id, uploaded_by, filename, mime_type, size_bytes, notes, audio_data, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'uploaded')
     RETURNING id, filename, mime_type, size_bytes, notes, status, created_at`,
    [
      tenantId,
      uploadedBy || null,
      file.originalname || "recording",
      file.mimetype || "application/octet-stream",
      file.size || file.buffer.length,
      notes || null,
      file.buffer
    ]
  );

  return result.rows[0];
}

async function listTrainingRecordings(tenantId) {
  const [recordings, examples] = await Promise.all([
    query(
      `SELECT id, filename, mime_type, size_bytes, notes, status, transcript,
              analysis, error, trained_at, deleted_at, created_at, updated_at,
              audio_data IS NOT NULL AS has_audio
       FROM voice_training_recordings
       WHERE tenant_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [tenantId]
    ),
    listTrainingExamples(tenantId, { limit: 20 })
  ]);

  const summary = recordings.rows.reduce((acc, row) => {
    acc.total += 1;
    acc[row.status] = (acc[row.status] || 0) + 1;
    if (row.has_audio) acc.rawAudioRetained += 1;
    return acc;
  }, { total: 0, rawAudioRetained: 0 });

  return { recordings: recordings.rows, examples, summary };
}

async function runTrainingBatch({ tenantId = null, limit = DEFAULT_TRAINING_LIMIT } = {}) {
  const params = [];
  let where = "status='uploaded' AND audio_data IS NOT NULL";
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id=$${params.length}`;
  }
  params.push(limit);

  const pending = await query(
    `SELECT id, tenant_id, filename, mime_type, audio_data, notes
     FROM voice_training_recordings
     WHERE ${where}
     ORDER BY created_at ASC
     LIMIT $${params.length}`,
    params
  );

  const results = [];
  for (const recording of pending.rows) {
    results.push(await processTrainingRecording(recording));
  }

  return {
    ok: results.every(result => result.ok),
    processed: results.length,
    trained: results.filter(result => result.ok).length,
    failed: results.filter(result => !result.ok).length,
    results
  };
}

async function processTrainingRecording(recording) {
  await query(
    `UPDATE voice_training_recordings
     SET status='training', error=NULL
     WHERE id=$1`,
    [recording.id]
  );

  try {
    const transcriptResult = await transcribeAudioBuffer(recording.audio_data, {
      filename: recording.filename,
      mimeType: recording.mime_type
    });
    const transcript = transcriptResult.text;
    if (!transcript) throw new Error("No transcript returned from Sarvam STT");
    const analysis = extractTrainingInsights(transcript, { filename: recording.filename, notes: recording.notes });
    const insertedExamples = await upsertTrainingExamples({
      tenantId: recording.tenant_id,
      recordingId: recording.id,
      examples: analysis.examples
    });

    await query(
      `UPDATE voice_training_recordings
       SET status='trained',
           transcript=$2,
           analysis=$3::jsonb,
           error=NULL,
           trained_at=NOW()
       WHERE id=$1`,
      [
        recording.id,
        transcript,
        JSON.stringify({ ...analysis, stt: transcriptResult.metadata, insertedExamples })
      ]
    );

    return { ok: true, id: recording.id, filename: recording.filename, examples: insertedExamples, transcriptChars: transcript.length };
  } catch (err) {
    await query(
      `UPDATE voice_training_recordings
       SET status='failed', error=$2
       WHERE id=$1`,
      [recording.id, err.message]
    );
    return { ok: false, id: recording.id, filename: recording.filename, error: err.message };
  }
}

async function cleanupRawRecordings({ tenantId = null } = {}) {
  const params = [];
  let where = "audio_data IS NOT NULL AND status <> 'training'";
  if (tenantId) {
    params.push(tenantId);
    where += ` AND tenant_id=$${params.length}`;
  }

  const result = await query(
    `UPDATE voice_training_recordings
     SET audio_data=NULL,
         deleted_at=NOW(),
         status=CASE WHEN status='uploaded' THEN 'deleted_untrained' ELSE status END,
         error=CASE WHEN status='uploaded' THEN COALESCE(error, 'Raw recording deleted before scheduled training ran') ELSE error END
     WHERE ${where}
     RETURNING id, filename, status`,
    params
  );

  return { deleted: result.rowCount, recordings: result.rows };
}

async function listTrainingExamples(tenantId, { limit = 50 } = {}) {
  const result = await query(
    `SELECT id, intent_key, user_phrase, recommended_reply, language, confidence,
            source_recording_id, created_at, updated_at
     FROM voice_training_examples
     WHERE tenant_id=$1 AND is_active=true
     ORDER BY updated_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows;
}

async function getTrainingExamplesForPrompt(tenantId, { limit = MAX_PROMPT_EXAMPLES } = {}) {
  if (!tenantId) return "";
  const examples = await listTrainingExamples(tenantId, { limit });
  if (!examples.length) return "";

  return examples
    .map(example => `- If customer says "${example.user_phrase}", handle as ${example.intent_key}: ${example.recommended_reply}`)
    .join("\n");
}

async function upsertTrainingExamples({ tenantId, recordingId, examples }) {
  let inserted = 0;
  for (const example of examples || []) {
    await query(
      `INSERT INTO voice_training_examples
        (tenant_id, source_recording_id, intent_key, normalized_phrase, user_phrase, recommended_reply, language, confidence, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
       ON CONFLICT (tenant_id, intent_key, normalized_phrase)
       DO UPDATE SET
         source_recording_id=EXCLUDED.source_recording_id,
         user_phrase=EXCLUDED.user_phrase,
         recommended_reply=EXCLUDED.recommended_reply,
         language=EXCLUDED.language,
         confidence=GREATEST(voice_training_examples.confidence, EXCLUDED.confidence),
         is_active=true,
         updated_at=NOW()`,
      [
        tenantId,
        recordingId,
        example.intentKey,
        normalizePhrase(example.userPhrase),
        example.userPhrase,
        example.recommendedReply,
        example.language || "Hinglish",
        example.confidence || 0.6
      ]
    );
    inserted++;
  }
  return inserted;
}

function extractTrainingInsights(transcript, context = {}) {
  const text = String(transcript || "").replace(/\s+/g, " ").trim();
  const examples = [];
  const matchedIntents = [];

  for (const rule of INTENT_RULES) {
    const phrase = findMatchedPhrase(text, rule.patterns);
    if (!phrase) continue;
    matchedIntents.push(rule.key);
    examples.push({
      intentKey: rule.key,
      userPhrase: phrase,
      recommendedReply: rule.recommendedReply,
      language: rule.language || "Hinglish",
      confidence: rule.confidence || 0.7
    });
  }

  if (text && !examples.length) {
    examples.push({
      intentKey: "general_conversation_style",
      userPhrase: firstUsefulSentence(text),
      recommendedReply: "Answer the latest question first, keep the reply under 20 spoken words, then ask one clear next-step question.",
      language: "Hinglish",
      confidence: 0.45
    });
  }

  return {
    source: "uploaded_recording",
    filename: context.filename || "",
    notes: context.notes || "",
    transcriptChars: text.length,
    matchedIntents,
    examples
  };
}

function findMatchedPhrase(text, patterns) {
  if (!text) return "";
  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    if (patterns.some(pattern => pattern.test(sentence))) return trimPhrase(sentence);
  }
  if (patterns.some(pattern => pattern.test(text))) return trimPhrase(firstUsefulSentence(text));
  return "";
}

function splitSentences(text) {
  return String(text || "")
    .split(/[\n.!?।]+/)
    .map(item => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function firstUsefulSentence(text) {
  return splitSentences(text).find(sentence => sentence.length >= 8) || String(text || "").slice(0, 160);
}

function trimPhrase(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= 160) return text;
  return `${text.slice(0, 157).trim()}...`;
}

function normalizePhrase(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

async function transcribeAudioBuffer(input, { filename = "", mimeType = "" } = {}) {
  if (!config.ai.sarvamApiKey) {
    throw new Error("SARVAM_API_KEY is required to train from recordings");
  }

  const wav = await convertToWav(input);
  const stt = await transcribeWav(wav);
  return {
    text: stt.text,
    metadata: {
      provider: "sarvam",
      filename,
      mimeType,
      inputBytes: input.length,
      wavBytes: wav.length,
      ...stt.metadata
    }
  };
}

function convertToWav(input) {
  return runFfmpeg(input, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", "pipe:0",
    "-ac", "1",
    "-ar", String(process.env.SARVAM_STT_FILE_SAMPLE_RATE || process.env.SARVAM_STT_SAMPLE_RATE || 16000),
    "-f", "wav",
    "pipe:1"
  ]);
}

function transcribeWav(audio) {
  return new Promise(resolve => {
    const sampleRate = String(process.env.SARVAM_STT_FILE_SAMPLE_RATE || process.env.SARVAM_STT_SAMPLE_RATE || 16000);
    const params = new URLSearchParams({
      "language-code": process.env.SARVAM_STT_LANGUAGE_CODE || "hi-IN",
      model: process.env.SARVAM_STT_MODEL || "saaras:v3",
      mode: process.env.SARVAM_STT_MODE || "codemix",
      sample_rate: sampleRate,
      input_audio_codec: "wav",
      high_vad_sensitivity: process.env.SARVAM_STT_HIGH_VAD_SENSITIVITY || "true",
      vad_signals: process.env.SARVAM_STT_VAD_SIGNALS || "true",
      flush_signal: "true"
    });

    const ws = new WebSocket(`wss://api.sarvam.ai/speech-to-text/ws?${params.toString()}`, {
      headers: { "Api-Subscription-Key": config.ai.sarvamApiKey }
    });

    const transcripts = [];
    const messages = [];
    let done = false;
    let opened = false;
    const startedAt = Date.now();
    const timer = setTimeout(() => finish({ closeReason: "timeout" }), SARVAM_FILE_TIMEOUT_MS);

    ws.on("open", async () => {
      opened = true;
      for (let offset = 0; offset < audio.length; offset += SARVAM_FILE_CHUNK_BYTES) {
        if (ws.readyState !== WebSocket.OPEN) break;
        const chunk = audio.subarray(offset, offset + SARVAM_FILE_CHUNK_BYTES);
        ws.send(JSON.stringify({
          audio: {
            data: chunk.toString("base64"),
            sample_rate: sampleRate,
            encoding: "audio/wav"
          }
        }));
        await sleep(Number(process.env.SARVAM_STT_FILE_CHUNK_DELAY_MS || 30));
      }
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "flush" }));
        setTimeout(() => finish({ closeReason: "flushed" }), Number(process.env.SARVAM_STT_FILE_FLUSH_WAIT_MS || 3000));
      }
    });

    ws.on("message", data => {
      const payload = parseJson(data.toString());
      const text = String(payload?.data?.transcript || payload?.data?.text || payload?.transcript || payload?.text || "").trim();
      messages.push({
        type: payload?.type || "",
        signalType: payload?.data?.signal_type || payload?.signal_type || "",
        transcript: text
      });
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
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      resolve({
        text: mergeTranscripts(transcripts),
        metadata: {
          opened,
          elapsedMs: Date.now() - startedAt,
          messageCount: messages.length,
          transcriptCount: transcripts.length,
          ...extra
        }
      });
    }
  });
}

function mergeTranscripts(items) {
  const merged = [];
  for (const item of items) {
    const text = String(item || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const previous = merged[merged.length - 1] || "";
    if (previous === text || previous.endsWith(text)) continue;
    merged.push(text);
  }
  return merged.join(" ").replace(/\s+/g, " ").trim();
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: String(text || "").slice(0, 500) };
  }
}

function runFfmpeg(input, args) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) return reject(new Error("ffmpeg binary not available"));

    const child = spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] });
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

function resolveFfmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const INTENT_RULES = [
  {
    key: "amount_query",
    patterns: [/\b(how much|amount|loan amount|eligible amount|offer amount|kitna|kitni)\b/iu, /(कितना|कितनी|रकम|अमाउंट|लोन राशि)/u],
    recommendedReply: "Answer using the imported offer_amount or loan_amount only. If amount is missing, say the final amount is visible after login on www.tezcredit.com.",
    confidence: 0.85
  },
  {
    key: "more_amount_request",
    patterns: [/\b(more amount|higher amount|zyada|jada|amount badha)\b/iu, /(ज्यादा|अधिक|और पैसा|बढ़ा)/u],
    recommendedReply: "Say: pehle current approved amount complete kar lijiye; repayment and eligibility ke baad higher amount ke liye apply kar sakte hain.",
    confidence: 0.84
  },
  {
    key: "website_help",
    patterns: [/\b(website|site|tezcredit\.com|open|apply now|login|log in)\b/iu, /(वेबसाइट|साइट|लॉगिन|लॉग इन|खोल)/u],
    recommendedReply: "Guide to open www.tezcredit.com, tap Apply Now, login with mobile number, and never ask for OTP on the call.",
    confidence: 0.78
  },
  {
    key: "not_visible_or_stuck",
    patterns: [/\b(not visible|can't see|cannot see|stuck|nothing showing|screen)\b/iu, /(नहीं दिख|दिख नहीं|अटक|स्क्रीन)/u],
    recommendedReply: "Ask which screen they see now. Do not mark interested or complete until the pending step is actually visible or completed.",
    confidence: 0.78
  },
  {
    key: "legitimacy_or_source",
    patterns: [/\b(who are you|from where|is this genuine|fraud|scam|safe)\b/iu, /(कौन|कहाँ से|सही है|फ्रॉड|सुरक्षित|सेफ)/u],
    recommendedReply: "Say you are Sneha calling from TezCredit about their loan application. Ask them to verify only on www.tezcredit.com and never share OTP/PIN/password.",
    confidence: 0.82
  },
  {
    key: "interest_fee_emi",
    patterns: [/\b(interest|fee|charges|emi|penalty)\b/iu, /(ब्याज|फीस|चार्ज|ई एम आई|ईएमआई|पेनल्टी)/u],
    recommendedReply: "Do not invent rates or fees. Say exact terms are shown on the final offer screen after login, then guide them to the pending step.",
    confidence: 0.8
  },
  {
    key: "busy_or_decline",
    patterns: [/\b(busy|later|not now|no time|call later)\b/iu, /(अभी नहीं|बाद में|व्यस्त|समय नहीं)/u],
    recommendedReply: "If they are busy or negative, explain the purpose in one short line, offer a callback once, then close politely if they still decline.",
    confidence: 0.75
  },
  {
    key: "language_switch",
    patterns: [/\b(english|hindi|speak in|language)\b/iu, /(अंग्रेजी|इंग्लिश|हिंदी|भाषा)/u],
    recommendedReply: "Switch language immediately and continue the same journey step. Do not restart the script.",
    confidence: 0.76
  },
  {
    key: "step_completed",
    patterns: [/\b(done|complete|completed|ho gaya|submit|submitted)\b/iu, /(हो गया|कर दिया|पूरा)/u],
    recommendedReply: "Acknowledge, ask if the website now shows the next pending step, then continue to that step instead of repeating the same instruction.",
    confidence: 0.8
  }
];

module.exports = {
  cleanupRawRecordings,
  extractTrainingInsights,
  getTrainingExamplesForPrompt,
  listTrainingExamples,
  listTrainingRecordings,
  runTrainingBatch,
  storeTrainingRecording,
  _test: { extractTrainingInsights, normalizePhrase }
};
