const express = require("express");
const { query } = require("../db/pool");
const { generateReply } = require("../providers/gemini");
const { synthesizeSpeech } = require("../providers/sarvam");
const { inferOutcome, isOptOut } = require("../services/outcomes");
const { getTenantSettings } = require("../services/settings");
const config = require("../config");

const router = express.Router();

router.post("/exotel/status", async (req, res) => {
  const callSid = req.body.CallSid || req.body.Sid;
  const status = req.body.Status || req.body.CallStatus || "unknown";
  const duration = Number(req.body.DialCallDuration || req.body.Duration || 0);

  if (callSid) {
    await query(
      `UPDATE calls SET status=$1, duration_seconds=$2, updated_at=NOW()
       WHERE call_sid=$3`,
      [status === "completed" ? "completed" : status, duration, callSid]
    );
  }
  res.sendStatus(200);
});

router.all("/exotel/answer", async (req, res) => {
  const leadId = req.query.leadId || req.body.leadId;
  const lead = await findLead(leadId);

  if (!lead) return res.type("text/xml").send(`<Response><Say>Lead not found.</Say></Response>`);

  const text = await generateReply({ lead });
  const call = await latestCallForLead(lead.id);

  if (call) await addTranscript(call.id, "assistant", text);

  res.type("text/xml").send(await conversationXml({ text, leadId: lead.id, callId: call?.id }));
});

router.all("/exotel/respond", async (req, res) => {
  const leadId = req.query.leadId || req.body.leadId;
  const lead = await findLead(leadId);

  if (!lead) return res.type("text/xml").send(`<Response><Say>Lead not found.</Say></Response>`);

  const call = await latestCallForLead(lead.id);
  const message = req.body.SpeechResult || req.body.speech || req.body.Digits || req.query.message || "";

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

  const reply = await generateReply({ lead, lastUserMessage: message });
  if (call) {
    await addTranscript(call.id, "assistant", reply);
    await query(
      `UPDATE calls SET outcome=$1, updated_at=NOW() WHERE id=$2`,
      [inferOutcome(message), call.id]
    );
  }

  res.type("text/xml").send(await conversationXml({ text: reply, leadId: lead.id, callId: call?.id }));
});

router.get("/audio/:token", (req, res) => {
  serveAudio(req, res).catch(() => res.sendStatus(404));
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

async function addTranscript(callId, speaker, text) {
  await query(
    `INSERT INTO transcripts (call_id, speaker, text) VALUES ($1,$2,$3)`,
    [callId, speaker, text]
  );
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
  const lead = await findLead(leadId);
  const settings = lead ? await getTenantSettings(lead.tenant_id) : null;
  const disclosure = settings?.aiDisclosure ? `<Say>${escapeXml(settings.aiDisclosure)}</Say>` : "";
  const prompt = await speechTag(text, callId);
  const action = `${config.serverUrl}/webhooks/exotel/respond?leadId=${encodeURIComponent(leadId)}`;
  return `<Response>${disclosure}<Gather input="speech dtmf" timeout="5" action="${escapeXml(action)}" method="POST">${prompt}</Gather><Say>Dhanyavaad.</Say></Response>`;
}

module.exports = router;
