const { query } = require("../db/pool");

// Cross-campaign contact frequency caps.
//
// WHY THIS EXISTS SEPARATELY FROM max_call_attempts:
// `leads.attempt_count` / `campaigns.max_attempts` limit attempts for ONE lead row in ONE
// campaign. A borrower who appears in three campaigns (say an EMI reminder, an overdue
// follow-up, and a retargeting push) has three lead rows, each with its own counter -- so the
// existing limits permit three calls to the same person on the same day while every
// per-campaign check still reports "within limits".
//
// RBI fair-practice guidance for recovery explicitly calls out persistently bothering
// borrowers. So the cap that matters is per PERSON, not per lead row: keyed on the last 10
// digits of the phone number (the same normalisation used elsewhere for matching), scoped to
// the tenant, counted across all campaigns.
//
// ⚠️ THIS FILE IS THE ADVISORY/PREVIEW COPY, used by routes/campaigns.js to tell an operator
// how many queued leads will be skipped. ENFORCEMENT lives in apps/worker/src/index.js
// (`contactFrequencyBlock`), which runs immediately before dialling -- the counts change
// between queueing and dispatch, so the worker must re-check.
//
// The worker cannot import this module (separate npm workspace with its own db client, the
// same reason config.js is duplicated). If you change the rule here -- the window, the
// connected-status list, or the phone matching -- change it there too, or the preview will
// quietly disagree with what actually happens.

const DEFAULT_MAX_PER_DAY = Number(process.env.MAX_CONTACTS_PER_DAY || 1);
const DEFAULT_MAX_PER_WEEK = Number(process.env.MAX_CONTACTS_PER_WEEK || 3);

// Only calls that actually reached the person count against the cap. A failed dial or a
// busy signal is not "bothering" them, and counting it would silently strand borrowers whose
// number is temporarily unreachable.
const CONNECTED_STATUSES = ["completed", "streaming"];

/**
 * Counts recent connected contacts for a phone number across every campaign in the tenant.
 * @returns {{ today: number, week: number }}
 */
async function recentContactCounts(tenantId, phone) {
  const result = await query(
    `SELECT
       COUNT(*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '24 hours')::int AS today,
       COUNT(*) FILTER (WHERE c.created_at >= NOW() - INTERVAL '7 days')::int  AS week
     FROM calls c
     JOIN leads l ON l.id = c.lead_id
     WHERE c.tenant_id = $1
       AND RIGHT(l.phone, 10) = RIGHT($2, 10)
       AND c.status = ANY($3)`,
    [tenantId, String(phone || ""), CONNECTED_STATUSES]
  );
  const row = result.rows[0] || {};
  return { today: Number(row.today || 0), week: Number(row.week || 0) };
}

/**
 * Decides whether another call to this person is permitted right now.
 *
 * @returns {{ allowed: boolean, reason?: string, counts: object, limits: object }}
 */
async function checkContactFrequency(tenantId, phone, limits = {}) {
  const maxPerDay = Number(limits.maxPerDay ?? DEFAULT_MAX_PER_DAY);
  const maxPerWeek = Number(limits.maxPerWeek ?? DEFAULT_MAX_PER_WEEK);

  // A non-positive limit means "no cap" -- useful for non-collections campaigns.
  const dayCapped = maxPerDay > 0;
  const weekCapped = maxPerWeek > 0;
  if (!dayCapped && !weekCapped) {
    return { allowed: true, counts: { today: 0, week: 0 }, limits: { maxPerDay, maxPerWeek } };
  }

  if (!phone) {
    return { allowed: true, counts: { today: 0, week: 0 }, limits: { maxPerDay, maxPerWeek } };
  }

  const counts = await recentContactCounts(tenantId, phone);

  if (dayCapped && counts.today >= maxPerDay) {
    return {
      allowed: false,
      reason: `daily_contact_cap_reached (${counts.today}/${maxPerDay} in 24h across all campaigns)`,
      counts,
      limits: { maxPerDay, maxPerWeek }
    };
  }

  if (weekCapped && counts.week >= maxPerWeek) {
    return {
      allowed: false,
      reason: `weekly_contact_cap_reached (${counts.week}/${maxPerWeek} in 7d across all campaigns)`,
      counts,
      limits: { maxPerDay, maxPerWeek }
    };
  }

  return { allowed: true, counts, limits: { maxPerDay, maxPerWeek } };
}

module.exports = {
  checkContactFrequency,
  recentContactCounts,
  DEFAULT_MAX_PER_DAY,
  DEFAULT_MAX_PER_WEEK,
  CONNECTED_STATUSES
};
