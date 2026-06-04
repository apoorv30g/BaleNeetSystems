const { pool } = require("../db/pool");

const DEFAULT_TEST_CAMPAIGN_PATTERNS = [
  "%test%",
  "%audible sarvam%",
  "%sarvam only%",
  "%stt live%",
  "%intent test%",
  "%controlled%"
];

const DEFAULT_TEST_PHONES = ["8826522604", "7417465513", "8979082261"];

async function cleanupTestData({
  tenantId,
  confirm = false,
  campaignNamePatterns = DEFAULT_TEST_CAMPAIGN_PATTERNS,
  phones = DEFAULT_TEST_PHONES
}) {
  if (!tenantId) throw new Error("tenantId is required");

  const patterns = normalizePatterns(campaignNamePatterns);
  const normalizedPhones = normalizePhones(phones);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const campaigns = await findCampaigns(client, tenantId, patterns);
    const campaignIds = campaigns.rows.map(row => row.id);

    const leads = await client.query(
      `SELECT id, campaign_id, name, phone, created_at
       FROM leads
       WHERE tenant_id=$1
         AND (
           ($2::uuid[] <> '{}'::uuid[] AND campaign_id = ANY($2::uuid[]))
           OR ($3::text[] <> '{}'::text[] AND RIGHT(regexp_replace(phone, '\\D', '', 'g'), 10) = ANY($3::text[]))
         )
       ORDER BY created_at DESC`,
      [tenantId, campaignIds, normalizedPhones]
    );
    const leadIds = leads.rows.map(row => row.id);

    const calls = await client.query(
      `SELECT id, campaign_id, lead_id, call_sid, status, outcome, created_at
       FROM calls
       WHERE tenant_id=$1
         AND (
           ($2::uuid[] <> '{}'::uuid[] AND campaign_id = ANY($2::uuid[]))
           OR ($3::uuid[] <> '{}'::uuid[] AND lead_id = ANY($3::uuid[]))
         )
       ORDER BY created_at DESC`,
      [tenantId, campaignIds, leadIds]
    );
    const callIds = calls.rows.map(row => row.id);
    const callSids = calls.rows.map(row => row.call_sid).filter(Boolean);

    const counts = await countRelated(client, { tenantId, campaignIds, leadIds, callIds, callSids });
    const preview = {
      ok: true,
      dryRun: !confirm,
      matchedCampaigns: campaigns.rows.length,
      matchedLeads: leads.rows.length,
      matchedCalls: calls.rows.length,
      counts,
      campaigns: campaigns.rows.map(row => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at
      })),
      sampleLeads: leads.rows.slice(0, 20),
      sampleCalls: calls.rows.slice(0, 20)
    };

    if (!confirm) {
      await client.query("ROLLBACK");
      return preview;
    }

    const deleted = await deleteRelated(client, { tenantId, campaignIds, leadIds, callIds, callSids });
    await client.query("COMMIT");
    return { ...preview, dryRun: false, deleted };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function findCampaigns(client, tenantId, patterns) {
  if (!patterns.length) return { rows: [] };

  const patternClauses = patterns.map((_, index) => `LOWER(name) LIKE LOWER($${index + 2})`);
  return client.query(
    `SELECT id, name, created_at
     FROM campaigns
     WHERE tenant_id=$1 AND (${patternClauses.join(" OR ")})
     ORDER BY created_at DESC`,
    [tenantId, ...patterns]
  );
}

async function countRelated(client, { tenantId, campaignIds, leadIds, callIds, callSids }) {
  const voicebotEvents = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM voicebot_events
       WHERE ($1::uuid[] <> '{}'::uuid[] AND campaign_id = ANY($1::uuid[]))
          OR ($2::uuid[] <> '{}'::uuid[] AND lead_id = ANY($2::uuid[]))
          OR ($3::text[] <> '{}'::text[] AND call_sid = ANY($3::text[]))`,
    [campaignIds, leadIds, callSids]
  );
  const callSttEvents = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM call_stt_events
       WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND call_id = ANY($2::uuid[])`,
    [tenantId, callIds]
  );
  const notificationEvents = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM notification_events
       WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND lead_id = ANY($2::uuid[])`,
    [tenantId, leadIds]
  );
  const complianceLogs = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM compliance_logs
       WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND lead_id = ANY($2::uuid[])`,
    [tenantId, leadIds]
  );
  const callAudioCache = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM call_audio_cache
       WHERE $1::uuid[] <> '{}'::uuid[] AND call_id = ANY($1::uuid[])`,
    [callIds]
  );
  const transcripts = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM transcripts
       WHERE $1::uuid[] <> '{}'::uuid[] AND call_id = ANY($1::uuid[])`,
    [callIds]
  );
  const leads = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM leads
       WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND id = ANY($2::uuid[])`,
    [tenantId, leadIds]
  );
  const calls = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM calls
       WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND id = ANY($2::uuid[])`,
    [tenantId, callIds]
  );
  const campaigns = await countRows(
    client,
      `SELECT COUNT(*)::int count FROM campaigns
       WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND id = ANY($2::uuid[])`,
    [tenantId, campaignIds]
  );

  return {
    campaigns,
    leads,
    calls,
    transcripts,
    voicebotEvents,
    callSttEvents,
    notificationEvents,
    complianceLogs,
    callAudioCache
  };
}

async function deleteRelated(client, { tenantId, campaignIds, leadIds, callIds, callSids }) {
  const deleted = {};
  deleted.voicebotEvents = await deleteCount(
    client,
    `DELETE FROM voicebot_events
     WHERE ($1::uuid[] <> '{}'::uuid[] AND campaign_id = ANY($1::uuid[]))
        OR ($2::uuid[] <> '{}'::uuid[] AND lead_id = ANY($2::uuid[]))
        OR ($3::text[] <> '{}'::text[] AND call_sid = ANY($3::text[]))`,
    [campaignIds, leadIds, callSids]
  );
  deleted.callSttEvents = await deleteCount(
    client,
    `DELETE FROM call_stt_events
     WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND call_id = ANY($2::uuid[])`,
    [tenantId, callIds]
  );
  deleted.notificationEvents = await deleteCount(
    client,
    `DELETE FROM notification_events
     WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND lead_id = ANY($2::uuid[])`,
    [tenantId, leadIds]
  );
  deleted.complianceLogs = await deleteCount(
    client,
    `DELETE FROM compliance_logs
     WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND lead_id = ANY($2::uuid[])`,
    [tenantId, leadIds]
  );
  deleted.callAudioCache = await deleteCount(
    client,
    `DELETE FROM call_audio_cache
     WHERE $1::uuid[] <> '{}'::uuid[] AND call_id = ANY($1::uuid[])`,
    [callIds]
  );
  deleted.transcripts = await deleteCount(
    client,
    `DELETE FROM transcripts
     WHERE $1::uuid[] <> '{}'::uuid[] AND call_id = ANY($1::uuid[])`,
    [callIds]
  );
  deleted.calls = await deleteCount(
    client,
    `DELETE FROM calls
     WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND id = ANY($2::uuid[])`,
    [tenantId, callIds]
  );
  deleted.leads = await deleteCount(
    client,
    `DELETE FROM leads
     WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND id = ANY($2::uuid[])`,
    [tenantId, leadIds]
  );
  deleted.campaigns = await deleteCount(
    client,
    `DELETE FROM campaigns
     WHERE tenant_id=$1 AND $2::uuid[] <> '{}'::uuid[] AND id = ANY($2::uuid[])`,
    [tenantId, campaignIds]
  );
  return deleted;
}

async function countRows(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows[0]?.count || 0;
}

async function deleteCount(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rowCount || 0;
}

function normalizePatterns(patterns) {
  return (Array.isArray(patterns) ? patterns : [])
    .map(pattern => String(pattern || "").trim())
    .filter(Boolean);
}

function normalizePhones(phones) {
  return [...new Set((Array.isArray(phones) ? phones : [])
    .map(phone => String(phone || "").replace(/\D/g, "").slice(-10))
    .filter(phone => phone.length === 10))];
}

module.exports = {
  cleanupTestData,
  DEFAULT_TEST_CAMPAIGN_PATTERNS,
  DEFAULT_TEST_PHONES
};
