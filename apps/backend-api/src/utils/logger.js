function log(level, message, meta = {}) {
  const entry = {
    level,
    message,
    service: "backend-api",
    ts: new Date().toISOString(),
    ...meta
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

module.exports = {
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta)
};
