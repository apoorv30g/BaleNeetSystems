const config = require("../config");
const { generateReply: generateGeminiReply } = require("./gemini");
const { generateSarvamReply } = require("./sarvamChat");

const DEFAULT_PRIMARY = "sarvam";
const DEFAULT_FALLBACK = "gemini";

async function generateReply(args) {
  const primary = normalizeProvider(process.env.LLM_PROVIDER || DEFAULT_PRIMARY);
  const fallback = normalizeProvider(process.env.LLM_FALLBACK_PROVIDER || DEFAULT_FALLBACK);
  const providers = uniqueProviders([primary, fallback]);
  const errors = [];

  for (const provider of providers) {
    try {
      return await generateWithProvider(provider, args);
    } catch (err) {
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
    geminiModel: config.ai.geminiModel
  };
}

function isConfigured(provider) {
  if (provider === "sarvam") return Boolean(config.ai.sarvamApiKey);
  if (provider === "gemini") return Boolean(config.ai.geminiApiKey);
  return false;
}

module.exports = { generateReply, llmProviderStatus };
