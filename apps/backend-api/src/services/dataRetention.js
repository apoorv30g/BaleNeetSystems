const { query } = require("../db/pool");
const logger = require("../utils/logger");

// Data retention for borrower conversation records.
//
// Transcripts hold the most sensitive material this system produces: financial circumstances,
// hardship disclosures, personal details. Keeping them forever is both a breach-blast-radius
// problem and hard to defend to an NBFC's compliance team, which will ask "how long do you
// keep this and why".
//
// ON ENCRYPTION AT REST -- an honest note, because the obvious answer is wrong here:
// column-level encryption of transcripts was considered and NOT implemented. Several live
// features read transcript text directly -- the self-training miner (services/flowLearning.js),
// the compliance auditor's regex scans (services/complianceAudit.js), and transcript export.
// Encrypting the column would break all three, or force decryption of every row on every
// nightly job, which defeats the purpose. The appropriate control at this layer is FULL-DISK
// encryption on the database host (an ops decision, configured on the VPS) combined with the
// retention limits below. Revisit column-level encryption only if the threat model shifts to
// "attacker has database read access but not host access".

const DEFAULT_TRANSCRIPT_DAYS = Number(process.env.TRANSCRIPT_RETENTION_DAYS || 180);
const DEFAULT_EVENT_DAYS = Number(process.env.EVENT_RETENTION_DAYS || 90);
const DEFAULT_AUDIO_CACHE_HOURS = Number(process.env.AUDIO_CACHE_RETENTION_HOURS || 24);

// Deletes in bounded batches so a large backlog cannot hold a long transaction open and
// block live calls writing to the same tables.
const BATCH_SIZE = Number(process.env.RETENTION_BATCH_SIZE || 5000);

async function deleteInBatches(label, sql, params) {
  let totalDeleted = 0;
  for (let pass = 0; pass < 100; pass++) {
    let result;
    try {
      result = await query(sql, params);
    } catch (err) {
      // A missing table on an un-migrated database should not fail the whole run.
      if (["42P01", "42703"].includes(err.code)) {
        logger.warn("retention_table_missing", { label, code: err.code });
        return { label, deleted: totalDeleted, skipped: true };
      }
      throw err;
    }
    const deleted = result.rowCount || 0;
    totalDeleted += deleted;
    if (deleted < BATCH_SIZE) break;
  }
  return { label, deleted: totalDeleted };
}

async function runRetentionSweep({
  transcriptDays = DEFAULT_TRANSCRIPT_DAYS,
  eventDays = DEFAULT_EVENT_DAYS,
  audioCacheHours = DEFAULT_AUDIO_CACHE_HOURS
} = {}) {
  const results = [];

  // Transcripts: the most sensitive, so the primary target.
  if (transcriptDays > 0) {
    results.push(await deleteInBatches(
      "transcripts",
      `DELETE FROM transcripts
       WHERE ctid IN (
         SELECT ctid FROM transcripts
         WHERE created_at < NOW() - ($1 || ' days')::interval
         LIMIT ${BATCH_SIZE}
       )`,
      [String(transcriptDays)]
    ));
  }

  // Raw STT events duplicate transcript content; expire them sooner.
  if (eventDays > 0) {
    results.push(await deleteInBatches(
      "call_stt_events",
      `DELETE FROM call_stt_events
       WHERE ctid IN (
         SELECT ctid FROM call_stt_events
         WHERE created_at < NOW() - ($1 || ' days')::interval
         LIMIT ${BATCH_SIZE}
       )`,
      [String(eventDays)]
    ));

    results.push(await deleteInBatches(
      "voicebot_events",
      `DELETE FROM voicebot_events
       WHERE ctid IN (
         SELECT ctid FROM voicebot_events
         WHERE created_at < NOW() - ($1 || ' days')::interval
         LIMIT ${BATCH_SIZE}
       )`,
      [String(eventDays)]
    ));
  }

  // Cached TTS audio is regenerable and holds spoken borrower-specific text.
  if (audioCacheHours > 0) {
    results.push(await deleteInBatches(
      "call_audio_cache",
      `DELETE FROM call_audio_cache
       WHERE ctid IN (
         SELECT ctid FROM call_audio_cache
         WHERE expires_at < NOW() - ($1 || ' hours')::interval
         LIMIT ${BATCH_SIZE}
       )`,
      [String(audioCacheHours)]
    ));
  }

  const summary = {
    transcriptDays,
    eventDays,
    audioCacheHours,
    deleted: Object.fromEntries(results.map(r => [r.label, r.deleted])),
    totalDeleted: results.reduce((sum, r) => sum + r.deleted, 0)
  };
  logger.info("retention_sweep_complete", summary);
  return summary;
}

// Reports what WOULD be deleted, for a compliance conversation or before enabling the job.
async function retentionPreview({
  transcriptDays = DEFAULT_TRANSCRIPT_DAYS,
  eventDays = DEFAULT_EVENT_DAYS
} = {}) {
  const counts = {};
  const targets = [
    ["transcripts", "transcripts", transcriptDays],
    ["call_stt_events", "call_stt_events", eventDays],
    ["voicebot_events", "voicebot_events", eventDays]
  ];

  for (const [label, table, days] of targets) {
    try {
      const result = await query(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE created_at < NOW() - ($1 || ' days')::interval`,
        [String(days)]
      );
      counts[label] = Number(result.rows[0]?.n || 0);
    } catch (err) {
      if (!["42P01", "42703"].includes(err.code)) throw err;
      counts[label] = null;
    }
  }

  return { policy: { transcriptDays, eventDays }, wouldDelete: counts };
}

module.exports = {
  runRetentionSweep,
  retentionPreview,
  DEFAULT_TRANSCRIPT_DAYS,
  DEFAULT_EVENT_DAYS
};
