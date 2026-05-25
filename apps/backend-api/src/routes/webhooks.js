const express = require("express");
const { query } = require("../db/pool");
const { generateReply } = require("../providers/gemini");
const { synthesizeSpeech } = require("../providers/sarvam");

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
  const leadResult = await query(`SELECT * FROM leads WHERE id=$1`, [leadId]);
  const lead = leadResult.rows[0];

  if (!lead) return res.type("text/xml").send(`<Response><Say>Lead not found.</Say></Response>`);

  const text = await generateReply({ lead });
  try { await synthesizeSpeech(text); } catch (e) { console.error("TTS failed", e.message); }

  await query(
    `INSERT INTO transcripts (call_id, speaker, text)
     SELECT c.id, 'assistant', $1 FROM calls c
     WHERE c.lead_id=$2 ORDER BY c.created_at DESC LIMIT 1`,
    [text, lead.id]
  );

  res.type("text/xml").send(`<Response><Say>${escapeXml(text)}</Say></Response>`);
});

function escapeXml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

module.exports = router;
