const config = require("../config");
const { generateReply: generateGeminiReply } = require("./gemini");
const { generateSarvamReply } = require("./sarvamChat");

const DEFAULT_PRIMARY = "sarvam";
const DEFAULT_FALLBACK = "gemini";

// Simple circuit breaker — fast-fails a provider after THRESHOLD consecutive errors,
// then re-allows after RESET_MS to let it recover.
const CIRCUIT_THRESHOLD = Number(process.env.LLM_CIRCUIT_THRESHOLD || 5);
const CIRCUIT_RESET_MS = Number(process.env.LLM_CIRCUIT_RESET_MS || 30000);
const circuitState = {}; // { [provider]: { failures: number, openAt: number|null } }

function getCircuit(provider) {
  if (!circuitState[provider]) circuitState[provider] = { failures: 0, openAt: null };
  return circuitState[provider];
}

function isCircuitOpen(provider) {
  const c = getCircuit(provider);
  if (c.openAt === null) return false;
  if (Date.now() - c.openAt > CIRCUIT_RESET_MS) {
    c.openAt = null; // half-open: allow one probe
    return false;
  }
  return true;
}

function recordSuccess(provider) {
  const c = getCircuit(provider);
  c.failures = 0;
  c.openAt = null;
}

function recordFailure(provider) {
  const c = getCircuit(provider);
  c.failures += 1;
  if (c.failures >= CIRCUIT_THRESHOLD) c.openAt = Date.now();
}

async function generateReply(args) {
  const primary = normalizeProvider(process.env.LLM_PROVIDER || DEFAULT_PRIMARY);
  const fallback = normalizeProvider(process.env.LLM_FALLBACK_PROVIDER || DEFAULT_FALLBACK);
  const providers = uniqueProviders([primary, fallback]);
  const errors = [];

  for (const provider of providers) {
    if (isCircuitOpen(provider)) {
      errors.push(`${provider}: circuit open (too many recent failures)`);
      continue;
    }
    try {
      const result = await generateWithProvider(provider, args);
      recordSuccess(provider);
      return result;
    } catch (err) {
      recordFailure(provider);
      errors.push(`${provider}: ${err.message}`);
    }
  }

  throw new Error(`LLM failed for all configured providers: ${errors.join(" | ")}`);
}

async function generateWithProvider(provider, args) {
  if (provider === "sarvam") return generateSarvamReply(args);
  if (provider === "gemini") return generateGeminiReply(args);
  throw new Error(`Unsupported LLM provider: ${provider}`);
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  if (["sarvam", "sarvam-chat", "sarvam-m"].includes(provider)) return "sarvam";
  if (["gemini", "google", "google-gemini"].includes(provider)) return "gemini";
  if (["none", "off", "false"].includes(provider)) return "";
  return provider;
}

function uniqueProviders(providers) {
  return [...new Set(providers.map(normalizeProvider).filter(Boolean))];
}

function llmProviderStatus() {
  const primary = normalizeProvider(process.env.LLM_PROVIDER || DEFAULT_PRIMARY);
  const fallback = normalizeProvider(process.env.LLM_FALLBACK_PROVIDER || DEFAULT_FALLBACK);
  return {
    primary,
    fallback,
    primaryConfigured: isConfigured(primary),
    fallbackConfigured: isConfigured(fallback),
    sarvamModel: process.env.SARVAM_CHAT_MODEL || "sarvam-30b",
    geminiModel: config.ai.geminiModel,
    circuits: Object.fromEntries(
      Object.entries(circuitState).map(([p, c]) => [p, { open: isCircuitOpen(p), failures: c.failures }])
    )
  };
}

function isConfigured(provider) {
  if (provider === "sarvam") return Boolean(config.ai.sarvamApiKey);
  if (provider === "gemini") return Boolean(config.ai.geminiApiKey);
  return false;
}

module.exports = { generateReply, llmProviderStatus };
