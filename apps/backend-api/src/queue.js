const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const config = require("./config");

const redisClient = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const connection = redisClient;
const callQueue = new Queue("lead-calls", { connection });

module.exports = { callQueue, connection, redisClient };
