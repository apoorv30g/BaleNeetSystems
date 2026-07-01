const TEZ_JOURNEY = [
  {
    stage: "SELFIE_PENDING",
    playbookType: "TEZ_SELFIE_PENDING",
    label: "live selfie",
    textPattern: /(selfie|live photo|camera|सेल्फी|फोटो|कैमरा)/
  },
  {
    stage: "AADHAAR_PENDING",
    playbookType: "TEZ_AADHAAR_PENDING",
    label: "Aadhaar KYC",
    textPattern: /(aadhaar|aadhar|kyc|digilocker|आधार|केवाईसी|के वाई सी|डिजिलॉकर)/
  },
  {
    stage: "PROFILE_PENDING",
    playbookType: "TEZ_PROFILE_PENDING",
    label: "profile details",
    textPattern: /(profile|profession|income|employer|employment|pan|pincode|address|प्रोफाइल|पैन|पिनकोड|इनकम)/
  },
  {
    stage: "BANK_VERIFICATION_PENDING",
    playbookType: "TEZ_BANK_VERIFICATION_PENDING",
    label: "bank verification",
    textPattern: /(bank verification|penny drop|upi|bank account|account verification|बैंक वेरिफिकेशन|यू पी आई|खाता)/
  },
  {
    stage: "E_SIGN_PENDING",
    playbookType: "TEZ_ESIGN_PENDING",
    label: "agreement e-sign",
    textPattern: /(e[ -]?sign|esign|agreement|sign document|ई साइन|एग्रीमेंट|हस्ताक्षर)/
  },
  {
    stage: "APPROVED_NOT_DISBURSED",
    playbookType: "TEZ_APPROVED_NOT_DISBURSED",
    label: "approval and disbursal",
    textPattern: /(approved|approval|disburs|credited|money received|amount received|पैसा मिल|पैसे मिल|खाते में आ|डिस्बर्स)/
  }
];

const STAGE_BY_NAME = new Map(TEZ_JOURNEY.map(item => [item.stage, item]));
const STAGE_BY_PLAYBOOK = new Map(TEZ_JOURNEY.map(item => [item.playbookType, item]));

function isTezJourneyLead(lead = {}) {
  const product = String(lead.source_metadata?.productName || "").toLowerCase();
  return Boolean(getTezJourneyStage(lead))
    || String(lead.playbook_type || "").startsWith("TEZ_")
    || product.includes("tezcredit");
}

function normalizeTezCreditSurfaceText(lead = {}, text = "", websiteUrl = "www.tezcredit.com") {
  if (!isTezJourneyLead(lead)) return String(text || "");
  return String(text || "")
    .replace(/\bsecure app link\b/gi, `secure TezCredit website, ${websiteUrl}`)
    .replace(/\bapp link\b/gi, `TezCredit website link, ${websiteUrl}`)
    .replace(/\bapp support\b/gi, "website support")
    .replace(/\bmobile app\b/gi, "website")
    .replace(/\bapp\b/gi, "website")
    .replace(/ऐप/g, "website");
}

function getTezJourneyStage(lead = {}) {
  const metadataStage = normalizeStage(lead.source_metadata?.journeyProgress?.currentStage);
  const dropStage = normalizeStage(lead.drop_stage);
  const playbookStage = STAGE_BY_PLAYBOOK.get(String(lead.playbook_type || "").toUpperCase())?.stage || "";
  return metadataStage || dropStage || playbookStage;
}

function tezJourneyContext(lead = {}) {
  const currentStage = getTezJourneyStage(lead);
  const currentIndex = TEZ_JOURNEY.findIndex(item => item.stage === currentStage);
  if (currentIndex < 0) return null;

  const savedCompleted = Array.isArray(lead.source_metadata?.journeyProgress?.completedStages)
    ? lead.source_metadata.journeyProgress.completedStages.map(normalizeStage).filter(Boolean)
    : [];
  const completedStages = unique([
    ...TEZ_JOURNEY.slice(0, currentIndex).map(item => item.stage),
    ...savedCompleted
  ]).filter(stage => stage !== currentStage);

  return {
    currentStage,
    currentIndex,
    current: TEZ_JOURNEY[currentIndex],
    completedStages,
    remainingStages: TEZ_JOURNEY.slice(currentIndex).map(item => item.stage),
    next: TEZ_JOURNEY[currentIndex + 1] || null,
    totalStages: TEZ_JOURNEY.length
  };
}

function detectTezJourneyProgress(lead = {}, text = "", { lastSpokenText = "" } = {}) {
  const context = tezJourneyContext(lead);
  if (!context) return null;

  const normalized = normalizeText(text);
  if (!normalized || isNegativeOrFailed(normalized)) return null;

  const currentMentioned = context.current.textPattern.test(normalized);
  const normalizedLastPrompt = normalizeText(lastSpokenText);
  const lastPromptWasCurrentStage = context.current.textPattern.test(normalizedLastPrompt);
  const explicitCompletion = completionPhrase(normalized);
  const confirmedCompletionQuestion = positiveConfirmation(normalized)
    && completionConfirmationAsked(normalizedLastPrompt, context.current);
  const reportedStage = detectReportedStage(normalized, context.currentIndex);
  const movedForwardInApp = reportedStage
    && reportedStage.index > context.currentIndex
    && screenProgressPhrase(normalized);

  if (context.current.stage === "APPROVED_NOT_DISBURSED") {
    if (!disbursalConfirmed(normalized) && !confirmedCompletionQuestion) return null;
    return buildProgress(context, null, "disbursal_confirmed");
  }

  if (movedForwardInApp) {
    return buildProgress(context, reportedStage.item, "next_screen_reported");
  }

  if (confirmedCompletionQuestion) {
    return buildProgress(context, context.next, "completion_question_confirmed");
  }

  if (!explicitCompletion || (!currentMentioned && !lastPromptWasCurrentStage)) return null;
  return buildProgress(context, context.next, "stage_completion_confirmed");
}

function applyTezJourneyProgress(lead = {}, progress = {}, at = new Date()) {
  const existingMetadata = lead.source_metadata && typeof lead.source_metadata === "object"
    ? lead.source_metadata
    : {};
  const existingProgress = existingMetadata.journeyProgress && typeof existingMetadata.journeyProgress === "object"
    ? existingMetadata.journeyProgress
    : {};
  const completedStages = unique([
    ...(progress.completedStages || []),
    progress.completedStage
  ].map(normalizeStage).filter(Boolean));
  const history = Array.isArray(existingProgress.history) ? existingProgress.history.slice(-19) : [];
  const timestamp = at instanceof Date ? at.toISOString() : String(at);
  history.push({
    completedStage: progress.completedStage,
    nextStage: progress.nextStage || "JOURNEY_COMPLETED",
    reason: progress.reason || "stage_completion_confirmed",
    at: timestamp
  });

  const journeyProgress = {
    ...existingProgress,
    startingStage: existingProgress.startingStage || getTezJourneyStage(lead),
    currentStage: progress.nextStage || "JOURNEY_COMPLETED",
    completedStages,
    completedCount: completedStages.length,
    totalStages: TEZ_JOURNEY.length,
    journeyCompleted: Boolean(progress.journeyComplete),
    lastAdvancedAt: timestamp,
    completedAt: progress.journeyComplete ? timestamp : (existingProgress.completedAt || null),
    history
  };
  const sourceMetadata = {
    ...existingMetadata,
    journeyStage: journeyProgress.currentStage,
    journeyProgress
  };

  return {
    ...lead,
    drop_stage: progress.nextStage || "JOURNEY_COMPLETED",
    playbook_type: progress.nextPlaybookType || lead.playbook_type,
    source_status: progress.journeyComplete ? "JOURNEY_COMPLETED" : lead.source_status,
    source_metadata: sourceMetadata,
    status: progress.journeyComplete ? "completed" : lead.status
  };
}

function buildTezJourneyTransitionReply(progress = {}, english = false) {
  if (progress.journeyComplete) {
    return english
      ? "Perfect, the disbursal is complete. Your TezCredit journey is finished. Thank you for confirming."
      : "बहुत बढ़िया, disbursal complete हो गया है। आपकी TezCredit journey पूरी हो गई। Confirm करने के लिए धन्यवाद।";
  }

  const replies = {
    AADHAAR_PENDING: english
      ? "Perfect, the selfie is done. Has the Aadhaar KYC screen opened now?"
      : "बहुत बढ़िया, selfie हो गई। क्या अब Aadhaar KYC का screen खुला है?",
    PROFILE_PENDING: english
      ? "Great, Aadhaar KYC is done. Which profile detail is the website asking for now?"
      : "बहुत अच्छा, Aadhaar KYC हो गई। अब website कौन सी profile detail माँग रही है?",
    BANK_VERIFICATION_PENDING: english
      ? "Good, your profile is complete. Can you see the bank-verification option now?"
      : "ठीक है, profile complete है। क्या अब bank verification का option दिख रहा है?",
    E_SIGN_PENDING: english
      ? "Excellent, bank verification is done. Do you see the agreement and e-sign button?"
      : "बहुत बढ़िया, bank verification हो गया। क्या agreement और e-sign button दिख रहा है?",
    APPROVED_NOT_DISBURSED: english
      ? "Great, the agreement is signed. Is the website showing approval or disbursal processing now?"
      : "बहुत अच्छा, agreement sign हो गया। क्या website पर approval या disbursal processing दिख रही है?"
  };

  return replies[progress.nextStage] || (english
    ? "Great, that step is complete. Tell me what the website shows next."
    : "बहुत अच्छा, यह step complete है। अब website पर आगे क्या दिख रहा है?");
}

function tezJourneyPromptNotes(lead = {}) {
  const context = tezJourneyContext(lead);
  if (!context) return [];
  const completed = context.completedStages.map(stageLabel).join(", ") || "none confirmed";
  const remaining = context.remainingStages.map(stageLabel).join(" -> ");
  return [
    `- This is one continuous TezCredit journey, not an isolated playbook.`,
    `- Current pending stage: ${context.current.label} (${context.current.stage}).`,
    `- Already completed stages: ${completed}. Never take the customer back to them.`,
    `- Remaining journey in order: ${remaining}.`,
    `- Use only the TezCredit website at www.tezcredit.com. Never call it an app.`,
    `- Canonical action: ask the customer to open www.tezcredit.com, click Apply Now, and sign in with their registered mobile number to resume the pending journey stage. Never ask them to say the OTP.`,
    `- Advance only after the customer clearly confirms the current stage is complete or reports the next website screen.`
  ];
}

function buildProgress(context, nextItem, reason) {
  return {
    completedStage: context.currentStage,
    completedLabel: context.current.label,
    completedStages: unique([...context.completedStages, context.currentStage]),
    nextStage: nextItem?.stage || null,
    nextPlaybookType: nextItem?.playbookType || null,
    nextLabel: nextItem?.label || null,
    journeyComplete: !nextItem,
    reason
  };
}

function detectReportedStage(text, currentIndex) {
  for (let index = currentIndex + 1; index < TEZ_JOURNEY.length; index += 1) {
    if (TEZ_JOURNEY[index].textPattern.test(text)) return { index, item: TEZ_JOURNEY[index] };
  }
  return null;
}

function completionPhrase(text) {
  return /\b(done|completed|finished|submitted|verified|successful|success|ho gaya|ho gya|hogaya|kar liya|kar diya|complete kar liya)\b/.test(text)
    || /(हो गया|हो गई|कर लिया|कर ली|कर दिया|कर दी|पूरा हो गया|पूरी हो गई|सबमिट हो गया|वेरिफाई हो गया)/.test(text);
}

function positiveConfirmation(text) {
  return /^(yes|yes it is|yes done|yeah|yep|correct|right|done|ok done|haan|han|ha ji|haan ji|ji haan|ho gaya)$/.test(text)
    || /^(हाँ|हां|हाँ जी|हां जी|जी हाँ|जी हां|हो गया|हो गई|जी)$/.test(text);
}

function completionConfirmationAsked(text, currentStage) {
  if (!text || !currentStage?.textPattern.test(text)) return false;
  if (currentStage.stage === "APPROVED_NOT_DISBURSED") {
    return /(money|amount|funds|paisa|paise|पैसा|पैसे|राशि).*(credited|received|account|credit|आ गया|आ गई|मिल गया|मिल गए)/.test(text);
  }
  return /(is|has|did|does|क्या).*(complete|completed|done|successful|success|हो गया|हो गई|पूरा|पूरी|कर लिया|save|saved|submit|submitted)/.test(text);
}

function screenProgressPhrase(text) {
  return /\b(now|next|showing|shows|opened|asking|moved|screen|option|visible|aa gaya|aaya hai|dikh raha|khul gaya)\b/.test(text)
    || /(अब|आ गया|आ गई|दिख रहा|दिख रही|खुल गया|खुल गई|माँग रहा|स्क्रीन)/.test(text);
}

function disbursalConfirmed(text) {
  return /(money|amount|loan|funds|paisa|paise).*(received|credited|disbursed|mil gaya|mil gaye|aa gaya|account.*aa)/.test(text)
    || /(received|credited|disbursed).*(money|amount|loan|funds)/.test(text)
    || /(पैसा|पैसे|राशि).*(मिल गया|मिल गए|आ गया|आ गई|credit|क्रेडिट)/.test(text)
    || /(खाते|अकाउंट).*(पैसा|पैसे|राशि).*(आ गया|आ गई|मिल गया)/.test(text);
}

function isNegativeOrFailed(text) {
  return /\b(not done|not complete|not completed|didn t|did not|failed|failure|error|still pending|nahi hua|nahi kiya|nahin hua)\b/.test(text)
    || /(नहीं हुआ|नही हुआ|नहीं किया|नही किया|नहीं हो रहा|नही हो रहा|फेल|एरर|अभी बाकी|pending)/.test(text);
}

function stageLabel(stage) {
  return STAGE_BY_NAME.get(normalizeStage(stage))?.label || String(stage || "");
}

function normalizeStage(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (STAGE_BY_NAME.has(normalized)) return normalized;
  return STAGE_BY_PLAYBOOK.get(normalized)?.stage || "";
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[।,.!?;:()[\]{}"'`*_>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  return Array.from(new Set(values));
}

module.exports = {
  TEZ_JOURNEY,
  applyTezJourneyProgress,
  buildTezJourneyTransitionReply,
  detectTezJourneyProgress,
  getTezJourneyStage,
  isTezJourneyLead,
  normalizeTezCreditSurfaceText,
  tezJourneyContext,
  tezJourneyPromptNotes
};
