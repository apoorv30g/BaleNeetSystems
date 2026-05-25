const express = require("express");
const { requireAuth } = require("../middleware/auth");
const { deletePlaybook, listPlaybooks, upsertPlaybook } = require("../services/playbooks");

const router = express.Router();
router.use(requireAuth);

router.get("/", async (req, res) => {
  res.json(await listPlaybooks(req.user.tenantId));
});

router.post("/", async (req, res) => {
  if (!req.body.title) return res.status(400).json({ error: "Title is required" });
  const playbook = await upsertPlaybook(req.user.tenantId, req.body);
  res.json(playbook);
});

router.put("/:key", async (req, res) => {
  const playbook = await upsertPlaybook(req.user.tenantId, { ...req.body, key: req.params.key });
  res.json(playbook);
});

router.delete("/:key", async (req, res) => {
  await deletePlaybook(req.user.tenantId, req.params.key);
  res.json({ ok: true });
});

module.exports = router;
