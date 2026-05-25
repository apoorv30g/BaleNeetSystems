const express = require("express");
const cors = require("cors");
const config = require("./config");

const app = express();

app.use(cors({ origin: config.frontendUrl, credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_, res) => res.json({ ok: true, service: "loanconnect-backend", ts: new Date().toISOString() }));

app.use("/auth", require("./routes/auth"));
app.use("/campaigns", require("./routes/campaigns"));
app.use("/analytics", require("./routes/analytics"));
app.use("/webhooks", require("./routes/webhooks"));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => console.log(`LoanConnect backend running on ${config.port}`));
