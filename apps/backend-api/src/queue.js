const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const config = require("./config");

const connection = { url: config.redisUrl };
const redisClient = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
const callQueue = new Queue("lead-calls", { connection });

module.exports = { callQueue, connection, redisClient };
