const { WebSocketServer } = require("ws");
const { query } = require("../db/pool");
const { generateReply } = require("../providers/llm");
const { synthesizeSpeech } = require("../providers/sarvam");
const { toExotelPcmBase64 } = require("../providers/audio");
const { createLiveStt } = require("../providers/sttLive");
const {
  buildAudioCacheKey,
  charLength,
  getCachedAudio,
  saveCachedAudio
} = require("../services/audioCache");
const { createPcmVad } = require("../services/vad");
const {
  classifyConversation,
  isCallScreening,
  isOptOut,
  isTerminalIntent,
  isVoicemail,
  terminalOutcome
} = require("../services/outcomes");
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
const FAST_ACK_DELAY_MS = Number(process.env.VOICEBOT_FAST_ACK_DELAY_MS || process.env.VOICEBOT_ACK_DELAY_MS || 850);
const FAST_ACK_SCRIPTED_ENABLED = process.env.VOICEBOT_FAST_ACK_SCRIPTED_ENABLED === "true";
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
const VAD_ENABLED = process.env.VOICEBOT_VAD_ENABLED !== "false";
const AUDIO_CACHE_ENABLED = process.env.VOICEBOT_AUDIO_CACHE_ENABLED !== "false";
const BARGE_IN_CLEAR_ENABLED = process.env.VOICEBOT_BARGE_IN_CLEAR_ENABLED !== "false";
const BARGE_IN_GRACE_MS = Number(process.env.VOICEBOT_BARGE_IN_GRACE_MS || 2500);
const BARGE_IN_MIN_CHUNKS = Number(process.env.VOICEBOT_BARGE_IN_MIN_CHUNKS || 10);
const INTRO_BARGE_IN_ENABLED = process.env.VOICEBOT_INTRO_BARGE_IN_ENABLED === "true";
const SCREENING_RESPONSE_ENABLED = process.env.VOICEBOT_SCREENING_RESPONSE_ENABLED === "true";
const TTS_PREROLL_MS = Number(process.env.VOICEBOT_TTS_PREROLL_MS || 300);
const VOICEBOT_MEDIA_VERSION = "2026-06-04-audible-preroll-volume-v1";
const INTRO_START_MODE = process.env.VOICEBOT_INTRO_START_MODE || "first_media";
const PCM_CACHE_MAX = Number(process.env.VOICEBOT_PCM_CACHE_MAX || 200);

// Bounded LRU cache — prevents unbounded memory growth over long server uptime.
const pcmCache = (() => {
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const val = map.get(key);
      map.delete(key);
      map.set(key, val);
      return val;
    },
    set(key, val) {
      if (map.has(key)) map.delete(key);
      else if (map.size >= PCM_CACHE_MAX) map.delete(map.keys().next().value);
      map.set(key, val);
    },
    has(key) { return map.has(key); }
  };
})();

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
      vad: null,
      sttAudioChunks: 0,
      sttAudioBytes: 0,
      sttAudioSkippedChunks: 0,
      sttAudioSkippedBytes: 0,
      sttVadSuppressedChunks: 0,
      sttVadSuppressedBytes: 0,
      sttVadSpeechStarts: 0,
      sttVadSpeechEnds: 0,
      ttsCharsDynamic: 0,
      ttsCharsCached: 0,
      ttsCacheHits: 0,
      ttsCacheMisses: 0,
      llmCallsCount: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      speaking: false,
      closed: false,
      mediaChunks: 0,
      bytesReceived: 0,
      outboundSequence: 1,
      outboundChunk: 1,
      userTurns: 0,
      turnSeq: 0,
      activeTurnSeq: 0,
      speechSeq: 0,
      activeSpeechSeq: 0,
      cancelSpeechSeq: 0,
      interimStartedAt: 0,
      interimTimer: null,
      interimCount: 0,
      pendingTranscript: null,
      lastProcessedTranscript: null,
      confirmedName: false,
      confirmedNameTurn: 0,
      capturedName: "",
      lastSpokenText: "",
      lastSpokenMark: "",
      activeSpeechMark: "",
      activeSpeechMediaStartedAt: 0,
      activeSpeechChunksSent: 0,
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
        forwardAudioToStt(session, audio);
      } else {
        session.sttAudioSkippedChunks++;
        session.sttAudioSkippedBytes += audio.length;
        if (session.sttAudioSkippedChunks === 1 || session.sttAudioSkippedChunks % 100 === 0) {
          logVoicebotEvent(session, "stt_audio_skipped_during_assistant", {
            payloadBytes: audio.length,
            sttAudioSkippedChunks: session.sttAudioSkippedChunks,
            sttAudioSkippedBytes: session.sttAudioSkippedBytes,
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
        if (session.speaking && STT_DURING_ASSISTANT_ENABLED && shouldCancelAssistantSpeech(session, status)) {
          invalidateAssistantTurn(session, "barge_in_speech_started");
          cancelAssistantSpeech(ws, session, "barge_in_speech_started");
        }
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

function forwardAudioToStt(session, audio) {
  if (!audio?.length) return;
  const vadResult = applyVad(session, audio);
  const forwardedBytes = vadResult.forwarded.reduce((sum, buffer) => sum + buffer.length, 0);

  if (vadResult.started) {
    session.sttVadSpeechStarts++;
    logVoicebotEvent(session, "vad_speech_started", {
      speechStarts: session.sttVadSpeechStarts,
      stats: vadResult.stats,
      snapshot: session.vad?.snapshot?.() || null
    }).catch(() => {});
  }
  if (vadResult.ended) {
    session.sttVadSpeechEnds++;
    logVoicebotEvent(session, "vad_speech_ended", {
      speechEnds: session.sttVadSpeechEnds,
      stats: vadResult.stats,
      snapshot: session.vad?.snapshot?.() || null
    }).catch(() => {});
  }

  if (!forwardedBytes) {
    session.sttVadSuppressedChunks++;
    session.sttVadSuppressedBytes += audio.length;
    if (session.sttVadSuppressedChunks === 1 || session.sttVadSuppressedChunks % 100 === 0) {
      logVoicebotEvent(session, "stt_audio_vad_suppressed", {
        payloadBytes: audio.length,
        suppressedChunks: session.sttVadSuppressedChunks,
        suppressedBytes: session.sttVadSuppressedBytes,
        reason: vadResult.reason,
        stats: vadResult.stats,
        sttProvider: session.stt?.provider || "",
        sttReady: Boolean(session.stt?.ready)
      }).catch(() => {});
    }
    return;
  }

  for (const buffer of vadResult.forwarded) {
    session.sttAudioChunks++;
    session.sttAudioBytes += buffer.length;
    session.stt?.sendAudio(buffer);
  }

  if (session.sttAudioChunks === vadResult.forwarded.length || session.sttAudioChunks % 100 === 0 || vadResult.started) {
    logVoicebotEvent(session, "stt_audio_forwarded", {
      inputBytes: audio.length,
      forwardedBytes,
      forwardedBuffers: vadResult.forwarded.length,
      sttAudioChunks: session.sttAudioChunks,
      sttAudioBytes: session.sttAudioBytes,
      vadEnabled: VAD_ENABLED,
      vadReason: vadResult.reason,
      stats: vadResult.stats,
      sttProvider: session.stt?.provider || "",
      sttReady: Boolean(session.stt?.ready),
      speaking: session.speaking
    }).catch(() => {});
  }
}

function applyVad(session, audio) {
  if (!VAD_ENABLED) {
    return {
      forwarded: [audio],
      speech: true,
      started: false,
      ended: false,
      reason: "disabled",
      stats: { durationMs: pcmBytesToMs(audio.length, session.mediaSampleRate || 8000) }
    };
  }
  if (!session.vad) {
    session.vad = createPcmVad({
      enabled: true,
      sampleRate: session.mediaSampleRate || 8000
    });
  }
  return session.vad.process(audio);
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
  const turnSeq = beginUserTurn(session, text, event.source || "final");
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
  updateConversationMemory(session, text);

  const nonHumanOutcome = isVoicemail(text) ? "VOICEMAIL" : (isCallScreening(text) ? "CALL_SCREENING" : "");
  if (nonHumanOutcome) {
    session.ending = true;
    const transcript = session.callId ? await getTranscript(session.callId) : [];
    const classification = classifyConversation({
      userMessage: text,
      transcript,
      playbookType: session.lead.playbook_type
    });
    if (session.callId) {
      await finalizeCall(session, {
        outcome: nonHumanOutcome,
        summary: classification.summary
      });
    }
    await logVoicebotEvent(session, "non_human_detected", {
      text,
      outcome: nonHumanOutcome,
      reason: classification.reason,
      nextAction: classification.nextAction
    });
    if (nonHumanOutcome === "CALL_SCREENING" && SCREENING_RESPONSE_ENABLED) {
      const reply = callScreeningReply(session);
      if (session.callId) await addTranscript(session.callId, "assistant", reply);
      await speakAndClose(ws, session, reply, "call_screening_close");
    } else {
      await closeQuietly(ws, session);
    }
    return;
  }

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

  if (isContextualNegativeReply(session, text)) {
    const reply = contextualNegativeReply(session);
    await logVoicebotEvent(session, "contextual_negative_followup", {
      text,
      lastSpokenText: session.lastSpokenText || "",
      linkInstructionReason: session.linkInstructionReason || ""
    });
    if (session.callId) {
      await addTranscript(session.callId, "assistant", reply);
      const transcript = await getTranscript(session.callId);
      const classification = classifyConversation({ userMessage: text, transcript, playbookType: session.lead.playbook_type });
      await query(
        `UPDATE calls SET outcome=$1, summary=$2, updated_at=NOW() WHERE id=$3`,
        [classification.outcome === "NOT_INTERESTED" ? "IN_PROGRESS" : classification.outcome, classification.summary, session.callId]
      );
    }
    await speakText(ws, session, reply, "contextual_negative_played");
    scheduleNoSpeechCheck(ws, session, "after_contextual_negative");
    return;
  }

  if (isTerminalIntent(text)) {
    session.ending = true;
    const outcome = terminalOutcome(text);
    const closingText = terminalClosingText(outcome, session);
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
  if (!scriptedReply) {
    session.llmCallsCount++;
    session.llmInputTokens += estimateInputTokens({
      lead: session.lead,
      lastUserMessage: text,
      transcript: promptTranscript,
      conversationState: buildConversationState(session)
    });
  }
  const replyPromise = scriptedReply
    ? Promise.resolve(scriptedReply)
    : safeGenerateReply(session, {
      lead: session.lead,
      lastUserMessage: text,
      transcript: promptTranscript,
      conversationState: buildConversationState(session)
    });
  const ackText = pickAckText(session);
  if (FAST_ACK_ENABLED && ackText && (!scriptedReply || FAST_ACK_SCRIPTED_ENABLED)) {
    await maybeSpeakDelayedAck(ws, session, replyPromise, ackText, turnSeq);
  }

  const reply = await replyPromise;
  if (!scriptedReply) {
    session.llmOutputTokens += estimateTokens(reply);
  }
  if (!isCurrentTurn(session, turnSeq)) {
    await logVoicebotEvent(session, "reply_stale_dropped", {
      text,
      turnSeq,
      activeTurnSeq: session.activeTurnSeq,
      elapsedMs: Date.now() - turnStartedAt,
      source: scriptedReply ? "scripted" : "llm"
    });
    return;
  }

  await logVoicebotEvent(session, "reply_ready", {
    elapsedMs: Date.now() - turnStartedAt,
    textBytes: Buffer.byteLength(reply),
    source: scriptedReply ? "scripted" : "llm",
    provider: scriptedReply ? "scripted" : normalizeProviderName(process.env.LLM_PROVIDER || "sarvam")
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

async function maybeSpeakDelayedAck(ws, session, replyPromise, ackText, turnSeq) {
  let settled = false;
  replyPromise.then(() => {
    settled = true;
  }).catch(() => {
    settled = true;
  });

  await sleep(FAST_ACK_DELAY_MS);
  if (settled || !isCurrentTurn(session, turnSeq) || session.speaking) return false;

  await speakText(ws, session, ackText, "ack_played");
  return true;
}

function beginUserTurn(session, text, source = "") {
  session.turnSeq = (session.turnSeq || 0) + 1;
  session.activeTurnSeq = session.turnSeq;
  session.activeTurnText = text;
  session.activeTurnSource = source;
  return session.activeTurnSeq;
}

function invalidateAssistantTurn(session, reason = "") {
  session.turnSeq = (session.turnSeq || 0) + 1;
  session.activeTurnSeq = session.turnSeq;
  session.lastTurnInvalidation = { reason, at: Date.now() };
  return session.activeTurnSeq;
}

function isCurrentTurn(session, turnSeq) {
  return !session.closed && !session.ending && session.activeTurnSeq === turnSeq;
}

function buildConversationState(session = {}) {
  return {
    confirmedName: Boolean(session.confirmedName),
    capturedName: session.capturedName || "",
    lastSpokenText: session.lastSpokenText || "",
    userTurns: session.userTurns || 0,
    linkInstructionGiven: Boolean(session.linkInstructionGiven),
    linkInstructionReason: session.linkInstructionReason || "",
    linkPositiveFollowups: Number(session.linkPositiveFollowups || 0)
  };
}

function estimateInputTokens(value) {
  return estimateTokens(JSON.stringify(value || {}));
}

function estimateTokens(value) {
  const text = String(value || "");
  if (!text) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase() || "unknown";
}

function updateConversationMemory(session, text) {
  if (!session?.lead) return;

  const askedName = askedForNameRecently(session.lastSpokenText);
  const extractedName = extractNameAnswer(text);
  const confirmsKnownName = askedName && Boolean(session.lead.name) && isPositiveAgreement(normalizeVoiceIntent(text));
  const shortName = askedName ? shortNameAnswer(text) : "";

  if (!session.confirmedName && (extractedName || confirmsKnownName || shortName)) {
    session.confirmedName = true;
    session.confirmedNameTurn = session.userTurns || 0;
    session.capturedName = extractedName || shortName || session.lead.name || "";
    if (session.capturedName && (!session.lead.name || isGenericLeadName(session.lead.name))) {
      session.lead = { ...session.lead, name: session.capturedName };
    }
  }
}

function askedForNameRecently(text) {
  const normalized = normalizeVoiceIntent(text);
  return /(your name|confirm.*name|name.*confirm|reference detail|naam|नाम|आपका नाम|नाम बत|नाम confirm|नाम कन्फर्म|नाम क्या)/.test(normalized);
}

function extractNameAnswer(text) {
  const value = String(text || "").trim();
  const patterns = [
    /\bmy name is\s+([a-z][a-z\s.'-]{1,40})/i,
    /\bi am\s+([a-z][a-z\s.'-]{1,40})/i,
    /\bthis is\s+([a-z][a-z\s.'-]{1,40})/i,
    /\bmera naam\s+([a-z][a-z\s.'-]{1,40})/i,
    /\bमेरा नाम\s+([\p{L}\s.'-]{1,40})/iu,
    /\bमैं\s+([\p{L}\s.'-]{1,40})/iu
  ];

  for (const pattern of patterns) {
    const match = value.match(pattern);
    const candidate = cleanNameCandidate(match?.[1]);
    if (candidate) return candidate;
  }

  return "";
}

function shortNameAnswer(text) {
  let candidate = String(text || "")
    .replace(/\b(yes|yeah|haan|han|ji|okay|ok|correct|right)\b/gi, " ")
    .replace(/\b(my name is|i am|this is|mera naam|main|mein)\b/gi, " ")
    .replace(/\b(मेरा नाम|मैं|जी|हाँ|ठीक है)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();

  candidate = cleanNameCandidate(candidate);
  if (!candidate) return "";

  const normalized = normalizeVoiceIntent(candidate);
  if (/(loan|amount|rate|interest|emi|fee|charge|link|offer|payment|due|callback|busy|not interested|लोन|पेमेंट|ब्याज|लिंक|ऑफर)/.test(normalized)) {
    return "";
  }

  const wordCount = candidate.split(/\s+/).filter(Boolean).length;
  return wordCount >= 1 && wordCount <= 4 ? candidate : "";
}

function cleanNameCandidate(value) {
  const candidate = String(value || "")
    .replace(/[0-9]/g, " ")
    .replace(/\b(age|old|years|saal|sal|loan|amount|please|sir|madam)\b.*$/i, " ")
    .replace(/[।,.!?;:()[\]{}"'`*_>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!candidate || candidate.length < 2 || candidate.length > 50) return "";
  return candidate;
}

function isGenericLeadName(name) {
  return /^(customer|test user|user|lead)$/i.test(String(name || "").trim());
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
  const amountText = amount ? formatLoanAmount(amount) : "eligible amount";
  const english = isEnglishSession(session);

  if (lead.playbook_type === "FRESH_LEAD" && session.confirmedNameTurn === session.userTurns && isNameConfirmationTurn(normalized)) {
    if (english) return "Thanks. How much loan are you looking for right now?";
    return "धन्यवाद। अभी आपको कितना loan चाहिए?";
  }

  if (mentionsMissingLink(normalized)) {
    queueLeadLink(session, "missing_link");
    if (english) return "Sure, I am sending the secure link again. Please open it and check your final offer in two minutes.";
    return "ठीक है, मैं सुरक्षित link दोबारा भेज रहा हूँ। कृपया उसे खोलकर दो मिनट में final offer check कर लीजिए।";
  }

  if (mentionsLinkProblem(normalized)) {
    queueLeadLink(session, "link_problem");
    if (english) return "I am sending the secure link again. Please open it in mobile data or the app; if it still fails, use app support.";
    return "मैं सुरक्षित link दोबारा भेज रहा हूँ। उसे mobile data या app में खोलिए; फिर भी दिक्कत हो तो app support use कीजिए।";
  }

  if (asksSendDetails(normalized)) {
    queueLeadLink(session, "send_details");
    if (english) return "Sure, I am sending the secure link by SMS. Please review the details there before accepting anything.";
    return "ठीक है, मैं सुरक्षित link SMS पर भेज रहा हूँ। कुछ accept करने से पहले details वहीं देख लीजिए।";
  }

  if (mentionsWrongAnswer(normalized)) {
    if (english) return "Sorry, I misunderstood. Tell me the exact point: interest rate, EMI, amount, fees, or link?";
    return "माफ़ कीजिए, मैं गलत समझा। आप क्या जानना चाहते हैं: ब्याज दर, ई एम आई, amount, fees या link?";
  }

  if (asksIdentity(normalized)) {
    if (english) return "I am LoanConnect's AI assistant, calling about your loan eligibility or offer. I will not ask for OTP or passwords.";
    return "मैं लोन कनेक्ट का AI assistant हूँ, आपकी loan eligibility या offer के बारे में call कर रहा हूँ। मैं ओ टी पी या password नहीं पूछूँगा।";
  }

  if (asksDataSource(normalized)) {
    if (english) return "This number is linked to a loan enquiry or app registration record. If that is wrong, tell me and I will mark it.";
    return "यह number loan enquiry या app registration record से जुड़ा दिख रहा है। अगर यह गलत है, बताइए, मैं mark कर दूँगा।";
  }

  if (asksHumanSupport(normalized)) {
    if (english) return "There is no human transfer on this call. I can note the issue, and support is available in the app.";
    return "इस call पर human transfer नहीं है। मैं issue note कर सकता हूँ, और support app में available है।";
  }

  if (mentionsLinkReceived(normalized)) {
    markLinkInstruction(session, "link_received");
    if (english) return "Great. Open it once and tell me which screen you see: documents, KYC, bank verification, e-sign, final offer, or an error.";
    return "बहुत अच्छा। Link खोलिए और बताइए कौन सा screen दिख रहा है: documents, KYC, bank verification, e-sign, final offer या error?";
  }

  if (isConversationalBackchannel(normalized) && hasRecentLinkInstruction(session)) {
    return positiveFollowUpReply(session, english);
  }

  if (isPositiveAgreement(normalized)) {
    if (hasRecentLinkInstruction(session)) {
      return positiveFollowUpReply(session, english);
    }
    const stageReply = stagePositiveReply(session, english);
    if (stageReply) {
      queueLeadLink(session, "stage_positive");
      return stageReply;
    }
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

  if (asksForgotLogin(normalized)) {
    queueLeadLink(session, "forgot_login");
    if (english) return "I am sending the app link again. Login with your mobile number inside the app, but never share the OTP with me.";
    return "मैं app link फिर भेज रहा हूँ। app में अपने mobile number से login कीजिए, लेकिन ओ टी पी मुझे कभी मत बताइए।";
  }

  if (asksSafety(normalized) || asksOtpOrSensitiveDetails(normalized)) {
    if (english) return "Yes, use only the secure app link. I will never ask for OTP, PIN, password, Aadhaar OTP, or card details.";
    return "हाँ, सिर्फ सुरक्षित app link use कीजिए। मैं ओ टी पी, PIN, password, Aadhaar OTP या card details कभी नहीं पूछूँगा।";
  }

  if (asksInterestRate(normalized)) {
    if (english) return "The exact interest rate appears on the final offer screen after eligibility. You can reject it if it does not suit you.";
    return "ब्याज दर फ़ाइनल ऑफर स्क्रीन पर एलिजिबिलिटी के बाद दिखेगी। पसंद न हो तो आप मना कर सकते हैं।";
  }

  if (asksPenalty(normalized)) {
    if (english) return "Any late fee or penalty is shown on the payment screen. Paying as soon as possible helps avoid extra charges.";
    return "Late fee या penalty payment screen पर साफ दिखेगी। जल्दी payment करने से extra charges कम हो सकते हैं।";
  }

  if (asksFeesOrCharges(normalized)) {
    if (english) return "Any fee or charge is shown clearly in the app before acceptance. Please never share OTP or card details.";
    return "कोई भी fee या charge ऐप में साफ दिखेगा, स्वीकार करने से पहले। ओ टी पी या card details मत बताइए।";
  }

  if (asksEmiOrTenure(normalized)) {
    if (english) return "EMI and tenure options are shown with the final offer in the app. Open the secure link, and I will stay on the line.";
    return "ई एम आई और tenure options ऐप में final offer के साथ दिखेंगे। सुरक्षित link खोलिए, मैं line पर हूँ।";
  }

  if (asksChangeAmount(normalized)) {
    if (english) return "You can choose a lower amount if the app allows it. A higher amount depends on final eligibility.";
    return "कम amount app में allowed हो तो चुन सकते हैं। ज़्यादा amount final eligibility पर depend करेगा।";
  }

  if (asksDocuments(normalized)) {
    if (english) return "The app will show the exact documents needed. Usually it is basic KYC and income details, if required.";
    return "ऐप exact documents दिखाएगा। आम तौर पर basic KYC और income details लग सकती हैं।";
  }

  if (asksApprovalStatus(normalized)) {
    if (english) return "Your eligibility looks incomplete or pending. Please open the secure link to see what is pending and the final offer.";
    return "आपकी eligibility incomplete या pending दिख रही है। क्या pending है और final offer देखने के लिए सुरक्षित link खोलिए।";
  }

  if (asksEligibilityCriteria(normalized)) {
    if (english) return "Eligibility depends on your profile, income details, and bureau checks. The app will show the final result before you accept.";
    return "Eligibility profile, income details और bureau checks पर depend करती है। Accept करने से पहले app final result दिखाएगा।";
  }

  if (asksProcessAfterDocs(normalized)) {
    if (english) return "After documents are checked, the app shows your final offer. You can review it before accepting anything.";
    return "Documents check होने के बाद app final offer दिखाएगा। कुछ accept करने से पहले आप उसे review कर सकते हैं।";
  }

  if (asksDisbursal(normalized)) {
    if (english) return "Disbursal timing depends on final approval and bank processing. The app will show the next step after acceptance.";
    return "Disbursal final approval और bank processing पर depend करता है। Accept करने के बाद app next step दिखाएगा।";
  }

  if (asksCibil(normalized)) {
    if (english) return "Repaying on time helps protect your CIBIL record. Overdue payment can negatively affect it.";
    return "समय पर payment करने से आपका सिबिल record protect रहता है। Overdue payment से negative impact हो सकता है।";
  }

  if (asksCommitmentOrRejection(normalized)) {
    if (english) return "Checking the offer does not force you to take it. You can review the final terms and reject if they do not suit you.";
    return "Offer check करने से loan लेना compulsory नहीं है। Final terms देखकर पसंद न हो तो आप मना कर सकते हैं।";
  }

  if (asksOfferValidity(normalized)) {
    const dueText = lead.due_date ? ` It is currently marked until ${lead.due_date}.` : "";
    if (english) return `Offer validity is shown in the app before acceptance.${dueText} Please check it once now.`;
    return lead.due_date
      ? `Offer validity app में दिखेगी। अभी record में ${lead.due_date} तक दिख रहा है, एक बार app में confirm कर लीजिए।`
      : "Offer validity app में accept करने से पहले साफ दिखेगी। कृपया एक बार अभी check कर लीजिए।";
  }

  if (asksDueDate(normalized)) {
    if (lead.due_date) {
      if (english) return `Your due date is showing as ${lead.due_date}. Please confirm the amount on the secure payment screen.`;
      return `आपकी due date ${lead.due_date} दिख रही है। Amount सुरक्षित payment screen पर confirm कर लीजिए।`;
    }
    if (english) return "The exact due date is shown on the payment screen in the app. Please open the secure link to confirm it.";
    return "Exact due date app की payment screen पर दिखेगी। Confirm करने के लिए सुरक्षित link खोलिए।";
  }

  if (asksPayAmount(normalized)) {
    const payAmount = lead.loan_amount || lead.offer_amount || "";
    if (payAmount) {
      if (english) return `The payable amount is showing around ${formatLoanAmount(payAmount)}. Please confirm the exact amount on the payment screen.`;
      return `Payable amount लगभग ${formatLoanAmount(payAmount)} दिख रहा है। Exact amount payment screen पर confirm कर लीजिए।`;
    }
    if (english) return "The exact payable amount is shown on the secure payment screen before you pay.";
    return "Exact payable amount payment करने से पहले सुरक्षित payment screen पर दिखेगा।";
  }

  if (mentionsPaymentFailed(normalized)) {
    queueLeadLink(session, "payment_failed");
    if (english) return "If payment failed, please retry only from the secure link. If money was debited, check app support before paying again.";
    return "Payment failed हो तो सिर्फ secure link से retry कीजिए। पैसा debit हुआ हो तो दोबारा pay करने से पहले app support check कीजिए।";
  }

  if (asksPartialPayment(normalized)) {
    if (english) return "Partial payment options, if available, will show on the payment screen. Full payment helps avoid extra charges.";
    return "Partial payment option available होगा तो payment screen पर दिखेगा। Full payment से extra charges avoid होते हैं।";
  }

  if (asksEarlyPayment(normalized)) {
    if (english) return "Early payment can reduce interest where applicable and helps maintain a good repayment record.";
    return "Early payment से जहाँ applicable हो interest कम हो सकता है, और repayment record अच्छा रहता है।";
  }

  if (asksRestructureOrHardship(normalized)) {
    if (english) return "I understand. Please check restructuring or easy EMI options in the app. I will note that you need help.";
    return "समझ गया। App में restructuring या easy EMI options check कीजिए। मैं note कर रहा हूँ कि आपको help चाहिए।";
  }

  if (asksConfused(normalized)) {
    if (english) return "No problem. I will keep it simple: open the secure link, check the final details, and accept only if you are comfortable.";
    return "कोई बात नहीं। Simple है: secure link खोलिए, final details देखिए, और comfortable हों तभी accept कीजिए।";
  }

  if (asksAmount(normalized)) {
    if (english) return `Your eligibility shows up to ${amountText}. The final amount will be confirmed after checking details in the app.`;
    return `आपकी eligibility ${amountText} तक दिख रही है। Final amount app में details check करने के बाद confirm होगा।`;
  }

  if (asksReason(normalized)) {
    const stageReply = stageReasonReply(session, english);
    if (stageReply) return stageReply;
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
  markLinkInstruction(session, reason);
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

function markLinkInstruction(session, reason = "") {
  if (!session) return;
  session.linkInstructionGiven = true;
  session.linkInstructionReason = reason;
  session.linkInstructionCount = Number(session.linkInstructionCount || 0) + 1;
}

function hasRecentLinkInstruction(session = {}) {
  return Boolean(session.linkInstructionGiven) || assistantAskedToOpenLink(session.lastSpokenText);
}

function assistantAskedToOpenLink(text = "") {
  const normalized = normalizeVoiceIntent(text);
  return /(secure link|same secure link|link भेज|link खोल|link open|लिंक खोल|सुरक्षित link|सुरक्षित लिंक|app खोल|ऐप खोल|final offer check|final eligibility|documents.*check|offer आगे)/.test(normalized);
}

function positiveFollowUpReply(session = {}, english = false) {
  session.linkPositiveFollowups = Number(session.linkPositiveFollowups || 0) + 1;
  const stage = String(session.lead?.drop_stage || session.lead?.playbook_type || "").toUpperCase();

  if (stage.includes("BANK_VERIFICATION")) {
    if (english) return "Great. Are you seeing UPI verification, bank-account verification, or an error on the screen?";
    return "बहुत अच्छा। Screen पर UPI verification, bank-account verification या कोई error दिख रहा है?";
  }
  if (stage.includes("E_SIGN")) {
    if (english) return "Great. Please review the amount and terms. Are you seeing the e-sign button or any error?";
    return "बहुत अच्छा। Amount और terms review कीजिए। क्या e-sign button दिख रहा है या कोई error है?";
  }
  if (stage.includes("SELFIE")) {
    if (english) return "Great. Are you on the live selfie screen now, or is the camera step not opening?";
    return "बहुत अच्छा। क्या live selfie screen खुल गया है, या camera step open नहीं हो रहा?";
  }
  if (stage.includes("AADHAAR")) {
    if (english) return "Great. Are you seeing DigiLocker Aadhaar KYC, OTP, or any error on the screen?";
    return "बहुत अच्छा। Screen पर DigiLocker Aadhaar KYC, OTP, या कोई error दिख रहा है?";
  }
  if (stage.includes("PROFILE")) {
    if (english) return "Great. Which profile detail is pending on the screen: personal, employment, income, or address?";
    return "बहुत अच्छा। Screen पर कौन सी profile detail pending है: personal, employment, income या address?";
  }

  if (english) return "Great. Tell me what you see now: documents, KYC, bank verification, e-sign, final offer, or an error?";
  return "बहुत अच्छा। अब बताइए screen पर क्या दिख रहा है: documents, KYC, bank verification, e-sign, final offer या error?";
}

function isContextualNegativeReply(session = {}, text = "") {
  if (!hasRecentLinkInstruction(session)) return false;
  const normalized = normalizeVoiceIntent(text);
  return isBareNegative(normalized);
}

function contextualNegativeReply(session = {}) {
  const english = isEnglishSession(session);
  const stage = String(session.lead?.drop_stage || session.lead?.playbook_type || "").toUpperCase();

  if (stage.includes("BANK_VERIFICATION")) {
    if (english) return "No problem. Is bank verification not opening, or are you unsure about entering bank details?";
    return "कोई बात नहीं। Bank verification खुल नहीं रहा, या bank details डालने में doubt है?";
  }
  if (stage.includes("E_SIGN")) {
    if (english) return "No problem. Are you not comfortable with the terms, or is the e-sign screen not opening?";
    return "कोई बात नहीं। Terms comfortable नहीं हैं, या e-sign screen open नहीं हो रहा?";
  }
  if (stage.includes("SELFIE")) {
    if (english) return "No problem. Is the camera not opening, or are you not able to take the selfie now?";
    return "कोई बात नहीं। Camera open नहीं हो रहा, या अभी selfie नहीं कर पा रहे?";
  }
  if (stage.includes("AADHAAR")) {
    if (english) return "No problem. Is DigiLocker not opening, or are you not comfortable with Aadhaar KYC?";
    return "कोई बात नहीं। DigiLocker open नहीं हो रहा, या Aadhaar KYC को लेकर doubt है?";
  }

  if (english) return "No problem. What is stopping you right now: link not received, app not opening, documents, or not interested?";
  return "कोई बात नहीं। अभी क्या दिक्कत है: link नहीं मिला, app नहीं खुला, documents, या interest नहीं है?";
}

function isBareNegative(text = "") {
  return /^(no|nope|na|nahi|nahin|nhi|not now|नहीं|नही|ना|न|नाही)$/.test(text);
}

function isConversationalBackchannel(text = "") {
  return /^(hmm|hm|umm|haan ji|han ji|ji|accha|achha|okay|ok|ओके|अच्छा|हम्म|हां जी|हाँ जी|जी)$/.test(text);
}

function terminalClosingText(outcome, session = {}) {
  const english = isEnglishSession(session);
  if (outcome === "VOICEMAIL") return english ? "Reached voicemail. Ending this call." : "Voicemail मिला। Call close कर रहा हूँ।";
  if (outcome === "CALL_SCREENING") return english ? "LoanConnect AI assistant calling about a loan enquiry. Thank you." : "लोन कनेक्ट AI assistant, loan enquiry के बारे में call कर रहा हूँ। धन्यवाद।";
  if (outcome === "PAID") return english ? "Thanks, I have noted that you already paid. Please keep the payment receipt handy." : "धन्यवाद, मैं note कर रहा हूँ कि आपने payment कर दिया है। Receipt संभाल कर रखिए।";
  if (outcome === "PROMISE_TO_PAY") return english ? "Thanks, I have noted your payment commitment. Please pay from the secure link before the time you mentioned." : "धन्यवाद, मैं आपका payment commitment note कर रहा हूँ। बताए हुए समय से पहले secure link से payment कर दीजिए।";
  if (outcome === "CALLBACK") return english ? "Sure, we will contact you later. Thank you." : "ठीक है, हम बाद में संपर्क करेंगे। धन्यवाद।";
  if (outcome === "WRONG_NUMBER") return english ? "Sorry about that, I am marking this as a wrong number. Thank you." : "माफ कीजिए, मैं इस number को wrong number mark कर रहा हूँ। धन्यवाद।";
  if (outcome === "OPTED_OUT") return english ? "Understood. We will not call you again. Thank you." : "समझ गया। हम आपको दोबारा call नहीं करेंगे। धन्यवाद।";
  return "ठीक है, मैं call यहीं close कर रहा हूँ। धन्यवाद।";
}

function callScreeningReply(session = {}) {
  return terminalClosingText("CALL_SCREENING", session);
}

async function speakAndClose(ws, session, text, markName) {
  clearNoSpeechTimers(session);
  clearInterimTimer(session);
  await speakText(ws, session, text, markName);
  await sleep(Number(process.env.VOICEBOT_END_CLOSE_GRACE_MS || 900));
  if (!session.closed && ws.readyState === ws.OPEN) ws.close();
}

async function closeQuietly(ws, session) {
  clearNoSpeechTimers(session);
  clearInterimTimer(session);
  await sleep(Number(process.env.VOICEBOT_NON_HUMAN_CLOSE_GRACE_MS || 100));
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

function formatLoanAmount(value) {
  const number = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(number) || number <= 0) return `₹${value}`;
  return `₹${Math.round(number).toLocaleString("en-IN")}`;
}

function mentionsMissingLink(text) {
  return /(link nahi|link nahin|link नहीं|लिंक नहीं|लिंक नही|लिंक नहीं है|लिंक नही है|नहीं है मेरे पास|नही है मेरे पास|mere paas nahi|mere paas nahin)/.test(text);
}

function mentionsLinkProblem(text) {
  return /(link.*(open nahi|open nahin|not opening|nahi khul|nahin khul|error|expired|expire|काम नहीं|work nahi)|लिंक.*(नहीं खुल|नही खुल|error|एरर|expire|expired|काम नहीं|काम नही)|app.*(open nahi|not opening|nahi khul|error)|ऐप.*(नहीं खुल|नही खुल|error|एरर))/.test(text);
}

function asksSendDetails(text) {
  return /(send details|share details|details bhej|details send|whatsapp|sms|message kar|मेसेज|मैसेज|डिटेल भेज|details भेज|व्हाट्सऐप|वॉट्सऐप|एस एम एस|sms भेज)/.test(text);
}

function mentionsWrongAnswer(text) {
  return /(ye nahi|ye nahin|यह नहीं|ये नहीं|यह नही|ये नही|not asked|did not ask|wrong answer|गलत जवाब|गलत समझ|nahi pucha|nahin pucha|नहीं पूछा|नही पूछा)/.test(text);
}

function asksIdentity(text) {
  return /(who are you|who is this|which company|company name|कौन बोल|कौन हो|किस company|किस कंपनी|कंपनी का नाम|company ka naam|कहाँ से बोल|kahan se bol|loanconnect kaun|लोन कनेक्ट कौन)/.test(text);
}

function asksDataSource(text) {
  return /(got my number|where.*number|number.*kaha|number.*कहाँ|मेरा number|मेरे number|मेरा नंबर|मेरे नंबर|data kaha|data कहाँ|कहाँ से मिला|कहा से मिला)/.test(text);
}

function asksHumanSupport(text) {
  return /(agent|human|person|representative|customer care|support se baat|talk to.*support|कस्टमर केयर|support से बात|सपोर्ट से बात|किसी आदमी|इंसान से बात|agent से बात)/.test(text);
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

function asksInterestRate(text) {
  return /(rate of interest|interest rate|\broi\b|\binterest\b|ब्याज|ब्याज दर|इंटरेस्ट|इंट्रेस्ट|रेट ऑफ|रेट क्या|दर क्या|कितना ब्याज|कितनी ब्याज)/.test(text);
}

function asksFeesOrCharges(text) {
  return /(processing fee|process fee|fees|fee|charge|charges|hidden charge|penalty|late fee|प्रोसेसिंग|फीस|चार्ज|शुल्क|पेनल्टी|जुर्माना|लेट fee|लेट फीस)/.test(text);
}

function asksPenalty(text) {
  return /(penalty|late fee|late charge|everyday charge|delay charge|पेनल्टी|जुर्माना|लेट fee|लेट फीस|late fees|देर से|देरी)/.test(text);
}

function asksEmiOrTenure(text) {
  return /(emi|e m i|installment|instalment|tenure|month|months|किस्त|किश्त|ई एम आई|ईएमआई|महीने|कितने महीने|टेन्योर)/.test(text);
}

function asksChangeAmount(text) {
  return /(reduce.*amount|lower amount|increase.*amount|higher amount|amount kam|amount badh|कम amount|कम अमाउंट|ज्यादा amount|ज़्यादा amount|अमाउंट कम|अमाउंट बढ़|राशि कम|राशि बढ़)/.test(text);
}

function asksDocuments(text) {
  return /(document|documents|doc|docs|kyc|aadhaar|aadhar|pan|salary slip|bank statement|डॉक्यूमेंट|डाक्यूमेंट|कागज|कागज़|के वाई सी|आधार|पैन|सैलरी|बैंक statement|बैंक स्टेटमेंट)/.test(text);
}

function asksSafety(text) {
  return /(safe|secure|genuine|real|fraud|scam|trust|सुरक्षित|सेफ|सच में|असली|फ्रॉड|धोखा|भरोसा)/.test(text);
}

function asksOtpOrSensitiveDetails(text) {
  return /(otp|o t p|pin|password|card detail|aadhaar otp|aadhar otp|ओ टी पी|ओटीपी|पिन|पासवर्ड|card details|कार्ड details|आधार ओटीपी|आधार ओ टी पी)/.test(text);
}

function asksForgotLogin(text) {
  return /(forgot.*login|login.*forgot|login nahi|login nahin|password bhool|password भूल|login भूल|पासवर्ड भूल|login नहीं|login नही|लॉगिन नहीं|लॉगिन नही|लॉगिन भूल)/.test(text);
}

function asksApprovalStatus(text) {
  return /(why.*not approved|not approved|approval status|pending.*approval|what.*pending|kyun approve|approve क्यों|approved नहीं|approved नही|क्यों approve|pending क्या|क्या pending|क्या बचा|document pending|kyc pending)/.test(text);
}

function asksEligibilityCriteria(text) {
  return /(minimum income|salary required|income required|eligible kaise|eligibility criteria|self employed|business.*loan|salary slip required|कितनी income|income चाहिए|salary चाहिए|self employed|business वाले|eligible कैसे|eligibility कैसे)/.test(text);
}

function asksProcessAfterDocs(text) {
  return /(after upload|after documents|upload ke baad|document ke baad|kyc ke baad|upload करने के बाद|document के बाद|documents के बाद|kyc के बाद|आगे क्या)/.test(text);
}

function asksDisbursal(text) {
  return /(disbursal|disbursement|money.*account|account.*money|kab milega|कब मिलेगा|पैसा कब|account में कब|खाते में कब|bank में कब|डिस्बर्स)/.test(text);
}

function asksCibil(text) {
  return /(cibil|credit score|bureau|सिबिल|क्रेडिट score|क्रेडिट स्कोर|ब्यूरो)/.test(text);
}

function asksCommitmentOrRejection(text) {
  return /(commitment|compulsory|mandatory|reject|cancel|can i say no|without commitment|force|reject kar|cancel kar|compulsory है|ज़रूरी है|जरूरी है|मना कर|reject कर|cancel कर|loan lena padega|लेना पड़ेगा)/.test(text);
}

function asksOfferValidity(text) {
  return /(valid|validity|expire|expiry|kab tak|कब तक|valid कब|expire कब|expiry कब|offer कब तक|ऑफर कब तक|offer expire)/.test(text);
}

function asksDueDate(text) {
  return /(due date|payment date|last date|pay date|कब payment|payment कब|पेमेंट कब|due कब|due date|ड्यू date|ड्यू डेट|last date|आखिरी date|आखिरी तारीख)/.test(text);
}

function asksPayAmount(text) {
  return /(how much.*pay|pay कितना|pay kitna|payment amount|payable amount|कितना pay|कितना पे|कितनी payment|कितना payment|पेमेंट amount|payable)/.test(text);
}

function mentionsPaymentFailed(text) {
  return /(payment failed|payment fail|payment stuck|money debited|amount debited|paid but failed|पेमेंट failed|पेमेंट fail|payment अटक|पेमेंट अटक|पैसा कट|पैसे कट|amount debit|debit हो गया)/.test(text);
}

function asksPartialPayment(text) {
  return /(partial payment|part payment|pay partially|half payment|thoda pay|थोड़ा pay|थोड़ा पे|part payment|partial|आधा payment|आधा पे)/.test(text);
}

function asksEarlyPayment(text) {
  return /(pay early|early payment|advance payment|prepay|pre payment|jaldi pay|पहले payment|early closure|जल्दी payment|पहले पे|advance में)/.test(text);
}

function asksRestructureOrHardship(text) {
  return /(restructur|easy emi|extend|extension|job lost|lost job|no job|salary nahi|cannot pay|can't pay|cant pay|unable to pay|financial problem|पैसे नहीं|पैसे नही|pay नहीं कर|pay नही कर|नौकरी चली|salary नहीं|salary नही|extend कर|extension|easy emi|ईज़ी ई एम आई|रीस्ट्रक्चर)/.test(text);
}

function asksConfused(text) {
  return /(samajh nahi|samajh nahin|samajh nahi aaya|understand nahi|understand nahin|confused|clear nahi|समझ नहीं|समझ नही|समझ नहीं आया|समझ नही आया|clear नहीं|क्लियर नहीं)/.test(text);
}

function asksReason(text) {
  return /(kyun|why|kisliye|क्यों|किसलिए|किस लिये|call kyu|कॉल क्यों)/.test(text);
}

function asksQuestion(text) {
  return /(question|poochna|puchna|पूछना|सवाल|जानना|doubt|डाउट|दिक्कत|problem|issue|समस्या)/.test(text);
}

function isNameConfirmationTurn(text) {
  if (asksQuestion(text)) return false;
  if (/(loan|amount|rate|interest|emi|fee|charge|link|offer|payment|due|callback|busy|not interested|लोन|पेमेंट|ब्याज|लिंक|ऑफर)/.test(text)) {
    return false;
  }
  return true;
}

function firstGreeting(lead) {
  return stageFirstGreeting(lead) || FAST_INTRO_TEXT;
}

function stageFirstGreeting(lead = {}) {
  const english = normalizePreferredLanguage(lead.language) === "English";
  const product = productNameForLead(lead);
  const stage = String(lead.drop_stage || lead.playbook_type || "");
  const amount = lead.offer_amount || lead.loan_amount;
  const amountText = amount ? formatLoanAmount(amount) : "";

  if (stage === "SELFIE_PENDING") {
    return english
      ? `Hi, this is ${product}'s AI assistant. Your loan application is pending at live selfie. Can you complete it now?`
      : `नमस्ते, ${product} से AI assistant बोल रहा हूँ। आपकी loan application live selfie step पर pending है। क्या आप अभी complete कर सकते हैं?`;
  }
  if (stage === "AADHAAR_PENDING") {
    return english
      ? `Hi, this is ${product}'s AI assistant. Your Aadhaar DigiLocker KYC is pending in the app. Can you complete it now?`
      : `नमस्ते, ${product} से AI assistant बोल रहा हूँ। आपकी Aadhaar DigiLocker KYC app में pending है। क्या आप अभी complete कर सकते हैं?`;
  }
  if (stage === "PROFILE_PENDING") {
    return english
      ? `Hi, this is ${product}'s AI assistant. A profile detail is pending before final eligibility. Can you open the app now?`
      : `नमस्ते, ${product} से AI assistant बोल रहा हूँ। Final eligibility से पहले profile detail pending है। क्या आप अभी app खोल सकते हैं?`;
  }
  if (stage === "BANK_VERIFICATION_PENDING") {
    return english
      ? `Hi, this is ${product}'s AI assistant. Your${amountText ? ` ${amountText}` : ""} loan offer is ready, but bank verification is pending. Can you do it now?`
      : `नमस्ते, ${product} से AI assistant बोल रहा हूँ। आपका${amountText ? ` ${amountText}` : ""} loan offer ready है, बस bank verification pending है। क्या अभी कर सकते हैं?`;
  }
  if (stage === "E_SIGN_PENDING") {
    return english
      ? `Hi, this is ${product}'s AI assistant. Your loan is at the final e-sign step. Can you review and e-sign in the app now?`
      : `नमस्ते, ${product} से AI assistant बोल रहा हूँ। आपका loan final e-sign step पर है। क्या आप अभी app में review करके e-sign कर सकते हैं?`;
  }
  if (stage === "APPROVED_NOT_DISBURSED") {
    return english
      ? `Hi, this is ${product}'s AI assistant. Your approval is visible, but disbursal is not complete. Which app screen do you see?`
      : `नमस्ते, ${product} से AI assistant बोल रहा हूँ। आपकी approval दिख रही है, लेकिन disbursal complete नहीं हुआ। App में कौन सा screen दिख रहा है?`;
  }
  return "";
}

function stagePositiveReply(session = {}, english = false) {
  const lead = session.lead || {};
  const stage = String(lead.drop_stage || lead.playbook_type || "");
  if (stage === "SELFIE_PENDING") {
    return english
      ? "Great. Open the secure app link, choose live selfie, and keep your face centered in the camera."
      : "बहुत अच्छा। Secure app link खोलिए, live selfie चुनिए, और face camera के center में रखिए।";
  }
  if (stage === "AADHAAR_PENDING") {
    return english
      ? "Great. Open the app and complete Aadhaar KYC through DigiLocker. Please do not share OTP on this call."
      : "बहुत अच्छा। App खोलकर DigiLocker से Aadhaar KYC complete कीजिए। OTP इस call पर share मत कीजिए।";
  }
  if (stage === "PROFILE_PENDING") {
    return english
      ? "Great. Open the app and fill the pending profile field. It may be income, employer, PAN, or pincode."
      : "बहुत अच्छा। App खोलकर pending profile field भरिए। यह income, employer, PAN या pincode हो सकता है।";
  }
  if (stage === "BANK_VERIFICATION_PENDING") {
    return english
      ? "Great. Open the app and complete bank verification using UPI or bank account details."
      : "बहुत अच्छा। App खोलकर UPI या bank account details से bank verification complete कीजिए।";
  }
  if (stage === "E_SIGN_PENDING") {
    return english
      ? "Great. Review the amount and terms in the app, then e-sign only if you are comfortable."
      : "बहुत अच्छा। App में amount और terms review कीजिए, comfortable हों तभी e-sign कीजिए।";
  }
  if (stage === "APPROVED_NOT_DISBURSED") {
    return english
      ? "Great. Tell me which screen you see in the app, and I will guide the next step."
      : "बहुत अच्छा। App में कौन सा screen दिख रहा है बताइए, मैं next step guide कर दूँगा।";
  }
  return "";
}

function stageReasonReply(session = {}, english = false) {
  const lead = session.lead || {};
  const stage = String(lead.drop_stage || lead.playbook_type || "");
  if (stage === "SELFIE_PENDING") {
    return english
      ? "The call is because your loan application cannot move ahead until live selfie is completed."
      : "यह call इसलिए है क्योंकि live selfie complete हुए बिना application आगे नहीं बढ़ पाएगी।";
  }
  if (stage === "AADHAAR_PENDING") {
    return english
      ? "The call is because Aadhaar KYC is pending, and final eligibility needs that step."
      : "यह call इसलिए है क्योंकि Aadhaar KYC pending है, और final eligibility के लिए यह step जरूरी है।";
  }
  if (stage === "BANK_VERIFICATION_PENDING") {
    return english
      ? "Your offer is ready, but bank verification is pending before agreement or disbursal can move ahead."
      : "आपका offer ready है, लेकिन agreement या disbursal से पहले bank verification pending है।";
  }
  if (stage === "E_SIGN_PENDING") {
    return english
      ? "Your loan is at the final agreement step. E-sign is needed before disbursal can move ahead."
      : "आपका loan final agreement step पर है। Disbursal आगे बढ़ाने के लिए e-sign जरूरी है।";
  }
  return "";
}

function productNameForLead(lead = {}) {
  return lead.source_metadata?.productName || process.env.VOICEBOT_PRODUCT_NAME || "LoanConnect";
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
  session.lastSpokenText = text;
  session.lastSpokenMark = markName;
  session.activeSpeechMark = markName;
  session.activeSpeechMediaStartedAt = 0;
  session.activeSpeechChunksSent = 0;
  const speechSeq = (session.speechSeq || 0) + 1;
  session.speechSeq = speechSeq;
  session.activeSpeechSeq = speechSeq;
  session.speaking = true;
  const startedAt = Date.now();
  const stopKeepalive = SILENCE_KEEPALIVE_ENABLED ? startSilenceKeepalive(ws, session, markName) : () => {};
  try {
    const pcmBase64 = await getPcmBase64(text, session);
    stopKeepalive();

    if (pcmBase64) {
      const sendResult = await sendMedia(ws, session, pcmBase64, speechSeq);
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
    if (session.activeSpeechSeq === speechSeq) {
      session.speaking = false;
      session.activeSpeechMark = "";
      session.activeSpeechMediaStartedAt = 0;
      session.activeSpeechChunksSent = 0;
    }
  }
}

function shouldCancelAssistantSpeech(session, status = {}) {
  if (!session.activeSpeechSeq) return false;

  const mark = String(session.activeSpeechMark || "");
  const isIntro = mark.includes("intro");
  if (isIntro && !INTRO_BARGE_IN_ENABLED) {
    logVoicebotEvent(session, "barge_in_ignored", {
      reason: "intro_protected",
      mark,
      provider: status.provider || "",
      signalType: status.signalType || status.type || ""
    }).catch(() => {});
    return false;
  }

  const mediaStartedAt = session.activeSpeechMediaStartedAt || 0;
  const speechAgeMs = mediaStartedAt ? Date.now() - mediaStartedAt : 0;
  const chunksSent = session.activeSpeechChunksSent || 0;
  if (speechAgeMs < BARGE_IN_GRACE_MS || chunksSent < BARGE_IN_MIN_CHUNKS) {
    logVoicebotEvent(session, "barge_in_ignored", {
      reason: "speech_grace_period",
      mark,
      speechAgeMs,
      chunksSent,
      minChunks: BARGE_IN_MIN_CHUNKS,
      graceMs: BARGE_IN_GRACE_MS,
      provider: status.provider || "",
      signalType: status.signalType || status.type || ""
    }).catch(() => {});
    return false;
  }

  return true;
}

function cancelAssistantSpeech(ws, session, reason = "") {
  const speechSeq = session.activeSpeechSeq || 0;
  if (!speechSeq) return;
  session.cancelSpeechSeq = Math.max(session.cancelSpeechSeq || 0, speechSeq);
  if (BARGE_IN_CLEAR_ENABLED && ws.readyState === ws.OPEN && session.streamSid) {
    ws.send(JSON.stringify({
      event: "clear",
      stream_sid: session.streamSid
    }));
  }
  logVoicebotEvent(session, "assistant_speech_cancelled", {
    reason,
    speechSeq,
    activeTurnSeq: session.activeTurnSeq,
    clearSent: Boolean(BARGE_IN_CLEAR_ENABLED && session.streamSid)
  }).catch(() => {});
}

async function getPcmBase64(text, session = {}) {
  const sampleRate = session.mediaSampleRate || 8000;
  const volume = Number(process.env.VOICEBOT_TTS_VOLUME || 1.6);
  const ttsLanguageCode = ttsLanguageCodeForSession(session);
  const speechText = prepareTextForSpeech(text, session);
  const speaker = process.env.SARVAM_TTS_SPEAKER || "shubh";
  const model = process.env.SARVAM_TTS_MODEL || "bulbul:v2";
  const charCount = charLength(speechText);
  const cacheKey = buildAudioCacheKey({
    text: speechText,
    languageCode: ttsLanguageCode,
    speaker,
    model,
    sampleRate,
    volume
  });
  const memoryKey = `pcm:${cacheKey}`;

  if (pcmCache.has(memoryKey)) {
    trackTtsCacheHit(session, { charCount, cacheKey, source: "memory" });
    return pcmCache.get(memoryKey);
  }

  if (AUDIO_CACHE_ENABLED) {
    const cached = await getCachedAudio(cacheKey);
    if (cached?.pcm_base64) {
      const pcmBase64 = cached.pcm_base64;
      trackTtsCacheHit(session, { charCount: Number(cached.char_count || charCount), cacheKey, source: "persistent" });
      if (pcmCache.size < Number(process.env.VOICEBOT_PCM_CACHE_LIMIT || 50)) {
        pcmCache.set(memoryKey, pcmBase64);
      }
      return pcmBase64;
    }
  }

  trackTtsCacheMiss(session, { charCount, cacheKey });

  const speech = await synthesizeSpeech(speechText, { languageCode: ttsLanguageCode });
  if (speech.mode !== "audio") return null;

  const pcmBase64 = await toExotelPcmBase64(speech.audioBase64, { sampleRate, volume });
  if (pcmCache.size < Number(process.env.VOICEBOT_PCM_CACHE_LIMIT || 50)) {
    pcmCache.set(memoryKey, pcmBase64);
  }
  trackTtsDynamic(session, {
    charCount: speech.charCount || charCount,
    cacheKey,
    model: speech.model || model,
    speaker: speech.speaker || speaker,
    languageCode: speech.languageCode || ttsLanguageCode
  });
  await saveCachedAudio({
    cacheKey,
    text: speechText,
    languageCode: speech.languageCode || ttsLanguageCode,
    speaker: speech.speaker || speaker,
    model: speech.model || model,
    sampleRate,
    volume,
    mimeType: "audio/pcm",
    pcmBase64,
    source: "dynamic_tts"
  });
  return pcmBase64;
}

function trackTtsCacheHit(session, details = {}) {
  session.ttsCharsCached = Number(session.ttsCharsCached || 0) + Number(details.charCount || 0);
  session.ttsCacheHits = Number(session.ttsCacheHits || 0) + 1;
  logVoicebotEvent(session, "tts_cache_hit", {
    cacheKey: details.cacheKey,
    source: details.source || "unknown",
    charCount: Number(details.charCount || 0)
  }).catch(() => {});
}

function trackTtsCacheMiss(session, details = {}) {
  session.ttsCacheMisses = Number(session.ttsCacheMisses || 0) + 1;
  logVoicebotEvent(session, "tts_cache_miss", {
    cacheKey: details.cacheKey,
    charCount: Number(details.charCount || 0)
  }).catch(() => {});
}

function trackTtsDynamic(session, details = {}) {
  session.ttsCharsDynamic = Number(session.ttsCharsDynamic || 0) + Number(details.charCount || 0);
  logVoicebotEvent(session, "tts_generated", {
    cacheKey: details.cacheKey,
    charCount: Number(details.charCount || 0),
    model: details.model || "",
    speaker: details.speaker || "",
    languageCode: details.languageCode || ""
  }).catch(() => {});
}

function prepareTextForSpeech(text, session = {}) {
  const base = String(text || "");
  if (isEnglishSession(session)) {
    return base
      .replace(/\bLoanConnect\b/gi, "Loan Connect")
      .replace(/\bTezCredit\b/gi, "Tez Credit")
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
    .replace(/\bTezCredit\b/gi, "तेज़ क्रेडिट")
    .replace(/\bDigiLocker\b/gi, "डिजी लॉकर")
    .replace(/\bAadhaar\b/gi, "आधार")
    .replace(/\bPAN\b/gi, "पैन")
    .replace(/\bUPI\b/gi, "यू पी आई")
    .replace(/\be-sign\b/gi, "ई साइन")
    .replace(/\besign\b/gi, "ई साइन")
    .replace(/\bselfie\b/gi, "सेल्फी")
    .replace(/\bdisbursal\b/gi, "डिस्बर्सल")
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

async function sendMedia(ws, session, audioBase64, speechSeq = session.activeSpeechSeq || 0) {
  if (ws.readyState !== ws.OPEN) return { chunks: 0, stoppedEarly: true, chunkBytes: outboundChunkBytes(), pcmBytes: 0 };
  const chunkBytes = outboundChunkBytes();
  const rawAudio = prependPreroll(Buffer.from(audioBase64, "base64"), session);
  const audio = padToChunkSize(rawAudio, chunkBytes);
  let chunks = 0;
  session.activeSpeechMediaStartedAt = Date.now();
  session.activeSpeechChunksSent = 0;

  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    if (ws.readyState !== ws.OPEN || session.closed) break;
    if (speechSeq && (session.cancelSpeechSeq || 0) >= speechSeq) break;
    const chunk = audio.subarray(offset, offset + chunkBytes);
    const payload = chunk.toString("base64");
    sendMediaFrame(ws, session, payload, pcmTimestampMs(session, offset));
    chunks++;
    if (session.activeSpeechSeq === speechSeq) session.activeSpeechChunksSent = chunks;
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
  await persistCallMetrics(session, durationSeconds);
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
  await persistCallMetrics(session, durationSeconds);
}

async function persistCallMetrics(session, durationSeconds) {
  if (!session.callId) return;
  const metrics = buildCallMetrics(session, durationSeconds);
  try {
    await query(
      `UPDATE calls
       SET tts_chars_dynamic=$2,
           tts_chars_cached=$3,
           tts_cache_hits=$4,
           tts_cache_misses=$5,
           stt_audio_ms_sent=$6,
           stt_audio_ms_wall=$7,
           llm_calls_count=$8,
           llm_input_tokens=$9,
           llm_output_tokens=$10,
           cache_hit_ratio=$11,
           cost_estimate=$12,
           cost_breakdown=$13::jsonb,
           updated_at=NOW()
       WHERE id=$1`,
      [
        session.callId,
        metrics.ttsCharsDynamic,
        metrics.ttsCharsCached,
        metrics.ttsCacheHits,
        metrics.ttsCacheMisses,
        metrics.sttAudioMsSent,
        metrics.sttAudioMsWall,
        metrics.llmCallsCount,
        metrics.llmInputTokens,
        metrics.llmOutputTokens,
        metrics.cacheHitRatio,
        metrics.costEstimateInr,
        JSON.stringify(metrics.costBreakdown)
      ]
    );
  } catch (err) {
    if (isMissingCostSchema(err)) {
      logger.warn("voicebot_cost_metrics_schema_missing", { callId: session.callId, code: err.code });
      return;
    }
    throw err;
  }
}

function buildCallMetrics(session, durationSeconds) {
  const sampleRate = Number(session.mediaSampleRate || 8000);
  const ttsCharsDynamic = wholeNumber(session.ttsCharsDynamic);
  const ttsCharsCached = wholeNumber(session.ttsCharsCached);
  const totalTtsChars = ttsCharsDynamic + ttsCharsCached;
  const sttAudioMsSent = pcmBytesToMs(session.sttAudioBytes, sampleRate);
  const sttAudioMsWall = pcmBytesToMs(session.bytesReceived, sampleRate);
  const llmInputTokens = wholeNumber(session.llmInputTokens);
  const llmOutputTokens = wholeNumber(session.llmOutputTokens);
  const costBreakdown = computeVoicebotCallCost({
    durationSeconds,
    sttAudioMsSent,
    ttsCharsDynamic,
    ttsCharsCached,
    llmInputTokens,
    llmOutputTokens,
    vad: {
      enabled: VAD_ENABLED,
      suppressedBytes: wholeNumber(session.sttVadSuppressedBytes),
      suppressedChunks: wholeNumber(session.sttVadSuppressedChunks),
      speechStarts: wholeNumber(session.sttVadSpeechStarts),
      speechEnds: wholeNumber(session.sttVadSpeechEnds),
      skippedDuringAssistantBytes: wholeNumber(session.sttAudioSkippedBytes)
    }
  });

  return {
    ttsCharsDynamic,
    ttsCharsCached,
    ttsCacheHits: wholeNumber(session.ttsCacheHits),
    ttsCacheMisses: wholeNumber(session.ttsCacheMisses),
    sttAudioMsSent,
    sttAudioMsWall,
    llmCallsCount: wholeNumber(session.llmCallsCount),
    llmInputTokens,
    llmOutputTokens,
    cacheHitRatio: totalTtsChars ? roundRatio(ttsCharsCached / totalTtsChars) : 0,
    costEstimateInr: costBreakdown.totalInclGstInr,
    costBreakdown
  };
}

function computeVoicebotCallCost({ durationSeconds, sttAudioMsSent, ttsCharsDynamic, ttsCharsCached, llmInputTokens, llmOutputTokens, vad = {} }) {
  const rates = voicebotCostRates();
  const connectedMinutes = Math.max(0, Number(durationSeconds || 0) / 60);
  const billableMinutes = connectedMinutes > 0 ? Math.max(1, Math.ceil(connectedMinutes)) : 0;
  const sttHours = Math.max(0, Number(sttAudioMsSent || 0) / 3600000);
  const llmTokens = wholeNumber(llmInputTokens) + wholeNumber(llmOutputTokens);

  const exotelVoiceInr = roundMoney(billableMinutes * rates.exotelOutboundCostPerMinuteInr);
  const exotelAttemptInr = roundMoney(rates.exotelAttemptCostInr);
  const sarvamSttInr = roundMoney(sttHours * rates.sarvamSttCostPerHourInr);
  const sarvamTtsInr = roundMoney((wholeNumber(ttsCharsDynamic) / 1000) * rates.sarvamTtsCostPer1kCharsInr);
  const sarvamLlmInr = roundMoney((llmTokens / 1000) * rates.sarvamLlmCostPer1kTokensInr);
  const infraInr = roundMoney(connectedMinutes * rates.infraCostPerMinuteInr);
  const subtotalInr = roundMoney(exotelVoiceInr + exotelAttemptInr + sarvamSttInr + sarvamTtsInr + sarvamLlmInr + infraInr);
  const gstInr = roundMoney(subtotalInr * rates.gstRate);
  const totalInclGstInr = roundMoney(subtotalInr + gstInr);
  const cachedTtsSavingsInr = roundMoney((wholeNumber(ttsCharsCached) / 1000) * rates.sarvamTtsCostPer1kCharsInr);

  return {
    model: "voicebot_direct_cost_v1",
    currency: "INR",
    usage: {
      durationSeconds: wholeNumber(durationSeconds),
      connectedMinutes: roundUsage(connectedMinutes),
      billableMinutes,
      sttAudioMsSent: wholeNumber(sttAudioMsSent),
      ttsCharsDynamic: wholeNumber(ttsCharsDynamic),
      ttsCharsCached: wholeNumber(ttsCharsCached),
      llmInputTokens: wholeNumber(llmInputTokens),
      llmOutputTokens: wholeNumber(llmOutputTokens),
      vad
    },
    rates,
    components: {
      exotelVoiceInr,
      exotelAttemptInr,
      sarvamSttInr,
      sarvamTtsInr,
      sarvamLlmInr,
      infraInr,
      gstInr
    },
    cachedTtsSavingsInr,
    subtotalInr,
    totalInclGstInr,
    costPerConnectedMinuteInclGstInr: connectedMinutes ? roundMoney(totalInclGstInr / connectedMinutes) : totalInclGstInr
  };
}

function voicebotCostRates() {
  const exotelMinute = moneyEnv("EXOTEL_COST_PER_MINUTE_INR", 0.6);
  return {
    exotelOutboundCostPerMinuteInr: moneyEnv("EXOTEL_OUTBOUND_COST_PER_MINUTE_INR", exotelMinute),
    exotelAttemptCostInr: moneyEnv("EXOTEL_ATTEMPT_COST_INR", 0.06),
    sarvamSttCostPerHourInr: moneyEnv("SARVAM_STT_COST_PER_HOUR_INR", 30),
    sarvamTtsCostPer1kCharsInr: moneyEnv("SARVAM_TTS_COST_PER_1K_CHARS_INR", 1.5),
    sarvamLlmCostPer1kTokensInr: moneyEnv("SARVAM_LLM_COST_PER_1K_TOKENS_INR", 0.01),
    infraCostPerMinuteInr: moneyEnv("INFRA_COST_PER_MINUTE_INR", 0.03),
    gstRate: numberEnv("GST_RATE", 0.18)
  };
}

function pcmBytesToMs(bytes, sampleRate) {
  const rate = Number(sampleRate || 8000);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return wholeNumber((Number(bytes || 0) / (rate * 2)) * 1000);
}

function wholeNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.round(number);
}

function moneyEnv(name, fallback = 0) {
  const raw = process.env[name];
  const value = Number(raw === undefined || raw === "" ? fallback : raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function numberEnv(name, fallback = 0) {
  const raw = process.env[name];
  const value = Number(raw === undefined || raw === "" ? fallback : raw);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function roundMoney(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 100) / 100;
}

function roundUsage(value) {
  const number = Number(value || 0);
  return Math.round((Number.isFinite(number) ? number : 0) * 1000) / 1000;
}

function roundRatio(value) {
  const number = Number(value || 0);
  return Math.round(Math.min(Math.max(number, 0), 1) * 10000) / 10000;
}

function isMissingCostSchema(err) {
  return ["42P01", "42703"].includes(err?.code);
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

module.exports = {
  attachVoicebot,
  _test: {
    beginUserTurn,
    buildConversationState,
    buildScriptedReply,
    extractNameAnswer,
    firstGreeting,
    invalidateAssistantTurn,
    contextualNegativeReply,
    isContextualNegativeReply,
    isCurrentTurn,
    normalizeVoiceIntent,
    shouldCancelAssistantSpeech,
    updateConversationMemory
  }
};
