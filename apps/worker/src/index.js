require("dotenv").config();
const { Worker } = require("bullmq");
const config = require("./config");
const { query } = require("./db");
const { triggerOutboundCall } = require("./exotel");

function insideCallWindow() {
  const hour = new Date().getHours();
  return hour >= config.callWindowStart && hour < config.callWindowEnd;
}

const worker = new Worker("lead-calls", async (job) => {
  const { tenantId, campaignId, leadId } = job.data;

  if (!insideCallWindow()) throw new Error("Outside call window");

  const leadResult = await query(`SELECT * FROM leads WHERE id=$1 AND tenant_id=$2`, [leadId, tenantId]);
  const lead = leadResult.rows[0];
  if (!lead) throw new Error("Lead not found");

  if (lead.attempt_count >= config.maxCallAttempts) {
    await query(`UPDATE leads SET status='max_attempts' WHERE id=$1`, [leadId]);
    return;
  }

  const callRow = await query(
    `INSERT INTO calls (tenant_id, campaign_id, lead_id, status) VALUES ($1,$2,$3,'initiated') RETURNING *`,
    [tenantId, campaignId, leadId]
  );

  try {
    const result = await triggerOutboundCall({ to: lead.phone, leadId, campaignId });
    await query(`UPDATE calls SET call_sid=$1, status='dialing', updated_at=NOW() WHERE id=$2`, [result.callSid, callRow.rows[0].id]);
    await query(`UPDATE leads SET status='called', attempt_count=attempt_count+1, last_called_at=NOW() WHERE id=$1`, [leadId]);
  } catch (err) {
    await query(`UPDATE calls SET status='failed', error=$1, updated_at=NOW() WHERE id=$2`, [err.message, callRow.rows[0].id]);
    await query(`UPDATE leads SET status='failed', attempt_count=attempt_count+1, last_called_at=NOW() WHERE id=$1`, [leadId]);
    throw err;
  }
}, { connection: { url: config.redisUrl }, concurrency: config.maxConcurrentCalls });

worker.on("completed", job => console.log(`completed job ${job.id}`));
worker.on("failed", (job, err) => console.error(`failed job ${job?.id}: ${err.message}`));

console.log(`Worker started with concurrency ${config.maxConcurrentCalls}`);
