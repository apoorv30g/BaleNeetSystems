const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const { signToken } = require("../middleware/auth");

const router = express.Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await query(`SELECT * FROM users WHERE email=$1`, [email]);
  const user = result.rows[0];

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, tenantId: user.tenant_id }
  });
});

module.exports = router;
