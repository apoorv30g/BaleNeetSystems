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
Respond now in one natural Hinglish sentence, maximum 18 words. No bullet points.`
      }]
    }],
    generationConfig: {
      maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 80),
      temperature: Number(process.env.GEMINI_TEMPERATURE || 0.4)
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
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || fallbackReply(lead);
  }

  throw new Error(`Gemini failed for all configured models: ${errors.join(" | ")}`);
}

function uniqueModels(models) {
  return [...new Set(models.map(model => String(model || "").trim()).filter(Boolean))];
}

function fallbackReply(lead) {
  if (lead.playbook_type === "SOFT_PAYMENT_REMINDER") {
    return `Namaste ${lead.name || ""} ji, aapki payment due date nazdeek hai. Agar aap abhi pay kar dete hain to repayment record positive rahega. Main secure payment link bhej deta hoon.`;
  }
  if (lead.playbook_type === "HARD_PAYMENT_REMINDER") {
    return `Namaste ${lead.name || ""} ji, aapki payment due date miss ho gayi hai. Late fee aur CIBIL impact avoid karne ke liye payment jaldi complete karna better rahega.`;
  }
  if (lead.playbook_type === "APPROVED_USERS") {
    return `Namaste ${lead.name || ""} ji, aapka loan offer ready hai aur expire ho sakta hai. Agar aap chahein to main process continue karne ka secure link bhej deta hoon.`;
  }
  if (lead.playbook_type === "FRESH_LEAD") {
    return `Namaste ${lead.name || ""} ji, main loan eligibility ke regarding call kar raha hoon. Aap 2 minute mein eligibility check kar sakte hain.`;
  }
  return `Namaste ${lead.name || ""} ji, aapka loan application incomplete hai. Main aapko secure link bhej deta hoon jisse aap process complete kar sakte hain.`;
}

module.exports = { generateReply };
