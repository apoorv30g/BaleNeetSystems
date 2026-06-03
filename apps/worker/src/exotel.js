const config = require("./config");

function authHeader() {
  return `Basic ${Buffer.from(`${config.exotel.apiKey}:${config.exotel.apiToken}`).toString("base64")}`;
}

async function triggerOutboundCall({ to, leadId, campaignId, callId }) {
  if (config.dryRunCalls) {
    console.log("[dry-run] call", { to, leadId, campaignId, callId, mode: config.exotel.outboundMode });
    return { callSid: `dryrun_${Date.now()}`, dryRun: true };
  }

  if (!config.callDispatchEnabled) {
    throw new Error("Call dispatch is disabled. Set CALL_DISPATCH_ENABLED=true to place paid Exotel calls.");
  }

  if (!config.exotel.accountSid || !config.exotel.apiKey || !config.exotel.apiToken) {
    console.log("[mock] call", { to, leadId, campaignId });
    return { callSid: `mock_${Date.now()}` };
  }

  const endpoint = `${config.exotel.apiBase}/v1/Accounts/${config.exotel.accountSid}/Calls/connect`;
  const statusCallback = `${config.serverUrl}/webhooks/exotel/status`;
  const customField = `lc_call:${callId};lead:${leadId};campaign:${campaignId}`;
  const params = new FormData();
  params.set("From", formatCustomerNumber(to));
  params.set("CallerId", config.exotel.fromNumber);
  params.set("TimeOut", String(config.exotel.ringTimeoutSeconds));
  params.set("TimeLimit", String(config.exotel.timeLimitSeconds));
  params.set("CustomField", customField);
  if (config.exotel.outboundMode === "flow") {
    if (!config.exotel.flowUrl) throw new Error("EXOTEL_FLOW_URL is required when EXOTEL_OUTBOUND_MODE=flow");
    params.set("Url", config.exotel.flowUrl);
  } else if (config.exotel.outboundMode === "exoml") {
    const answerUrl = new URL(`${config.serverUrl}/webhooks/exotel/answer`);
    answerUrl.searchParams.set("leadId", leadId);
    answerUrl.searchParams.set("campaignId", campaignId);
    answerUrl.searchParams.set("callId", callId);
    params.set("Url", answerUrl.toString());
  } else {
    params.set("StreamType", "bidirectional");
    params.set("StreamUrl", `${config.serverUrl.replace(/^http/, "ws")}/webhooks/exotel/voicebot?leadId=${encodeURIComponent(leadId)}&campaignId=${encodeURIComponent(campaignId)}&callId=${encodeURIComponent(callId)}`);
    params.set("StreamName", "loanconnect_bot");
  }
  params.set("Record", "true");
  params.set("StatusCallback", statusCallback);
  if (config.exotel.outboundMode === "direct") {
    params.append("StatusCallbackEvents[]", "answered");
    params.append("StatusCallbackEvents[]", "terminal");
  }

  const res = await fetch(endpoint, { method: "POST", headers: { Authorization: authHeader() }, body: params });
  const text = await res.text();
  if (!res.ok) throw new Error(`Exotel failed: ${text}`);

  let callSid = `exotel_${Date.now()}`;
  try {
    const json = JSON.parse(text);
    callSid = json?.Call?.Sid || json?.Call?.CallSid || json?.call?.sid || json?.call?.call_sid || callSid;
  } catch {
    const sidMatch = text.match(/<Sid>([^<]+)<\/Sid>/i);
    if (sidMatch?.[1]) callSid = sidMatch[1];
  }
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
