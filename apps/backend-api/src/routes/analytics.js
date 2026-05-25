const express = require("express");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth);

router.get("/summary", async (req, res) => {
  const summary = await query(
    `SELECT
      COUNT(*)::int as total_calls,
      COUNT(CASE WHEN status='completed' THEN 1 END)::int as completed,
      COUNT(CASE WHEN status='failed' THEN 1 END)::int as failed,
      COUNT(CASE WHEN outcome='INTERESTED' THEN 1 END)::int as interested,
      ROUND(AVG(duration_seconds),0) as avg_duration,
      ROUND(SUM(cost_estimate),2) as total_cost
     FROM calls WHERE tenant_id=$1`,
    [req.user.tenantId]
  );

  const playbooks = await query(
    `SELECT l.playbook_type,
      COUNT(c.id)::int as calls,
      COUNT(CASE WHEN c.outcome='INTERESTED' THEN 1 END)::int as interested
     FROM leads l
     LEFT JOIN calls c ON c.lead_id=l.id
     WHERE l.tenant_id=$1
     GROUP BY l.playbook_type
     ORDER BY calls DESC`,
    [req.user.tenantId]
  );

  const calls = await query(
    `SELECT c.*, l.name as lead_name, l.phone, l.playbook_type, l.drop_stage
     FROM calls c
     LEFT JOIN leads l ON l.id=c.lead_id
     WHERE c.tenant_id=$1
     ORDER BY c.created_at DESC LIMIT 100`,
    [req.user.tenantId]
  );

  res.json({ summary: summary.rows[0], playbooks: playbooks.rows, recentCalls: calls.rows });
});

module.exports = router;
