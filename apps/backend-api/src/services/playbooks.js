const config = require("../config");
const { query } = require("../db/pool");

const PLAYBOOKS = {
  SOFT_PAYMENT_REMINDER: {
    category: "Collection",
    title: "Soft Payment Reminder",
    task: "Payment reminders",
    trigger: "Sent before due date, commonly T-5.",
    cadence: "Configurable frequency, up to multiple reminders per day.",
    goal: "Nudge user to pay before due date and preserve a good repayment record.",
    steps: [
      "Greet politely",
      "Remind upcoming payment date",
      "Explain that early closure can reduce interest where applicable",
      "Mention good repayment pattern before deadline and positive CIBIL impact",
      "Mention better future loan terms where configurable, such as increased limit or reduced interest",
      "Share payment link"
    ]
  },
  HARD_PAYMENT_REMINDER: {
    category: "Collection",
    title: "Hard Payment Reminder",
    task: "Defaulter follow-up",
    trigger: "Sent after due date.",
    cadence: "Configurable frequency, usually daily until resolved or max attempts reached.",
    goal: "Recover overdue payment without being aggressive.",
    steps: [
      "Notify missed deadline",
      "Mention penalty charges and everyday late fees carefully",
      "Nudge repayment of the full loan amount to avoid extra penalties and negative CIBIL impact",
      "Ask when the user will pay and close on a payment commitment",
      "Offer restructuring/easy EMI if eligible"
    ]
  },
  UNAPPROVED_USERS: {
    category: "Retargeting",
    title: "Unapproved Users",
    task: "Warm call registered users",
    trigger: "User registered but did not upload documents or check final eligibility.",
    cadence: "Configurable retargeting sequence.",
    goal: "Bring back users who registered but did not complete eligibility/doc upload.",
    steps: [
      "Notify eligibility up to the configured amount and create urgency",
      "Ask them to check eligibility in under 2 minutes on call and view final loan offer",
      "Guide the user through the process",
      "If the user faces difficulty, route to customer support"
    ]
  },
  APPROVED_USERS: {
    category: "Retargeting",
    title: "Approved Users",
    task: "Warm call approved users",
    trigger: "User received an offer but did not take the loan.",
    cadence: "Configurable retargeting sequence until offer expiry or closure.",
    goal: "Convert approved users who did not take loan.",
    steps: [
      "Notify expiry of the loan offer amount and create urgency",
      "Nudge the user to move forward with the process",
      "Help the user through the process",
      "If they say no, understand why and route to credit underwriter if required",
      "If the user faces difficulty, route to customer support"
    ]
  },
  FRESH_LEAD: {
    category: "Targeting",
    title: "Fresh Lead",
    task: "Cold calling fresh leads",
    trigger: "Fresh lead sourced from database or campaign upload.",
    cadence: "Configurable cold calling sequence.",
    goal: "Cold call fresh lead and guide to eligibility check.",
    steps: [
      "Greeting and introduction",
      "Confirm user reference details such as name and age",
      "Ask loan requirement",
      "Tell them loan eligibility up to the configured amount",
      "Send UTM link via SMS/WhatsApp",
      "Guide through the process, final loan amount check, and loan receipt"
    ]
  }
};

async function listPlaybooks(tenantId) {
  try {
    await seedDefaultPlaybooks(tenantId);
    const result = await query(
      `SELECT * FROM playbooks WHERE tenant_id=$1 AND is_active=true ORDER BY category, title`,
      [tenantId]
    );
    if (result.rows.length) return rowsToMap(result.rows);
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }

  return PLAYBOOKS;
}

async function getPlaybook(tenantId, key) {
  try {
    await seedDefaultPlaybooks(tenantId);
    const result = await query(
      `SELECT * FROM playbooks WHERE tenant_id=$1 AND key=$2 AND is_active=true LIMIT 1`,
      [tenantId, key]
    );
    if (result.rows[0]) return rowToPlaybook(result.rows[0]);
  } catch (err) {
    if (!["42P01", "42703"].includes(err.code)) throw err;
  }

  return PLAYBOOKS[key] || PLAYBOOKS.UNAPPROVED_USERS;
}

async function upsertPlaybook(tenantId, payload) {
  const key = normalizeKey(payload.key || payload.title);
  const steps = normalizeSteps(payload.steps);

  const result = await query(
    `INSERT INTO playbooks (tenant_id, key, title, category, task, trigger, cadence, goal, steps, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
     ON CONFLICT (tenant_id, key) DO UPDATE SET
       title=EXCLUDED.title,
       category=EXCLUDED.category,
       task=EXCLUDED.task,
       trigger=EXCLUDED.trigger,
       cadence=EXCLUDED.cadence,
       goal=EXCLUDED.goal,
       steps=EXCLUDED.steps,
       is_active=true
     RETURNING *`,
    [
      tenantId,
      key,
      payload.title || key,
      payload.category || "Custom",
      payload.task || "",
      payload.trigger || "",
      payload.cadence || "",
      payload.goal || "",
      JSON.stringify(steps)
    ]
  );

  return { key: result.rows[0].key, ...rowToPlaybook(result.rows[0]) };
}

async function deletePlaybook(tenantId, key) {
  await query(`UPDATE playbooks SET is_active=false WHERE tenant_id=$1 AND key=$2`, [tenantId, key]);
}

async function seedDefaultPlaybooks(tenantId) {
  const existing = await query(`SELECT 1 FROM playbooks WHERE tenant_id=$1 LIMIT 1`, [tenantId]);
  if (existing.rows.length) return;

  for (const [key, playbook] of Object.entries(PLAYBOOKS)) {
    await query(
      `INSERT INTO playbooks (tenant_id, key, title, category, task, trigger, cadence, goal, steps, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
       ON CONFLICT (tenant_id, key) DO NOTHING`,
      [
        tenantId,
        key,
        playbook.title,
        playbook.category,
        playbook.task,
        playbook.trigger,
        playbook.cadence,
        playbook.goal,
        JSON.stringify(playbook.steps)
      ]
    );
  }
}

async function buildPrompt(lead) {
  const playbook = await getPlaybook(lead.tenant_id, lead.playbook_type);
  const amount = lead.offer_amount || lead.loan_amount || "eligible";
  return `
You are a warm Hindi-English AI loan assistant.

Playbook: ${playbook.title}
Category: ${playbook.category}
Goal: ${playbook.goal}
Task: ${playbook.task || playbook.category}
Trigger: ${playbook.trigger || "not provided"}
Cadence: ${playbook.cadence || "configurable"}

Customer:
Name: ${lead.name || "Customer"}
Phone: ${lead.phone}
Drop stage: ${lead.drop_stage || lead.playbook_type}
Loan amount: ${lead.loan_amount || "not provided"}
Offer amount: ${lead.offer_amount || "not provided"}
Due date: ${lead.due_date || "not provided"}
Language: ${lead.language || "Hinglish"}

Conversation steps:
${playbook.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Rules:
- Speak in natural Hinglish unless language says otherwise.
- Keep it short and human.
- Use moderate pace.
- Do not sound like a robotic call center script.
- Never ask for OTP, PIN, password, card details, or Aadhaar OTP.
- Never promise guaranteed loan approval.
- Never threaten the user.
- For collections, be firm but respectful.
- If user is interested, tell them secure link will be shared.
- Loan app link: ${config.loanAppUrl}
- Payment link base: ${config.paymentLinkBase}
- Support phone: ${config.supportPhone || "available in app"}

Now generate the first spoken message only.
`;
}

function rowsToMap(rows) {
  return rows.reduce((acc, row) => {
    acc[row.key] = rowToPlaybook(row);
    return acc;
  }, {});
}

function rowToPlaybook(row) {
  return {
    category: row.category,
    title: row.title,
    task: row.task || "",
    trigger: row.trigger || "",
    cadence: row.cadence || "",
    goal: row.goal || "",
    steps: Array.isArray(row.steps) ? row.steps : []
  };
}

function normalizeKey(value) {
  return String(value || "CUSTOM_PLAYBOOK")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "CUSTOM_PLAYBOOK";
}

function normalizeSteps(steps) {
  if (Array.isArray(steps)) return steps.map(step => String(step).trim()).filter(Boolean);
  return String(steps || "").split(/\r?\n/).map(step => step.trim()).filter(Boolean);
}

module.exports = { PLAYBOOKS, buildPrompt, deletePlaybook, listPlaybooks, upsertPlaybook };
