const express = require("express");
const { asyncRouter } = require("../utils/asyncRouter");
const { requireAuth, requireRole } = require("../middleware/auth");
const { deletePlaybook, listPlaybooks, removeLearnedFaq, upsertPlaybook } = require("../services/playbooks");
const { approveProposal, listProposals, rejectProposal, runFlowLearningBatch } = require("../services/flowLearning");
const { variantStatsForPlaybook, runVariantStatsBatch } = require("../services/variantStats");

const router = asyncRouter();
router.use(requireAuth);

router.get("/", async (req, res) => {
  res.json(await listPlaybooks(req.user.tenantId));
});

// After a save, immediately synthesize any new flow/brand text into the TTS cache so the
// very next call speaks from cache. Lazy require avoids a startup circular import.
function prewarmSavedPlaybook(tenantId, playbook) {
  try {
    const { prewarmPlaybookFlow } = require("./voicebot");
    prewarmPlaybookFlow(tenantId, playbook.key, playbook.voiceConfig);
  } catch (err) {
    // Prewarm is an optimization only — a failure must never fail the save.
  }
}

router.post("/", async (req, res) => {
  if (!req.body.title) return res.status(400).json({ error: "Title is required" });
  const playbook = await upsertPlaybook(req.user.tenantId, req.body);
  prewarmSavedPlaybook(req.user.tenantId, playbook);
  res.json(playbook);
});

router.put("/:key", async (req, res) => {
  const playbook = await upsertPlaybook(req.user.tenantId, { ...req.body, key: req.params.key });
  prewarmSavedPlaybook(req.user.tenantId, playbook);
  res.json(playbook);
});

router.delete("/:key", async (req, res) => {
  await deletePlaybook(req.user.tenantId, req.params.key);
  res.json({ ok: true });
});

// ---- Self-training review queue ----

router.get("/proposals/pending", async (req, res) => {
  res.json(await listProposals(req.user.tenantId, "pending"));
});

router.post("/proposals/:id/approve", requireRole("admin"), async (req, res) => {
  const applied = await approveProposal({ id: req.params.id, tenantId: req.user.tenantId, userId: req.user.userId });
  if (!applied) return res.status(404).json({ error: "Proposal not found or already decided" });
  try {
    const { prewarmPlaybookFlow } = require("./voicebot");
    prewarmPlaybookFlow(req.user.tenantId, applied.playbookKey, applied.voiceConfig);
  } catch {
    // prewarm is best-effort
  }
  res.json({ ok: true, playbookKey: applied.playbookKey });
});

router.post("/proposals/:id/reject", requireRole("admin"), async (req, res) => {
  const ok = await rejectProposal({ id: req.params.id, tenantId: req.user.tenantId, userId: req.user.userId });
  if (!ok) return res.status(404).json({ error: "Proposal not found or already decided" });
  res.json({ ok: true });
});

// Undo for an approved learning: removes the learned FAQ entry matching this phrase set.
router.post("/:key/learned/remove", requireRole("admin"), async (req, res) => {
  const removed = await removeLearnedFaq(req.user.tenantId, req.params.key, req.body?.phrases || []);
  if (!removed) return res.status(404).json({ error: "Learned entry not found" });
  res.json({ ok: true });
});

// Manual trigger for the nightly mining job (also runs automatically at 21:30 IST).
router.post("/proposals/mine", requireRole("admin"), async (req, res) => {
  const result = await runFlowLearningBatch({ sinceHours: Number(req.body?.sinceHours || 26) });
  res.json(result);
});

// ---- Self-optimizing scripts: gate-variant performance ----

router.get("/:key/variant-stats", async (req, res) => {
  res.json(await variantStatsForPlaybook(req.user.tenantId, req.params.key));
});

router.post("/variant-stats/recompute", requireRole("admin"), async (req, res) => {
  const result = await runVariantStatsBatch({ sinceDays: Number(req.body?.sinceDays || 14) });
  res.json(result);
});

module.exports = router;
