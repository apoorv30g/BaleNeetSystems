const config = require("../config");
const { query } = require("../db/pool");
const { isTezJourneyLead, tezJourneyContext, tezJourneyPromptNotes } = require("./tezJourney");

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
  },
  TEZ_SELFIE_PENDING: {
    category: "TezCredit Retargeting",
    title: "TezCredit - Selfie Pending",
    task: "Bring back users who stopped at live selfie.",
    trigger: "User has entered basic details but selfie is not completed.",
    cadence: "Call once soon after drop-off, then retry as per campaign policy.",
    goal: "Get the user to open the TezCredit website and complete the live selfie correctly.",
    steps: [
      "Say their TezCredit loan application is almost ready but live selfie is pending",
      "Explain the selfie takes under one minute and the face must stay centered",
      "Send or mention www.tezcredit.com",
      "Ask them to open www.tezcredit.com, click Apply Now, and sign in with their registered mobile number while you stay on the line",
      "If they are busy, capture a callback time"
    ]
  },
  TEZ_AADHAAR_PENDING: {
    category: "TezCredit Retargeting",
    title: "TezCredit - Aadhaar KYC Pending",
    task: "Help users complete Aadhaar DigiLocker KYC.",
    trigger: "Selfie is done but Aadhaar KYC is incomplete.",
    cadence: "Retarget until KYC completion or decline.",
    goal: "Get the user to complete Aadhaar KYC through DigiLocker.",
    steps: [
      "Say their TezCredit application is pending only at Aadhaar KYC",
      "Clarify that KYC happens through the secure TezCredit website and DigiLocker",
      "Reassure that you will never ask for OTP on the call",
      "Ask them to open www.tezcredit.com, click Apply Now, sign in, and complete Aadhaar KYC now",
      "If there is a mismatch or website issue, note the issue and point to website support"
    ]
  },
  TEZ_PROFILE_PENDING: {
    category: "TezCredit Retargeting",
    title: "TezCredit - Profile Details Pending",
    task: "Help users finish income, employer, PAN or pincode details.",
    trigger: "Profile details are incomplete before final eligibility.",
    cadence: "Retarget until profile completion or decline.",
    goal: "Get the user to complete pending profile details on the TezCredit website.",
    steps: [
      "Say their TezCredit application is stuck at profile details",
      "Mention PAN, income, employer or pincode may be pending on the website",
      "Ask them to open www.tezcredit.com, click Apply Now, sign in, and finish the pending field",
      "Explain final eligibility can be checked only after this",
      "If they are confused, ask which screen they see and guide simply"
    ]
  },
  TEZ_BANK_VERIFICATION_PENDING: {
    category: "TezCredit Retargeting",
    title: "TezCredit - Bank Verification Pending",
    task: "Convert approved users stuck at penny drop or bank verification.",
    trigger: "User has approval/profile complete but bank verification is pending.",
    cadence: "High priority retargeting until bank verification or expiry.",
    goal: "Get the user to verify bank details so the loan can move to agreement/disbursal.",
    steps: [
      "Say their TezCredit loan offer is ready but bank verification is pending",
      "Mention they can verify using UPI or bank account details on the website",
      "Ask them to open www.tezcredit.com, click Apply Now, sign in, and complete bank verification",
      "Reassure that no OTP, PIN or card details are needed on the call",
      "If they face failure, ask them to retry on the website or use website support"
    ]
  },
  TEZ_ESIGN_PENDING: {
    category: "TezCredit Retargeting",
    title: "TezCredit - E-sign Pending",
    task: "Convert approved users stuck at loan agreement e-sign.",
    trigger: "Bank verification is done but loan agreement is not signed.",
    cadence: "High priority retargeting until signed or declined.",
    goal: "Get the user to review and e-sign the loan agreement.",
    steps: [
      "Say their TezCredit loan is at the final agreement step",
      "Ask them to open www.tezcredit.com, click Apply Now, sign in, and review the loan amount and terms",
      "Tell them to e-sign only if they are comfortable with the terms",
      "Mention disbursal can proceed after successful e-sign and final checks",
      "If they have a doubt, answer briefly and return to e-sign"
    ]
  },
  TEZ_APPROVED_NOT_DISBURSED: {
    category: "TezCredit Retargeting",
    title: "TezCredit - Approved Not Disbursed",
    task: "Help approved users complete the remaining step before disbursal.",
    trigger: "User is approved but no disbursal is recorded.",
    cadence: "High priority retargeting until disbursed, declined or expired.",
    goal: "Find the blocker and guide the user to the next website step.",
    steps: [
      "Say their TezCredit approval is visible but disbursal is not complete",
      "Ask them to open www.tezcredit.com, click Apply Now, sign in, and report the screen shown",
      "Guide to the pending step: bank verification, e-sign, or final review",
      "Reassure that you will not ask for OTP, PIN or password",
      "Close with a clear next action or callback"
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

async function buildPrompt(lead, { transcript = [], lastUserMessage = "", conversationState = {} } = {}) {
  const playbook = await getPlaybook(lead.tenant_id, lead.playbook_type);
  const amount = lead.offer_amount || lead.loan_amount || "eligible";
  const transcriptUserTurns = transcript.filter(item => item.speaker === "user").length;
  const userTurns = (transcriptUserTurns || lastUserMessage) ? Math.max(transcriptUserTurns, 1) : 0;
  const openingAlreadySpoken = transcript.some(item => item.speaker === "assistant");
  const stepIndex = resolveStepIndex(playbook, lead, userTurns, openingAlreadySpoken, conversationState, lastUserMessage);
  const currentStep = playbook.steps[stepIndex] || playbook.goal || "Continue the playbook conversation";
  const upcomingStep = playbook.steps[stepIndex + 1] || "";
  const recentTranscript = formatTranscript(transcript);
  const languageInstruction = responseLanguageInstruction(lead.language);
  const stateNotes = conversationStateNotes(lead, conversationState, lastUserMessage);
  const journeyNotes = journeyContextNotes(lead);
  const suggestedLines = suggestedVoiceLines(lead);
  const journeyUrl = isTezJourneyLead(lead) ? config.tezCreditUrl : config.loanAppUrl;

  return `
You are a warm Hindi-English AI loan assistant for a phone call.

Playbook: ${playbook.title}
Category: ${playbook.category}
Goal: ${playbook.goal}
Task: ${playbook.task || playbook.category}
Trigger: ${playbook.trigger || "not provided"}
Cadence: ${playbook.cadence || "configurable"}
Current required playbook action: ${currentStep}
Next action after this, if user cooperates: ${upcomingStep || "Close politely based on user intent."}

Customer:
Name: ${lead.name || "Customer"}
Phone: ${lead.phone}
Drop stage: ${lead.drop_stage || lead.playbook_type}
Loan amount: ${lead.loan_amount || "not provided"}
Offer amount: ${lead.offer_amount || "not provided"}
Due date: ${lead.due_date || "not provided"}
Language: ${lead.language || "Hinglish"}
Source status: ${lead.source_status || "not provided"}
Journey stage: ${lead.drop_stage || lead.playbook_type}

Journey context:
${journeyNotes}

Known call memory:
${stateNotes}

Conversation steps:
${playbook.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}

Crisp spoken lines for this journey:
${suggestedLines}

Recent transcript:
${recentTranscript || "No prior conversation except the opening greeting."}

Latest customer message:
${lastUserMessage || "No clear customer message captured yet."}

Rules:
- Treat the selected playbook as the source of truth for what to do next.
- If a journey stage is provided, anchor every response to that exact pending step.
- Never claim that a different journey stage is pending. Mention later stages only as future steps.
- Use only the customer amounts shown above. Never calculate, estimate, or invent another loan amount.
- Use only the Customer journey URL and Payment link base listed below. Never invent a website, domain, phone number, or support channel.
- Never state a numeric interest rate, fee, EMI, penalty, or tenure unless that exact value appears in the customer data above.
- Never claim guaranteed approval, guaranteed disbursal, or guaranteed eligibility.
- Use the crisp spoken lines as examples. Do not read them all at once.
- Follow the current required playbook action. Do not restart from the beginning unless the user asks.
- If the known call memory says the name is already confirmed, never ask the name or reference details again.
- If the customer answers a question, progress to the next relevant action.
- Listen like a live caller: answer the customer's latest sentence first, then move one small step forward.
- Never answer an older question if the latest customer message changed topic.
- Never repeat the last assistant prompt or the same idea in the same words. If the next action is unchanged, rephrase it with a smaller, more specific ask.
- If the customer says "yes", "ok", "haan", or "hmm" after a link/app instruction, ask what screen they see now.
- If the user says only "no" or "nahi" after a link/app instruction, ask what is blocking them before treating it as not interested.
- If the customer asks a question, answer briefly and then return to the playbook path.
- If the customer says "what?", "repeat", "samajh nahi aaya", "है जी?", or sounds confused, do not repeat the same line. Say it differently in simpler words.
- If asked about interest rate, fees, EMI, tenure, or exact final amount, do not invent numbers. Say the exact value is shown on the final offer/payment screen after eligibility checks, then guide them to open the secure link.
- If asked about safety, say the user should use only the secure app link and that you will never ask for OTP, PIN, password, card details, or Aadhaar OTP on the call.
- If the customer says "that is not what I asked" or sounds frustrated, apologize once and ask which exact detail they want: interest rate, EMI, amount, fees, documents, or link.
- ${languageInstruction}
- If the customer asks to switch language, obey immediately and continue in that language.
- For Hindi, write Hindi words in Devanagari, not Romanized Hindi. Use "हाँ जी", "आप", "ठीक है", "कर दूँ" instead of "haan ji", "aap", "theek hai", "kar doon".
- Keep brand and app words easy to pronounce: say "लोन कनेक्ट", "सुरक्षित लिंक", "सिबिल", and "ई एम आई".
- Use English words only when they sound natural on an Indian phone call, such as "app", "link", or "offer".
- Sound calm, helpful, and conversational, like a patient assistant on a real call.
- Start with a tiny acknowledgement only when it fits, such as "हाँ जी", "ठीक है", or "समझ गया".
- Do not repeat the customer's name, LoanConnect, or the same sentence structure in every turn.
- Avoid sounding like a script. Use natural micro-replies such as "हाँ जी, समझ गया" only when they help the flow.
- Ask only one clear question at a time.
- Use everyday words. Avoid internal terms like playbook, campaign, drop stage, trigger, cadence, UTM, or routing.
- If the customer sounds busy or hesitant, make the ask smaller and offer a callback.
- If the latest message is just a greeting, greet back briefly and move to the current playbook action.
- Keep it short and human: usually 12 to 18 words, maximum two short sentences.
- Always finish the spoken response as a complete sentence with final punctuation. Never end mid-phrase.
- Prefer one helpful sentence plus one clear next step over explaining every detail.
- Use moderate pace.
- Do not sound like a robotic call center script.
- Avoid long clauses. Use one or two short spoken sentences.
- Never ask for OTP, PIN, password, card details, or Aadhaar OTP.
- Never promise guaranteed loan approval.
- Never threaten the user.
- For collections, be firm but respectful.
- If user is interested, tell them secure link will be shared.
- If user declines, ask for one short reason only once, then close politely.
- There is no live human transfer in this call. If the playbook says route to support, capture the issue and mention help is available in the app/support channel.
- Customer journey URL: ${journeyUrl}
- Payment link base: ${config.paymentLinkBase}
- Support phone: ${config.supportPhone || "available in app"}

Common answers you can use:
- Identity: say you are LoanConnect's AI assistant calling about loan eligibility, offer, or payment reminder based on the playbook.
- Data source: say the number is linked to a loan enquiry or app registration record; if wrong, the user can say so and it will be marked.
- Link issues: send or resend the secure app/payment link and ask the user to open it in mobile data or the app.
- Login issues: ask the user to login in the app with their mobile number, but never ask them to share OTP.
- Documents: exact requirements are shown in the app; usually basic KYC and income details may be needed.
- Disbursal: timing depends on final approval and bank processing; do not promise instant transfer unless data says so.
- CIBIL: timely payment helps protect CIBIL; overdue payment can hurt it.
- Already paid: acknowledge and ask them to keep the receipt; do not demand payment again.
- Payment failed: ask them to retry only through the secure link; if money was debited, use app support before paying again.
- Partial payment or restructuring: say options are shown in the app if eligible.
- No human transfer: say there is no human transfer on this call; capture the issue and point to app support.

Now generate only the next spoken response.
`;
}

function journeyContextNotes(lead = {}) {
  const meta = lead.source_metadata || {};
  const product = meta.productName || "the loan app";
  const stage = String(lead.drop_stage || lead.playbook_type || "");
  const notes = [
    `- Product/application: ${product}.`,
    ...tezJourneyPromptNotes(lead)
  ];

  if (stage === "SELFIE_PENDING") notes.push("- Pending step: live selfie. User must keep face centered and complete it at www.tezcredit.com.");
  if (stage === "AADHAAR_PENDING") notes.push("- Pending step: Aadhaar KYC through DigiLocker from the TezCredit website.");
  if (stage === "PROFILE_PENDING") notes.push("- Pending step: profile details such as income, employer, PAN or pincode.");
  if (stage === "BANK_VERIFICATION_PENDING") notes.push("- Pending step: bank verification / penny drop using UPI or bank account details.");
  if (stage === "E_SIGN_PENDING") notes.push("- Pending step: review and e-sign the loan agreement.");
  if (stage === "APPROVED_NOT_DISBURSED") notes.push("- Pending step: approval exists but disbursal is not complete; discover the current website screen.");

  if (meta.utmCampaign) notes.push(`- UTM campaign: ${meta.utmCampaign}. Do not say this to the customer.`);
  if (meta.rejectReason) notes.push(`- Internal reject reason: ${meta.rejectReason}. Do not call rejected users unless explicitly uploaded.`);
  return notes.join("\n");
}

function suggestedVoiceLines(lead = {}) {
  const english = responseLanguageInstruction(lead.language).includes("English");
  const stage = String(lead.drop_stage || lead.playbook_type || "");
  const amount = lead.offer_amount || lead.loan_amount;
  const amountText = amount ? ` ${formatAmountForPrompt(amount)}` : "";
  const lines = {
    SELFIE_PENDING: english
      ? [
        "Your TezCredit application is pending at the live selfie step.",
        "It takes less than a minute. Please keep your face centered in the camera.",
        "Can you open the app now and complete the selfie?"
      ]
      : [
        "आपकी TezCredit application live selfie step पर pending है।",
        "इसमें एक minute से कम लगेगा। Face camera के center में रखना है।",
        "क्या आप अभी app खोलकर selfie complete कर सकते हैं?"
      ],
    AADHAAR_PENDING: english
      ? [
        "Your TezCredit KYC is pending at Aadhaar DigiLocker.",
        "Please complete it only inside the secure app. I will not ask for OTP.",
        "Can you open the app and finish Aadhaar KYC now?"
      ]
      : [
        "आपकी TezCredit KYC Aadhaar DigiLocker step पर pending है।",
        "यह secure app के अंदर ही complete होगा। मैं OTP नहीं पूछूँगा।",
        "क्या आप अभी app खोलकर Aadhaar KYC complete कर सकते हैं?"
      ],
    PROFILE_PENDING: english
      ? [
        "Your TezCredit application is stuck at profile details.",
        "Please complete the pending income, employer, PAN or pincode field.",
        "After this, the app can show final eligibility."
      ]
      : [
        "आपकी TezCredit application profile details पर रुकी हुई है।",
        "Income, employer, PAN या pincode में जो field pending है, उसे complete करना है।",
        "इसके बाद app final eligibility दिखा पाएगा।"
      ],
    BANK_VERIFICATION_PENDING: english
      ? [
        `Your TezCredit offer${amountText ? ` of about${amountText}` : ""} is ready, but bank verification is pending.`,
        "You can verify using UPI or bank account details inside the app.",
        "Can you complete bank verification now?"
      ]
      : [
        `आपका TezCredit offer${amountText ? ` लगभग${amountText}` : ""} ready है, बस bank verification pending है।`,
        "App में UPI या bank account details से verify कर सकते हैं।",
        "क्या आप अभी bank verification complete कर सकते हैं?"
      ],
    E_SIGN_PENDING: english
      ? [
        "Your TezCredit loan is at the final agreement step.",
        "Please review the amount and terms in the app, then e-sign only if comfortable.",
        "After successful e-sign and final checks, disbursal can move ahead."
      ]
      : [
        "आपका TezCredit loan final agreement step पर है।",
        "App में amount और terms review कीजिए, comfortable हों तभी e-sign कीजिए।",
        "E-sign और final checks के बाद disbursal आगे बढ़ सकता है।"
      ],
    APPROVED_NOT_DISBURSED: english
      ? [
        "Your TezCredit approval is visible, but disbursal is not complete.",
        "Which screen do you see in the app right now?",
        "I can guide you to bank verification, e-sign, or final review."
      ]
      : [
        "आपकी TezCredit approval दिख रही है, लेकिन disbursal complete नहीं हुआ है।",
        "App में अभी कौन सा screen दिख रहा है?",
        "मैं bank verification, e-sign या final review step में guide कर दूँगा।"
      ]
  }[stage] || [];

  return lines.length
    ? lines.map((line, index) => `${index + 1}. ${normalizeTezCreditPlaybookText(line)}`).join("\n")
    : "- No stage-specific line. Keep the response short and helpful.";
}

function formatAmountForPrompt(value) {
  const number = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(number) || number <= 0) return String(value || "");
  return `₹${Math.round(number).toLocaleString("en-IN")}`;
}

function responseLanguageInstruction(language) {
  const value = String(language || "").toLowerCase();
  if (value.includes("english")) {
    return "Speak in simple Indian English. Do not use Hindi unless the customer asks for Hindi.";
  }
  return "Speak in natural Indian phone-call Hindi unless language says otherwise.";
}

function resolveStepIndex(playbook, lead, userTurns, openingAlreadySpoken, conversationState, lastUserMessage) {
  const maxIndex = Math.max(playbook.steps.length - 1, 0);
  let stepIndex = Math.min(Math.max(userTurns + (openingAlreadySpoken ? 0 : -1), 0), maxIndex);

  const nameAlreadyConfirmed = Boolean(conversationState?.confirmedName) || freshLeadNameProvided(lead, lastUserMessage);
  if (lead.playbook_type === "FRESH_LEAD" && nameAlreadyConfirmed && asksForReferenceDetails(playbook.steps[stepIndex])) {
    stepIndex = Math.min(stepIndex + 1, maxIndex);
  }

  return stepIndex;
}

function conversationStateNotes(lead, conversationState = {}, lastUserMessage = "") {
  const notes = [];
  const capturedName = conversationState.capturedName || "";
  const nameConfirmed = Boolean(conversationState.confirmedName) || freshLeadNameProvided(lead, lastUserMessage);
  const journey = tezJourneyContext(lead);

  if (nameConfirmed) {
    notes.push(`- Name/reference confirmation is already done${capturedName ? `: ${capturedName}` : ""}. Do not ask for the name again.`);
    if (lead.playbook_type === "FRESH_LEAD") {
      notes.push("- Continue with the loan requirement or final eligibility guidance.");
    }
  } else {
    notes.push("- No explicit name confirmation captured yet.");
  }

  if (conversationState.lastSpokenText) {
    notes.push(`- Last assistant prompt: ${conversationState.lastSpokenText}`);
  }

  if (journey) {
    notes.push(`- Continue from ${journey.current.label}; do not restart earlier TezCredit stages.`);
    notes.push(`- Journey progress: ${journey.completedStages.length}/${journey.totalStages} stages completed.`);
  }

  return notes.join("\n");
}

function asksForReferenceDetails(step) {
  return /(name|reference detail|नाम|reference)/i.test(String(step || ""));
}

function freshLeadNameProvided(lead, lastUserMessage) {
  if (lead.playbook_type !== "FRESH_LEAD") return false;
  return /\b(my name is|i am|this is|mera naam)\b/i.test(String(lastUserMessage || "")) ||
    /\b(मेरा नाम|मैं)\b/u.test(String(lastUserMessage || ""));
}

function formatTranscript(transcript) {
  return transcript
    .slice(-10)
    .map(item => {
      const speaker = item.speaker === "assistant" ? "Assistant" : "Customer";
      return `${speaker}: ${String(item.text || "").replace(/\s+/g, " ").trim().slice(0, 220)}`;
    })
    .filter(line => !line.endsWith(": "))
    .join("\n");
}

function rowsToMap(rows) {
  return rows.reduce((acc, row) => {
    acc[row.key] = rowToPlaybook(row);
    return acc;
  }, {});
}

function rowToPlaybook(row) {
  const playbook = {
    category: row.category,
    title: row.title,
    task: row.task || "",
    trigger: row.trigger || "",
    cadence: row.cadence || "",
    goal: row.goal || "",
    steps: Array.isArray(row.steps) ? row.steps : []
  };
  if (!String(row.key || "").startsWith("TEZ_")) return playbook;
  return {
    ...playbook,
    task: normalizeTezCreditPlaybookText(playbook.task),
    trigger: normalizeTezCreditPlaybookText(playbook.trigger),
    cadence: normalizeTezCreditPlaybookText(playbook.cadence),
    goal: normalizeTezCreditPlaybookText(playbook.goal),
    steps: playbook.steps.map(normalizeTezCreditPlaybookText)
  };
}

function normalizeTezCreditPlaybookText(value) {
  return String(value || "")
    .replace(/\bsecure app link\b/gi, "secure TezCredit website link")
    .replace(/\bapp support\b/gi, "website support")
    .replace(/\bapp\b/gi, "website")
    .replace(/ऐप/g, "website");
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
