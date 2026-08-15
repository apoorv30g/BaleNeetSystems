# Production Readiness Review

**System:** LoanConnect Playbook AI — multi-tenant AI voice-calling platform for Indian lending
**Reviewed:** August 2026
**Scope:** backend-api, worker, dashboard-web, database, deployment, compliance posture

---

## Executive summary

The system is **further along than most projects at this stage**. Security headers, CORS allow-listing, rate limiting, correlation IDs, structured logging, graceful shutdown, bcrypt password hashing, advisory-locked cron jobs, and tenant scoping on user-facing queries are all already in place — these are usually the things missing at this point, and they aren't.

The gaps that remain cluster in three areas: **error handling under failure**, **operational readiness** (backups, CI, monitoring), and **the collections use case** being regulated work the platform doesn't yet enforce.

Findings are ordered by severity. Each states the concrete failure it causes, not just the principle.

---

## P0 — Fix before production

### 1. Async route errors hang the client instead of returning 500

**Verified empirically** against the installed Express 4.22.2: an `async` route handler that throws does **not** reach the error middleware. Express 4 does not catch rejected promises from handlers.

Roughly **76 async routes** exist across `src/routes/`, of which only about 21 have `try`/`catch`. Unguarded examples: `analytics.js` (1 route, 0 try-blocks), `auth.js` (2/0), `compliance.js` (10/0), `training.js` (6/0).

**Failure mode:** any transient Postgres error — connection-pool exhaustion, a failover, a slow query timing out — on an unguarded route means the request receives **no response at all**. The `process.on("unhandledRejection")` handler in `index.js` keeps the process alive and logs it, so the process doesn't crash, which is exactly what makes this hard to notice: the dashboard just spins forever, and the operator sees a hung UI rather than an error.

**Fix:** wrap route handlers in an async error forwarder. This is a small, mechanical change:

```js
// src/utils/asyncRoute.js
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports = { asyncRoute };
```

Then `router.get("/summary", asyncRoute(async (req, res) => { ... }))`. The existing error middleware in `index.js` already handles the rest correctly, including not leaking DB internals on 5xx.

Alternatively, upgrading to Express 5 makes this automatic — but that is a larger change with its own migration risk; the wrapper is the lower-risk path.

### 2. `bcrypt.compareSync` blocks the event loop during live calls

`routes/auth.js` uses `bcrypt.compareSync` on both login paths. bcrypt at default cost takes ~100ms and `compareSync` **blocks the entire Node event loop** for that duration.

This is ordinarily a minor concern. It is not minor here: the same process runs the **real-time voicebot WebSocket**. A login during an active call stalls audio streaming for every in-flight conversation — dropped frames, delayed playback marks, broken turn-taking. Several concurrent logins would be audible to customers.

**Fix:** use the async `bcrypt.compare` (`await bcrypt.compare(...)`). One-line change per call site.

### 3. No database backups

`docker-compose.prod.yml` provisions a Postgres volume; nothing backs it up. On Railway today you have platform-level backups, but **the planned migration to a self-hosted VPS removes that safety net**, and the migration is being driven by a compliance requirement — meaning the data becoming unrecoverable is precisely the data that matters most.

**Fix before cutover:** nightly `pg_dump` on a cron, retained off-box (encrypted, India-resident to stay consistent with the residency requirement), plus a **documented and actually-rehearsed restore**. An untested backup is not a backup.

### 4. No CI — tests are opt-in

There is no `.github/workflows`. The 192 tests only run when someone remembers to run them locally.

**Fix:** a workflow running `npm test` plus the dashboard build on every push. This also becomes the natural place to build and push Docker images, which the 2 GB VPS plan depends on (building on a 2 GB box will OOM on the Next.js build).

---

## P1 — Address soon after launch

### 5. Sarvam is now a single point of failure with no failover

Removing Deepgram and Gemini for data residency was correct and necessary, but it eliminated all cross-provider failover. A Sarvam outage now means LLM-fallback turns degrade to a canned reply and live STT has only reconnect-retry.

This is an accepted trade-off, not a defect — but it must be **monitored** rather than discovered mid-campaign. The `sarvamHealth.js` preflight already exists and the worker calls it before dialing; what's missing is alerting when it starts failing.

**Fix:** alert on preflight failure rate and on `llm_circuit_open` events. Consider pausing campaign dispatch automatically when Sarvam health fails repeatedly — better to delay calls than to burn attempts on conversations that will degrade.

### 6. No monitoring, alerting, or error tracking

Logging is structured and correlation IDs are threaded through — good foundations, but logs are only written, never watched. Nothing pages anyone when calls start failing.

**Fix:** ship logs somewhere queryable, add error tracking (Sentry or similar), and alert on a small number of things that actually matter:
- `/health` failing
- Sarvam preflight failure rate
- Call failure rate above baseline
- Queue depth growing (worker stalled)
- Compliance audit `fail` verdicts appearing

### 7. JWTs cannot be revoked

`middleware/auth.js` issues 8-hour JWTs with no refresh flow and no revocation list. A leaked token stays valid for up to 8 hours; deactivating a user does not end their session.

**Fix:** for a BFSI product, add a token version/`jti` claim checked against the user row, so password change or deactivation invalidates existing tokens immediately.

### 8. Login is vulnerable to user enumeration

In `auth.js`, `if (!user || !passwordMatches(user, password))` skips bcrypt entirely when the user doesn't exist, so a nonexistent email returns measurably faster than a wrong password. This lets an attacker enumerate registered accounts.

**Fix:** always run a bcrypt comparison against a dummy hash when the user is not found, so both paths cost the same.

### 9. Webhook and voicebot lead lookups are not tenant-scoped

User-facing routes are correctly tenant-scoped — I verified the campaign export queries and they're clean. But `webhooks.js:284`, `voicebot.js:573` and `voicebot.js:657` do `SELECT * FROM leads WHERE id=$1` with no `tenant_id` filter.

Practical risk is low (lead IDs are UUIDv4 and these endpoints sit behind shared secrets), so this is defense-in-depth rather than an active hole — but in a multi-tenant BFSI system, cross-tenant reads are the failure you least want, and adding the filter costs nothing.

### 10. Test coverage is unit-only

All 15 test files are pure-function tests. There are **no integration tests** (no DB, no HTTP, no WebSocket), and **no tests at all** for the worker or dashboard.

Untested-by-construction areas include: every route handler, tenant isolation, the migration script, queue behaviour, and the Exotel WebSocket protocol handling — which is the most intricate code in the system.

**Fix:** add integration tests against a throwaway Postgres (the existing `docker-compose.yml` already provides one locally). Highest value first: auth/tenant isolation, campaign lead upload, and a scripted voicebot conversation driven through the WebSocket message protocol.

---

## P2 — Hardening and quality

### 11. No request body validation

Routes read `req.body` fields directly. Malformed input surfaces as a Postgres error rather than a clean 400 — and, per finding #1, currently as a hung request. A schema validator (zod/joi) at the route boundary fixes both the error quality and part of the hang exposure.

### 12. Transcripts are stored in plaintext

`transcripts` holds full borrower conversations — financial circumstances, hardship disclosures, personal details. Stored unencrypted with no retention policy and no masking.

For an NBFC deployment this deserves an explicit decision: encryption at rest (at minimum full-disk on the VPS; ideally column-level for transcript text), a defined retention window, and PII masking in logs. Your own `SYSTEM_DOCUMENTATION.md` notes masking as a goal; it isn't implemented.

### 13. Collections guardrails are not built

The NBFC use case is **regulated collections work**, and RBI fair-practice expectations are largely unimplemented in product logic:

| Guardrail | Status |
|---|---|
| Calling window | ✅ `tenant_settings.call_window_start/end` |
| Per-lead attempt cap | ✅ `max_call_attempts` |
| DNC suppression | ✅ `dnc_list` |
| Post-call compliance audit | ✅ `complianceAudit.js` |
| **Frequency cap across campaigns** | ❌ per-lead-per-campaign only — a borrower in three campaigns can be called three times a day |
| **Third-party disclosure prevention** | ❌ nothing stops debt details being discussed with whoever answers |
| **Promise-to-pay capture** | ❌ not modelled |
| **Human escalation path** | ❌ explicitly descoped |

The frequency-cap gap is the sharpest: it is exactly the "persistent bothering" RBI guidance names, and the current per-campaign scoping makes it invisible in testing.

### 14. Single-instance assumptions

`maxConcurrentCalls` defaults to 1 and `docker-compose.prod.yml` runs one instance of everything. The nightly jobs already use Postgres advisory locks, so they are multi-instance-safe — but the WebSocket voicebot holds per-call state in memory, so horizontal scaling requires sticky routing. Fine at current volume; worth knowing before a scale-up surprises you.

### 15. Operational gaps

- **No migration rollback.** `migrate.js` is forward-only and idempotent; a bad migration has no documented recovery path beyond restore-from-backup (which doesn't exist yet — see #3).
- **No staging environment.** Changes go straight to production.
- **`SUPPORT_PHONE` is empty by default**, so escalation paths in call scripts may render blank.

---

## Suggested sequence

**Before production traffic:** #1 (async errors), #2 (bcrypt blocking), #3 (backups + rehearsed restore), #4 (CI).

**First month:** #5–#7 (Sarvam alerting, monitoring, token revocation), #10 (integration tests for auth/tenant isolation).

**Before NBFC collections go-live:** #13 (frequency cap and third-party disclosure especially), #12 (transcript encryption and retention), plus the residency migration.

---

## What's already solid

Worth stating explicitly, because it shapes how much of the above is real risk versus polish:

- Security headers, CORS allow-listing, per-route rate limiting, correlation IDs
- Structured logging that deliberately avoids leaking DB internals on 5xx
- Graceful shutdown draining both HTTP and the worker queue
- bcrypt hashing with the plaintext-password env fallback already removed
- Tenant scoping correct on all user-facing routes (verified)
- Advisory-locked nightly jobs — already multi-instance-safe
- Idempotent migrations
- A genuinely layered compliance design (scripted flow → grounding filter → LLM instruction → post-call audit)
- 192 passing tests over the conversation logic, which is the hardest part to reason about

---

*Findings #1 and #2 were verified by running code against the installed dependencies. The remainder are from source inspection. Regulatory points (#12, #13) are engineering observations, not legal advice — validate with the NBFC's compliance team.*
