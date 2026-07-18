const express = require("express");
const { query } = require("../db/pool");
const { generateReply, llmProviderStatus } = require("../providers/llm");
const { liveSttProviderStatus } = require("../providers/sttLive");
const { getSarvamHealth } = require("../providers/sarvamHealth");
const { synthesizeSpeech } = require("../providers/sarvam");
const { toExotelPcmBase64 } = require("../providers/audio");
const { transcribeAudioUrl } = require("../providers/deepgram");
const { classifyConversation, isOptOut } = require("../services/outcomes");
const { getTenantSettings } = require("../services/settings");
const config = require("../config");

const router = express.Router();
const FAST_EXOML_GREETING = `Namaste, main ${config.assistantName} ${config.brandName} se bol rahi hoon. Yeh ek test call hai. Dhanyavaad.`;

// Validates EXOTEL_WEBHOOK_SECRET if configured. Exotel cannot sign payloads, so we
// use a shared secret passed as a query param (?secret=...) or X-Webhook-Secret header.
function webhookAuth(req, res, next) {
  const secret = process.env.EXOTEL_WEBHOOK_SECRET;
  if (!secret) return next(); // not configured — allow all (dev/test)
  const provided = req.query.secret || req.headers["x-webhook-secret"] || "";
  if (provided !== secret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

router.post("/exotel/status", webhookAuth, async (req, res) => {
  const body = bodyOf(req);
  const callSid = body.CallSid || body.Sid;
  const status = body.Status || body.CallStatus || "unknown";
  const duration = Number(body.DialCallDuration || body.Duration || 0);
  const customCallId = parseCustomCallId(body.CustomField || body.customField || body.Customfield);

  if (callSid || customCallId) {
    const callResult = await query(
      `UPDATE calls SET status=$1, duration_seconds=$2, call_sid=COALESCE($3, call_sid), updated_at=NOW()
       WHERE ($3::text IS NOT NULL AND call_sid=$3)
          OR ($4::uuid IS NOT NULL AND id=$4)
       RETURNING id, lead_id, campaign_id`,
      [status === "completed" ? "completed" : status, duration, callSid || null, customCallId]
    );
    await logStatusEvent({
      callSid,
      call: callResult.rows[0],
      status,
      duration,
      body
    });
  }
  res.sendStatus(200);
});

router.all("/exotel/answer", webhookAuth, async (req, res) => {
  try {
    const body = bodyOf(req);
    const leadId = req.query.leadId || body.leadId;
    const lead = await findLead(leadId);
    const callSid = body.CallSid || body.Sid || req.query.CallSid || req.query.Sid || "";
    const callId = req.query.callId || body.callId || "";

    if (!lead) return res.type("text/xml").send(`<Response><Say>Lead not found.</Say></Response>`);

    const call = await latestCallForLead(lead.id);
    await logExomlAnswerRequest({
      callSid,
      lead,
      callId: callId || call?.id,
      method: req.method,
      query: req.query,
      body
    });
    const text = process.env.EXOML_DYNAMIC_REPLY === "true"
      ? await safeGenerateReply({ lead }, FAST_EXOML_GREETING)
      : FAST_EXOML_GREETING;

    if (call) await addTranscript(call.id, "assistant", text);

    res.type("text/xml").send(await conversationXml({ text, leadId: lead.id, callId: call?.id }));
  } catch (err) {
    console.error("exotel answer failed", err);
    res.type("text/xml").send(`<Response><Say>${escapeXml(FAST_EXOML_GREETING)}</Say></Response>`);
  }
});

router.all("/exotel/respond", webhookAuth, async (req, res) => {
  const body = bodyOf(req);
  const leadId = req.query.leadId || body.leadId;
  const lead = await findLead(leadId);

  if (!lead) return res.type("text/xml").send(`<Response><Say>Lead not found.</Say></Response>`);

  const call = await latestCallForLead(lead.id);
  const message = await resolveUserMessage(req, { lead, call });

  if (call && message) await addTranscript(call.id, "user", message);

  if (isOptOut(message)) {
    await query(
      `INSERT INTO dnc_list (tenant_id, phone, reason)
       VALUES ($1,$2,'call_opt_out')
       ON CONFLICT (tenant_id, phone) DO UPDATE SET reason='call_opt_out'`,
      [lead.tenant_id, lead.phone]
    );
    if (call) {
      await query(`UPDATE calls SET outcome='OPTED_OUT', status='completed', updated_at=NOW() WHERE id=$1`, [call.id]);
      await addTranscript(call.id, "assistant", "Opt-out acknowledged.");
    }
    return res.type("text/xml").send(`<Response><Say>Samajh gaya. Hum aapko dobara call nahi karenge. Dhanyavaad.</Say></Response>`);
  }

  const promptTranscript = call ? await getTranscript(call.id) : [];
  const reply = await safeGenerateReply({ lead, lastUserMessage: message, transcript: promptTranscript }, "Dhanyavaad. Hum aapse baad mein sampark karenge.");
  if (call) {
    await addTranscript(call.id, "assistant", reply);
    const transcript = await getTranscript(call.id);
    const classification = classifyConversation({ userMessage: message, transcript, playbookType: lead.playbook_type });
    await query(
      `UPDATE calls SET outcome=$1, summary=$2, updated_at=NOW() WHERE id=$3`,
      [classification.outcome, classification.summary, call.id]
    );
  }

  res.type("text/xml").send(await conversationXml({ text: reply, leadId: lead.id, callId: call?.id }));
});

router.get("/audio/:token", (req, res) => {
  serveAudio(req, res).catch(() => res.sendStatus(404));
});

router.get("/exotel/voicebot-health", async (req, res) => {
  const configuredChunkBytes = Number(process.env.EXOTEL_MEDIA_CHUNK_BYTES || 3200);
  const chunkBytes = Number.isFinite(configuredChunkBytes)
    ? Math.floor(Math.min(Math.max(configuredChunkBytes, 320), 100000) / 320) * 320
    : 3200;

  const includeLive = String(req.query.live || "").toLowerCase() === "true";
  const sarvamLive = includeLive
    ? await getSarvamHealth({ force: String(req.query.force || "").toLowerCase() === "true" })
    : null;

  res.status(sarvamLive && !sarvamLive.ok ? 503 : 200).json({
    ok: !sarvamLive || sarvamLive.ok,
    path: "/webhooks/exotel/voicebot",
    pathTokenFormat: "/webhooks/exotel/voicebot/:token",
    wssUrl: `${config.serverUrl.replace(/^http/, "ws")}/webhooks/exotel/voicebot`,
    dynamicUrl: `${config.serverUrl}/webhooks/exotel/voicebot-url`,
    dynamicJsonUrl: `${config.serverUrl}/webhooks/exotel/voicebot-url?format=json`,
    mediaVersion: "2026-06-04-audible-preroll-volume-v1",
    chunkBytes: chunkBytes || 3200,
    introStartMode: process.env.VOICEBOT_INTRO_START_MODE || "first_media",
    firstMediaFallbackMs: Number(process.env.VOICEBOT_FIRST_MEDIA_FALLBACK_MS || 350),
    silenceKeepaliveEnabled: process.env.VOICEBOT_SILENCE_KEEPALIVE_ENABLED === "true",
    introDelayMs: Number(process.env.VOICEBOT_INTRO_DELAY_MS || 0),
    stt: liveSttProviderStatus(),
    llm: llmProviderStatus(),
    deepgramConfigured: Boolean(config.ai.deepgramApiKey),
    geminiConfigured: Boolean(config.ai.geminiApiKey),
    sarvamConfigured: Boolean(config.ai.sarvamApiKey),
    sarvamLive,
    tokenRequired: Boolean(config.voicebotToken)
  });
});

router.get("/exotel/voicebot-preflight", async (req, res) => {
  const force = String(req.query.force || "").toLowerCase() === "true";
  const health = await getSarvamHealth({ force });
  res.status(health.ok ? 200 : 503).json(health);
});

router.all("/exotel/voicebot-url", async (req, res) => {
  const params = { ...req.query, ...bodyOf(req) };
  const lead = await resolveVoicebotLead(params);
  const leadId = params.leadId || lead?.id || "";
  const campaignId = params.campaignId || lead?.campaign_id || "";
  const callId = await latestCallIdForLead(leadId);
  const callSid = params.CallSid || params.callSid || params.Sid || "";

  const wssUrl = new URL(`${config.serverUrl.replace(/^http/, "ws")}/webhooks/exotel/voicebot`);
  if (leadId) wssUrl.searchParams.set("leadId", leadId);
  if (campaignId) wssUrl.searchParams.set("campaignId", campaignId);
  if (callId) wssUrl.searchParams.set("callId", callId);

  await logVoicebotUrlRequest({
    callSid,
    leadId,
    campaignId,
    callId,
    method: req.method,
    params,
    wssUrl: wssUrl.toString()
  });

  const wantsJson = String(params.format || "").toLowerCase() === "json";
  if (wantsJson) return res.json({ url: wssUrl.toString() });
  res.type("text/plain").send(wssUrl.toString());
});

router.get("/exotel/tts-health", async (req, res) => {
  try {
    const speech = await synthesizeSpeech("Namaste, main Sneha TezCredit se bol rahi hoon.");
    let pcmBytes = 0;
    let pcmStats = null;
    if (speech.mode === "audio") {
      const sampleRate = Number(process.env.EXOTEL_MEDIA_SAMPLE_RATE || 8000);
      const pcmBase64 = await toExotelPcmBase64(speech.audioBase64, {
        sampleRate,
        volume: Number(process.env.VOICEBOT_TTS_VOLUME || 1.6)
      });
      const pcm = Buffer.from(pcmBase64, "base64");
      pcmBytes = pcm.length;
      pcmStats = pcm16Stats(pcm);
    }
    res.json({
      ok: speech.mode === "audio",
      mode: speech.mode,
      mimeType: speech.mimeType || null,
      pcmBytes,
      pcmStats
    });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

router.all("/exotel/passthru", async (req, res) => {
  const body = bodyOf(req);
  const callSid = body.CallSid || req.query.CallSid || body.Sid || req.query.Sid || "";
  const callResult = callSid
    ? await query(`SELECT * FROM calls WHERE call_sid=$1 ORDER BY created_at DESC LIMIT 1`, [callSid])
    : { rows: [] };
  const call = callResult.rows[0];
  const escalate = ["DISPUTE", "CALLBACK", "WRONG_NUMBER"].includes(call?.outcome);

  res.json({
    escalate,
    outcome: call?.outcome || "UNKNOWN",
    callId: call?.id || null
  });
});

async function serveAudio(req, res) {
  const result = await query(
    `SELECT * FROM call_audio_cache WHERE token=$1 AND expires_at > NOW()`,
    [req.params.token]
  );
  const audio = result.rows[0];
  if (!audio) return res.sendStatus(404);
  res.setHeader("Content-Type", audio.mime_type);
  res.setHeader("Cache-Control", "no-store");
  res.send(Buffer.from(audio.audio_base64, "base64"));
}

function pcm16Stats(buffer) {
  if (!buffer?.length) return { peak: 0, rms: 0, samples: 0 };
  let peak = 0;
  let sumSquares = 0;
  const samples = Math.floor(buffer.length / 2);
  for (let offset = 0; offset + 1 < buffer.length; offset += 2) {
    const sample = buffer.readInt16LE(offset);
    const abs = Math.abs(sample);
    if (abs > peak) peak = abs;
    sumSquares += sample * sample;
  }
  return {
    peak,
    rms: samples ? Math.round(Math.sqrt(sumSquares / samples)) : 0,
    samples
  };
}

function escapeXml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function findLead(leadId) {
  const leadResult = await query(`SELECT * FROM leads WHERE id=$1`, [leadId]);
  return leadResult.rows[0];
}

async function latestCallForLead(leadId) {
  const result = await query(
    `SELECT * FROM calls WHERE lead_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );
  return result.rows[0];
}

async function latestCallIdForLead(leadId) {
  if (!leadId) return "";
  const call = await latestCallForLead(leadId);
  return call?.id || "";
}

async function resolveVoicebotLead(params) {
  if (params.leadId) return findLead(params.leadId);
  const phone = normalizePhone(params.From || params.from || params.Caller || params.caller || params.CallFrom || params.callFrom);
  if (!phone) return null;
  const result = await query(
    `SELECT * FROM leads
     WHERE RIGHT(phone, 10)=RIGHT($1, 10)
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function addTranscript(callId, speaker, text) {
  // Deduplicate within a 5-second window to guard against retried webhook deliveries.
  const existing = await query(
    `SELECT id FROM transcripts
     WHERE call_id=$1 AND speaker=$2 AND text=$3 AND created_at > NOW() - INTERVAL '5 seconds'
     LIMIT 1`,
    [callId, speaker, text]
  );
  if (existing.rows.length) return;
  await query(
    `INSERT INTO transcripts (call_id, speaker, text) VALUES ($1,$2,$3)`,
    [callId, speaker, text]
  );
}

async function getTranscript(callId) {
  const result = await query(
    `SELECT speaker, text FROM transcripts WHERE call_id=$1 ORDER BY created_at ASC`,
    [callId]
  );
  return result.rows;
}

async function resolveUserMessage(req, { lead, call }) {
  const body = bodyOf(req);
  const directMessage = body.SpeechResult || body.speech || body.TranscriptionText || body.Digits || req.query.message || "";
  if (directMessage) return String(directMessage).trim();

  const audioUrl = body.RecordingUrl || body.RecordingURL || body.AudioUrl || body.AudioURL || req.query.audioUrl || "";
  if (!audioUrl) return "";

  try {
    const result = await transcribeAudioUrl(audioUrl, { language: deepgramLanguage(lead.language) });
    await logSttEvent({
      tenantId: lead.tenant_id,
      callId: call?.id,
      audioUrl,
      transcript: result.transcript,
      confidence: result.confidence,
      status: result.mode
    });
    return result.transcript || "";
  } catch (err) {
    await logSttEvent({
      tenantId: lead.tenant_id,
      callId: call?.id,
      audioUrl,
      status: "failed",
      error: err.message
    });
    return "";
  }
}

async function logSttEvent({ tenantId, callId, audioUrl, transcript = "", confidence = null, status, error = "" }) {
  await query(
    `INSERT INTO call_stt_events (tenant_id, call_id, provider, audio_url, transcript, confidence, status, error)
     VALUES ($1,$2,'deepgram',$3,$4,$5,$6,$7)`,
    [tenantId, callId || null, audioUrl || null, transcript, confidence, status, error || null]
  );
}

function deepgramLanguage(language) {
  const value = String(language || "").toLowerCase();
  if (value.includes("hindi")) return "hi";
  if (value.includes("english")) return "en";
  return process.env.DEEPGRAM_LANGUAGE || "multi";
}

function parseCustomCallId(value) {
  const match = String(value || "").match(/lc_call:([0-9a-fA-F-]{36})/);
  return match ? match[1] : null;
}

async function logStatusEvent({ callSid, call, status, duration, body }) {
  try {
    await query(
      `INSERT INTO voicebot_events (call_sid, lead_id, campaign_id, event_type, details)
       VALUES ($1,$2,$3,'status_callback',$4)`,
      [
        callSid || null,
        call?.lead_id || null,
        call?.campaign_id || null,
        { status, duration, body }
      ]
    );
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }
}

async function logVoicebotUrlRequest({ callSid, leadId, campaignId, callId, method, params, wssUrl }) {
  try {
    await query(
      `INSERT INTO voicebot_events (call_sid, lead_id, campaign_id, event_type, details)
       VALUES ($1,$2,$3,'voicebot_url_requested',$4)`,
      [
        callSid || null,
        leadId || null,
        campaignId || null,
        {
          callId: callId || null,
          method,
          params,
          wssUrl
        }
      ]
    );
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }
}

async function logExomlAnswerRequest({ callSid, lead, callId, method, query: queryParams, body }) {
  try {
    await query(
      `INSERT INTO voicebot_events (call_sid, lead_id, campaign_id, event_type, details)
       VALUES ($1,$2,$3,'exoml_answer_requested',$4)`,
      [
        callSid || null,
        lead?.id || null,
        lead?.campaign_id || null,
        {
          callId: callId || null,
          method,
          query: queryParams,
          body
        }
      ]
    );
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }
}

async function speechTag(text, callId) {
  try {
    const speech = await synthesizeSpeech(text);
    if (speech.mode !== "audio") return `<Say>${escapeXml(text)}</Say>`;

    const result = await query(
      `INSERT INTO call_audio_cache (call_id, mime_type, audio_base64, expires_at)
       VALUES ($1,$2,$3,NOW() + INTERVAL '15 minutes')
       RETURNING token`,
      [callId || null, speech.mimeType, speech.audioBase64]
    );
    const token = result.rows[0].token;

    return `<Play>${escapeXml(config.serverUrl)}/webhooks/audio/${token}</Play>`;
  } catch (e) {
    console.error("TTS failed", e.message);
    return `<Say>${escapeXml(text)}</Say>`;
  }
}

async function conversationXml({ text, leadId, callId }) {
  if (process.env.EXOML_ENABLE_GATHER !== "true") {
    return `<Response><Say>${escapeXml(text)}</Say></Response>`;
  }

  const lead = await findLead(leadId);
  const settings = lead ? await getTenantSettings(lead.tenant_id) : null;
  const disclosure = settings?.aiDisclosure ? `<Say>${escapeXml(settings.aiDisclosure)}</Say>` : "";
  const prompt = process.env.EXOML_USE_SARVAM_AUDIO === "true"
    ? await speechTag(text, callId)
    : `<Say>${escapeXml(text)}</Say>`;
  const action = `${config.serverUrl}/webhooks/exotel/respond?leadId=${encodeURIComponent(leadId)}`;
  return `<Response>${disclosure}<Gather input="speech dtmf" timeout="5" action="${escapeXml(action)}" method="POST">${prompt}</Gather><Say>Dhanyavaad.</Say></Response>`;
}

async function safeGenerateReply(args, fallback) {
  try {
    return await generateReply(args);
  } catch (err) {
    console.error("generate reply failed", err.message);
    return fallback;
  }
}

function bodyOf(req) {
  return req.body && typeof req.body === "object" ? req.body : {};
}

module.exports = router;
