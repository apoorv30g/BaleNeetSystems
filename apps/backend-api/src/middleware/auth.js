const jwt = require("jsonwebtoken");
const config = require("../config");

const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

function signToken(user) {
  return jwt.sign(
    { userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: JWT_EXPIRY }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: "Forbidden" });
    next();
  };
}

module.exports = { signToken, requireAuth, requireRole };
