const config = require("./config");

function authHeader() {
  return `Basic ${Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString("base64")}`;
}

async function triggerOutboundCall({ to, leadId, campaignId, callId }) {
  if (!config.exotel.accountSid || !config.exotel.apiKey || !config.exotel.apiToken) {
    console.log("[mock] call", { to, leadId, campaignId });
    return { callSid: `mock_${Date.now()}` };
  }

  const endpoint = `${config.exotel.apiBase}/v1/Accounts/${config.exotel.accountSid}/Calls/connect`;
  const streamUrl = `${config.serverUrl.replace(/^http/, "ws")}/webhooks/exotel/voicebot/connect?leadId=${encodeURIComponent(leadId)}&campaignId=${encodeURIComponent(campaignId)}&callId=${encodeURIComponent(callId)}`;
  const statusCallback = `${config.serverUrl}/webhooks/exotel/status`;
  const params = new FormData();
  params.set("From", formatCustomerNumber(to));
  params.set("CallerId", config.exotel.fromNumber);
  params.set("callerid", config.exotel.fromNumber);
  params.set("StreamType", "bidirectional");
  params.set("streamtype", "bidirectional");
  params.set("StreamUrl", streamUrl);
  params.set("streamurl", streamUrl);
  params.set("StreamName", "loanconnect_bot");
  params.set("streamname", "loanconnect_bot");
  params.set("Record", "true");
  params.set("record", "true");
  params.set("TimeOut", String(config.exotel.ringTimeoutSeconds));
  params.set("TimeLimit", String(config.exotel.timeLimitSeconds));
  params.set("timelimit", String(config.exotel.timeLimitSeconds));
  params.set("CustomField", `lc_call:${callId}`);
  params.set("customfield", `lc_call:${callId}`);
  if (config.exotel.callType) params.set("CallType", config.exotel.callType);
  if (config.exotel.callType) params.set("calltype", config.exotel.callType);
  params.set("StatusCallback", statusCallback);
  params.set("statuscallback", statusCallback);
  params.append("StatusCallbackEvents[]", "ringing");
  params.append("StatusCallbackEvents[]", "answered");
  params.append("StatusCallbackEvents[]", "terminal");
  params.append("statuscallbackevents[]", "ringing");
  params.append("statuscallbackevents[]", "answered");
  params.append("statuscallbackevents[]", "terminal");

  const res = await fetch(endpoint, { method: "POST", headers: { Authorization: authHeader() }, body: params });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel failed: ${text}`);

  let callSid = `exotel_${Date.now()}`;
  try {
    const json = JSON.parse(text);
    callSid = json?.Call?.Sid || json?.Call?.CallSid || json?.call?.sid || json?.call?.call_sid || callSid;
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
