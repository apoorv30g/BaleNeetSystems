const { Queue } = require("bullmq");
const config = require("./config");

const connection = { url: config.redisUrl };
const callQueue = new Queue("lead-calls", { connection });

module.exports = { callQueue, connection };
