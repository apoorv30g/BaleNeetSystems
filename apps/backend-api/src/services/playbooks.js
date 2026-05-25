const config = require("../config");

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

function buildPrompt(lead) {
  const playbook = PLAYBOOKS[lead.playbook_type] || PLAYBOOKS.UNAPPROVED_USERS;
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

module.exports = { PLAYBOOKS, buildPrompt };
