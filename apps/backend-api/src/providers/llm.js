const config = require("../config");
const { generateSarvamReply } = require("./sarvamChat");

// Sarvam is the ONLY supported LLM provider. Gemini was removed for India data-residency
// compliance -- borrower conversation data must not leave Indian jurisdiction, and Gemini
// is a US-hosted service. Do not reintroduce a non-Indian provider here without a
// compliance review.
const DEFAULT_PRIMARY = "sarvam";

// Circuit breaker — fast-fails after THRESHOLD consecutive errors, then re-allows after
// RESET_MS. With a single provider this no longer diverts traffic elsewhere; it stops us
// hammering a failing Sarvam and lets scripted-flow replies degrade quickly instead of
// each turn waiting on a doomed request.
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
  const provider = normalizeProvider(process.env.LLM_PROVIDER || DEFAULT_PRIMARY);
  if (!provider) throw new Error("LLM is disabled (LLM_PROVIDER is set to none)");

  if (isCircuitOpen(provider)) {
    throw new Error(`${provider}: circuit open (too many recent failures)`);
  }

  try {
    const result = await generateWithProvider(provider, args);
    recordSuccess(provider);
    return result;
  } catch (err) {
    recordFailure(provider);
    throw new Error(`LLM failed (${provider}): ${err.message}`);
  }
}

async function generateWithProvider(provider, args) {
  if (provider === "sarvam") return generateSarvamReply(args);
  throw new Error(`Unsupported LLM provider: ${provider}. Only "sarvam" is permitted (data-residency policy).`);
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  // "sarvam-m" here is a legacy PROVIDER-name alias some env configs still use, not the
  // deprecated sarvam-m chat MODEL. The actual model name is resolved separately via
  // config.ai.sarvamChatModel, which already guards against the deprecated model id.
  if (["sarvam", "sarvam-chat", "sarvam-m"].includes(provider)) return "sarvam";
  if (["none", "off", "false"].includes(provider)) return "";
  return provider;
}

function llmProviderStatus() {
  const primary = normalizeProvider(process.env.LLM_PROVIDER || DEFAULT_PRIMARY);
  return {
    primary,
    fallback: "",
    primaryConfigured: isConfigured(primary),
    fallbackConfigured: false,
    sarvamModel: config.ai.sarvamChatModel,
    circuits: Object.fromEntries(
      Object.entries(circuitState).map(([p, c]) => [p, { open: isCircuitOpen(p), failures: c.failures }])
    )
  };
}

function isConfigured(provider) {
  if (provider === "sarvam") return Boolean(config.ai.sarvamApiKey);
  return false;
}

module.exports = { generateReply, llmProviderStatus };
