const { WebSocketServer } = require("ws");
const { query } = require("../db/pool");
const { generateReply } = require("../providers/llm");
const { synthesizeSpeech } = require("../providers/sarvam");
const { toExotelPcmBase64 } = require("../providers/audio");
const { createLiveStt } = require("../providers/sttLive");
const { classifyConversation, isOptOut, isTerminalIntent, terminalOutcome } = require("../services/outcomes");
const logger = require("../utils/logger");
const config = require("../config");
const { sendLeadLink } = require("../providers/notifications");

const FAST_INTRO_TEXT = process.env.VOICEBOT_FAST_INTRO_TEXT || "Namaste, LoanConnect se AI assistant. Kya aap mujhe sun paa rahe hain?";
const FAST_ACK_TEXTS = parseVoicebotTexts(process.env.VOICEBOT_FAST_ACK_TEXTS || process.env.VOICEBOT_FAST_ACK_TEXT || "Okay.|Got it.|Sure.|Haan ji.|Theek hai.|Samjha.");
const FAST_ACK_TEXT = FAST_ACK_TEXTS[0] || "Haan ji.";
const FAST_CLARIFY_TEXT = process.env.VOICEBOT_FAST_CLARIFY_TEXT || "Sorry, awaaz clear nahi aayi. Ek baar phir bolenge?";
const NO_SPEECH_PROMPT_TEXT = process.env.VOICEBOT_NO_SPEECH_PROMPT_TEXT || "Hello, are you able to hear me? Main line par hoon.";
const NO_SPEECH_GOODBYE_TEXT = process.env.VOICEBOT_NO_SPEECH_GOODBYE_TEXT || "I could not hear you, so I am ending this call. Thank you.";
const INTRO_DELAY_MS = Number(process.env.VOICEBOT_INTRO_DELAY_MS || 0);
const SILENCE_KEEPALIVE_ENABLED = process.env.VOICEBOT_SILENCE_KEEPALIVE_ENABLED === "true";
const FAST_ACK_ENABLED = process.env.VOICEBOT_FAST_ACK_ENABLED !== "false";
const NO_SPEECH_TIMEOUT_ENABLED = process.env.VOICEBOT_NO_SPEECH_TIMEOUT_ENABLED !== "false";
const NO_SPEECH_PROMPT_MS = Number(process.env.VOICEBOT_NO_SPEECH_PROMPT_MS || 9000);
const NO_SPEECH_END_MS = Number(process.env.VOICEBOT_NO_SPEECH_END_MS || 22000);
const MIN_TRANSCRIPT_CONFIDENCE = Number(process.env.VOICEBOT_MIN_TRANSCRIPT_CONFIDENCE || 0.62);
const LOW_CONFIDENCE_MAX_WORDS = Number(process.env.VOICEBOT_LOW_CONFIDENCE_MAX_WORDS || 3);
const INTERIM_TRANSCRIPT_ENABLED = process.env.VOICEBOT_INTERIM_TRANSCRIPT_ENABLED !== "false";
const INTERIM_TRANSCRIPT_DELAY_MS = Number(process.env.VOICEBOT_INTERIM_TRANSCRIPT_DELAY_MS || 1200);
const INTERIM_TRANSCRIPT_FORCE_MS = Number(process.env.VOICEBOT_INTERIM_TRANSCRIPT_FORCE_MS || 2600);
const INTERIM_TRANSCRIPT_MIN_WORDS = Number(process.env.VOICEBOT_INTERIM_TRANSCRIPT_MIN_WORDS || 2);
const INTERIM_TRANSCRIPT_MIN_CHARS = Number(process.env.VOICEBOT_INTERIM_TRANSCRIPT_MIN_CHARS || 5);
const STT_DURING_ASSISTANT_ENABLED = process.env.VOICEBOT_STT_DURING_ASSISTANT_ENABLED === "true";
const TTS_PREROLL_MS = Number(process.env.VOICEBOT_TTS_PREROLL_MS || 300);
const VOICEBOT_MEDIA_VERSION = "2026-06-04-audible-preroll-volume-v1";
const INTRO_START_MODE = process.env.VOICEBOT_INTRO_START_MODE || "first_media";
const pcmCache = new Map();

function attachVoicebot(server) {
  const wss = new WebSocketServer({ noServer: true });
  prewarmAudio(FAST_INTRO_TEXT).catch(err => logger.warn("voicebot_prewarm_failed", { error: err.message }));
  for (const ackText of FAST_ACK_TEXTS) {
    prewarmAudio(ackText).catch(err => logger.warn("voicebot_ack_prewarm_failed", { error: err.message, ackText }));
  }
  prewarmAudio(FAST_CLARIFY_TEXT).catch(err => logger.warn("voicebot_clarify_prewarm_failed", { error: err.message }));
  prewarmAudio(NO_SPEECH_PROMPT_TEXT).catch(err => logger.warn("voicebot_no_speech_prompt_prewarm_failed", { error: err.message }));
  prewarmAudio(NO_SPEECH_GOODBYE_TEXT).catch(err => logger.warn("voicebot_no_speech_goodbye_prewarm_failed", { error: err.message }));

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
      requestedCallId: url.searchParams.get("callId"),
      callSid: url.searchParams.get("callSid") || "",
      streamSid: "",
      callId: null,
      tenantId: null,
      lead: null,
      mediaFormat: null,
      mediaSampleRate: 8000,
      callerPhone: "",
      calledPhone: "",
      preferredLanguage: "",
      stt: null,
      sttAudioChunks: 0,
      sttAudioBytes: 0,
      sttAudioSkippedChunks: 0,
      speaking: false,
      closed: false,
      mediaChunks: 0,
      bytesReceived: 0,
      outboundSequence: 1,
      outboundChunk: 1,
      userTurns: 0,
      interimStartedAt: 0,
      interimTimer: null,
      interimCount: 0,
      pendingTranscript: null,
      lastProcessedTranscript: null,
      ending: false,
      introTimer: null,
      noSpeechPromptTimer: null,
      noSpeechEndTimer: null,
      introStarted: false,
      startedAt: Date.now()
    };

    logger.info("voicebot_connected", { leadId: session.leadId, campaignId: session.campaignId });
    logVoicebotEvent(session, "ws_connected", { url: req.url, remoteAddress: req.socket.remoteAddress }).catch(() => {});

    ws.on("message", data => handleMessage(ws, session, data).catch(err => {
      logger.error("voicebot_message_failed", { error: err.message, leadId: session.leadId });
      logVoicebotEvent(session, "message_failed", { error: err.message }).catch(() => {});
    }));

    ws.on("close", (code, reason) => {
      session.closed = true;
      if (session.introTimer) clearTimeout(session.introTimer);
      clearInterimTimer(session);
      clearNoSpeechTimers(session);
      session.stt?.close();
      markCallCompleted(session).catch(err => logger.warn("voicebot_close_status_update_failed", {
        error: err.message,
        callId: session.callId
      }));
      logger.info("voicebot_closed", {
        leadId: session.leadId,
        callId: session.callId,
        code,
        reason: reason?.toString(),
        mediaChunks: session.mediaChunks,
        bytesReceived: session.bytesReceived,
        durationMs: Date.now() - session.startedAt
      });
      logVoicebotEvent(session, "ws_closed", {
        code,
        reason: reason?.toString(),
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
  if (event !== "media") {
    await logVoicebotEvent(session, event || "unknown_message", summarizeMessage(message));
  }

  if (event === "connected") {
    return;
  }

  if (event === "start") {
    await initializeSession(session, message);
    startStt(ws, session);
    if (INTRO_START_MODE === "first_media") {
      scheduleIntro(ws, session, Number(process.env.VOICEBOT_FIRST_MEDIA_FALLBACK_MS || 350));
    } else {
      scheduleIntro(ws, session, INTRO_DELAY_MS);
    }
    return;
  }

  if (event === "media") {
    const payload = message?.media?.payload || message?.Media?.Payload || message.payload || "";
    if (payload) {
      session.mediaChunks++;
      const audio = Buffer.from(payload, "base64");
      session.bytesReceived += audio.length;
      if (session.mediaChunks === 1 || session.mediaChunks % 100 === 0) {
        await logVoicebotEvent(session, "media", {
          payloadBytes: audio.length,
          mediaChunks: session.mediaChunks,
          bytesReceived: session.bytesReceived
        });
      }
      if (INTRO_START_MODE === "first_media" && !session.introStarted) {
        startIntro(ws, session, "first_media");
      }
      const shouldForwardToStt = STT_DURING_ASSISTANT_ENABLED || !session.speaking;
      if (shouldForwardToStt) {
        session.sttAudioChunks++;
        session.sttAudioBytes += audio.length;
        if (session.sttAudioChunks === 1 || session.sttAudioChunks % 100 === 0) {
          logVoicebotEvent(session, "stt_audio_forwarded", {
            payloadBytes: audio.length,
            sttAudioChunks: session.sttAudioChunks,
            sttAudioBytes: session.sttAudioBytes,
            sttProvider: session.stt?.provider || "",
            sttReady: Boolean(session.stt?.ready),
            speaking: session.speaking
          }).catch(() => {});
        }
        session.stt?.sendAudio(audio);
      } else {
        session.sttAudioSkippedChunks++;
        if (session.sttAudioSkippedChunks === 1 || session.sttAudioSkippedChunks % 100 === 0) {
          logVoicebotEvent(session, "stt_audio_skipped_during_assistant", {
            payloadBytes: audio.length,
            sttAudioSkippedChunks: session.sttAudioSkippedChunks,
            speaking: session.speaking
          }).catch(() => {});
        }
      }
    }
    return;
  }

  if (event === "dtmf") {
    const digit = message?.dtmf?.digit || message?.digits || message?.Digit || "";
    if (session.callId && digit) await addTranscript(session.callId, "user", `DTMF:${digit}`);
    sendMark(ws, session, `dtmf_${digit || "unknown"}`);
    return;
  }

  if (event === "clear") {
    sendMark(ws, session, "context_cleared");
    return;
  }

  if (event === "stop") {
    if (session.callId) {
      await query(`UPDATE calls SET status='completed', updated_at=NOW() WHERE id=$1 AND status='streaming'`, [session.callId]);
    }
    ws.close();
  }
}

function scheduleIntro(ws, session, delayMs = INTRO_DELAY_MS) {
  if (session.introTimer) clearTimeout(session.introTimer);

  if (delayMs <= 0) {
    startIntro(ws, session, "immediate");
    return;
  }

  session.introTimer = setTimeout(() => {
    session.introTimer = null;
    startIntro(ws, session, "timer");
  }, delayMs);

  logVoicebotEvent(session, "intro_scheduled", { delayMs, mode: INTRO_START_MODE }).catch(() => {});
}

function startIntro(ws, session, trigger) {
  if (session.introStarted || session.closed || ws.readyState !== ws.OPEN) return;
  session.introStarted = true;
  if (session.introTimer) {
    clearTimeout(session.introTimer);
    session.introTimer = null;
  }

  logVoicebotEvent(session, "intro_started", { trigger, mode: INTRO_START_MODE }).catch(() => {});
  speakIntro(ws, session).catch(err => {
    logger.error("voicebot_intro_failed", { error: err.message, callId: session.callId });
    logVoicebotEvent(session, "intro_failed", { error: err.message }).catch(() => {});
  });
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
  session.streamSid = pick(message, ["stream_sid", "streamSid", "start.stream_sid", "start.streamSid"]) || session.streamSid;
  session.mediaFormat = message?.start?.media_format || message?.start?.mediaFormat || message?.media_format || null;
  session.mediaSampleRate = normalizeMediaSampleRate(
    session.mediaFormat?.sample_rate || session.mediaFormat?.sampleRate || message?.start?.sample_rate || message?.start?.sampleRate
  );
  await logVoicebotEvent(session, "start_received", {
    callSid,
    rawKeys: Object.keys(message || {}),
    streamSid: session.streamSid,
    mediaFormat: session.mediaFormat,
    mediaSampleRate: session.mediaSampleRate
  });

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
  session.preferredLanguage = normalizePreferredLanguage(lead.language);
  session.campaignId = session.campaignId || lead.campaign_id;

  const callResult = session.requestedCallId
    ? await query(
      `UPDATE calls
       SET call_sid=COALESCE($1, call_sid),
           status='streaming',
           updated_at=NOW()
       WHERE id=$2 AND tenant_id=$3 AND lead_id=$4
       RETURNING *`,
      [callSid || null, session.requestedCallId, lead.tenant_id, lead.id]
    )
    : { rows: [] };
  let reuseMode = callResult.rows[0] ? "requested_call_id" : "";

  if (!callResult.rows[0]) {
    const matchedPlaceholder = await query(
      `UPDATE calls
       SET call_sid=COALESCE($1, call_sid),
           status='streaming',
           updated_at=NOW()
       WHERE id=(
         SELECT id FROM calls
         WHERE tenant_id=$2
           AND lead_id=$3
           AND campaign_id=$4
           AND status IN ('initiated','dialing','queued')
           AND created_at > NOW() - INTERVAL '20 minutes'
         ORDER BY created_at DESC
         LIMIT 1
       )
       RETURNING *`,
      [callSid || null, lead.tenant_id, lead.id, session.campaignId]
    );
    callResult.rows = matchedPlaceholder.rows;
    if (callResult.rows[0]) reuseMode = "latest_outbound_placeholder";
  }

  if (!callResult.rows[0]) {
    const inserted = await query(
      `INSERT INTO calls (tenant_id, campaign_id, lead_id, call_sid, status)
       VALUES ($1,$2,$3,$4,'streaming')
       RETURNING *`,
      [lead.tenant_id, session.campaignId, lead.id, callSid || null]
    );
    callResult.rows = inserted.rows;
    reuseMode = "inserted_streaming_call";
  }

  session.callId = callResult.rows[0].id;
  await logVoicebotEvent(session, "lead_matched", {
    leadId: lead.id,
    callId: session.callId,
    reusedCall: reuseMode !== "inserted_streaming_call",
    reuseMode,
    campaignId: session.campaignId
  });
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

  const text = firstGreeting(lead);
  if (session.callId) await addTranscript(session.callId, "assistant", text);

  await speakText(ws, session, text, "intro_played");
  scheduleNoSpeechCheck(ws, session, "after_intro");
}

function startStt(ws, session) {
  if (session.stt) return;

  session.stt = createLiveStt({
    leadLanguage: session.lead?.language,
    onOpen: details => logVoicebotEvent(session, "stt_open", details).catch(() => {}),
    onClose: details => logVoicebotEvent(session, "stt_closed", details).catch(() => {}),
    onStatus: status => {
      if (status.type === "SpeechStarted") {
        clearNoSpeechTimers(session);
      }
      if ([
        "ConnectAttempt",
        "ReconnectAttempt",
        "UnexpectedResponse",
        "SpeechStarted",
        "UtteranceEnd",
        "FallbackStarted",
        "ProviderUnavailable",
        "FallbackUnavailable",
        "OpenTimeout"
      ].includes(status.type)) {
        logVoicebotEvent(session, "stt_status", status).catch(() => {});
      }
    },
    onTranscript: event => handleTranscript(ws, session, event).catch(err => {
      logger.error("voicebot_transcript_failed", { error: err.message, callId: session.callId });
    }),
    onError: (err, meta = {}) => {
      logger.warn("voicebot_stt_failed", { error: err.message, callId: session.callId, provider: meta.provider });
      logVoicebotEvent(session, "stt_error", { error: err.message, ...meta }).catch(() => {});
    }
  });
}

async function handleTranscript(ws, session, event) {
  const text = event.transcript.trim();
  if (!text) return;
  clearNoSpeechTimers(session);

  if (!event.isFinal && !event.speechFinal) {
    trackInterimTranscript(ws, session, event);
    return;
  }

  clearInterimTimer(session);
  if (session.speaking) {
    schedulePendingTranscript(ws, session, { ...event, transcript: text, source: "final_during_speech" }, 250);
    return;
  }

  await processUserTranscript(ws, session, { ...event, transcript: text, source: "final" });
}

function trackInterimTranscript(ws, session, event) {
  if (!INTERIM_TRANSCRIPT_ENABLED) return;
  const text = event.transcript.trim();
  const wordCount = transcriptWordCount(text);
  if (text.length < INTERIM_TRANSCRIPT_MIN_CHARS || wordCount < INTERIM_TRANSCRIPT_MIN_WORDS) return;

  const now = Date.now();
  session.interimStartedAt = session.interimStartedAt || now;
  session.interimCount++;
  if (session.interimCount === 1 || session.interimCount % 10 === 0) {
    logVoicebotEvent(session, "transcript_interim_seen", {
      text,
      confidence: event.confidence,
      wordCount,
      interimCount: session.interimCount
    }).catch(() => {});
  }

  const forceReady = now - session.interimStartedAt >= INTERIM_TRANSCRIPT_FORCE_MS;
  schedulePendingTranscript(
    ws,
    session,
    { ...event, transcript: text, isFinal: false, speechFinal: false, source: forceReady ? "interim_forced" : "interim_timeout" },
    forceReady ? 0 : INTERIM_TRANSCRIPT_DELAY_MS
  );
}

function schedulePendingTranscript(ws, session, event, delayMs) {
  clearInterimTimer(session);
  session.pendingTranscript = event;
  session.interimTimer = setTimeout(() => {
    session.interimTimer = null;
    const pending = session.pendingTranscript;
    session.pendingTranscript = null;
    if (!pending || session.closed || ws.readyState !== ws.OPEN) return;
    if (session.speaking) {
      schedulePendingTranscript(ws, session, pending, 250);
      return;
    }
    processUserTranscript(ws, session, pending).catch(err => {
      logger.error("voicebot_pending_transcript_failed", { error: err.message, callId: session.callId });
    });
  }, Math.max(0, delayMs));
}

function clearInterimTimer(session) {
  if (session.interimTimer) {
    clearTimeout(session.interimTimer);
    session.interimTimer = null;
  }
  session.pendingTranscript = null;
}

async function processUserTranscript(ws, session, event) {
  const text = event.transcript.trim();
  if (!text) return;
  if (session.ending) return;
  if (isRecentlyProcessedTranscript(session, text)) return;
  const sttProvider = liveSttEventProvider(event);
  session.interimStartedAt = 0;
  session.interimCount = 0;
  if (session.speaking) return;
  const turnStartedAt = Date.now();
  await logVoicebotEvent(session, "transcript_final", {
    text,
    confidence: event.confidence,
    words: event.words,
    languages: event.languages,
    isFinal: event.isFinal,
    speechFinal: event.speechFinal,
    source: event.source || "final"
  });

  if (isLikelyMisheardTranscript(text, event)) {
    await logVoicebotEvent(session, "transcript_low_confidence", {
      text,
      confidence: event.confidence,
      wordCount: transcriptWordCount(text),
      threshold: MIN_TRANSCRIPT_CONFIDENCE,
      words: event.words
    });
    if (session.callId) {
      await query(
        `INSERT INTO call_stt_events (tenant_id, call_id, provider, transcript, confidence, status)
         VALUES ($1,$2,$3,$4,$5,'ignored_low_confidence')`,
        [session.tenantId, session.callId, sttProvider, text, event.confidence]
      );
    }
    await speakText(ws, session, FAST_CLARIFY_TEXT, "clarify_low_confidence");
    scheduleNoSpeechCheck(ws, session, "after_clarify");
    return;
  }

  if (!session.lead) {
    await speakText(ws, session, "Dhanyavaad. Main aapki baat note kar raha hoon. LoanConnect team aapki request process karegi.", "generic_reply_played");
    return;
  }

  if (session.callId) {
    await addTranscript(session.callId, "user", text);
    await query(
      `INSERT INTO call_stt_events (tenant_id, call_id, provider, transcript, confidence, status)
       VALUES ($1,$2,$3,$4,$5,'completed')`,
      [session.tenantId, session.callId, sttProvider, text, event.confidence]
    );
  }
  session.userTurns++;

  const languageSwitch = detectLanguageSwitch(text);
  if (languageSwitch) {
    session.preferredLanguage = languageSwitch.language;
    session.lead = { ...session.lead, language: languageSwitch.language };
    await logVoicebotEvent(session, "language_switched", {
      text,
      language: languageSwitch.language,
      reason: languageSwitch.reason
    });
    const reply = languageSwitchReply(languageSwitch.language, session.lead);
    if (session.callId) await addTranscript(session.callId, "assistant", reply);
    await speakText(ws, session, reply, "language_switch_played");
    scheduleNoSpeechCheck(ws, session, "after_language_switch");
    return;
  }

  if (isOptOut(text)) {
    session.ending = true;
    await query(
      `INSERT INTO dnc_list (tenant_id, phone, reason)
       VALUES ($1,$2,'call_opt_out')
       ON CONFLICT (tenant_id, phone) DO UPDATE SET reason='call_opt_out'`,
      [session.tenantId, session.lead.phone]
    );
    const closingText = "समझ गया। हम आपको दोबारा call नहीं करेंगे। धन्यवाद।";
    if (session.callId) {
      await addTranscript(session.callId, "assistant", closingText);
      await finalizeCall(session, {
        outcome: "OPTED_OUT",
        summary: `Latest user response: "${text.slice(0, 180)}". User opted out of future calls.`
      });
    }
    await speakAndClose(ws, session, closingText, "opt_out");
    return;
  }

  if (isTerminalIntent(text)) {
    session.ending = true;
    const outcome = terminalOutcome(text);
    const closingText = terminalClosingText(outcome);
    if (session.callId) {
      await addTranscript(session.callId, "assistant", closingText);
      const classification = classifyConversation({
        userMessage: text,
        transcript: await getTranscript(session.callId),
        playbookType: session.lead.playbook_type
      });
      await finalizeCall(session, {
        outcome: outcome === "IN_PROGRESS" ? classification.outcome : outcome,
        summary: classification.summary
      });
    }
    await logVoicebotEvent(session, "terminal_intent", { text, outcome });
    await speakAndClose(ws, session, closingText, "terminal_close");
    return;
  }

  const promptTranscript = session.callId ? await getTranscript(session.callId) : [];
  const scriptedReply = buildScriptedReply(session, text);
  const replyPromise = scriptedReply
    ? Promise.resolve(scriptedReply)
    : safeGenerateReply(session, { lead: session.lead, lastUserMessage: text, transcript: promptTranscript });
  const ackText = pickAckText(session);
  if (FAST_ACK_ENABLED && ackText) {
    await speakText(ws, session, ackText, "ack_played");
  }

  const reply = await replyPromise;
  await logVoicebotEvent(session, "reply_ready", {
    elapsedMs: Date.now() - turnStartedAt,
    textBytes: Buffer.byteLength(reply),
    source: scriptedReply ? "scripted" : "llm"
  });
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
  scheduleNoSpeechCheck(ws, session, "after_reply");
}

function isRecentlyProcessedTranscript(session, text) {
  const key = normalizeTranscript(text);
  const now = Date.now();
  if (session.lastProcessedTranscript?.key === key && now - session.lastProcessedTranscript.at < 8000) {
    return true;
  }
  session.lastProcessedTranscript = { key, at: now };
  return false;
}

function buildScriptedReply(session, text) {
  const lead = session.lead;
  const normalized = normalizeVoiceIntent(text);
  const amount = lead.offer_amount || lead.loan_amount || "";
  const amountText = amount ? `₹${amount}` : "eligible amount";
  const english = isEnglishSession(session);

  if (mentionsMissingLink(normalized)) {
    queueLeadLink(session, "missing_link");
    if (english) return "Sure, I am sending the secure link again. Please open it and check your final offer in two minutes.";
    return "ठीक है, मैं सुरक्षित link दोबारा भेज रहा हूँ। कृपया उसे खोलकर दो मिनट में final offer check कर लीजिए।";
  }

  if (mentionsLinkReceived(normalized)) {
    if (english) return "Great. Please open the same secure link and check your final offer. I am on the line.";
    return "बहुत अच्छा। अब उसी link को खोलकर final offer check कर लीजिए। मैं line पर हूँ।";
  }

  if (isPositiveAgreement(normalized)) {
    queueLeadLink(session, "user_agreed");
    if (lead.playbook_type === "UNAPPROVED_USERS") {
      if (english) return "Sure, I am sending the secure link. Please open it and check your documents and final eligibility.";
      return "ठीक है, मैं सुरक्षित link भेज रहा हूँ। उसे खोलकर documents और final eligibility दो मिनट में check कर लीजिए।";
    }
    if (lead.playbook_type === "APPROVED_USERS") {
      if (english) return "Sure, I am sending the secure link. Please open it to continue your loan offer.";
      return "ठीक है, मैं सुरक्षित link भेज रहा हूँ। आपका offer आगे बढ़ाने के लिए उसे खोल लीजिए।";
    }
    if (english) return "Sure, I am sending the secure link. Please open it and complete the next step.";
    return "ठीक है, मैं सुरक्षित link भेज रहा हूँ। कृपया उसे खोलकर आगे का step पूरा कर लीजिए।";
  }

  if (asksAmount(normalized)) {
    if (english) return `Your eligibility shows up to ${amountText}. The final amount will be confirmed after checking details in the app.`;
    return `आपकी eligibility ${amountText} तक दिख रही है। Final amount app में details check करने के बाद confirm होगा।`;
  }

  if (asksReason(normalized)) {
    if (english) return "Your loan eligibility is still incomplete, so I called to help you check the final offer.";
    return "आपकी loan eligibility अधूरी दिख रही है, इसलिए यह call है। मैं सिर्फ final offer check करने में मदद कर रहा हूँ।";
  }

  if (asksQuestion(normalized)) {
    if (english) return "Sure, please ask. I will answer briefly and then help you check the final offer.";
    return "हाँ, पूछिए। मैं आपकी बात समझकर छोटा सा जवाब दूँगा, फिर final offer check करवा दूँगा।";
  }

  return "";
}

function detectLanguageSwitch(text) {
  const normalized = normalizeVoiceIntent(text);
  if (/(speak|talk|reply|respond|continue|switch).*(english|angrezi|inglish)|english (mein|me|please)|in english|i don t understand|i do not understand|don t understand hindi|don't understand hindi|language samajh|भाषा समझ|हिंदी समझ नहीं|हिन्दी समझ नहीं|english बोल|अंग्रेजी बोल|अंग्रेज़ी बोल|इंग्लिश बोल/.test(normalized)) {
    return { language: "English", reason: "user_requested_english" };
  }
  if (/(hindi mein|hindi me|speak hindi|talk hindi|reply hindi|हिंदी में|हिन्दी में|हिंदी बोल|हिन्दी बोल)/.test(normalized)) {
    return { language: "Hindi", reason: "user_requested_hindi" };
  }
  return null;
}

function languageSwitchReply(language, lead = {}) {
  if (language === "English") {
    if (lead.playbook_type === "UNAPPROVED_USERS") {
      return "Sure, I will speak in English. I am calling from LoanConnect to help you check your final loan offer. Can you spare two minutes?";
    }
    return "Sure, I will speak in English from now on. How can I help you with your loan today?";
  }
  return "ठीक है, अब मैं हिंदी में बात करूँगा। क्या आप दो मिनट में अपना final offer check कर सकते हैं?";
}

function isEnglishSession(session = {}) {
  return normalizePreferredLanguage(session.preferredLanguage || session.lead?.language) === "English";
}

function normalizePreferredLanguage(language) {
  const value = String(language || "").toLowerCase();
  if (value.includes("english") || value.includes("angrezi") || value.includes("इंग्लिश") || value.includes("अंग्रेज")) return "English";
  if (value.includes("hindi") || value.includes("hinglish") || value.includes("हिंदी") || value.includes("हिन्दी")) return "Hindi";
  return "";
}

function queueLeadLink(session, reason) {
  if (!session.tenantId || !session.lead) return;
  sendLeadLink({
    tenantId: session.tenantId,
    lead: session.lead,
    channel: "sms",
    link: config.loanAppUrl
  })
    .then(event => logVoicebotEvent(session, "lead_link_queued", { reason, status: event.status, channel: event.channel }).catch(() => {}))
    .catch(err => logVoicebotEvent(session, "lead_link_failed", { reason, error: err.message }).catch(() => {}));
}

function terminalClosingText(outcome) {
  if (outcome === "CALLBACK") return "ठीक है, हम बाद में संपर्क करेंगे। धन्यवाद।";
  if (outcome === "WRONG_NUMBER") return "माफ कीजिए, मैं इस number को wrong number mark कर रहा हूँ। धन्यवाद।";
  if (outcome === "OPTED_OUT") return "समझ गया। हम आपको दोबारा call नहीं करेंगे। धन्यवाद।";
  return "ठीक है, मैं call यहीं close कर रहा हूँ। धन्यवाद।";
}

async function speakAndClose(ws, session, text, markName) {
  clearNoSpeechTimers(session);
  clearInterimTimer(session);
  await speakText(ws, session, text, markName);
  await sleep(Number(process.env.VOICEBOT_END_CLOSE_GRACE_MS || 900));
  if (!session.closed && ws.readyState === ws.OPEN) ws.close();
}

async function safeGenerateReply(session, args) {
  try {
    return await generateReply(args);
  } catch (err) {
    await logVoicebotEvent(session, "llm_failed", { error: err.message });
    return "Samajh gaya. Main LoanConnect ka AI assistant hoon. Kya aap loan eligibility aur offer details ke liye ek minute de sakte hain?";
  }
}

function normalizeVoiceIntent(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[।,.!?;:()[\]{}"'`*_>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionsMissingLink(text) {
  return /(link nahi|link nahin|link नहीं|लिंक नहीं|लिंक नही|लिंक नहीं है|लिंक नही है|नहीं है मेरे पास|नही है मेरे पास|mere paas nahi|mere paas nahin)/.test(text);
}

function mentionsLinkReceived(text) {
  return /(aa gaya|aagaya|mil gaya|मिल गया|आ गया|आगया|link मिला|लिंक मिला)/.test(text);
}

function isPositiveAgreement(text) {
  return /^(haan|han|haa|yes|ok|okay|sure|ठीक|हाँ|हां|हा|ओके)$/.test(text)
    || /(kar dijiye|kar do|bhej do|bhej dijiye|send kar|continue|कर दीजिए|कर दीजिये|कर दो|भेज दो|भेज दीजिए|भेज दीजिये|आगे बढ़)/.test(text);
}

function asksAmount(text) {
  return /(kitna|amount|limit|offer amount|कितना|अमाउंट|राशि|लिमिट|कितनी eligibility|कितनी एलिजिबिलिटी)/.test(text);
}

function asksReason(text) {
  return /(kyun|why|kisliye|क्यों|किसलिए|किस लिये|call kyu|कॉल क्यों)/.test(text);
}

function asksQuestion(text) {
  return /(question|poochna|puchna|पूछना|सवाल|जानना|doubt|डाउट|दिक्कत|problem|issue|समस्या)/.test(text);
}

function firstGreeting(lead) {
  return FAST_INTRO_TEXT;
}

function parseVoicebotTexts(value) {
  return String(value || "")
    .split("|")
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function pickAckText(session) {
  if (!FAST_ACK_TEXTS.length) return "";
  const index = Math.max((session.userTurns || 1) - 1, 0) % FAST_ACK_TEXTS.length;
  return FAST_ACK_TEXTS[index];
}

function scheduleNoSpeechCheck(ws, session, stage) {
  clearNoSpeechTimers(session);
  if (!NO_SPEECH_TIMEOUT_ENABLED || session.closed || ws.readyState !== ws.OPEN) return;

  session.noSpeechPromptTimer = setTimeout(() => {
    session.noSpeechPromptTimer = null;
    if (session.closed || ws.readyState !== ws.OPEN || session.speaking) return;
    logVoicebotEvent(session, "no_speech_prompt_started", { stage, delayMs: NO_SPEECH_PROMPT_MS }).catch(() => {});
    speakText(ws, session, NO_SPEECH_PROMPT_TEXT, "no_speech_prompt").catch(err => {
      logger.warn("voicebot_no_speech_prompt_failed", { error: err.message, callId: session.callId });
    });
  }, NO_SPEECH_PROMPT_MS);

  session.noSpeechEndTimer = setTimeout(() => {
    session.noSpeechEndTimer = null;
    if (session.closed || ws.readyState !== ws.OPEN) return;
    logVoicebotEvent(session, "no_speech_timeout", { stage, delayMs: NO_SPEECH_END_MS }).catch(() => {});
    speakText(ws, session, NO_SPEECH_GOODBYE_TEXT, "no_speech_goodbye")
      .catch(err => logger.warn("voicebot_no_speech_goodbye_failed", { error: err.message, callId: session.callId }))
      .finally(() => {
        if (!session.closed && ws.readyState === ws.OPEN) ws.close();
      });
  }, NO_SPEECH_END_MS);
}

function clearNoSpeechTimers(session) {
  if (session.noSpeechPromptTimer) {
    clearTimeout(session.noSpeechPromptTimer);
    session.noSpeechPromptTimer = null;
  }
  if (session.noSpeechEndTimer) {
    clearTimeout(session.noSpeechEndTimer);
    session.noSpeechEndTimer = null;
  }
}

function isLikelyMisheardTranscript(text, event) {
  if (event.confidence === null || event.confidence === undefined || event.confidence === "") return false;
  const confidence = Number(event.confidence);
  if (!Number.isFinite(confidence) || confidence >= MIN_TRANSCRIPT_CONFIDENCE) return false;
  if (transcriptWordCount(text) > LOW_CONFIDENCE_MAX_WORDS) return false;
  return !isAllowedShortIntent(text);
}

function liveSttEventProvider(event) {
  const provider = String(event?.provider || "live-stt").replace(/[^a-z0-9_-]/gi, "").toLowerCase();
  return provider ? `${provider}-live` : "live-stt";
}

function transcriptWordCount(text) {
  return normalizeTranscript(text).split(/\s+/).filter(Boolean).length;
}

function isAllowedShortIntent(text) {
  const normalized = normalizeTranscript(text);
  if (!normalized) return false;
  return [
    "haan",
    "han",
    "haa",
    "yes",
    "yeah",
    "ji",
    "ok",
    "okay",
    "theek",
    "thik",
    "nahi",
    "nahin",
    "no",
    "callback",
    "call back",
    "interested",
    "not interested"
  ].some(intent => normalized === intent || normalized.includes(` ${intent} `));
}

function normalizeTranscript(text) {
  return ` ${String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

async function speakText(ws, session, text, markName) {
  if (ws.readyState !== ws.OPEN || session.closed) return;
  session.speaking = true;
  const startedAt = Date.now();
  const stopKeepalive = SILENCE_KEEPALIVE_ENABLED ? startSilenceKeepalive(ws, session, markName) : () => {};
  try {
    const pcmBase64 = await getPcmBase64(text, session);
    stopKeepalive();

    if (pcmBase64) {
      const sendResult = await sendMedia(ws, session, pcmBase64);
      await logVoicebotEvent(session, "media_sent", {
        markName,
        ...sendResult,
        elapsedMs: Date.now() - startedAt
      });
      if (!session.closed && ws.readyState === ws.OPEN) sendMark(ws, session, markName);
      return;
    }
    sendMark(ws, session, `${markName}_text_only`);
  } catch (err) {
    stopKeepalive();
    logger.warn("voicebot_tts_failed", { error: err.message, leadId: session.leadId });
    await logVoicebotEvent(session, "tts_failed", { error: err.message, markName });
    sendMark(ws, session, `${markName}_tts_failed`);
  } finally {
    stopKeepalive();
    session.speaking = false;
  }
}

async function getPcmBase64(text, session = {}) {
  const sampleRate = session.mediaSampleRate || 8000;
  const volume = Number(process.env.VOICEBOT_TTS_VOLUME || 1.6);
  const ttsLanguageCode = ttsLanguageCodeForSession(session);
  const speechText = prepareTextForSpeech(text, session);
  const cacheKey = `${sampleRate}:${volume}:${ttsLanguageCode}:${speechText}`;
  if (pcmCache.has(cacheKey)) return pcmCache.get(cacheKey);

  const speech = await synthesizeSpeech(speechText, { languageCode: ttsLanguageCode });
  if (speech.mode !== "audio") return null;

  const pcmBase64 = await toExotelPcmBase64(speech.audioBase64, { sampleRate, volume });
  if (pcmCache.size < Number(process.env.VOICEBOT_PCM_CACHE_LIMIT || 50)) {
    pcmCache.set(cacheKey, pcmBase64);
  }
  return pcmBase64;
}

function prepareTextForSpeech(text, session = {}) {
  const base = String(text || "");
  if (isEnglishSession(session)) {
    return base
      .replace(/\bLoanConnect\b/gi, "Loan Connect")
      .replace(/\bCIBIL\b/gi, "SIBIL")
      .replace(/\bEMI\b/gi, "E M I")
      .replace(/\bKYC\b/gi, "K Y C")
      .replace(/\bOTP\b/gi, "O T P")
      .replace(/\s+/g, " ")
      .trim();
  }

  return base
    .replace(/Namaste,\s*LoanConnect se AI assistant\.?\s*Kya aap mujhe sun paa rahe hain\?/i, "नमस्ते, लोन कनेक्ट से ए आई असिस्टेंट। क्या आप मुझे सुन पा रहे हैं?")
    .replace(/\bNamaste\b/gi, "नमस्ते")
    .replace(/\bAI assistant\b/gi, "ए आई असिस्टेंट")
    .replace(/\bLoanConnect\b/gi, "लोन कनेक्ट")
    .replace(/\bCIBIL\b/gi, "सिबिल")
    .replace(/\bEMI\b/gi, "ई एम आई")
    .replace(/\bKYC\b/gi, "के वाई सी")
    .replace(/\bOTP\b/gi, "ओ टी पी")
    .replace(/\bSMS\b/gi, "एस एम एस")
    .replace(/\bWhatsApp\b/gi, "व्हाट्सऐप")
    .replace(/\bapp\b/gi, "ऐप")
    .replace(/\blink\b/gi, "लिंक")
    .replace(/\boffer\b/gi, "ऑफर")
    .replace(/\bfinal\b/gi, "फाइनल")
    .replace(/\bcheck\b/gi, "चेक")
    .replace(/\bpayment\b/gi, "पेमेंट")
    .replace(/\boverdue\b/gi, "ओवरड्यू")
    .replace(/\bcall\b/gi, "कॉल")
    .replace(/\bline\b/gi, "लाइन")
    .replace(/\bclose\b/gi, "क्लोज़")
    .replace(/\bOK\b/gi, "ओके")
    .replace(/\bOkay\b/gi, "ओके")
    .replace(/\bGot it\b/gi, "समझ गया")
    .replace(/\bSure\b/gi, "ठीक है")
    .replace(/\bHaan ji\b/gi, "हाँ जी")
    .replace(/\bTheek hai\b/gi, "ठीक है")
    .replace(/\bSamjha\b/gi, "समझ गया")
    .replace(/\baap\b/gi, "आप")
    .replace(/\s+/g, " ")
    .trim();
}

function ttsLanguageCodeForSession(session = {}) {
  if (isEnglishSession(session)) return process.env.SARVAM_TTS_ENGLISH_LANGUAGE || "en-IN";
  return process.env.SARVAM_TTS_LANGUAGE || "hi-IN";
}

async function prewarmAudio(text) {
  await getPcmBase64(text, { mediaSampleRate: 8000 });
}

function startSilenceKeepalive(ws, session, markName) {
  const chunkBytes = outboundChunkBytes();
  const delayMs = pcmDurationMs(chunkBytes, session);
  const silence = Buffer.alloc(chunkBytes).toString("base64");
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || ws.readyState !== ws.OPEN || session.closed) return;
    sendMediaFrame(ws, session, silence, 0);
  }, delayMs);

  logVoicebotEvent(session, "silence_keepalive_started", { markName, chunkBytes, delayMs }).catch(() => {});

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}

async function sendMedia(ws, session, audioBase64) {
  if (ws.readyState !== ws.OPEN) return { chunks: 0, stoppedEarly: true, chunkBytes: outboundChunkBytes(), pcmBytes: 0 };
  const chunkBytes = outboundChunkBytes();
  const rawAudio = prependPreroll(Buffer.from(audioBase64, "base64"), session);
  const audio = padToChunkSize(rawAudio, chunkBytes);
  let chunks = 0;

  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    if (ws.readyState !== ws.OPEN || session.closed) break;
    const chunk = audio.subarray(offset, offset + chunkBytes);
    const payload = chunk.toString("base64");
    sendMediaFrame(ws, session, payload, pcmTimestampMs(session, offset));
    chunks++;
    if (offset + chunkBytes < audio.length) await sleep(pcmDurationMs(chunk.length, session));
  }

  return {
    chunks,
    chunkBytes,
    pcmBytes: rawAudio.length,
    paddedBytes: audio.length,
    sampleRate: session.mediaSampleRate || 8000,
    prerollMs: TTS_PREROLL_MS,
    stoppedEarly: chunks * chunkBytes < audio.length,
    mediaVersion: VOICEBOT_MEDIA_VERSION
  };
}

function outboundChunkBytes() {
  const configured = Number(process.env.EXOTEL_MEDIA_CHUNK_BYTES || 3200);
  const bounded = Number.isFinite(configured) ? Math.min(Math.max(configured, 320), 100000) : 3200;
  return Math.floor(bounded / 320) * 320 || 3200;
}

function prependPreroll(audio, session) {
  if (!Number.isFinite(TTS_PREROLL_MS) || TTS_PREROLL_MS <= 0) return audio;
  const silenceBytes = Math.floor((TTS_PREROLL_MS * mediaBytesPerMs(session)) / 320) * 320;
  if (silenceBytes <= 0) return audio;
  return Buffer.concat([Buffer.alloc(silenceBytes), audio]);
}

function padToChunkSize(audio, chunkBytes) {
  const remainder = audio.length % chunkBytes;
  if (!remainder) return audio;
  return Buffer.concat([audio, Buffer.alloc(chunkBytes - remainder)]);
}

function pcmDurationMs(byteLength, session) {
  return Math.max(20, Math.floor(byteLength / mediaBytesPerMs(session)));
}

function mediaBytesPerMs(session) {
  return ((session?.mediaSampleRate || 8000) * 2) / 1000;
}

function pcmTimestampMs(session, offsetBytes) {
  return Math.floor(offsetBytes / mediaBytesPerMs(session));
}

function normalizeMediaSampleRate(value) {
  const sampleRate = Number(value || process.env.EXOTEL_MEDIA_SAMPLE_RATE || 8000);
  if ([8000, 16000, 24000].includes(sampleRate)) return sampleRate;
  return 8000;
}

function sendMediaFrame(ws, session, payload, timestamp) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "media",
    sequence_number: String(session.outboundSequence++),
    stream_sid: session.streamSid || undefined,
    media: {
      chunk: String(session.outboundChunk++),
      timestamp: String(timestamp),
      payload
    }
  }));
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
  const stop = message.stop || message.Stop || {};
  const mark = message.mark || message.Mark || {};
  if (event === "media") {
    const payload = message?.media?.payload || message?.Media?.Payload || message.payload || "";
    return { event, payloadBytes: payload ? Buffer.from(payload, "base64").length : 0 };
  }
  if (event === "stop") {
    return {
      event,
      keys: Object.keys(message || {}),
      callSid: stop.callSid || stop.call_sid || message.CallSid || message.Sid || "",
      reason: stop.reason || stop.Reason || "",
      accountSid: stop.accountSid || stop.account_sid || ""
    };
  }
  if (event === "mark") {
    return {
      event,
      keys: Object.keys(message || {}),
      markName: mark.name || mark.Name || "",
      streamSid: message.stream_sid || message.streamSid || ""
    };
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

async function markCallCompleted(session) {
  if (!session.callId) return;
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
  await query(
    `UPDATE calls
     SET status='completed',
         duration_seconds=CASE
           WHEN duration_seconds IS NULL OR duration_seconds=0 THEN $2
           ELSE duration_seconds
         END,
         updated_at=NOW()
     WHERE id=$1 AND status='streaming'`,
    [session.callId, durationSeconds]
  );
}

async function finalizeCall(session, { outcome, summary }) {
  if (!session.callId) return;
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedAt) / 1000));
  await query(
    `UPDATE calls
     SET status='completed',
         outcome=COALESCE($2,outcome),
         summary=COALESCE($3,summary),
         duration_seconds=CASE
           WHEN duration_seconds IS NULL OR duration_seconds=0 THEN $4
           ELSE duration_seconds
         END,
         updated_at=NOW()
     WHERE id=$1`,
    [session.callId, outcome || null, summary || null, durationSeconds]
  );
}

function sendMark(ws, session, name) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({
    event: "mark",
    stream_sid: session?.streamSid || undefined,
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
