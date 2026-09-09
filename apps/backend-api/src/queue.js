const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const config = require("./config");

const redisClient = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
// Without an error listener, a transient Redis blip emits an unhandled 'error' event
// and crashes the whole process — killing every live call. ioredis auto-reconnects.
redisClient.on("error", (err) => {
  console.error("[redis] Client error:", err.message);
});
const connection = redisClient;

// Without retention limits BullMQ keeps EVERY completed and failed job record in Redis
// forever. On a small self-hosted box that grows without bound until Redis exhausts memory.
// Completed jobs carry no information the `calls` table does not already hold, so they are
// discarded aggressively; failures are kept longer because they are what you debug from.
const callQueue = new Queue("lead-calls", {
  connection,
  defaultJobOptions: {
    removeOnComplete: {
      age: Number(process.env.QUEUE_KEEP_COMPLETED_SECONDS || 3600), // 1h
      count: Number(process.env.QUEUE_KEEP_COMPLETED_COUNT || 1000)
    },
    removeOnFail: {
      age: Number(process.env.QUEUE_KEEP_FAILED_SECONDS || 7 * 24 * 3600), // 7 days
      count: Number(process.env.QUEUE_KEEP_FAILED_COUNT || 5000)
    }
  }
});

module.exports = { callQueue, connection, redisClient };
