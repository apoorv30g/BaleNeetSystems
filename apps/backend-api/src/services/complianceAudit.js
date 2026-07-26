const { query } = require("../db/pool");
const logger = require("../utils/logger");

// Compliance autopilot: every call is audited (not sampled) against deterministic rules
// derived from RBI Fair Practices / TRAI expectations for lending calls:
//   - the bot identified itself (disclosure),
//   - never asked the customer FOR an OTP/PIN/password,
//   - never promised guaranteed approval,
//   - never used threatening/harassing language,
//   - honored opt-out requests,
//   - called inside the tenant's permitted calling window.
// Deterministic checks keep the audit free and reproducible; each failed check carries an
// evidence snippet so a human can verify the flag in seconds.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const CHECK_WEIGHTS = {
  disclosure_present: 15,
  no_otp_request: 30,
  no_guarantee: 20,
  no_threat: 30,
  opt_out_honored: 25,
  calling_window: 10
};

// Assistant ASKING for credentials -- must not match the scripts' own "we will never ask
// for OTP" disclaimers, so every pattern here requires an asking verb next to the token.
const OTP_REQUEST_PATTERNS = /(otp|pin|password|cvv|पासवर्ड|ओ ?टी ?पी).{0,20}(batao|bataiye|bata d|de do|de dijiye|de dena|boliye|bolo|share|send|likho|daal|बता|बताओ|बताइए|दे दीजिए|दे दो|बोलिए|भेजो|शेयर)|((batao|bataiye|bata|boliye|share|बता|बताओ|बताइए|बोलिए).{0,20}(otp|pin|password|ओ ?टी ?पी))/i;

const GUARANTEE_PATTERNS = /(guaranteed (approval|loan|disbursal)|100 ?% (approval|approve|guarantee)|pakka (mil|approve|loan)|zaroor mil jayega|पक्का (मिलेगा|मिल जाएगा|approve)|गारंटीड|ज़रूर मिल जाएगा|निश्चित रूप से मिलेगा)/i;

const THREAT_PATTERNS = /(legal action|police|arrest|jail|court|blacklist|ghar (aa|par aa)|recovery agent (aayega|bhejenge)|consequences will|पुलिस|गिरफ्तार|जेल|कोर्ट|कानूनी कार्रवाई|ब्लैकलिस्ट|घर (आ जाएंगे|भेजेंगे)|धमकी|अंजाम)/i;

const OPT_OUT_PATTERNS = /(do not call|dont call|don't call|never call|stop calling|remove my number|unsubscribe|dobara call (mat|nahi)|फिर कॉल मत|दोबारा (कॉल|फोन) मत|कॉल मत करना|फोन मत करना)/i;

function auditTranscript({ transcript = [], outcome = "", brandName = "", callHourIst = null, callWindow = null }) {
  const assistantLines = transcript.filter(t => t.speaker === "assistant").map(t => String(t.text || ""));
  const userLines = transcript.filter(t => t.speaker === "user").map(t => String(t.text || ""));
  const checks = {};
  const flags = [];

  const firstAssistant = assistantLines.slice(0, 2).join(" ");
  checks.disclosure_present = !assistantLines.length
    || !brandName
    || firstAssistant.toLowerCase().includes(String(brandName).toLowerCase());
  if (!checks.disclosure_present) {
    flags.push({ check: "disclosure_present", evidence: firstAssistant.slice(0, 160) });
  }

  const otpLine = assistantLines.find(line => OTP_REQUEST_PATTERNS.test(line) && !/never|kabhi nahi|नहीं (पूछ|मांग)|मत बताइए|मत बताओ|only on the website|सिर्फ.*website/i.test(line));
  checks.no_otp_request = !otpLine;
  if (otpLine) flags.push({ check: "no_otp_request", evidence: otpLine.slice(0, 160) });

  const guaranteeLine = assistantLines.find(line => GUARANTEE_PATTERNS.test(line));
  checks.no_guarantee = !guaranteeLine;
  if (guaranteeLine) flags.push({ check: "no_guarantee", evidence: guaranteeLine.slice(0, 160) });

  const threatLine = assistantLines.find(line => THREAT_PATTERNS.test(line));
  checks.no_threat = !threatLine;
  if (threatLine) flags.push({ check: "no_threat", evidence: threatLine.slice(0, 160) });

  const userOptedOut = userLines.some(line => OPT_OUT_PATTERNS.test(line));
  checks.opt_out_honored = !userOptedOut || outcome === "OPTED_OUT";
  if (!checks.opt_out_honored) {
    flags.push({ check: "opt_out_honored", evidence: `Customer asked to stop calls but outcome was ${outcome || "unset"}` });
  }

  checks.calling_window = callHourIst === null || !callWindow
    || (callHourIst >= callWindow.start && callHourIst < callWindow.end);
  if (!checks.calling_window) {
    flags.push({ check: "calling_window", evidence: `Call placed at ${callHourIst}:00 IST, window ${callWindow.start}:00-${callWindow.end}:00` });
  }

  let score = 100;
  for (const [check, passed] of Object.entries(checks)) {
    if (!passed) score -= CHECK_WEIGHTS[check] || 10;
  }
  score = Math.max(0, score);
  const verdict = score >= 90 ? "pass" : score >= 70 ? "warn" : "fail";
  return { score, verdict, checks, flags };
}

async function runComplianceAuditBatch({ sinceHours = 26, limit = 500 } = {}) {
  let calls;
  try {
    calls = await query(
      `SELECT c.id, c.tenant_id, c.campaign_id, c.outcome, c.created_at, l.playbook_type,
              ts.call_window_start, ts.call_window_end, ts.ai_disclosure
       FROM calls c
       JOIN leads l ON l.id = c.lead_id
       LEFT JOIN tenant_settings ts ON ts.tenant_id = c.tenant_id
       LEFT JOIN call_compliance_audits a ON a.call_id = c.id
       WHERE c.created_at > NOW() - ($1 || ' hours')::interval
         AND a.id IS NULL
       ORDER BY c.created_at DESC
       LIMIT $2`,
      [String(sinceHours), limit]
    );
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) return { skipped: true, reason: "tables_missing" };
    throw err;
  }

  let audited = 0;
  let flagged = 0;
  for (const call of calls.rows) {
    try {
      const transcript = await query(
        `SELECT speaker, text FROM transcripts WHERE call_id=$1 ORDER BY created_at, id`,
        [call.id]
      );
      if (!transcript.rows.length) continue;

      const brand = await brandNameForCall(call);
      const callHourIst = new Date(new Date(call.created_at).getTime() + IST_OFFSET_MS).getUTCHours();
      const result = auditTranscript({
        transcript: transcript.rows,
        outcome: call.outcome || "",
        brandName: brand,
        callHourIst,
        callWindow: call.call_window_start != null
          ? { start: Number(call.call_window_start), end: Number(call.call_window_end) }
          : null
      });

      await query(
        `INSERT INTO call_compliance_audits (call_id, tenant_id, campaign_id, score, verdict, checks, flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (call_id) DO NOTHING`,
        [call.id, call.tenant_id, call.campaign_id, result.score, result.verdict, JSON.stringify(result.checks), JSON.stringify(result.flags)]
      );
      audited++;
      if (result.flags.length) flagged++;
    } catch (err) {
      logger.warn("compliance_audit_call_failed", { callId: call.id, error: err.message });
    }
  }
  return { candidates: calls.rows.length, audited, flagged };
}

async function brandNameForCall(call) {
  try {
    const playbook = await query(
      `SELECT voice_config FROM playbooks WHERE tenant_id=$1 AND key=$2 LIMIT 1`,
      [call.tenant_id, call.playbook_type]
    );
    return playbook.rows[0]?.voice_config?.brand?.name || "";
  } catch {
    return "";
  }
}

async function auditSummary(tenantId, { sinceDays = 7 } = {}) {
  const result = await query(
    `SELECT COUNT(*)::int AS audited,
            COALESCE(AVG(score), 0)::numeric(5,1) AS avg_score,
            COUNT(*) FILTER (WHERE verdict='pass')::int AS passed,
            COUNT(*) FILTER (WHERE verdict='warn')::int AS warned,
            COUNT(*) FILTER (WHERE verdict='fail')::int AS failed
     FROM call_compliance_audits
     WHERE tenant_id=$1 AND created_at > NOW() - ($2 || ' days')::interval`,
    [tenantId, String(sinceDays)]
  );
  return result.rows[0];
}

async function flaggedCalls(tenantId, { limit = 50 } = {}) {
  const result = await query(
    `SELECT a.call_id, a.campaign_id, a.score, a.verdict, a.flags, a.created_at,
            l.name AS lead_name, l.phone
     FROM call_compliance_audits a
     JOIN calls c ON c.id = a.call_id
     LEFT JOIN leads l ON l.id = c.lead_id
     WHERE a.tenant_id=$1 AND a.verdict != 'pass'
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [tenantId, limit]
  );
  return result.rows;
}

module.exports = {
  auditSummary,
  flaggedCalls,
  runComplianceAuditBatch,
  _test: { auditTranscript, OTP_REQUEST_PATTERNS, THREAT_PATTERNS, GUARANTEE_PATTERNS }
};
