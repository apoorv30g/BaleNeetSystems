const { query } = require("../db/pool");
const { getTenantSettings } = require("../services/settings");

async function sendLeadLink({ tenantId, lead, channel, link }) {
  const settings = await getTenantSettings(tenantId);
  const destination = lead.phone;
  const webhookUrl = channel === "whatsapp" ? settings.whatsappWebhookUrl : settings.smsWebhookUrl;
  const payload = {
    to: destination,
    text: `LoanConnect link: ${link}`,
    leadId: lead.id,
    channel
  };

  const event = await query(
    `INSERT INTO notification_events (tenant_id, lead_id, channel, destination, status, payload)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [tenantId, lead.id, channel, destination, webhookUrl ? "queued" : "mocked", payload]
  );

  if (!webhookUrl) return event.rows[0];

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(await res.text());
    await query(`UPDATE notification_events SET status='sent' WHERE id=$1`, [event.rows[0].id]);
    return { ...event.rows[0], status: "sent" };
  } catch (err) {
    await query(`UPDATE notification_events SET status='failed', error=$1 WHERE id=$2`, [err.message, event.rows[0].id]);
    throw err;
  }
}

module.exports = { sendLeadLink };
