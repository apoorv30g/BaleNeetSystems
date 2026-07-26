const { query } = require("../db/pool");
const logger = require("../utils/logger");

// Self-optimizing scripts: flow gate questions may define multiple phrasings (variants).
// The engine records which variant was spoken; this nightly job joins those events to call
// outcomes and computes a smoothed success weight per variant. The engine then samples
// variants proportionally to weight (with a floor, so no variant is ever starved and a
// currently-losing phrasing can recover) -- a light bandit, no per-call math.

const SUCCESS_OUTCOMES = ["INTERESTED", "JOURNEY_COMPLETED", "PROMISE_TO_PAY", "PAID"];

// Bayesian smoothing: (successes+1)/(spoken+2). New/low-data variants hover near 0.5 so
// they keep getting airtime until real evidence accumulates.
function computeWeight(spoken, successes) {
  const s = Math.max(0, Number(spoken) || 0);
  const w = (Math.max(0, Number(successes) || 0) + 1) / (s + 2);
  return Math.min(1, Math.max(0, w));
}

// Weighted random selection with a 0.1 floor per variant. `stats` maps variantIndex -> weight.
function pickVariantIndex(variantCount, stats = {}, rand = Math.random) {
  if (!Number.isInteger(variantCount) || variantCount <= 1) return 0;
  const weights = [];
  for (let i = 0; i < variantCount; i++) {
    // A genuine 0 weight (a consistently-losing variant) must stay near the floor -- distinguish
    // it from "no data yet" (undefined -> neutral 0.5). `|| 0.5` would wrongly rescue a real 0.
    const raw = stats[i];
    const base = raw == null || Number.isNaN(Number(raw)) ? 0.5 : Number(raw);
    weights.push(Math.max(0.1, base));
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rand() * total;
  for (let i = 0; i < variantCount; i++) {
    roll -= weights[i];
    if (roll <= 0) return i;
  }
  return variantCount - 1;
}

async function runVariantStatsBatch({ sinceDays = 14 } = {}) {
  let rows;
  try {
    rows = await query(
      `SELECT c.tenant_id,
              e.details->>'playbookKey' AS playbook_key,
              e.details->>'gateId' AS gate_id,
              (e.details->>'variantIndex')::int AS variant_index,
              COUNT(*)::int AS spoken,
              COUNT(*) FILTER (WHERE c.outcome = ANY($2))::int AS successes
       FROM voicebot_events e
       JOIN calls c ON c.call_sid = e.call_sid AND e.call_sid IS NOT NULL AND e.call_sid != ''
       WHERE e.event_type = 'flow_variant_spoken'
         AND e.created_at > NOW() - ($1 || ' days')::interval
         AND e.details->>'playbookKey' IS NOT NULL
       GROUP BY 1, 2, 3, 4`,
      [String(sinceDays), SUCCESS_OUTCOMES]
    );
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) return { skipped: true, reason: "tables_missing" };
    throw err;
  }

  let updated = 0;
  for (const row of rows.rows) {
    if (!row.tenant_id || !row.playbook_key || !row.gate_id || row.variant_index === null) continue;
    try {
      await query(
        `INSERT INTO flow_variant_stats (tenant_id, playbook_key, gate_id, variant_index, spoken, successes, weight, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (tenant_id, playbook_key, gate_id, variant_index) DO UPDATE SET
           spoken=EXCLUDED.spoken, successes=EXCLUDED.successes, weight=EXCLUDED.weight, updated_at=NOW()`,
        [row.tenant_id, row.playbook_key, row.gate_id, row.variant_index, row.spoken, row.successes, computeWeight(row.spoken, row.successes)]
      );
      updated++;
    } catch (err) {
      logger.warn("variant_stats_upsert_failed", { playbookKey: row.playbook_key, error: err.message });
    }
  }
  return { variants: rows.rows.length, updated };
}

// Loaded once per call (at lead attach) so the sync flow engine can sample without queries.
// Shape: { [gateId]: { [variantIndex]: weight } }
async function variantWeightsForPlaybook(tenantId, playbookKey) {
  try {
    const result = await query(
      `SELECT gate_id, variant_index, weight FROM flow_variant_stats
       WHERE tenant_id=$1 AND playbook_key=$2`,
      [tenantId, playbookKey]
    );
    if (!result.rows.length) return null;
    const weights = {};
    for (const row of result.rows) {
      weights[row.gate_id] = weights[row.gate_id] || {};
      weights[row.gate_id][row.variant_index] = Number(row.weight);
    }
    return weights;
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) return null;
    throw err;
  }
}

async function variantStatsForPlaybook(tenantId, playbookKey) {
  const result = await query(
    `SELECT gate_id, variant_index, spoken, successes, weight, updated_at
     FROM flow_variant_stats
     WHERE tenant_id=$1 AND playbook_key=$2
     ORDER BY gate_id, variant_index`,
    [tenantId, playbookKey]
  );
  return result.rows;
}

module.exports = {
  pickVariantIndex,
  runVariantStatsBatch,
  variantStatsForPlaybook,
  variantWeightsForPlaybook,
  _test: { computeWeight, pickVariantIndex, SUCCESS_OUTCOMES }
};
