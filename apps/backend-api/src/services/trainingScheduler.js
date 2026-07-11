const { pool } = require("../db/pool");
const logger = require("../utils/logger");
const { cleanupRawRecordings, runTrainingBatch } = require("./trainingData");

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
