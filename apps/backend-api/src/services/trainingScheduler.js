const { pool } = require("../db/pool");
const logger = require("../utils/logger");
const { cleanupRawRecordings, runTrainingBatch } = require("./trainingData");
const { runFlowLearningBatch, runNetworkSeeding } = require("./flowLearning");
const { runComplianceAuditBatch } = require("./complianceAudit");
const { runVariantStatsBatch } = require("./variantStats");
const { runRetentionSweep } = require("./dataRetention");

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function startTrainingScheduler() {
  if (process.env.NODE_ENV === "test" || process.env.TRAINING_SCHEDULER_ENABLED === "false") {
    return { stop() {} };
  }

  const timers = [
    scheduleDailyIst("voice_training_daily", 22, 0, async () => {
      await withAdvisoryLock("voice_training_daily_ist_2200", async () => {
        const result = await runTrainingBatch();
        logger.info("voice_training_daily_complete", result);
      });
    }),
    scheduleDailyIst("voice_training_cleanup", 23, 55, async () => {
      await withAdvisoryLock("voice_training_cleanup_ist_2355", async () => {
        const result = await cleanupRawRecordings();
        logger.info("voice_training_cleanup_complete", result);
      });
    }),
    // Self-training: mine yesterday's "didn't catch that" turns into proposed FAQ entries
    // for human review on the dashboard (never auto-applied).
    scheduleDailyIst("flow_learning_daily", 21, 30, async () => {
      await withAdvisoryLock("flow_learning_daily_ist_2130", async () => {
        const result = await runFlowLearningBatch();
        logger.info("flow_learning_daily_complete", result);
      });
    }),
    // Compliance autopilot: audit every unaudited recent call against the rule set.
    scheduleDailyIst("compliance_audit_daily", 21, 0, async () => {
      await withAdvisoryLock("compliance_audit_daily_ist_2100", async () => {
        const result = await runComplianceAuditBatch();
        logger.info("compliance_audit_daily_complete", result);
      });
    }),
    // Self-optimizing scripts: recompute gate-variant success weights from recent outcomes.
    scheduleDailyIst("variant_stats_daily", 22, 30, async () => {
      await withAdvisoryLock("variant_stats_daily_ist_2230", async () => {
        const result = await runVariantStatsBatch();
        logger.info("variant_stats_daily_complete", result);
      });
    }),
    // Cross-client network: seed opted-in tenants with proposals for topics the network
    // knows but their playbook cannot answer yet (proposals still require human approval).
    scheduleDailyIst("network_seeding_daily", 23, 0, async () => {
      await withAdvisoryLock("network_seeding_daily_ist_2300", async () => {
        const result = await runNetworkSeeding();
        logger.info("network_seeding_daily_complete", result);
      });
    }),
    // Data retention: expire old transcripts and raw events. Runs at 03:30 IST -- well
    // outside the calling window, and after the learning/audit jobs above have already
    // mined the data they need from recent calls.
    scheduleDailyIst("data_retention_daily", 3, 30, async () => {
      await withAdvisoryLock("data_retention_daily_ist_0330", async () => {
        const result = await runRetentionSweep();
        logger.info("data_retention_daily_complete", result);
      });
    })
  ];

  return {
    stop() {
      for (const timer of timers) clearTimeout(timer.current);
    }
  };
}

function scheduleDailyIst(name, hour, minute, job) {
  const ref = { current: null };

  async function runAndReschedule() {
    try {
      await job();
    } catch (err) {
      logger.error("voice_training_scheduled_job_failed", { job: name, error: err.message });
    } finally {
      ref.current = setTimeout(runAndReschedule, msUntilNextIst(hour, minute));
    }
  }

  const delay = msUntilNextIst(hour, minute);
  logger.info("voice_training_job_scheduled", { job: name, hourIst: hour, minuteIst: minute, delayMs: delay });
  ref.current = setTimeout(runAndReschedule, delay);
  return ref;
}

function msUntilNextIst(hour, minute) {
  const now = Date.now();
  const nowIst = new Date(now + IST_OFFSET_MS);
  let targetIstAsUtc = Date.UTC(
    nowIst.getUTCFullYear(),
    nowIst.getUTCMonth(),
    nowIst.getUTCDate(),
    hour,
    minute,
    0,
    0
  );

  const nowIstAsUtc = now + IST_OFFSET_MS;
  if (targetIstAsUtc <= nowIstAsUtc) targetIstAsUtc += DAY_MS;
  return Math.max(1000, targetIstAsUtc - nowIstAsUtc);
}

async function withAdvisoryLock(lockName, fn) {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [lockName]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) {
      logger.info("voice_training_job_skipped_locked", { lockName });
      return { skipped: true };
    }
    return await fn();
  } finally {
    if (locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockName]).catch(err => {
        logger.warn("voice_training_unlock_failed", { lockName, error: err.message });
      });
    }
    client.release();
  }
}

module.exports = { startTrainingScheduler, _test: { msUntilNextIst } };
