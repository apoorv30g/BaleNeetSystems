const { Pool } = require("pg");

async function main() {
  const phone = String(process.argv[2] || "").replace(/\D/g, "");
  if (phone.length < 10) throw new Error("Provide a valid phone number");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 1
  });

  try {
    const callResult = await pool.query(
      `SELECT c.*,
              l.name AS lead_name,
              l.phone,
              l.offer_amount,
              l.loan_amount,
              l.drop_stage,
              l.playbook_type,
              l.source_status,
              cp.name AS campaign_name
       FROM calls c
       JOIN leads l ON l.id=c.lead_id
       LEFT JOIN campaigns cp ON cp.id=c.campaign_id
       WHERE RIGHT(REGEXP_REPLACE(l.phone, '\\D', '', 'g'), 10)=RIGHT($1, 10)
       ORDER BY COALESCE(c.updated_at, c.created_at) DESC
       LIMIT 1`,
      [phone]
    );

    const call = callResult.rows[0];
    if (!call) {
      process.stdout.write(JSON.stringify({ phone, call: null }, null, 2));
      return;
    }

    const [transcripts, sttEvents, voicebotEvents] = await Promise.all([
      pool.query(
        `SELECT speaker, text, created_at
         FROM transcripts
         WHERE call_id=$1
         ORDER BY created_at ASC`,
        [call.id]
      ),
      pool.query(
        `SELECT provider, transcript, confidence, status, error, created_at
         FROM call_stt_events
         WHERE call_id=$1
         ORDER BY created_at ASC`,
        [call.id]
      ),
      pool.query(
        `SELECT event_type, details, created_at
         FROM voicebot_events
         WHERE lead_id=$1
           AND created_at BETWEEN $2::timestamp - INTERVAL '2 minutes'
                              AND COALESCE($3::timestamp, $2::timestamp) + INTERVAL '5 minutes'
         ORDER BY created_at ASC`,
        [call.lead_id, call.created_at, call.updated_at]
      )
    ]);

    process.stdout.write(JSON.stringify({
      call,
      transcripts: transcripts.rows,
      sttEvents: sttEvents.rows,
      voicebotEvents: voicebotEvents.rows
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(err => {
  process.stderr.write(`${err.stack || err.message}\n`);
  process.exitCode = 1;
});
