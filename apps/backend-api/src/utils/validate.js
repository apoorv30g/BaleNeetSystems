// Minimal request-body validation.
//
// Hand-rolled rather than pulling in zod/joi: the schemas needed here are shallow, and the
// Docker images ship to a small VPS where every dependency is also a supply-chain surface.
// If schemas start needing unions, refinements, or nested objects, swap this for zod --
// the middleware signature is designed so call sites would not change.
//
// Returns a clean 400 listing every problem at once, rather than failing on the first field
// (an operator fixing a CSV upload form should not have to submit five times to find five
// mistakes). Without this, malformed input reaches Postgres and surfaces as a 500.

const VALIDATORS = {
  string: (value, rule) => {
    if (typeof value !== "string") return "must be a string";
    const trimmed = value.trim();
    if (rule.required && !trimmed) return "is required";
    if (rule.min !== undefined && trimmed.length < rule.min) return `must be at least ${rule.min} characters`;
    if (rule.max !== undefined && trimmed.length > rule.max) return `must be at most ${rule.max} characters`;
    if (rule.pattern && !rule.pattern.test(trimmed)) return rule.patternMessage || "is not in the expected format";
    if (rule.oneOf && !rule.oneOf.includes(trimmed)) return `must be one of: ${rule.oneOf.join(", ")}`;
    return null;
  },
  number: (value, rule) => {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "must be a number";
    if (rule.integer && !Number.isInteger(n)) return "must be a whole number";
    if (rule.min !== undefined && n < rule.min) return `must be at least ${rule.min}`;
    if (rule.max !== undefined && n > rule.max) return `must be at most ${rule.max}`;
    return null;
  },
  boolean: (value) => (typeof value === "boolean" ? null : "must be true or false"),
  object: (value) => (value && typeof value === "object" && !Array.isArray(value) ? null : "must be an object"),
  array: (value, rule) => {
    if (!Array.isArray(value)) return "must be an array";
    if (rule.max !== undefined && value.length > rule.max) return `must have at most ${rule.max} items`;
    return null;
  }
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates a plain object against a shallow schema.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateBody(body, schema) {
  const errors = [];
  const input = body && typeof body === "object" ? body : {};

  for (const [field, rule] of Object.entries(schema)) {
    const value = input[field];
    const missing = value === undefined || value === null || value === "";

    if (missing) {
      if (rule.required) errors.push(`${field} is required`);
      continue; // optional-and-absent is fine; absence is not a type error
    }

    const check = VALIDATORS[rule.type];
    if (!check) continue;
    const problem = check(value, rule);
    if (problem) errors.push(`${field} ${problem}`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Express middleware factory. Rejects with 400 and the full error list.
 * Deliberately does NOT mutate or strip req.body -- routes already read the fields they
 * expect, and silently dropping unknown keys would hide client bugs.
 */
function validate(schema) {
  return (req, res, next) => {
    const { valid, errors } = validateBody(req.body, schema);
    if (!valid) return res.status(400).json({ error: "Invalid request", details: errors });
    next();
  };
}

// Shared field rules, so the same constraint is not re-spelled per route.
const fields = {
  email: { type: "string", required: true, max: 200, pattern: EMAIL_PATTERN, patternMessage: "must be a valid email address" },
  password: { type: "string", required: true, min: 8, max: 200 },
  name: { type: "string", max: 200 },
  // Deliberately permissive on shape (international formats vary); length-bounded only.
  phone: { type: "string", min: 8, max: 20 }
};

module.exports = { validate, validateBody, fields, EMAIL_PATTERN };
