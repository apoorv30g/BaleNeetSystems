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
const callQueue = new Queue("lead-calls", { connection });

module.exports = { callQueue, connection, redisClient };
