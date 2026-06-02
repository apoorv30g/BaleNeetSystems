const { WebSocketServer } = require("ws");
const { query } = require("../db/pool");
const { generateReply } = require("../providers/gemini");
const { synthesizeSpeech } = require("../providers/sarvam");
const { toExotelPcmBase64 } = require("../providers/audio");
const { createDeepgramLive } = require("../providers/deepgramLive");
const { classifyConversation, isOptOut } = require("../services/outcomes");
const logger = require("../utils/logger");
const config = require("../config");

function attachVoicebot(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (!url.pathname.startsWith("/webhooks/exotel/voicebot")) return;

    const pathToken = url.pathname
      .replace("/webhooks/exotel/voicebot", "")
      .split("/")
      .filter(Boolean)[0];
    const providedToken = url.searchParams.get("token") || pathToken || "";

    if (config.voicebotToken && providedToken !== config.voicebotToken) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit("connection", ws, req, url);
    });
  });

  wss.on("connection", (ws, req, url) => {
    const session = {
      leadId: url.searchParams.get("leadId"),
      campaignId: url.searchParams.get("campaignId"),
      callSid: url.searchParams.get("callSid") || "",
      callId: null,
      tenantId: null,
      lead: null,
      callerPhone: "",
      calledPhone: "",
      stt: null,
      speaking: false,
      closed: false,
      mediaChunks: 0,
      bytesReceived: 0,
      startedAt: Date.now()
    };

    logger.info("voicebot_connected", { leadId: session.leadId, campaignId: session.campaignId });
    logVoicebotEvent(session, "ws_connected", { url: req.url, remoteAddress: req.socket.remoteAddress }).catch(() => {});

    ws.on("message", data => handleMessage(ws, session, data).catch(err => {
      logger.error("voicebot_message_failed", { error: err.message, leadId: session.leadId });
      logVoicebotEvent(session, "message_failed", { error: err.message }).catch(() => {});
    }));

    ws.on("close", () => {
      session.closed = true;
      session.stt?.close();
      logger.info("voicebot_closed", {
        leadId: session.leadId,
        callId: session.callId,
        mediaChunks: session.mediaChunks,
        bytesReceived: session.bytesReceived,
        durationMs: Date.now() - session.startedAt
      });
      logVoicebotEvent(session, "ws_closed", {
        mediaChunks: session.mediaChunks,
        bytesReceived: session.bytesReceived,
        durationMs: Date.now() - session.startedAt
      }).catch(() => {});
    });
  });
}

async function handleMessage(ws, session, data) {
  const message = parseMessage(data);
  const event = String(message.event || message.Event || "").toLowerCase();
  await logVoicebotEvent(session, event || "unknown_message", summarizeMessage(message));

  if (event === "connected") {
    sendMark(ws, "connected");
    return;
  }

  if (event === "start") {
    await initializeSession(session, message);
    startStt(ws, session);
    await speakIntro(ws, session);
    return;
  }

  if (event === "media") {
    const payload = message?.media?.payload || message?.Media?.Payload || message.payload || "";
    if (payload) {
      session.mediaChunks++;
      const audio = Buffer.from(payload, "base64");
      session.bytesReceived += audio.length;
      session.stt?.sendAudio(audio);
    }
    return;
  }

  if (event === "dtmf") {
    const digit = message?.dtmf?.digit || message?.digits || message?.Digit || "";
    if (session.callId && digit) await addTranscript(session.callId, "user", `DTMF:${digit}`);
    sendMark(ws, `dtmf_${digit || "unknown"}`);
    return;
  }

  if (event === "clear") {
    sendMark(ws, "context_cleared");
    return;
  }

  if (event === "stop") {
    ws.close();
  }
}

function parseMessage(data) {
  try {
    return JSON.parse(data.toString());
  } catch {
    return {};
  }
}

async function initializeSession(session, message) {
  const callSid = session.callSid
    || pick(message, ["start.callSid", "start.call_sid", "start.call_sid", "CallSid", "callSid", "Sid"])
    || "";
  session.callSid = callSid;
  await logVoicebotEvent(session, "start_received", { callSid, rawKeys: Object.keys(message || {}) });

  const customParameters = message?.start?.customParameters || message?.start?.custom_parameters || message?.customParameters || {};

  if (!session.leadId && customParameters.leadId) {
    session.leadId = customParameters.leadId;
  }
  if (!session.campaignId && customParameters.campaignId) {
    session.campaignId = customParameters.campaignId;
  }

  session.callerPhone = normalizePhone(pick(message, [
    "start.from",
    "start.caller",
    "start.callFrom",
    "start.call_from",
    "From",
    "Caller",
    "CallFrom"
  ]));
  session.calledPhone = normalizePhone(pick(message, [
    "start.to",
    "start.called",
    "start.callTo",
    "start.call_to",
    "To",
    "Called",
    "CallTo"
  ]));

  if (!session.leadId) {
    const matchedLead = await findLatestLeadByPhone(session.callerPhone || session.calledPhone);
    if (matchedLead) {
      session.leadId = matchedLead.id;
      session.lead = matchedLead;
      session.campaignId = session.campaignId || matchedLead.campaign_id;
    }
  }

  if (!session.leadId) {
    logger.warn("voicebot_started_without_lead", {
      callSid,
      callerPhone: session.callerPhone,
      calledPhone: session.calledPhone
    });
    await logVoicebotEvent(session, "started_without_lead", {
      callerPhone: session.callerPhone,
      calledPhone: session.calledPhone
    });
    return;
  }

  const leadResult = session.lead ? { rows: [session.lead] } : await query(`SELECT * FROM leads WHERE id=$1`, [session.leadId]);
  const lead = leadResult.rows[0];
  if (!lead) return;

  session.tenantId = lead.tenant_id;
  session.lead = lead;

  const callResult = await query(
    `INSERT INTO calls (tenant_id, campaign_id, lead_id, call_sid, status)
     VALUES ($1,$2,$3,$4,'streaming')
     RETURNING *`,
    [lead.tenant_id, session.campaignId || lead.campaign_id, lead.id, callSid || null]
  );
  session.callId = callResult.rows[0].id;
  await logVoicebotEvent(session, "lead_matched", { leadId: lead.id, campaignId: session.campaignId || lead.campaign_id });
}

async function speakIntro(ws, session) {
  if (!session.leadId) {
    await speakText(
      ws,
      session,
      "Namaste, LoanConnect se AI assistant bol raha hoon. Kya aap abhi loan eligibility ke baare mein baat kar sakte hain?",
      "generic_intro_played"
    );
    return;
  }

  const lead = session.lead || (await query(`SELECT * FROM leads WHERE id=$1`, [session.leadId])).rows[0];
  if (!lead) {
    await speakText(ws, session, "Namaste, LoanConnect se AI assistant bol raha hoon. Kya aap abhi baat kar sakte hain?", "fallback_intro_played");
    return;
  }

  const text = await generateReply({ lead });
  if (session.callId) await addTranscript(session.callId, "assistant", text);

  await speakText(ws, session, text, "intro_played");
}

function startStt(ws, session) {
  if (session.stt) return;

  session.stt = createDeepgramLive({
    language: deepgramLanguage(session.lead?.language),
    onTranscript: event => handleTranscript(ws, session, event).catch(err => {
      logger.error("voicebot_transcript_failed", { error: err.message, callId: session.callId });
    }),
    onError: err => logger.warn("voicebot_stt_failed", { error: err.message, callId: session.callId })
  });
}

async function handleTranscript(ws, session, event) {
  if (!event.isFinal && !event.speechFinal) return;
  const text = event.transcript.trim();
  if (!text || session.speaking) return;

  if (!session.lead) {
    await speakText(ws, session, "Dhanyavaad. Main aapki baat note kar raha hoon. LoanConnect team aapki request process karegi.", "generic_reply_played");
    return;
  }

  if (session.callId) {
    await addTranscript(session.callId, "user", text);
    await query(
      `INSERT INTO call_stt_events (tenant_id, call_id, provider, transcript, confidence, status)
       VALUES ($1,$2,'deepgram-live',$3,$4,'completed')`,
      [session.tenantId, session.callId, text, event.confidence]
    );
  }

  if (isOptOut(text)) {
    await query(
      `INSERT INTO dnc_list (tenant_id, phone, reason)
       VALUES ($1,$2,'call_opt_out')
       ON CONFLICT (tenant_id, phone) DO UPDATE SET reason='call_opt_out'`,
      [session.tenantId, session.lead.phone]
    );
    if (session.callId) await query(`UPDATE calls SET outcome='OPTED_OUT', status='completed', updated_at=NOW() WHERE id=$1`, [session.callId]);
    await speakText(ws, session, "Samajh gaya. Hum aapko dobara call nahi karenge. Dhanyavaad.", "opt_out");
    ws.close();
    return;
  }

  const reply = await generateReply({ lead: session.lead, lastUserMessage: text });
  if (session.callId) {
    await addTranscript(session.callId, "assistant", reply);
    const transcript = await getTranscript(session.callId);
    const classification = classifyConversation({ userMessage: text, transcript, playbookType: session.lead.playbook_type });
    await query(
      `UPDATE calls SET outcome=$1, summary=$2, updated_at=NOW() WHERE id=$3`,
      [classification.outcome, classification.summary, session.callId]
    );
  }

  await speakText(ws, session, reply, "reply_played");
}

async function speakText(ws, session, text, markName) {
  if (ws.readyState !== ws.OPEN || session.closed) return;
  session.speaking = true;
  try {
    const speech = await synthesizeSpeech(text);
    if (speech.mode === "audio") {
      const pcmBase64 = await toExotelPcmBase64(speech.audioBase64);
      const chunks = await sendMedia(ws, pcmBase64);
      await logVoicebotEvent(session, "media_sent", { markName, chunks, pcmBytes: Buffer.from(pcmBase64, "base64").length });
      sendMark(ws, markName);
      return;
    }
    sendMark(ws, `${markName}_text_only`);
  } catch (err) {
    logger.warn("voicebot_tts_failed", { error: err.message, leadId: session.leadId });
    await logVoicebotEvent(session, "tts_failed", { error: err.message, markName });
    sendMark(ws, `${markName}_tts_failed`);
  } finally {
    session.speaking = false;
  }
}

async function sendMedia(ws, audioBase64) {
  if (ws.readyState !== ws.OPEN) return 0;
  const audio = Buffer.from(audioBase64, "base64");
  const chunkBytes = Number(process.env.EXOTEL_MEDIA_CHUNK_BYTES || 1600);
  const delayMs = Number(process.env.EXOTEL_MEDIA_CHUNK_DELAY_MS || 100);
  let chunks = 0;

  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    if (ws.readyState !== ws.OPEN) break;
    const payload = audio.subarray(offset, offset + chunkBytes).toString("base64");
    ws.send(JSON.stringify({ event: "media", media: { payload } }));
    chunks++;
    if (offset + chunkBytes < audio.length) await sleep(delayMs);
  }

  return chunks;
}

function deepgramLanguage(language) {
  const value = String(language || "").toLowerCase();
  if (value.includes("hindi")) return "hi";
  if (value.includes("english")) return "en";
  return process.env.DEEPGRAM_LANGUAGE || "multi";
}

function pick(obj, paths) {
  for (const path of paths) {
    const value = path.split(".").reduce((acc, key) => acc?.[key], obj);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

async function findLatestLeadByPhone(phone) {
  if (!phone) return null;
  const result = await query(
    `SELECT * FROM leads
     WHERE RIGHT(phone, 10)=RIGHT($1, 10)
     ORDER BY created_at DESC LIMIT 1`,
    [phone]
  );
  return result.rows[0] || null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function summarizeMessage(message) {
  const event = String(message.event || message.Event || "").toLowerCase();
  const start = message.start || message.Start || {};
  if (event === "media") {
    const payload = message?.media?.payload || message?.Media?.Payload || message.payload || "";
    return { event, payloadBytes: payload ? Buffer.from(payload, "base64").length : 0 };
  }
  return {
    event,
    keys: Object.keys(message || {}),
    callSid: start.callSid || start.call_sid || message.CallSid || message.Sid || "",
    from: start.from || start.caller || message.From || message.Caller || "",
    to: start.to || start.called || message.To || message.Called || ""
  };
}

async function logVoicebotEvent(session, eventType, details = {}) {
  try {
    await query(
      `INSERT INTO voicebot_events (call_sid, lead_id, campaign_id, event_type, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        session.callSid || details.callSid || null,
        session.leadId || null,
        session.campaignId || null,
        eventType || "unknown",
        details
      ]
    );
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }
}

function sendMark(ws, name) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "mark",
    mark: { name }
  }));
}

async function addTranscript(callId, speaker, text) {
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

module.exports = { attachVoicebot };
