const config = require("./config");

function authHeader() {
  return `Basic ${Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString("base64")}`;
}

async function triggerOutboundCall({ to, leadId, campaignId }) {
  if (!config.exotel.accountSid || !config.exotel.apiKey || !config.exotel.apiToken) {
    console.log("[mock] call", { to, leadId, campaignId });
    return { callSid: `mock_${Date.now()}` };
  }

  const endpoint = `${config.exotel.apiBase}/v1/Accounts/${config.exotel.accountSid}/Calls/connect`;
  const params = new FormData();
  params.set("From", formatCustomerNumber(to));
  params.set("CallerId", config.exotel.fromNumber);
  params.set("StreamType", "bidirectional");
  params.set("StreamUrl", `${config.serverUrl.replace(/^http/, "ws")}/webhooks/exotel/voicebot?leadId=${encodeURIComponent(leadId)}&campaignId=${encodeURIComponent(campaignId)}`);
  params.set("StreamName", "loanconnect_bot");
  params.set("Record", "true");
  params.set("StatusCallback", `${config.serverUrl}/webhooks/exotel/status`);
  params.append("StatusCallbackEvents[]", "answered");
  params.append("StatusCallbackEvents[]", "terminal");

  const res = await fetch(endpoint, { method: "POST", headers: { Authorization: authHeader() }, body: params });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel failed: ${text}`);

  let callSid = `exotel_${Date.now()}`;
  try {
    const json = JSON.parse(text);
    callSid = json?.Call?.Sid || json?.Call?.CallSid || callSid;
  } catch {}
  return { callSid, raw: text };
}

function formatCustomerNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  return value;
}

module.exports = { triggerOutboundCall };
