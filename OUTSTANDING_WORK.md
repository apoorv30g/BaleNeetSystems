# Outstanding Work / Deployment Notes

Handoff note covering what must happen before this goes live, what was built but is not yet
active, and what was deliberately left undone.

**Status of the code:** all changes are in the working tree. Test suite is **277 passing,
1 skipped**; the dashboard builds clean.

---

## 1. BLOCKING — run before (or with) the next deploy

### 1.1 Database migration

New columns and tables were added. **Deploying the code without migrating will break
authentication** — every authenticated request returns 503 because `requireAuth` reads
`users.token_version`.

```bash
npm run migrate
```

(In Railway: run it from the backend-api service Console, as before.)

What it adds — all additive and idempotent, no data is modified or dropped:

| Object | Purpose |
|---|---|
| `users.token_version` | JWT revocation generation |
| `users.is_active` | Account deactivation |
| `tenant_settings.max_contacts_per_day` | Cross-campaign frequency cap (default 1) |
| `tenant_settings.max_contacts_per_week` | Cross-campaign frequency cap (default 3) |
| `promise_to_pay` (table + 2 indexes) | Collections PTP capture |

> ⚠️ **The frequency-cap defaults are live the moment you migrate.** Existing tenants get
> `1/day` and `3/week` per borrower across all campaigns. If any current campaign legitimately
> calls people more often than that, calls will start being skipped (marked
> `status='frequency_capped'`). Set both to `0` for a tenant to disable capping.

### 1.2 Environment variables

| Variable | Needed? | Effect if unset |
|---|---|---|
| `METRICS_TOKEN` | **Yes, in production** | `/metrics` returns 503 — it fails closed rather than publishing internals |
| `ALERT_WEBHOOK_URL` | Strongly recommended | Alerts are logged but nobody is notified. Everything in §"Monitoring" below is inert without it |
| `TRANSCRIPT_RETENTION_DAYS` | Optional (default 180) | Transcripts deleted after 180 days |
| `EVENT_RETENTION_DAYS` | Optional (default 90) | STT/voicebot events deleted after 90 days |
| `MAX_CONTACTS_PER_DAY` / `_WEEK` | Optional (default 1 / 3) | Fallback when a tenant row has no value |

Set `ALERT_WEBHOOK_URL` to a Slack/Teams/Google Chat incoming webhook. It accepts `{"text": …}`.

---

## 2. INTEGRATION STATUS — all now wired ✅

This section previously listed code that existed but was never called. All three items are now
active; kept here as a record of what was wired and the design decisions behind it.

### 2.1 Third-party disclosure prevention — ✅ NOW ACTIVE
Wired into `routes/voicebot.js`:
- **Detection** — each user turn runs `isThirdPartyAnswerer(text)`. On a match (and while
  identity is unconfirmed) the call closes with a line that mentions no loan, amount, or reason
  for calling, and is recorded as `WRONG_NUMBER`. Placed *after* `isNamedCalleeDenial` so the
  softer "is <name> available?" clarification still gets first go at the name gate.
- **Reply guard** — `refineAssistantReply` suppresses any reply that would reveal a lending
  relationship, substituting an identity-confirmation request.

Two design notes:
- The guard is scoped to sessions where a third party has actually been **signalled**, not to
  every pre-confirmation turn. Identity is unconfirmed at the start of every call, so the
  broader rule would break the standard opening — which exists precisely to establish identity
  before any detail.
- The blocked-terms list covers lending *relationship* language ("bank verification pending",
  "your offer", "disbursal"), not just amounts. Confirming the person has applied for credit is
  itself a disclosure. This also catches the grounded/scripted path, not only invented LLM text.

Covered by `test/thirdPartyDisclosure.test.js` (6 tests) plus the 17 in `collections.test.js`.

### 2.2 Promise-to-pay capture — ✅ NOW ACTIVE
- **Capture** — `routes/voicebot.js` extracts a commitment from each user turn and writes it to
  `promise_to_pay`. Recorded **only after identity is confirmed**: a commitment attributed to an
  unidentified answerer is not actionable. Captured once per call.
- **Runs on every playbook**, not only `COLLECTION` campaigns — the extractor already demands an
  explicit payment intent plus a concrete amount or date, so it stays quiet elsewhere, and
  gating on `campaign_type` would miss commitments whenever that field is unset on imported leads.
- **API** — `GET /compliance/promises?days=30`.
- **Dashboard** — "Promises to pay" table on the Compliance page (customer, amount, date, captured).

### 2.3 Duplicate frequency-cap implementation — ✅ RESOLVED (both now used, and cross-referenced)
Kept both, with clearly separated roles rather than one silently unused:
- **Enforcement** — `apps/worker/src/index.js` (`contactFrequencyBlock`), run immediately before
  dialling. Authoritative, because counts change between queueing and dispatch.
- **Preview** — `apps/backend-api/src/services/contactFrequency.js`, now called by
  `POST /campaigns/:id/queue-calls`, which returns `frequencyCapped`. The dashboard shows
  "N will be skipped by the contact-frequency cap" when queueing.

The worker genuinely cannot import the backend module (separate npm workspace, separate db
client — the same reason `config.js` is duplicated). Both files now carry a ⚠️ header pointing
at the other, so a change to the window, the connected-status list, or the phone matching is
obviously a two-file change.

---

## 3. NOT VERIFIED — written but never executed here

This machine has no Docker and no local Postgres, so the following are unproven. Everything
else in the session was verified by running it.

| Item | How to verify |
|---|---|
| **Tenant-isolation integration tests** (10 tests) | Runs automatically on first CI push. CI fails the build if they skip |
| **Docker images** (3 Dockerfiles) | Built by the `docker-build` CI job |
| **Backup script** `ops/backup.sh` | Run it once on the server; confirm a dump appears and passes verification |
| **Restore script** `ops/restore.sh` | Run in rehearsal mode (default) — it restores to a scratch DB and prints row counts |

Locally, if you have Docker:

```bash
docker compose up -d postgres && DATABASE_URL=postgresql://postgres:password@localhost:5432/loanconnect npm run migrate --workspace backend-api && TEST_DATABASE_URL=postgresql://postgres:password@localhost:5432/loanconnect npm test
```

---

## 4. OPS TASKS — on the server

1. **Install the backup cron** (`ops/BACKUP_RUNBOOK.md` §1). Currently there are **no backups**
   once you leave Railway.
2. **Rehearse a restore** and record the date. An unrehearsed backup has an unknown success rate.
3. Set `BACKUP_GPG_RECIPIENT` if copying dumps off-box — otherwise borrower data travels
   unencrypted.
4. **Reverse proxy must allow WebSocket upgrades with a long idle timeout.** nginx defaults to
   60s, which would cut calls off mid-conversation.
5. Point monitoring at `GET /metrics` (bearer `METRICS_TOKEN`) and `GET /health`.

---

## 5. KNOWN GAPS — accepted, not oversights

- **No Sarvam failover.** Deepgram and Gemini were removed for data residency, so a Sarvam
  outage degrades LLM-fallback turns to canned replies. Alerting now exists; redundancy does not.
- **~90ms event-loop stall per login.** `bcryptjs` is pure JS and its async API does not free
  the loop (measured). Fixing it needs the native `bcrypt` package (adds a native build step) or
  a move to `node:crypto` scrypt (changes hash format, requires migrating existing hashes).
- **RPO up to 24h.** Daily dumps. PITR/WAL archiving would reduce it, at meaningfully more setup.
- **Redis is not backed up** — intentional; the queue is re-derivable, but in-flight jobs are
  lost on restore and campaigns must be re-queued.
- **No transcript encryption at rest.** Column-level encryption would break the self-training
  miner, the compliance auditor, and export. Full-disk encryption on the DB host is the right
  control — see the note in `services/dataRetention.js`.
- **No staging environment.** Changes go straight to production.
- **No migration rollback.** `migrate.js` is forward-only; recovery is restore-from-backup.
- **Single-instance assumptions.** Nightly jobs are advisory-locked and safe, but the voicebot
  holds per-call state in memory, so horizontal scaling needs sticky routing.

---

## 6. DELIBERATELY NOT DONE

- **Live transfer to a human agent** — descoped by you earlier. Worth revisiting for
  collections, since RBI guidance effectively expects an escalation path for disputes and
  hardship, and it would also need confirming Exotel supports mid-stream participant transfer.
- **Go2Market / 1600-series integration** — blocked on their answer to Question 1 in
  `Go2Market_Integration_Requirements.docx` (can they stream live audio to an external app?).
  That single answer determines whether it is a moderate adapter or a much larger SIP build.
- **India hosting migration** — recommended (DigitalOcean BLR1 / Vultr Mumbai / E2E Networks,
  ~₹800–1,000/mo). Docker/compose files are ready. Fixes both the residency requirement and a
  ~200ms-per-turn latency penalty from the current `sfo` region.
- **Cross-border AI check** — confirm with compliance that removing Deepgram/Gemini was
  sufficient, and that no other outbound data flow remains.

---

## 7. SUGGESTED ORDER

Everything implementable in code is done. What remains is yours to run — migration, secrets,
and server-side ops.

1. **Migrate** (§1.1) — blocking; auth breaks without it
2. **Set `METRICS_TOKEN` and `ALERT_WEBHOOK_URL`** (§1.2) — `/metrics` fails closed without the
   first; alerting is inert without the second
3. **Decide frequency-cap values per tenant** before campaigns resume (§1.1 warning)
4. **Push** — CI then verifies the integration tests and Docker builds, neither of which could
   be executed here (§3)
5. **Install backups and rehearse a restore** (§4)
6. **India hosting migration** (§6)

All code changes are uncommitted in the working tree. Test suite: **283 passing, 1 skipped**
(the skip is the integration suite, which activates when `TEST_DATABASE_URL` is set).
