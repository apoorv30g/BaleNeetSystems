const path = require("path");
const { parseCsv } = require("../utils/csv");
const { parseXlsx } = require("../utils/xlsx");

const TEZ_STAGE_PLAYBOOK = {
  SELFIE_PENDING: "TEZ_SELFIE_PENDING",
  AADHAAR_PENDING: "TEZ_AADHAAR_PENDING",
  PROFILE_PENDING: "TEZ_PROFILE_PENDING",
  BANK_VERIFICATION_PENDING: "TEZ_BANK_VERIFICATION_PENDING",
  E_SIGN_PENDING: "TEZ_ESIGN_PENDING",
  APPROVED_NOT_DISBURSED: "TEZ_APPROVED_NOT_DISBURSED"
};

function parseLeadUpload(file, campaign = {}) {
  const rows = parseRows(file);
  return rows.map((row, index) => normalizeLeadRow(row, {
    campaign,
    rowNumber: index + 2
  }));
}

function parseRows(file) {
  const ext = path.extname(file?.originalname || "").toLowerCase();
  if (ext === ".xlsx") return parseXlsx(file.buffer);
  return parseCsv(file.buffer.toString("utf8"));
}

function normalizeLeadRow(row, { campaign = {}, rowNumber = 0 } = {}) {
  const source = sourceMap(row);
  const sourceName = `${cleanValue(get(source, "utmsource"))} ${cleanValue(get(source, "utmcampaign"))}`.toLowerCase();
  const isTezCredit = hasAny(source, ["selfie", "aadhaar", "pennydrop", "esign"]) || /(crednorth|tezcredit|tez credit)/.test(sourceName);
  return isTezCredit
    ? normalizeTezCreditRow(source, campaign, rowNumber)
    : normalizeGenericRow(source, campaign, rowNumber);
}

function normalizeGenericRow(source, campaign, rowNumber) {
  const phone = normalizePhone(get(source, "phone", "mobile", "mobilenumber", "mobilephone"));
  const playbookType = get(source, "playbooktype") || campaign.playbook_type || "UNAPPROVED_USERS";
  const dropStage = get(source, "dropstage", "dropoffstage") || playbookType;

  if (!phone) return skipped(rowNumber, "missing_phone", source);

  return {
    ok: true,
    rowNumber,
    lead: {
      externalLeadId: get(source, "leadid", "externalid") || null,
      name: cleanValue(get(source, "name")),
      phone,
      campaignType: get(source, "campaigntype") || campaign.campaign_type || "RETARGETING",
      playbookType,
      dropStage,
      dueDate: cleanValue(get(source, "duedate")) || null,
      loanAmount: moneyValue(get(source, "loanamount")) || null,
      offerAmount: moneyValue(get(source, "offeramount")) || moneyValue(get(source, "loanamount")) || null,
      language: cleanValue(get(source, "language")) || campaign.language || "Hinglish",
      sourceStatus: cleanValue(get(source, "status")) || null,
      sourceRejectReason: cleanValue(get(source, "rejectreason")) || null,
      sourceMetadata: { raw: compactSource(source) }
    },
    stage: dropStage
  };
}

function normalizeTezCreditRow(source, campaign, rowNumber) {
  const phone = normalizePhone(get(source, "mobilenumber", "phone", "mobile"));
  if (!phone) return skipped(rowNumber, "missing_phone", source);

  const status = cleanValue(get(source, "status"));
  const rejectReason = cleanValue(get(source, "rejectreason"));
  const disbursedAmount = cleanValue(get(source, "disbursedamount"));
  const stage = detectTezStage(source);

  if (status.toLowerCase() === "reject") {
    return skipped(rowNumber, rejectReason ? `rejected_${safeReason(rejectReason)}` : "rejected", source, { stage, status });
  }
  if (isDisbursed(disbursedAmount)) {
    return skipped(rowNumber, "already_disbursed", source, { stage, status });
  }

  const loanAmount = moneyValue(get(source, "loanamount"));
  const playbookType = TEZ_STAGE_PLAYBOOK[stage] || campaign.playbook_type || "UNAPPROVED_USERS";
  const metadata = {
    productName: "TezCredit",
    clientSource: "CredNorth",
    journeyStage: stage,
    leadDate: cleanValue(get(source, "leaddate")),
    rejectDate: cleanValue(get(source, "rejectdate")),
    rejectReason,
    utmCampaign: cleanValue(get(source, "utmcampaign")),
    utmSource: cleanValue(get(source, "utmsource")),
    selfie: cleanValue(get(source, "selfie")),
    aadhaar: cleanValue(get(source, "aadhaar")),
    profession: cleanValue(get(source, "profession")),
    pan: cleanValue(get(source, "pan")),
    pinCode: cleanValue(get(source, "pincode")),
    pennyDrop: cleanValue(get(source, "pennydrop")),
    eSign: cleanValue(get(source, "esign")),
    disbursedAmount,
    disbursedDate: cleanValue(get(source, "disburseddate"))
  };

  return {
    ok: true,
    rowNumber,
    lead: {
      externalLeadId: cleanValue(get(source, "leadid")) || null,
      name: cleanValue(get(source, "name")),
      phone,
      campaignType: "RETARGETING",
      playbookType,
      dropStage: stage,
      dueDate: null,
      loanAmount,
      offerAmount: loanAmount,
      language: campaign.language || "Hinglish",
      sourceStatus: status || null,
      sourceRejectReason: rejectReason || null,
      sourceMetadata: metadata
    },
    stage
  };
}

function detectTezStage(source) {
  if (!isYes(get(source, "selfie"))) return "SELFIE_PENDING";
  if (!isYes(get(source, "aadhaar"))) return "AADHAAR_PENDING";
  if (!isYes(get(source, "profession"))) return "PROFILE_PENDING";
  if (!isYes(get(source, "pan"))) return "PROFILE_PENDING";
  if (!cleanValue(get(source, "pincode"))) return "PROFILE_PENDING";
  if (!isYes(get(source, "pennydrop"))) return "BANK_VERIFICATION_PENDING";
  if (!isYes(get(source, "esign"))) return "E_SIGN_PENDING";
  return "APPROVED_NOT_DISBURSED";
}

function skipped(rowNumber, reason, source, details = {}) {
  return {
    ok: false,
    rowNumber,
    reason,
    stage: details.stage || "",
    status: details.status || cleanValue(get(sourceMap(source), "status"))
  };
}

function sourceMap(row) {
  return Object.entries(row || {}).reduce((acc, [key, value]) => {
    acc[normalizeKey(key)] = value;
    return acc;
  }, {});
}

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function hasAny(source, keys) {
  return keys.some(key => Object.prototype.hasOwnProperty.call(source, key));
}

function get(source, ...keys) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) return source[key];
  }
  return "";
}

function cleanValue(value) {
  const text = String(value ?? "").trim();
  if (!text || /^(no input|nan|null|undefined)$/i.test(text)) return "";
  return text;
}

function normalizePhone(value) {
  const digits = cleanValue(value).replace(/\D/g, "");
  if (digits.length > 10 && digits.startsWith("91")) return digits.slice(-10);
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function moneyValue(value) {
  const cleaned = cleanValue(value).replace(/,/g, "");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  return cleaned;
}

function isYes(value) {
  return cleanValue(value).toLowerCase() === "yes";
}

function isDisbursed(value) {
  return /^\d+(\.\d+)?$/.test(cleanValue(value).replace(/,/g, ""));
}

function safeReason(value) {
  return cleanValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80);
}

function compactSource(source) {
  return Object.entries(source || {}).reduce((acc, [key, value]) => {
    const cleaned = cleanValue(value);
    if (cleaned) acc[key] = cleaned;
    return acc;
  }, {});
}

module.exports = {
  TEZ_STAGE_PLAYBOOK,
  parseLeadUpload,
  normalizeLeadRow,
  detectTezStage,
  _test: {
    normalizeLeadRow,
    detectTezStage
  }
};
