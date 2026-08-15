const { query } = require("../db/pool");
const logger = require("../utils/logger");

// Collections-specific guardrails and capture, per RBI fair-practice expectations for
// recovery conduct. Pure functions where possible so they are testable without a database.

// ---------------------------------------------------------------------------
// Third-party disclosure prevention
// ---------------------------------------------------------------------------
//
// RBI guidance prohibits disclosing a borrower's debt to relatives, employers, neighbours or
// other third parties. On an outbound call the bot cannot assume the person who answered is
// the borrower -- phones are shared, numbers get reassigned, family members pick up.
//
// So: until identity is CONFIRMED, the bot must not mention amounts, overdue status, EMIs, or
// anything that reveals a debt exists. This detects the answerer signalling they are not the
// borrower, so the flow can close politely instead of continuing to a debt discussion.

const THIRD_PARTY_PATTERNS = [
  // English
  /\b(?:wrong|not the right)\s+(?:number|person)\b/i,
  /\b(?:this|it)(?:'s| is)?\s+not\s+(?:me|him|her|his|hers)\b/i,
  /\bhe(?:'s| is)?\s+not\s+(?:here|available|home)\b/i,
  /\bshe(?:'s| is)?\s+not\s+(?:here|available|home)\b/i,
  /\bwho(?:'s| is)?\s+(?:this|calling)\b/i,
  /\b(?:i am|i'm)\s+(?:his|her|their)\s+(?:wife|husband|father|mother|son|daughter|brother|sister|friend|colleague)\b/i,
  /\bdoes not (?:live|stay) here\b/i,
  /\bno (?:such|one by that) (?:person|name)\b/i,
  // Hinglish (Latin script -- \b works here)
  /\bgalat\s*(?:number|nambar)\b/i,
  /\bwo\s+(?:ghar\s+)?(?:par\s+)?nahi\s+h(?:ai|ain)?\b/i,
  /\bkaun\s+bol\s+rah[ae]\b/i,
  /\byahan\s+koi\s+aisa\s+nahi\b/i,
  // Devanagari: NO \b here. JavaScript's \b is defined against \w, which is ASCII-only, so
  // there is never a word boundary beside a Devanagari character -- a \b-anchored Hindi
  // pattern silently never matches.
  /गलत\s*(?:नंबर|नम्बर)/,
  /वो\s+(?:घर\s+)?(?:पर\s+)?नहीं\s+ह(?:ैं|ै)/,
  /मैं\s+(?:उनकी|उनका|इनकी|इनका)\s+(?:पत्नी|पति|बेटा|बेटी|भाई|बहन)/,
  /कौन\s+बोल\s+रह[ाे]/
];

/**
 * True when the answerer has signalled they are not the borrower.
 * Used to suppress any debt disclosure and close the call politely.
 */
function isThirdPartyAnswerer(text = "") {
  const value = String(text || "");
  if (!value.trim()) return false;
  return THIRD_PARTY_PATTERNS.some(pattern => pattern.test(value));
}

// Anything that would reveal a debt exists. Checked against outbound bot speech BEFORE
// identity is confirmed -- a belt-and-braces companion to the flow's own gating, since the
// LLM fallback path can produce text the scripted flow never authored.
const DEBT_DISCLOSURE_PATTERNS = [
  /\b(?:emi|e\.m\.i)\b/i,
  /\b(?:overdue|outstanding|arrears|default(?:ed)?|delinquent)\b/i,
  /\b(?:loan|repayment|installment|instalment)\s+(?:amount|due|pending|payment)\b/i,
  /\b(?:due|pending)\s+(?:amount|payment|installment|instalment)\b/i,
  /(?:₹|rs\.?\s*|inr\s*)\d/i,
  // Merely confirming a lending RELATIONSHIP exists is itself a disclosure to a third party --
  // "your bank verification is pending" tells them this person has applied for credit, even
  // with no amount attached. These terms come straight from the live scripted flow, so the
  // grounded/scripted path is covered too, not just invented LLM text.
  /\b(?:bank verification|kyc verification|pan verification)\b/i,
  /\b(?:disbursal|disbursement|sanction(?:ed|ing)?)\b/i,
  /\byour (?:loan|offer|application|credit|account)\b/i,
  /\b(?:loan|credit)\s+(?:application|agreement|offer)\b/i,
  /\baapka[ea]?\s+(?:loan|offer|emi|amount|application)\b/i,
  // Devanagari without \b -- see the note on THIRD_PARTY_PATTERNS above.
  /बकाया/,
  /किस्त/,
  /क़र्ज़?|कर्ज/,
  /लोन\s+(?:की|का)\s+(?:राशि|भुगतान|किस्त)/,
  /आपका\s+(?:लोन|ऑफर|offer|loan|application)/,
  /(?:bank|बैंक)\s*verification/i
];

/**
 * Returns the debt-revealing fragments in a proposed reply, or [] when it is safe to speak
 * to an unidentified answerer.
 */
function debtDisclosureIssues(text = "") {
  const value = String(text || "");
  const issues = [];
  for (const pattern of DEBT_DISCLOSURE_PATTERNS) {
    const match = value.match(pattern);
    if (match) issues.push(`debt_disclosure:${match[0].trim().slice(0, 40)}`);
  }
  return issues;
}

/**
 * Guards a reply about to be spoken to someone whose identity is not confirmed.
 * @returns {{ safe: boolean, issues: string[] }}
 */
function guardThirdPartyDisclosure(text, { identityConfirmed = false } = {}) {
  if (identityConfirmed) return { safe: true, issues: [] };
  const issues = debtDisclosureIssues(text);
  return { safe: issues.length === 0, issues };
}

// ---------------------------------------------------------------------------
// Promise-to-pay capture
// ---------------------------------------------------------------------------

const AMOUNT_PATTERN = /(?:₹|rs\.?\s*|inr\s*)?\s*(\d{1,3}(?:,\d{2,3})+|\d{3,7})(?:\s*(?:rupees|rupaye|रुपये|रुपए))?/i;

// NOTE ON \b AND DEVANAGARI: JavaScript's \b is defined against \w, which is ASCII-only, so
// there is NEVER a word boundary beside a Devanagari character. `/\b(?:आज)\b/` silently never
// matches. Latin alternatives keep \b; Devanagari alternatives are listed separately without it.
const RELATIVE_DAYS = [
  [/\b(?:today|aaj)\b|आज/i, 0],
  [/\b(?:tomorrow|kal)\b|कल/i, 1],
  [/\b(?:day after tomorrow|parso)\b|परसों/i, 2],
  [/\b(?:next week|agle hafte)\b|अगले\s+हफ्ते/i, 7]
];

const PAY_INTENT = /\b(?:pay|paid|payment|kar dunga|kar dungi|kar denge|de dunga|de dungi|bhar dunga|karunga|karungi)\b|भर\s*द(?:ूंगा|ूँगा)|कर\s*द(?:ूंगा|ूँगा)|दे\s*द(?:ूंगा|ूँगा)|भुगतान/i;

/**
 * Extracts a promise-to-pay from a customer utterance.
 * Conservative on purpose: a wrongly-recorded commitment is worse than a missed one, because
 * collections teams act on these and a false promise means a wasted (and annoying) follow-up.
 *
 * @returns {{ amount: number|null, date: string|null, raw: string }|null}
 */
function extractPromiseToPay(text = "", now = new Date()) {
  const value = String(text || "").trim();
  if (!value || !PAY_INTENT.test(value)) return null;

  let amount = null;
  const amountMatch = value.match(AMOUNT_PATTERN);
  if (amountMatch) {
    const parsed = Number(String(amountMatch[1]).replace(/,/g, ""));
    // Ignore implausible values -- "pay 5" is far more likely a stray digit than a commitment.
    if (Number.isFinite(parsed) && parsed >= 100 && parsed <= 10000000) amount = parsed;
  }

  let date = null;
  for (const [pattern, offsetDays] of RELATIVE_DAYS) {
    if (pattern.test(value)) {
      const d = new Date(now.getTime());
      d.setDate(d.getDate() + offsetDays);
      date = d.toISOString().slice(0, 10);
      break;
    }
  }

  // An explicit day-of-month, e.g. "on the 15th" / "15 tarikh ko".
  if (!date) {
    // Trailing \b would fail after "तारीख" (see the Devanagari note above), so the Hindi
    // alternative is anchored on a non-word lookahead instead.
    const dom = value.match(/\b(\d{1,2})\s*(?:(?:th|st|nd|rd|tarikh)\b|तारीख)/i);
    if (dom) {
      const day = Number(dom[1]);
      if (day >= 1 && day <= 31) {
        const d = new Date(now.getTime());
        // A day already past this month means next month.
        if (day < d.getDate()) d.setMonth(d.getMonth() + 1);
        d.setDate(day);
        date = d.toISOString().slice(0, 10);
      }
    }
  }

  // Intent alone, with neither an amount nor a date, is not a commitment worth recording.
  if (amount === null && date === null) return null;

  return { amount, date, raw: value.slice(0, 500) };
}

async function recordPromiseToPay({ tenantId, callId, leadId, amount, date, rawText }) {
  try {
    await query(
      `INSERT INTO promise_to_pay (tenant_id, call_id, lead_id, promised_amount, promised_date, raw_text)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tenantId, callId || null, leadId || null, amount ?? null, date || null, rawText || null]
    );
    return true;
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) {
      logger.warn("ptp_table_missing", { code: err.code });
      return false;
    }
    throw err;
  }
}

async function promisesForTenant(tenantId, { days = 30 } = {}) {
  const result = await query(
    `SELECT p.*, l.name AS lead_name, l.phone
     FROM promise_to_pay p
     LEFT JOIN leads l ON l.id = p.lead_id
     WHERE p.tenant_id = $1 AND p.created_at > NOW() - ($2 || ' days')::interval
     ORDER BY p.promised_date ASC NULLS LAST, p.created_at DESC`,
    [tenantId, String(days)]
  );
  return result.rows;
}

module.exports = {
  isThirdPartyAnswerer,
  debtDisclosureIssues,
  guardThirdPartyDisclosure,
  extractPromiseToPay,
  recordPromiseToPay,
  promisesForTenant,
  _test: { THIRD_PARTY_PATTERNS, DEBT_DISCLOSURE_PATTERNS }
};
