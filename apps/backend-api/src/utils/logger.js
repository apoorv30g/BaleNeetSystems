// Structured logging with PII redaction.
//
// Log lines from this system routinely carry borrower context -- transcripts, phone numbers,
// loan amounts. Logs get shipped, tailed, pasted into tickets, and retained far longer than
// the data policy that governs the database, so they are a genuine leak path for an NBFC
// deployment. Redaction happens here, at the single choke point, rather than relying on every
// call site to remember.
//
// Set LOG_REDACT_PII=false to disable (local debugging only -- never in production).

const REDACT_ENABLED = process.env.LOG_REDACT_PII !== "false";

// Keys whose values are replaced wholesale, regardless of content.
const SENSITIVE_KEYS = new Set([
  "password", "password_hash", "passwordhash", "token", "authorization", "apikey", "api_key",
  "secret", "jwt", "phone", "mobile", "msisdn", "email", "pan", "aadhaar", "aadhar",
  "accountnumber", "account_number", "otp", "pin", "cvv"
]);

// Free-text values (transcripts, error strings) get pattern-based scrubbing.
// Digit lookarounds rather than \b: in "+919876543210" there is no word boundary between the
// country code and the number, so a \b-anchored phone pattern misses it and the 12-digit
// Aadhaar pattern then claims it instead. Phone must also be tried before Aadhaar.
const PATTERNS = [
  // Indian mobile numbers, with or without country code, spaced or concatenated.
  [/(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g, "[phone]"],
  // PAN: 5 letters, 4 digits, 1 letter.
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, "[pan]"],
  // Aadhaar: 12 digits, often spaced in groups of four.
  [/(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)/g, "[aadhaar]"],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "[email]"]
];

function redactText(value) {
  let out = String(value);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

function redact(value, key = "", depth = 0) {
  if (!REDACT_ENABLED || depth > 6) return value;

  if (key && SENSITIVE_KEYS.has(String(key).toLowerCase())) return "[redacted]";

  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(item => redact(item, "", depth + 1));

  if (value && typeof value === "object") {
    // Errors don't survive a plain spread; keep the useful fields explicitly.
    if (value instanceof Error) return { message: redactText(value.message), name: value.name };
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k, depth + 1);
    return out;
  }

  return value;
}

function log(level, message, meta = {}) {
  const entry = {
    level,
    message: typeof message === "string" ? redactText(message) : message,
    service: "backend-api",
    ts: new Date().toISOString(),
    ...redact(meta)
  };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else console.log(line);
}

module.exports = {
  info: (message, meta) => log("info", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  error: (message, meta) => log("error", message, meta),
  _test: { redact, redactText, SENSITIVE_KEYS }
};
