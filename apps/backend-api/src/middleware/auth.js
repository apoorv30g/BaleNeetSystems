const jwt = require("jsonwebtoken");
const config = require("../config");
const { query } = require("../db/pool");

const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

// How long a user's token_version / is_active state may be served from memory before we
// re-read it. This bounds the worst-case delay between revoking a session and that session
// actually stopping: with the default, a revoked token dies within 30s rather than lasting
// the full 8h token TTL. Set to 0 to check the database on every request.
const REVOCATION_CACHE_MS = Number(process.env.AUTH_REVOCATION_CACHE_MS || 30000);

// userId -> { tokenVersion, isActive, fetchedAt }
const userStateCache = new Map();

function signToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
      email: user.email,
      // Session generation. requireAuth rejects the token if this no longer matches the DB.
      tv: Number(user.token_version || 0)
    },
    config.jwtSecret,
    { expiresIn: JWT_EXPIRY }
  );
}

async function loadUserState(userId) {
  const cached = userStateCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < REVOCATION_CACHE_MS) return cached;

  const result = await query(
    `SELECT token_version, is_active FROM users WHERE id=$1`,
    [userId]
  );
  const row = result.rows[0];
  const state = row
    ? { tokenVersion: Number(row.token_version || 0), isActive: row.is_active !== false, fetchedAt: Date.now() }
    : { missing: true, fetchedAt: Date.now() };

  userStateCache.set(userId, state);
  return state;
}

// Called after any change that must end existing sessions. Clears the local cache so the
// next request re-reads from the DB immediately rather than waiting out the TTL.
function invalidateUserCache(userId) {
  userStateCache.delete(userId);
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  let claims;
  try {
    claims = jwt.verify(token, config.jwtSecret);
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }

  // Signature is valid, but the session may have been revoked since the token was issued.
  try {
    const state = await loadUserState(claims.userId);
    if (state.missing) return res.status(401).json({ error: "Invalid token" });
    if (!state.isActive) return res.status(401).json({ error: "Account disabled" });
    if (Number(claims.tv || 0) !== state.tokenVersion) {
      return res.status(401).json({ error: "Session expired, please sign in again" });
    }
  } catch (err) {
    // The database is unreachable. Fail closed: we cannot prove the session is still valid,
    // and this guards a system holding borrower data.
    return res.status(503).json({ error: "Authentication temporarily unavailable" });
  }

  req.user = claims;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

// Ends every existing session for a user by bumping the stored generation.
async function revokeUserSessions(userId) {
  await query(`UPDATE users SET token_version = token_version + 1 WHERE id=$1`, [userId]);
  invalidateUserCache(userId);
}

module.exports = {
  signToken,
  requireAuth,
  requireRole,
  revokeUserSessions,
  invalidateUserCache,
  _test: { userStateCache, loadUserState }
};
