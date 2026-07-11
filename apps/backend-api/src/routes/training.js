const express = require("express");
const multer = require("multer");
const {
  requireTrainingAuth,
  signTrainingToken,
  verifyTrainingPortalCredentials
} = require("../middleware/trainingAuth");
const {
  cleanupRawRecordings,
  listTrainingExamples,
  listTrainingRecordings,
  runTrainingBatch,
  storeTrainingRecording
} = require("../services/trainingData");

const router = express.Router();
const UPLOAD_MAX_BYTES = Number(process.env.TRAINING_UPLOAD_MAX_BYTES || 30 * 1024 * 1024);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES }
});

router.post("/auth/login", async (req, res) => {
  const user = await verifyTrainingPortalCredentials(req.body?.email, req.body?.password);
  if (!user) return res.status(401).json({ error: "Invalid training portal credentials" });

  res.json({
    token: signTrainingToken(user),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: "training_portal",
      tenantId: user.tenant_id
    }
  });
});

router.use(requireTrainingAuth);

router.get("/recordings", async (req, res) => {
  res.json(await listTrainingRecordings(req.user.tenantId));
});

router.get("/examples", async (req, res) => {
  res.json({ examples: await listTrainingExamples(req.user.tenantId, { limit: 100 }) });
});

router.post("/recordings", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Recording file is required" });
  const saved = await storeTrainingRecording({
    tenantId: req.user.tenantId,
    uploadedBy: req.user.userId,
    file: req.file,
    notes: req.body?.notes || ""
  });
  res.status(201).json(saved);
});

router.post("/run", async (req, res) => {
  const limit = Math.min(Number(req.body?.limit || process.env.TRAINING_MANUAL_BATCH_LIMIT || 10), 50);
  const result = await runTrainingBatch({ tenantId: req.user.tenantId, limit });
  res.json(result);
});

router.post("/cleanup", async (req, res) => {
  const result = await cleanupRawRecordings({ tenantId: req.user.tenantId });
  res.json(result);
});

router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? `Recording must be under ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} MB` : err.message });
  }
  next(err);
});

module.exports = router;
