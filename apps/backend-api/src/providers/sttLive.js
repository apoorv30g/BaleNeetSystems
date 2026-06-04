const config = require("../config");
const { createDeepgramLive } = require("./deepgramLive");
const { createSarvamLive } = require("./sarvamLive");

const DEFAULT_PRIMARY = "sarvam";
const DEFAULT_FALLBACK = "deepgram";

function createLiveStt({ leadLanguage, onTranscript, onOpen, onClose, onStatus, onError }) {
  const primaryProvider = normalizeProvider(process.env.STT_PROVIDER || DEFAULT_PRIMARY);
  const fallbackProvider = normalizeProvider(process.env.STT_FALLBACK_PROVIDER || DEFAULT_FALLBACK);
  const replayLimitBytes = Number(process.env.STT_FALLBACK_REPLAY_BYTES || 96000);
  const primaryOpenTimeoutMs = Number(process.env.STT_PRIMARY_OPEN_TIMEOUT_MS || 3500);
  const primaryNormalCloseReconnects = Number(process.env.STT_PRIMARY_NORMAL_CLOSE_RECONNECTS || 3);
  const primaryReconnectDelayMs = Number(process.env.STT_PRIMARY_RECONNECT_DELAY_MS || 250);
  const recentAudio = [];
  let recentBytes = 0;
  let active = null;
  let activeProvider = "";
  let activeGeneration = 0;
  let primaryNormalCloseReconnectCount = 0;
  let fallbackUsed = false;
  let closedByClient = false;
  let openTimer = null;

  const client = {
    get ready() {
      return Boolean(active?.ready);
    },
    get provider() {
      return activeProvider || primaryProvider;
    },
    sendAudio(buffer) {
      if (!buffer?.length) return;
      rememberAudio(buffer);
      active?.sendAudio(buffer);
    },
    close() {
      closedByClient = true;
      clearOpenTimer();
      active?.close();
    }
  };

  startProvider(primaryProvider, "primary");
  return client;

  function startProvider(provider, reason) {
    clearOpenTimer();
    const generation = ++activeGeneration;
    const normalized = normalizeProvider(provider);
    if (!normalized) {
      emitStatus({ provider, type: "ProviderUnavailable", reason: "invalid_provider" });
      maybeStartFallback(provider, "invalid_provider");
      return;
    }

    if (!isConfigured(normalized)) {
      emitStatus({ provider: normalized, type: "ProviderUnavailable", reason: "missing_api_key" });
      maybeStartFallback(normalized, "missing_api_key");
      return;
    }

    activeProvider = normalized;
    active = createProvider(normalized, {
      leadLanguage,
      onOpen: details => {
        if (generation !== activeGeneration) return;
        clearOpenTimer();
        onOpen?.({ provider: normalized, reason, ...details });
      },
      onClose: details => {
        const replaced = generation !== activeGeneration;
        if (!replaced) clearOpenTimer();
        onClose?.({ provider: normalized, replaced, ...details });
        if (!closedByClient && !replaced && shouldReconnectPrimary(normalized, details)) {
          primaryNormalCloseReconnectCount++;
          const nextAttempt = primaryNormalCloseReconnectCount + 1;
          emitStatus({
            provider: normalized,
            type: "ReconnectAttempt",
            reason: `normal_close_${details?.code || "unknown"}`,
            nextAttempt,
            maxReconnects: primaryNormalCloseReconnects
          });
          setTimeout(() => {
            if (!closedByClient && activeGeneration === generation) startProvider(normalized, "primary_reconnect");
          }, primaryReconnectDelayMs);
          return;
        }
        if (!closedByClient && !replaced) {
          maybeStartFallback(normalized, `close_${details?.code || "unknown"}`);
        }
      },
      onStatus: status => {
        if (generation !== activeGeneration) return;
        const enriched = { provider: normalized, ...status };
        emitStatus(enriched);
        if (status?.type === "UnexpectedResponse") {
          maybeStartFallback(normalized, `unexpected_response_${status.statusCode || ""}`);
        }
      },
      onTranscript: event => {
        if (generation !== activeGeneration) return;
        if (normalized === primaryProvider) primaryNormalCloseReconnectCount = 0;
        onTranscript?.({ provider: normalized, ...event });
      },
      onError: err => {
        if (generation !== activeGeneration) return;
        onError?.(err, { provider: normalized });
      }
    });

    replayRecentAudio(active);
    if (normalized === primaryProvider && primaryOpenTimeoutMs > 0) {
      openTimer = setTimeout(() => {
        emitStatus({ provider: normalized, type: "OpenTimeout", timeoutMs: primaryOpenTimeoutMs });
        maybeStartFallback(normalized, "open_timeout");
      }, primaryOpenTimeoutMs);
    }
  }

  function maybeStartFallback(fromProvider, reason) {
    const fallback = normalizeProvider(fallbackProvider);
    if (closedByClient || fallbackUsed || !fallback || fallback === normalizeProvider(fromProvider)) return false;
    fallbackUsed = true;

    if (!isConfigured(fallback)) {
      emitStatus({ provider: fallback, type: "FallbackUnavailable", fromProvider, reason, fallback, availability: "missing_api_key" });
      return false;
    }

    emitStatus({ provider: fallback, type: "FallbackStarted", fromProvider, reason, fallback });
    const previous = active;
    startProvider(fallback, "fallback");
    if (previous && previous !== active) previous.close();
    return true;
  }

  function rememberAudio(buffer) {
    if (!Number.isFinite(replayLimitBytes) || replayLimitBytes <= 0) return;
    recentAudio.push(buffer);
    recentBytes += buffer.length;
    while (recentBytes > replayLimitBytes && recentAudio.length) {
      recentBytes -= recentAudio.shift().length;
    }
  }

  function replayRecentAudio(target) {
    if (!target || !recentAudio.length) return;
    for (const buffer of recentAudio) target.sendAudio(buffer);
  }

  function clearOpenTimer() {
    if (!openTimer) return;
    clearTimeout(openTimer);
    openTimer = null;
  }

  function emitStatus(status) {
    onStatus?.(status);
  }

  function shouldReconnectPrimary(provider, details = {}) {
    if (provider !== primaryProvider) return false;
    if (fallbackUsed) return false;
    if (primaryNormalCloseReconnectCount >= primaryNormalCloseReconnects) return false;
    if (details.closedByClient) return false;
    return Number(details.code) === 1000;
  }
}

function createProvider(provider, options) {
  if (provider === "deepgram") {
    return createDeepgramLive({
      language: sttLanguageForProvider("deepgram", options.leadLanguage),
      onTranscript: options.onTranscript,
      onOpen: options.onOpen,
      onClose: options.onClose,
      onStatus: options.onStatus,
      onError: options.onError
    });
  }

  return createSarvamLive({
    languageCode: sttLanguageForProvider("sarvam", options.leadLanguage),
    onTranscript: options.onTranscript,
    onOpen: options.onOpen,
    onClose: options.onClose,
    onStatus: options.onStatus,
    onError: options.onError
  });
}

function sttLanguageForProvider(provider, language) {
  const value = String(language || "").toLowerCase();
  if (provider === "deepgram") {
    if (value.includes("english")) return "en";
    if (value.includes("hinglish")) return process.env.DEEPGRAM_LANGUAGE || "multi";
    if (value.includes("hindi")) return "hi";
    return process.env.DEEPGRAM_LANGUAGE || "multi";
  }

  const explicit = process.env.SARVAM_STT_LANGUAGE_CODE;
  if (explicit) return explicit;
  if (value.includes("english")) return "en-IN";
  if (value.includes("bengali")) return "bn-IN";
  if (value.includes("gujarati")) return "gu-IN";
  if (value.includes("kannada")) return "kn-IN";
  if (value.includes("malayalam")) return "ml-IN";
  if (value.includes("marathi")) return "mr-IN";
  if (value.includes("punjabi")) return "pa-IN";
  if (value.includes("tamil")) return "ta-IN";
  if (value.includes("telugu")) return "te-IN";
  return "hi-IN";
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (["sarvam", "sarvam-live", "saaras"].includes(provider)) return "sarvam";
  if (["deepgram", "deepgram-live"].includes(provider)) return "deepgram";
  if (["none", "off", "false"].includes(provider)) return "";
  return provider;
}

function isConfigured(provider) {
  if (provider === "sarvam") return Boolean(config.ai.sarvamApiKey);
  if (provider === "deepgram") return Boolean(config.ai.deepgramApiKey);
  return false;
}

function liveSttProviderStatus() {
  const primary = normalizeProvider(process.env.STT_PROVIDER || DEFAULT_PRIMARY);
  const fallback = normalizeProvider(process.env.STT_FALLBACK_PROVIDER || DEFAULT_FALLBACK);
  return {
    primary,
    fallback,
    primaryConfigured: isConfigured(primary),
    fallbackConfigured: isConfigured(fallback)
  };
}

module.exports = { createLiveStt, liveSttProviderStatus, sttLanguageForProvider };
