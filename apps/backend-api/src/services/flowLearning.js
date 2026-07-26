const { pool, query } = require("../db/pool");
const config = require("../config");
const logger = require("../utils/logger");

// The self-training loop, stage by stage:
//   1. MINE   -- find call turns where the bot said "sorry, didn't catch that" (or gave up),
//                and recover what the customer had actually said.
//   2. PROPOSE -- ask Sarvam's LLM to cluster those missed phrasings into a handful of new
//                FAQ entries (match phrases + a compliant Hindi/English answer draft).
//   3. REVIEW -- proposals sit in flow_improvement_proposals until a human approves them on
//                the dashboard. Nothing generated is ever spoken without approval.
//   4. APPLY  -- approval merges the entry into the playbook's voice_config.flow.faqs, where
//                the flow engine matches it by plain substring (never regex) from the next call.

// Assistant lines that mark a "the bot did not understand" turn. Must stay in sync with
// flowUnclearReply's prefixes in routes/voicebot.js.
const MISS_MARKERS = [
  "माफ कीजिए, समझ नहीं पाई।",
  "आवाज़ थोड़ी कट रही है।",
  "आपकी आवाज़ साफ नहीं आ रही",
  "Sorry, I did not catch that.",
  "Your voice broke up a little.",
  "I am having trouble hearing you clearly"
];

async function collectMissedUtterances({ sinceHours = 26 } = {}) {
  const markers = MISS_MARKERS.map((_, i) => `t.text LIKE $${i + 2} || '%'`).join(" OR ");
  const unclear = await query(
    `WITH t AS (
       SELECT tr.call_id, tr.speaker, tr.text,
              LAG(tr.speaker) OVER w AS prev_speaker,
              LAG(tr.text) OVER w AS prev_text
       FROM transcripts tr
       WHERE tr.created_at > NOW() - ($1 || ' hours')::interval
       WINDOW w AS (PARTITION BY tr.call_id ORDER BY tr.created_at, tr.id)
     )
     SELECT c.tenant_id, l.playbook_type AS playbook_key, t.prev_text AS user_text, COUNT(*)::int AS occurrences
     FROM t
     JOIN calls c ON c.id = t.call_id
     JOIN leads l ON l.id = c.lead_id
     WHERE t.speaker = 'assistant'
       AND t.prev_speaker = 'user'
       AND LENGTH(TRIM(COALESCE(t.prev_text, ''))) >= 4
       AND (${markers})
     GROUP BY 1, 2, 3
     ORDER BY occurrences DESC
     LIMIT 200`,
    [String(sinceHours), ...MISS_MARKERS]
  );

  // Turns the scripted layer handed to the LLM: the customer asked something real that the
  // flow had no answer for -- the strongest candidates for new FAQ entries.
  const llmFallbacks = await query(
    `SELECT l.tenant_id, l.playbook_type AS playbook_key, e.details->>'text' AS user_text, COUNT(*)::int AS occurrences
     FROM voicebot_events e
     JOIN leads l ON l.id = e.lead_id
     WHERE e.event_type = 'flow_llm_fallback'
       AND e.created_at > NOW() - ($1 || ' hours')::interval
       AND LENGTH(TRIM(COALESCE(e.details->>'text', ''))) >= 4
     GROUP BY 1, 2, 3
     ORDER BY occurrences DESC
     LIMIT 200`,
    [String(sinceHours)]
  );

  // Merge both sources, summing counts for identical utterances.
  const merged = new Map();
  for (const row of [...unclear.rows, ...llmFallbacks.rows]) {
    const key = `${row.tenant_id}::${row.playbook_key}::${row.user_text}`;
    const existing = merged.get(key);
    if (existing) existing.occurrences += row.occurrences;
    else merged.set(key, { ...row });
  }
  return [...merged.values()].sort((a, b) => b.occurrences - a.occurrences).slice(0, 200);
}

async function runFlowLearningBatch({ sinceHours = 26 } = {}) {
  if (!config.ai.sarvamApiKey) return { skipped: true, reason: "sarvam_key_missing" };

  let misses;
  try {
    misses = await collectMissedUtterances({ sinceHours });
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) return { skipped: true, reason: "tables_missing" };
    throw err;
  }
  if (!misses.length) return { groups: 0, proposals: 0 };

  const groups = new Map();
  for (const row of misses) {
    const key = `${row.tenant_id}::${row.playbook_key}`;
    if (!groups.has(key)) groups.set(key, { tenantId: row.tenant_id, playbookKey: row.playbook_key, utterances: [] });
    if (groups.get(key).utterances.length < 40) {
      groups.get(key).utterances.push({ text: row.user_text, occurrences: row.occurrences });
    }
  }

  let inserted = 0;
  for (const group of groups.values()) {
    try {
      const known = await knownPhrases(group.tenantId, group.playbookKey);
      const proposals = await proposalsFromSarvam({ ...group, knownPhrases: known });
      for (const proposal of proposals) {
        const phrases = sanitizePhrases(proposal.phrases);
        if (!phrases.length || !String(proposal.answer_hi || "").trim()) continue;
        if (phrases.every(p => known.has(p))) continue; // nothing new to learn
        await query(
          `INSERT INTO flow_improvement_proposals (tenant_id, playbook_key, kind, evidence, proposal)
           VALUES ($1,$2,'faq',$3,$4)`,
          [
            group.tenantId,
            group.playbookKey,
            JSON.stringify(proposal.evidence || group.utterances.slice(0, 10)),
            JSON.stringify({
              topic: normalizeTopic(proposal.topic),
              phrases,
              answer: { hi: String(proposal.answer_hi).trim(), en: String(proposal.answer_en || "").trim() },
              rationale: String(proposal.rationale || "").slice(0, 400)
            })
          ]
        );
        inserted++;
      }
    } catch (err) {
      logger.warn("flow_learning_group_failed", { playbookKey: group.playbookKey, error: err.message });
    }
  }
  return { groups: groups.size, proposals: inserted };
}

// Phrases the playbook already understands (existing learned FAQs + pending proposals),
// so the miner doesn't repropose the same thing every night.
async function knownPhrases(tenantId, playbookKey) {
  const known = new Set();
  const playbook = await query(
    `SELECT voice_config FROM playbooks WHERE tenant_id=$1 AND key=$2 LIMIT 1`,
    [tenantId, playbookKey]
  );
  for (const faq of playbook.rows[0]?.voice_config?.flow?.faqs || []) {
    for (const phrase of faq.phrases || []) known.add(String(phrase).toLowerCase().trim());
  }
  const pending = await query(
    `SELECT proposal FROM flow_improvement_proposals
     WHERE tenant_id=$1 AND playbook_key=$2 AND status IN ('pending','approved')`,
    [tenantId, playbookKey]
  );
  for (const row of pending.rows) {
    for (const phrase of row.proposal?.phrases || []) known.add(String(phrase).toLowerCase().trim());
  }
  return known;
}

async function proposalsFromSarvam({ playbookKey, utterances, knownPhrases: known }) {
  const prompt = [
    "You review transcripts from an Indian lending voice bot. The bot replied \"sorry, I didn't catch that\" to each customer utterance below (Hindi/Hinglish/English, often garbled by speech-to-text).",
    "Cluster utterances that express the same ASKABLE question or concern the bot should learn to answer. Ignore pure noise, greetings, and fragments with no recoverable meaning.",
    `Playbook: ${playbookKey}. Already-understood phrases (do not repropose): ${[...known].slice(0, 50).join(", ") || "none"}.`,
    "For each cluster (maximum 5), output: a short snake_case topic slug (e.g. cibil_impact, link_not_opening), short lowercase match phrases (substrings a matcher can find in future utterances), a compliant spoken answer in Hindi (Devanagari+common English loanwords) and English.",
    "Answers must NEVER promise approval, state interest rates or fees, or ask for OTP/PIN/password. When unsure of a fact, direct the customer to the website using the placeholder {{website}}. Use {{brand}} for the company name.",
    "Respond with ONLY a JSON array: [{\"topic\": \"...\", \"phrases\": [\"...\"], \"answer_hi\": \"...\", \"answer_en\": \"...\", \"rationale\": \"...\", \"evidence\": [\"utterance\", ...]}]. Empty array if nothing is worth learning.",
    "",
    "Missed utterances (with occurrence counts):",
    ...utterances.map(u => `- (${u.occurrences}x) ${u.text}`)
  ].join("\n");

  const body = {
    model: config.ai.sarvamChatModel,
    messages: [{ role: "user", content: prompt }],
    max_tokens: Number(process.env.FLOW_LEARNING_MAX_TOKENS || 1200),
    temperature: 0.2,
    stream: false,
    n: 1
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.FLOW_LEARNING_TIMEOUT_MS || 30000));
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-subscription-key": config.ai.sarvamApiKey },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Sarvam chat failed ${res.status}: ${text.slice(0, 300)}`);
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    const content = data?.choices?.[0]?.message?.content || "";
    return extractJsonArray(content);
  } finally {
    clearTimeout(timeout);
  }
}

// The model wraps JSON in prose/code fences more often than not -- pull out the first
// top-level array and parse just that.
function extractJsonArray(text) {
  const value = String(text || "");
  const start = value.indexOf("[");
  const end = value.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(value.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function sanitizePhrases(phrases) {
  const seen = new Set();
  const clean = [];
  for (const raw of Array.isArray(phrases) ? phrases : []) {
    const phrase = String(raw || "").toLowerCase().replace(/[|\\{}<>]/g, "").replace(/\s+/g, " ").trim();
    if (phrase.length < 3 || phrase.length > 60 || seen.has(phrase)) continue;
    seen.add(phrase);
    clean.push(phrase);
    if (clean.length >= 12) break;
  }
  return clean;
}

// Prepends the learned FAQ so it wins over defaults; tagged so learned entries are
// identifiable (and removable) later.
function mergeFaqProposalIntoVoiceConfig(voiceConfig, proposal) {
  const base = voiceConfig && typeof voiceConfig === "object" ? voiceConfig : {};
  const flow = base.flow && typeof base.flow === "object" ? base.flow : {};
  const entry = {
    phrases: sanitizePhrases(proposal.phrases),
    answer: { hi: String(proposal.answer?.hi || "").trim(), en: String(proposal.answer?.en || "").trim() },
    learned: true,
    learnedAt: new Date().toISOString()
  };
  return {
    ...base,
    flow: { ...flow, faqs: [entry, ...(Array.isArray(flow.faqs) ? flow.faqs : [])] }
  };
}

async function listProposals(tenantId, status = "pending") {
  const result = await query(
    `SELECT id, playbook_key, kind, status, evidence, proposal, created_at
     FROM flow_improvement_proposals
     WHERE tenant_id=$1 AND status=$2
     ORDER BY created_at DESC LIMIT 100`,
    [tenantId, status]
  );
  return result.rows;
}

async function approveProposal({ id, tenantId, userId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(
      `SELECT * FROM flow_improvement_proposals
       WHERE id=$1 AND tenant_id=$2 AND status='pending' FOR UPDATE`,
      [id, tenantId]
    );
    const proposal = found.rows[0];
    if (!proposal) {
      await client.query("ROLLBACK");
      return null;
    }

    const playbook = await client.query(
      `SELECT voice_config FROM playbooks WHERE tenant_id=$1 AND key=$2 AND is_active=true LIMIT 1 FOR UPDATE`,
      [tenantId, proposal.playbook_key]
    );
    if (!playbook.rows[0]) {
      // Playbook was deleted/deactivated since the proposal was mined -- approving would
      // silently drop the learning. Leave the proposal pending and surface a clear error.
      await client.query("ROLLBACK");
      return null;
    }

    const merged = mergeFaqProposalIntoVoiceConfig(playbook.rows[0].voice_config, proposal.proposal);
    await client.query(
      `UPDATE playbooks SET voice_config=$3 WHERE tenant_id=$1 AND key=$2`,
      [tenantId, proposal.playbook_key, JSON.stringify(merged)]
    );
    await client.query(
      `UPDATE flow_improvement_proposals SET status='approved', decided_at=NOW(), decided_by=$2 WHERE id=$1`,
      [id, userId || null]
    );
    await client.query("COMMIT");
    contributeToNetwork(tenantId, proposal.proposal).catch(err => {
      logger.warn("network_contribution_failed", { error: err.message });
    });
    return { playbookKey: proposal.playbook_key, voiceConfig: merged };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---- Cross-client learning network ----
// Understanding is shared, answers are not: only topic + phrase strings enter the pool,
// and only from tenants that opted in. Phrases carrying digits (phone numbers, amounts)
// or brand-specific words never leave the tenant.

function normalizeTopic(value) {
  const topic = String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return topic || "general";
}

function shareablePhrases(phrases) {
  return sanitizePhrases(phrases).filter(p => !/\d/.test(p));
}

async function tenantSharesLearnings(tenantId) {
  try {
    const result = await query(`SELECT share_learnings FROM tenant_settings WHERE tenant_id=$1`, [tenantId]);
    return Boolean(result.rows[0]?.share_learnings);
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) return false;
    throw err;
  }
}

async function contributeToNetwork(tenantId, proposalBody) {
  if (!(await tenantSharesLearnings(tenantId))) return;
  const topic = normalizeTopic(proposalBody?.topic);
  for (const phrase of shareablePhrases(proposalBody?.phrases)) {
    await query(
      `INSERT INTO shared_phrase_pool (topic, phrase)
       VALUES ($1,$2)
       ON CONFLICT (topic, phrase) DO UPDATE SET contributed_count = shared_phrase_pool.contributed_count + 1`,
      [topic, phrase]
    );
  }
}

// Seeds opted-in tenants' playbooks with proposals for topics the network already knows but
// this playbook can't answer yet -- a new client's bot benefits from every prior client's
// calls on day one. Answers are freshly drafted (brand-neutral placeholders), never copied.
async function runNetworkSeeding({ maxPerTenant = 3 } = {}) {
  if (!config.ai.sarvamApiKey) return { skipped: true, reason: "sarvam_key_missing" };

  let pool_;
  let tenants;
  try {
    pool_ = await query(
      `SELECT topic, ARRAY_AGG(phrase ORDER BY contributed_count DESC) AS phrases
       FROM shared_phrase_pool GROUP BY topic HAVING COUNT(*) >= 2`
    );
    if (!pool_.rows.length) return { seeded: 0 };
    tenants = await query(
      `SELECT ts.tenant_id FROM tenant_settings ts WHERE ts.share_learnings = true`
    );
  } catch (err) {
    if (["42P01", "42703"].includes(err.code)) return { skipped: true, reason: "tables_missing" };
    throw err;
  }

  let seeded = 0;
  for (const tenant of tenants.rows) {
    const playbooks = await query(
      `SELECT key, voice_config FROM playbooks
       WHERE tenant_id=$1 AND is_active=true
         AND (voice_config->'flow' IS NOT NULL OR key='PAN_VERIFICATION_RETARGETING')`,
      [tenant.tenant_id]
    );
    for (const playbook of playbooks.rows) {
      let created = 0;
      const known = await knownPhrases(tenant.tenant_id, playbook.key);
      const knownTopics = await query(
        `SELECT DISTINCT proposal->>'topic' AS topic FROM flow_improvement_proposals
         WHERE tenant_id=$1 AND playbook_key=$2`,
        [tenant.tenant_id, playbook.key]
      );
      const seenTopics = new Set(knownTopics.rows.map(r => r.topic).filter(Boolean));

      for (const row of pool_.rows) {
        if (created >= maxPerTenant) break;
        if (seenTopics.has(row.topic)) continue;
        const newPhrases = row.phrases.filter(p => !known.has(p)).slice(0, 8);
        if (newPhrases.length < 2) continue;
        try {
          const drafts = await proposalsFromSarvam({
            playbookKey: playbook.key,
            knownPhrases: known,
            utterances: newPhrases.map(text => ({ text, occurrences: 1 }))
          });
          const draft = drafts[0];
          if (!draft || !String(draft.answer_hi || "").trim()) continue;
          await query(
            `INSERT INTO flow_improvement_proposals (tenant_id, playbook_key, kind, evidence, proposal)
             VALUES ($1,$2,'network',$3,$4)`,
            [
              tenant.tenant_id,
              playbook.key,
              JSON.stringify(newPhrases.map(text => ({ text, source: "network" }))),
              JSON.stringify({
                topic: row.topic,
                phrases: sanitizePhrases([...newPhrases, ...(draft.phrases || [])]),
                answer: { hi: String(draft.answer_hi).trim(), en: String(draft.answer_en || "").trim() },
                rationale: `Customers of other lenders on this platform also ask about "${row.topic}". ${String(draft.rationale || "").slice(0, 250)}`
              })
            ]
          );
          created++;
          seeded++;
        } catch (err) {
          logger.warn("network_seed_topic_failed", { topic: row.topic, playbookKey: playbook.key, error: err.message });
        }
      }
    }
  }
  return { seeded };
}

async function rejectProposal({ id, tenantId, userId }) {
  const result = await query(
    `UPDATE flow_improvement_proposals SET status='rejected', decided_at=NOW(), decided_by=$3
     WHERE id=$1 AND tenant_id=$2 AND status='pending' RETURNING id`,
    [id, tenantId, userId || null]
  );
  return Boolean(result.rows[0]);
}

module.exports = {
  approveProposal,
  collectMissedUtterances,
  listProposals,
  rejectProposal,
  runFlowLearningBatch,
  runNetworkSeeding,
  _test: { extractJsonArray, mergeFaqProposalIntoVoiceConfig, sanitizePhrases, shareablePhrases, normalizeTopic, MISS_MARKERS }
};
