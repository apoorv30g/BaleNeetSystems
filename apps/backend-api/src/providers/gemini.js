const config = require("../config");
const { buildPrompt } = require("../services/playbooks");

async function generateReply({ lead, lastUserMessage = "", transcript = [] }) {
  if (!config.ai.geminiApiKey) {
    return fallbackReply(lead);
  }

  const prompt = await buildPrompt(lead, { transcript, lastUserMessage });
  const models = uniqueModels([config.ai.geminiModel, ...(config.ai.geminiFallbackModels || [])]);
  const errors = [];

  const body = {
    contents: [{
      parts: [{
        text: `${prompt}
Respond now in one natural Hinglish sentence, maximum 22 words. No bullet points.`
      }]
    }],
    generationConfig: {
      maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 80),
      temperature: Number(process.env.GEMINI_TEMPERATURE || 0.5)
    }
  };

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${config.ai.geminiApiKey}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      errors.push(`${model}: ${await res.text()}`);
      continue;
    }

    const data = await res.json();
    return cleanReply(data?.candidates?.[0]?.content?.parts?.[0]?.text) || fallbackReply(lead);
  }

  throw new Error(`Gemini failed for all configured models: ${errors.join(" | ")}`);
}

function uniqueModels(models) {
  return [...new Set(models.map(model => String(model || "").trim()).filter(Boolean))];
}

function cleanReply(value) {
  const maxWords = Number(process.env.GEMINI_REPLY_MAX_WORDS || 24);
  const text = String(value || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s"'`*_>-]+/g, "")
    .replace(/^\d+[\).:-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";
  const words = text.split(/\s+/);
  if (!Number.isFinite(maxWords) || words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(" ");
}

function fallbackReply(lead) {
  const name = firstName(lead.name);
  const prefix = name ? `${name} ji, ` : "";
  if (lead.playbook_type === "SOFT_PAYMENT_REMINDER") {
    return `${prefix}aapki payment due date paas hai. Kya main payment link abhi share kar doon?`;
  }
  if (lead.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `${prefix}payment overdue dikh rahi hai. Kya aap bata sakte hain payment kab tak kar payenge?`;
  }
  if (lead.playbook_type === "APPROVED_USERS") {
    return `${prefix}aapka loan offer ready hai. Kya aap ise aaj continue karna chahenge?`;
  }
  if (lead.playbook_type === "FRESH_LEAD") {
    return `${prefix}main loan eligibility ke liye call kar raha hoon. Aapko kitna loan chahiye?`;
  }
  return `${prefix}aapki loan eligibility pending hai. Kya main aapko final offer check karne mein guide karun?`;
}

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "";
}

module.exports = { generateReply };
