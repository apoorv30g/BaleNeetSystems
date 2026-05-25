const config = require("./config");

function authHeader() {
  return `Basic ${Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString("base64")}`;
}

async function triggerOutboundCall({ to, leadId, campaignId }) {
  if (!config.exotel.accountSid || !config.exotel.apiKey || !config.exotel.apiToken) {
    console.log("[mock] call", { to, leadId, campaignId });
    return { callSid: `mock_${Date.now()}` };
  }

  const endpoint = `${config.exotel.apiBase}/v1/Accounts/${config.exotel.accountSid}/Calls/connect.json`;
  const params = new URLSearchParams();
  params.set("From", config.exotel.fromNumber);
  params.set("To", to);
  params.set("Url", `${config.serverUrl}/webhooks/exotel/answer?leadId=${leadId}&campaignId=${campaignId}`);
  params.set("StatusCallback", `${config.serverUrl}/webhooks/exotel/status`);

  const res = await fetch(endpoint, { method: "POST", headers: { Authorization: authHeader(), "Content-Type": "application/x-www-form-urlencoded" }, body: params });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel failed: ${text}`);

  let callSid = `exotel_${Date.now()}`;
  try {
    const json = JSON.parse(text);
    callSid = json?.Call?.Sid || json?.Call?.CallSid || callSid;
  } catch {}
  return { callSid, raw: text };
}

module.exports = { triggerOutboundCall };
