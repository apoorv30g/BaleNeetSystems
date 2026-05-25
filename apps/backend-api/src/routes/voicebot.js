const { WebSocketServer } = require("ws");
const { query } = require("../db/pool");
const { generateReply } = require("../providers/gemini");
const { synthesizeSpeech } = require("../providers/sarvam");
const { toExotelPcmBase64 } = require("../providers/audio");
const { createDeepgramLive } = require("../providers/deepgramLive");
const { inferOutcome, isOptOut } = require("../services/outcomes");
const logger = require("../utils/logger");
const config = require("../config");

function attachVoicebot(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname !== "/webhooks/exotel/voicebot") return;
    if (config.voicebotToken && url.searchParams.get("token") !== config.voicebotToken) {
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
      stt: null,
      speaking: false,
      closed: false,
      mediaChunks: 0,
      bytesReceived: 0,
      startedAt: Date.now()
    };

    logger.info("voicebot_connected", { leadId: session.leadId, campaignId: session.campaignId });

    ws.on("message", data => handleMessage(ws, session, data).catch(err => {
      logger.error("voicebot_message_failed", { error: err.message, leadId: session.leadId });
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
    });
  });
}

async function handleMessage(ws, session, data) {
  const message = parseMessage(data);
  const event = String(message.event || message.Event || "").toLowerCase();

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
  const callSid = session.callSid || message?.start?.callSid || message?.start?.call_sid || message?.CallSid || "";
  session.callSid = callSid;

  if (!session.leadId && message?.start?.customParameters?.leadId) {
    session.leadId = message.start.customParameters.leadId;
  }
  if (!session.campaignId && message?.start?.customParameters?.campaignId) {
    session.campaignId = message.start.customParameters.campaignId;
  }

  if (!session.leadId) return;

  const leadResult = await query(`SELECT * FROM leads WHERE id=$1`, [session.leadId]);
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
}

async function speakIntro(ws, session) {
  if (!session.leadId) return;

  const lead = session.lead || (await query(`SELECT * FROM leads WHERE id=$1`, [session.leadId])).rows[0];
  if (!lead) return;

  const text = await generateReply({ lead });
  if (session.callId) await addTranscript(session.callId, "assistant", text);

  await speakText(ws, session, text, "intro_played");
}

function startStt(ws, session) {
  if (!session.lead || session.stt) return;

  session.stt = createDeepgramLive({
    language: deepgramLanguage(session.lead.language),
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
    await query(`UPDATE calls SET outcome=$1, updated_at=NOW() WHERE id=$2`, [inferOutcome(text), session.callId]);
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
      sendMedia(ws, pcmBase64);
      sendMark(ws, markName);
      return;
    }
    sendMark(ws, `${markName}_text_only`);
  } catch (err) {
    logger.warn("voicebot_tts_failed", { error: err.message, leadId: session.leadId });
    sendMark(ws, `${markName}_tts_failed`);
  } finally {
    session.speaking = false;
  }
}

function sendMedia(ws, audioBase64) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "media",
    media: { payload: audioBase64 }
  }));
}

function deepgramLanguage(language) {
  const value = String(language || "").toLowerCase();
  if (value.includes("hindi")) return "hi";
  if (value.includes("english")) return "en";
  return process.env.DEEPGRAM_LANGUAGE || "multi";
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

module.exports = { attachVoicebot };
