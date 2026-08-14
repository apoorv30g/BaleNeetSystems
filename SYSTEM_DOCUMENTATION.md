# LoanConnect Playbook AI — System Documentation

> **Who this is for:** a new engineer/intern joining the project. Read top-to-bottom once to
> understand *what* the system does and *why*, then use the file map and glossary as reference.
> No prior context assumed.

---

## 1. What this system does (in plain English)

It is an **AI voice-calling platform for Indian lending companies**. A lender uploads a list of
borrowers (leads) and picks a "playbook" (a call script). The system automatically **phones each
borrower and has a real, spoken, two-way conversation in Hindi/English** — introducing itself,
answering the customer's questions, and guiding them to complete a pending step (e.g. finish a
loan application, verify PAN, make a payment). It records the outcome of every call.

The bot is not a dumb recording. It:
- **listens** to what the customer says (speech-to-text),
- **decides** what to say next (a scripted flow engine, backed by an LLM for off-script questions),
- **speaks** back in a natural voice (text-to-speech),
- handles interruptions, repeated questions, confusion, and objections like a human agent,
- **learns** from its own calls to get better over time,
- and **audits itself** for regulatory compliance.

It is **multi-client**: one deployment serves many different lending companies, each with its own
brand name, voice, script, data, and users — fully isolated from each other.

---

## 2. High-level architecture

The project is a **monorepo** (`npm workspaces`) with **three applications** under `apps/`:

```
                          ┌──────────────────────┐
                          │   dashboard-web       │  Next.js web UI
                          │   (what humans use)   │  campaigns, playbooks,
                          └──────────┬───────────┘  compliance, analytics
                                     │ HTTPS (REST)
                                     ▼
   ┌───────────────┐        ┌──────────────────────┐        ┌──────────────┐
   │    worker     │◀──────▶│     backend-api       │◀──────▶│  PostgreSQL  │
   │ places calls  │ Redis  │  REST API + the       │        │  (all data)  │
   │ from a queue  │ queue  │  live voicebot engine │        └──────────────┘
   └──────┬────────┘        └──────────┬───────────┘
          │                            │
          │ places call via            │ live audio stream (WebSocket)
          ▼                            ▼
   ┌─────────────────────────────────────────────┐
   │  Exotel (telephony)  ◀── the phone network ──┤
   └─────────────────────────────────────────────┘
                                     │
              ┌──────────────────────┼──────────────────────┐
              ▼                      ▼                       ▼
          Sarvam STT             Sarvam LLM             Sarvam TTS
        (speech → text)        (decide the reply)       (text → voice)
```

**The three apps:**

| App | Tech | Job |
|-----|------|-----|
| `apps/backend-api` | Node.js + Express | The brain. REST API for the dashboard, the queue that drives calling, **and the real-time voicebot** that talks to customers over a WebSocket. |
| `apps/worker` | Node.js | Pulls call jobs off the Redis queue and tells Exotel to actually dial each number, respecting concurrency/pacing limits. |
| `apps/dashboard-web` | Next.js (React) | The web app lenders' staff log into — create campaigns, upload leads, edit playbooks, review compliance, approve AI-learned replies. |

**External services (all pluggable, configured by env vars):**

| Service | Role |
|---------|------|
| **PostgreSQL** | The single source of truth for all data (tenants, leads, calls, transcripts, playbooks…). |
| **Redis + BullMQ** | A job queue. When a campaign is launched, one job per lead is enqueued; the worker consumes them. |
| **Exotel** | Indian cloud telephony. Places the actual phone call and streams the live call audio to our backend. |
| **Sarvam STT** | Speech-to-Text — turns the customer's spoken words into text, in real time. |
| **Sarvam LLM** | The "brain" that generates a reply when the scripted flow can't answer. |
| **Sarvam TTS** | Text-to-Speech — turns the bot's reply text into a natural spoken voice. |

> **Sarvam is the only permitted AI provider.** Gemini (LLM) and Deepgram (STT) were removed
> for **India data-residency compliance** — borrower call audio and transcripts must not leave
> Indian jurisdiction. Sarvam is an Indian company. Do not reintroduce a non-Indian AI provider
> without a compliance review; the removal is enforced in `config.js`, `providers/llm.js` and
> `providers/sttLive.js`. Note this also means **there is no cross-provider failover** — if
> Sarvam is down, LLM-fallback replies fail and the call falls back to scripted-flow text only.

---

## 3. The core concept: Tenants, Playbooks, Campaigns, Leads

These four words appear everywhere. Learn them first.

- **Tenant** = one client company (e.g. "ASAP Finance"). Every row of data belongs to exactly one
  tenant. Client A can never see Client B's data. This is what makes the platform "multi-client".
- **User** = a person who logs into the dashboard. Belongs to one tenant, has a role (`admin`,
  `platform_admin`, etc.).
- **Playbook** = a reusable **call script + brand identity** for one workflow (e.g. "PAN
  Verification Retry"). Defines what the bot says, in what order, and how it handles questions.
  This is where a client's whole personality lives (see §6).
- **Campaign** = a specific calling run. Ties a playbook to a batch of leads with settings like
  daily call limit and max retry attempts.
- **Lead** = one borrower to be called (name, phone, which playbook applies, loan amount, etc.).
- **Call** = one attempt to phone one lead. Has a status, an outcome, a duration, and a transcript.

**Relationship:** `Tenant → has many → Playbooks & Campaigns → Campaign uses one Playbook + has many
Leads → each Lead generates Calls → each Call has a Transcript and an Outcome.`

---

## 4. The life of a call (end-to-end walkthrough)

This is the most important section. Follow one call from start to finish.

**Step 1 — Setup (dashboard).** A lender's admin creates a campaign, picks a playbook, uploads a
CSV of leads (`apps/dashboard-web/app/upload`), and clicks "Queue Calls".

**Step 2 — Enqueue (backend-api).** `POST /campaigns/:id/queue-calls`
([routes/campaigns.js](apps/backend-api/src/routes/campaigns.js)) checks each lead against the DNC
(Do-Not-Call) list and the calling window, then pushes one job per eligible lead onto the Redis
queue (`queue.js`).

**Step 3 — Dial (worker).** The worker ([apps/worker/src/index.js](apps/worker/src/index.js))
pulls jobs one at a time, respecting the concurrent-channel limit, and calls Exotel's API
([worker/src/exotel.js](apps/worker/src/exotel.js)) to place the outbound call. It creates a `calls`
row and holds the "channel slot" until the call reaches a terminal status.

**Step 4 — Answer (Exotel → backend webhook).** When the customer picks up, Exotel connects to our
backend and opens a **WebSocket** to stream the live call audio.
`attachVoicebot()` in [routes/voicebot.js](apps/backend-api/src/routes/voicebot.js) handles this
connection. This file (~5000 lines) is the real-time conversation engine.

**Step 5 — The conversation loop.** For each turn:
1. Customer speaks → audio chunks arrive over the WebSocket.
2. **VAD** (Voice Activity Detection, `services/vad.js`) + **live STT** (`providers/sttLive.js`
   → Sarvam) convert speech to text, waiting for the customer to finish (turn-taking).
3. `buildScriptedReply()` decides the reply:
   - First it tries the **scripted flow engine** (`runScriptedFlow`, see §6) — fast, exact,
     compliant.
   - If the flow has no answer for a genuine question, it hands **one turn** to the **LLM**
     (`providers/llm.js` → Sarvam), whose reply is passed through a **grounding filter** that
     strips anything unsafe (invented amounts/rates, guarantees, **OTP requests** — see §8).
4. The reply text → **TTS** (`providers/sarvam.js`) → audio → streamed back to the customer.
   Common lines are pre-synthesized and cached, so most turns have near-zero delay.
5. Everything is logged: the transcript (`transcripts` table) and structured events
   (`voicebot_events` table).

**Step 6 — Barge-in & interruptions.** If the customer starts talking while the bot is speaking,
VAD detects it and the bot stops (barge-in), just like a human would.

**Step 7 — Close.** When the conversation reaches a terminal point (customer not interested, asked
for a callback, finished the instructions, opted out, etc.), the bot speaks a closing line and
**hangs up**, recording the final outcome (`INTERESTED`, `CALLBACK`, `NOT_INTERESTED`,
`JOURNEY_COMPLETED`, `DISPUTE`, `OPTED_OUT`, …) on the `calls` row.

**Step 8 — After the call.** Nightly background jobs (§10–12) mine the transcript to improve the
bot, audit the call for compliance, and update script-variant statistics.

---

## 5. Multi-client isolation (how one system serves many lenders)

- **Data isolation:** every important table has a `tenant_id` column. Every query is scoped to the
  logged-in user's tenant. A user physically cannot read another tenant's leads, calls, or playbooks.
- **Onboarding a new client** = a platform-admin calls `POST /admin/clients`
  ([routes/admin.js](apps/backend-api/src/routes/admin.js)) which creates a `tenants` row + its
  users. Then that client's admin creates playbooks and campaigns. **No code changes, no redeploy.**
- **Brand isolation:** each playbook can carry its own brand (company name, assistant name,
  website) via `voice_config` (see §6/§7). So on one backend, Client A's calls say "ASAP Finance,
  Sneha" and Client B's say "SwarnaCredit, Meera" — from data alone.

---

## 6. The Playbook & Flow Engine (the heart of the product)

Originally each call script was hand-coded in JavaScript. That doesn't scale to many clients. So
the conversation is now **data**, stored per playbook in a JSON column called `voice_config`, and
interpreted by one generic engine: **`runScriptedFlow()`** in
[routes/voicebot.js](apps/backend-api/src/routes/voicebot.js).

**A `voice_config` looks like this:**

```json
{
  "brand":  { "name": "ASAP Finance", "assistant": "Sneha", "website": "https://www.asapfinance.in" },
  "flow": {
    "opening":      { "confirmName": true, "text": { "hi": "...{{brand}}...{{name}}...", "en": "..." } },
    "gates":        [ { "id": "availability", "question": {...}, "onNo": { "outcome": "busy" } }, ... ],
    "instructions": { "outcome": "continuing", "text": {...}, "condensed": {...} },
    "faqs":         [ { "intent": "amount", "answer": {...} }, ... ],
    "terminals":    [ ... ]
  }
}
```

**Vocabulary of a flow:**
- **opening** — first thing spoken; optionally confirms "Am I speaking with <name>?".
- **gate** — a yes/no checkpoint (e.g. "Is now a good time?"). On "yes" it advances to the next
  gate; on "no" it closes with a mapped outcome.
- **instructions** — the final action block (e.g. "go to the website and complete PAN verification").
- **faq** — an answer to an interrupt question that can come at *any* point ("what's the loan
  amount?", "is this a scam?"). Answered without losing the place in the flow.
- **terminal** — an intent that ends the call politely (not interested, callback, dispute, already
  done).
- **`{{brand}}`, `{{assistant}}`, `{{website}}`, `{{name}}`** — placeholders filled per-lead at
  runtime, so the same flow text works for any client.

**What the engine gives every flow for free** (this is why we did it): differently-phrased retries
on misheard input, a graceful "give up after 3 strikes" instead of infinite loops, "sure, let me
repeat" handling, treating "hmm/achha/haan" as agreement, answering a question then returning to the
gate, auto-hangup with the right analytics outcome, and one grounded LLM turn for anything off-script.

**The built-in PAN Verification flow** (`DEFAULT_PAN_FLOW` in voicebot.js) is the reference example
and the seed config. A new client's flow is authored as JSON in the dashboard Playbooks page — **no
code**.

**Intents are referenced by name, never raw regex.** Flow authors pick from a fixed registry
(`FLOW_INTENTS`) so user-supplied config can never inject a broken/dangerous regex.

---

## 7. Brand resolution (who the bot says it is)

When the bot needs the brand name, assistant name, or website, it resolves in this priority order
(`productNameForLead` / `agentNameForLead` / `leadJourneyUrl` in voicebot.js):

1. **The lead's playbook `voice_config.brand`** (per-client, the normal case).
2. The lead's import metadata (`source_metadata.productName`).
3. An environment variable override (`VOICEBOT_PRODUCT_NAME`).
4. The deployment default (`BRAND_NAME` / `ASSISTANT_NAME` / `LOAN_APP_URL` in `config.js`).

This is why setting a playbook's brand instantly re-brands every spoken line — greetings, identity
answers, disclaimers, closings — with zero code changes.

---

## 8. Compliance & safety (critical for lending — read this)

Lending calls are regulated (RBI Fair Practices, TRAI). The system enforces rules with
**defense in depth** — multiple independent layers so no single failure causes a violation.

**The hardest rule: the bot must NEVER ask the customer for an OTP/PIN/password/card.**
Enforced at four layers:

1. **Scripted flow (prevention by construction):** every scripted line says the *opposite* — "we
   will never ask for OTP." There is no scripted path that requests credentials.
2. **LLM output filter (the guardrail):** every LLM-generated reply passes through
   `groundGeneratedAssistantReply` → `assistantGroundingIssues`. If `requestsSensitiveData()`
   detects an OTP/PIN/password request (imperative *and* question forms, Hindi + English,
   negation-aware so disclaimers aren't misflagged), the reply is **discarded** and replaced with a
   safe fallback. Also strips invented amounts, invented interest rates, guaranteed-approval
   promises, and unsupported website URLs.
3. **LLM prompt (instruction):** the prompt built in
   [services/playbooks.js](apps/backend-api/src/services/playbooks.js) `buildPrompt()` explicitly
   forbids asking for OTP, quoting rates, or promising approval.
4. **Post-call audit (detection & proof):** the **compliance autopilot** (§below) re-checks every
   call afterward and flags any violation with evidence.

**Compliance autopilot** ([services/complianceAudit.js](apps/backend-api/src/services/complianceAudit.js)):
a nightly job audits **every** call (not a sample) against 6 deterministic rules — disclosure
spoken, no OTP request, no guarantee, no threats/harassment, opt-out honored, calling-window
respected — producing a 0–100 score and a pass/warn/fail verdict per call, with evidence snippets
for any failure. Surfaced on the Compliance dashboard page. This is a major sales differentiator:
*"every call audited, not sampled."*

**Other guardrails:** DNC (Do-Not-Call) list checked before every call; calling-window enforcement;
opt-out ("do not call me") immediately writes the number to the DNC list and ends the call.

---

## 9. Self-training loop (the bot learns from its own calls)

Goal you asked for: *"train itself from the conversations it is doing."* Implemented in
[services/flowLearning.js](apps/backend-api/src/services/flowLearning.js).

The loop, per client, per playbook:

1. **Capture (during calls):** two signals are logged — turns where the bot said "sorry, didn't
   catch that", and (`flow_llm_fallback` events) turns the scripted flow had to hand to the LLM.
   The second is the richest: real questions the script *couldn't* answer.
2. **Mine (nightly, 21:30 IST):** collect those missed utterances, grouped and counted
   (e.g. *"cibil par asar" — asked 5 times*).
3. **Propose (Sarvam LLM):** cluster them into at most 5 suggested new FAQ entries, each with match
   phrases + a compliant Hindi/English answer draft (the prompt forbids promising approval, quoting
   rates, or asking for OTP; unknowns defer to `{{website}}`).
4. **Review (human gate — mandatory):** proposals land in a review queue on the Playbooks page.
   **Nothing generated is ever spoken to a customer without a human clicking Approve.**
5. **Apply:** approval merges the entry into the playbook's `voice_config.flow.faqs` (transactionally)
   and pre-warms its audio. From the next call, the engine matches those phrases by **plain
   substring** (never regex) and gives the approved answer instantly — no LLM latency.
6. **Undo:** approved "learned" replies are listed on the playbook card with a one-click Remove.

**Compounding effect:** the scripted layer keeps absorbing the LLM's work → over weeks, more turns
are answered instantly and compliantly, and fewer need live generation (lower latency, lower cost).

---

## 10. Cross-client learning network (data network effect)

Extends §9 across clients, **opt-in and anonymized**
([services/flowLearning.js](apps/backend-api/src/services/flowLearning.js) `runNetworkSeeding`).

- A tenant opts in via a toggle (`tenant_settings.share_learnings`, set on the Compliance page).
- When an opted-in tenant approves a learned FAQ, only the **topic + phrase strings** (no answers,
  no brand text, no digits — so no phone numbers or amounts leak) enter a shared pool
  (`shared_phrase_pool`, which has **no tenant_id**).
- A nightly job seeds each opted-in tenant with fresh **proposals** for topics the network already
  knows but their playbook can't answer yet — so a brand-new client's bot understands the hundred
  ways borrowers phrase common questions *from day one*. Answers are always freshly drafted
  (brand-neutral) and still require human approval.

**Why it's a moat:** every client you sign makes the product better for the next one, using a
corpus no competitor can copy.

---

## 11. Self-optimizing scripts (A/B testing that runs itself)

A gate can define multiple phrasings (`questionVariants`).
- The engine **picks one per call**, weighted by past success (`services/variantStats.js`
  `pickVariantIndex`), and logs which variant it spoke (`flow_variant_spoken` event).
- A nightly job joins those events to call outcomes and recomputes each variant's **success weight**
  (Bayesian-smoothed so new variants get airtime; floored so a losing variant can still recover).
- Over time the bot leans toward the phrasing that converts best — *"campaigns that improve every
  week without anyone touching them."*
- Backward-compatible: gates with a single phrasing behave exactly as before (deterministic).

---

## 12. Background jobs (the nightly scheduler)

All scheduled work lives in
[services/trainingScheduler.js](apps/backend-api/src/services/trainingScheduler.js). It uses a
Postgres **advisory lock** so that even if multiple backend instances run, each job runs once.

| Time (IST) | Job | What it does |
|-----------|-----|--------------|
| 21:00 | compliance audit | Audit every recent unaudited call (§8). |
| 21:30 | flow learning | Mine missed turns → FAQ proposals (§9). |
| 22:00 | voice training | Existing recording-based training data prep. |
| 22:30 | variant stats | Recompute gate-variant success weights (§11). |
| 23:00 | network seeding | Seed opted-in tenants from the shared pool (§10). |
| 23:55 | cleanup | Delete raw recordings past retention. |

Each job also has a manual **admin trigger** endpoint for testing (e.g.
`POST /compliance/audit/run`, `POST /playbooks/proposals/mine`).

---

## 13. Database tables (what each one stores)

| Table | Purpose |
|-------|---------|
| `tenants` | One row per client company. |
| `users` | Dashboard login accounts, scoped to a tenant, with a role. |
| `tenant_settings` | Per-tenant config: calling window, max attempts, AI disclosure, `share_learnings` opt-in. |
| `playbooks` | Call scripts + `voice_config` (brand + flow JSON). The client's personality. |
| `campaigns` | A calling run: a playbook + settings (daily limit, retries). |
| `leads` | Borrowers to call (name, phone, playbook, amounts, `source_metadata`). |
| `calls` | One dial attempt: status, outcome, duration, cost breakdown, call_sid. |
| `transcripts` | Turn-by-turn text of each call (speaker + text). |
| `voicebot_events` | Structured events per call (variant spoken, LLM fallback, grounding, timeouts…). Powers analytics + learning. |
| `dnc_list` | Do-Not-Call numbers per tenant. Checked before every call. |
| `compliance_logs` | Rule-check events from live calls. |
| `call_compliance_audits` | Post-call audit score/verdict/flags per call (§8). |
| `flow_improvement_proposals` | AI-suggested FAQ entries awaiting human review (§9/§10). |
| `shared_phrase_pool` | Anonymized cross-client phrase→topic pool (§10). No tenant_id. |
| `flow_variant_stats` | Per-gate-variant success weights (§11). |
| `voice_audio_cache` / `call_audio_cache` | Cached TTS audio so common lines don't re-synthesize. |
| `voice_response_templates`, `voice_training_examples`, `voice_training_recordings` | Older training-data machinery (recording-based). |
| `notification_events` | SMS/WhatsApp link-send events. |
| `audit_logs` | Admin actions (settings changes, user changes) for accountability. |
| `schema_migrations` | Tracks which migrations have run. |

---

## 14. File & directory map (what is what, and why)

### `apps/backend-api/src/` — the brain

**`routes/`** (HTTP + WebSocket endpoints)
- `voicebot.js` — **the big one (~5000 lines).** The live real-time voice engine: WebSocket
  handling, turn-taking, barge-in, the scripted flow engine (`runScriptedFlow`), variant selection,
  the LLM grounding filter, TTS prewarming. Start here to understand a live call.
- `webhooks.js` — Exotel call-status callbacks + the EXOML (simpler XML-based) call flow. Enforces
  the webhook secret.
- `campaigns.js` — create campaigns, upload leads, queue calls, CSV export (with formula-injection
  guard).
- `playbooks.js` — CRUD for playbooks; the self-training review-queue endpoints; variant stats.
- `compliance.js` — settings, DNC list, compliance audit summary/flagged calls, share-learnings toggle.
- `admin.js` — platform-admin: create client tenants, manage users, costs, overview.
- `auth.js` — login (JWT).
- `analytics.js` — dashboards data.
- `training.js` — recording-based training upload/review.

**`services/`** (business logic, no HTTP)
- `playbooks.js` — playbook storage, `voice_config` normalization, `buildPrompt()` (the LLM prompt),
  brand attachment, learned-FAQ removal.
- `flowLearning.js` — the self-training loop + cross-client network (§9, §10).
- `complianceAudit.js` — the compliance autopilot (§8).
- `variantStats.js` — self-optimizing script weights (§11).
- `trainingScheduler.js` — the nightly cron with advisory locks (§12).
- `outcomes.js` — classifies what a call's outcome was (interested, callback, opt-out…).
- `tezJourney.js` — the legacy TezCredit multi-stage journey logic (the original client).
- `leadImport.js` — parses uploaded CSV/XLSX into leads.
- `settings.js` — tenant settings read/normalize.
- `vad.js` — voice activity detection (when is the customer speaking/done).
- `audioCache.js` — TTS audio cache keys and storage.
- `speechText.js` — text normalization for natural TTS (numbers → words, etc.).
- `compliance.js`, `testDataCleanup.js`, `trainingData.js` — supporting logic.

**`providers/`** (adapters to external AI/telephony services — swappable)
- `llm.js` — LLM entry point with a circuit breaker. **Sarvam only** (see the data-residency
  note in §2); the breaker now limits hammering a failing Sarvam rather than diverting traffic.
- `sarvamChat.js` / `sarvam.js` / `sarvamLive.js` / `sarvamHealth.js` — Sarvam chat (LLM), TTS,
  live STT, health checks.
- `sttLive.js` — live-STT abstraction (Sarvam only; retains primary reconnect-on-close).
- `audio.js` — PCM/codec conversion for Exotel's audio format.
- `notifications.js` — SMS/WhatsApp link sending.

**`db/`**
- `migrate.js` — creates/updates all tables (idempotent; run on deploy).
- `seed.js` — creates the first admin user (refuses default password in production).
- `pool.js` — the Postgres connection pool (with retry + error handling).

**`config.js`** — reads all environment variables into one config object.
**`index.js`** — boots the Express server, wires routes, starts the voicebot WebSocket + scheduler,
handles graceful shutdown and process-level crash guards.

### `apps/worker/src/` — the dialer
- `index.js` — consumes the Redis queue, places calls respecting concurrency/pacing, updates `calls`.
- `exotel.js` — Exotel outbound-call API adapter.
- `db.js`, `config.js`, `health.js` — pool, config, health endpoint.

### `apps/dashboard-web/app/` — the web UI (Next.js pages)
- `campaigns/`, `playbooks/`, `compliance/`, `analytics/`, `admin/`, `upload/`, `login/` — one
  folder per screen. `playbooks/page.jsx` includes the self-training review queue and learned-reply
  management; `compliance/page.jsx` includes the compliance-autopilot panel and network opt-in.

### Repo root
- `docker-compose.yml` — local Postgres + Redis.
- `DEPLOYMENT_GUIDE.md` — Railway deployment steps.
- `.env.example` — every environment variable, documented.

---

## 15. Configuration (environment variables you must know)

Set in Railway (or `.env` locally). The important ones:

| Variable | Why |
|----------|-----|
| `DATABASE_URL`, `REDIS_URL` | Postgres + Redis connections. Required. |
| `JWT_SECRET` | Signs dashboard login tokens. Required in production. |
| `EXOTEL_WEBHOOK_SECRET` | **Required in production.** Webhooks reject all traffic if unset — stops strangers forging call events. Must also be appended (`?secret=…`) to Exotel's callback URLs. |
| `VOICEBOT_TOKEN` | Protects the voicebot WebSocket endpoint. |
| `BRAND_NAME`, `ASSISTANT_NAME`, `LOAN_APP_URL` | Deployment-default brand (overridden per-playbook by `voice_config`). |
| `EXOTEL_*` | Telephony credentials + caller number + channel count. |
| `SARVAM_API_KEY` | The only AI provider key. `SARVAM_CHAT_MODEL` / `SARVAM_STT_MODEL` / `SARVAM_TTS_MODEL` pin the model versions. |
| `CALL_WINDOW_START/END`, `MAX_CALL_ATTEMPTS`, `MAX_CONCURRENT_CALLS` | Calling policy defaults. |

---

## 16. Deployment (how it goes live)

Hosted on **Railway** (see `DEPLOYMENT_GUIDE.md`). Three services (backend-api, worker,
dashboard-web) each deploy from this repo with a set root directory. On a new deploy:

1. Push code → Railway rebuilds the changed services.
2. Ensure `EXOTEL_WEBHOOK_SECRET` (and other env vars) are set on backend-api.
3. Run `npm run migrate` once (idempotent — adds any new tables/columns).
4. Restart. The scheduler and voicebot start automatically.

Tests: `npm test` (from repo root or `apps/backend-api`) runs the Node test suite (~188 tests
covering the flow engine, PAN flow, learning loop, compliance audit, variant stats, and grounding).

---

## 17. How to make common changes (recipes)

- **Onboard a new client:** platform-admin `POST /admin/clients` → client admin logs in → creates a
  playbook with a `voice_config` (brand + flow) → creates a campaign → uploads leads → queues calls.
- **Change what the bot says for a client:** edit that playbook's `voice_config` JSON in the
  dashboard Playbooks page and save (audio pre-warms automatically). No deploy.
- **Add a new answerable question globally:** add a named intent to `FLOW_INTENTS` + a detector
  function in voicebot.js, and a matching FAQ in the flow. (Or just let the self-training loop
  propose it from real calls.)
- **Add a new compliance rule:** add a check in `complianceAudit.js` `auditTranscript()`.
- **A/B test a gate line:** give the gate `questionVariants`; the system optimizes automatically.

---

## 18. Glossary (quick reference)

- **Tenant** — a client company; the unit of data isolation.
- **Playbook** — a call script + brand, stored as data (`voice_config`).
- **Flow engine** — `runScriptedFlow()`; interprets a playbook's flow into a live conversation.
- **Gate** — a yes/no checkpoint in a flow.
- **FAQ / intent** — a recognized question and its scripted answer, answerable any time.
- **Terminal** — an intent that ends the call (not interested, callback, dispute…).
- **Outcome** — the recorded result of a call (INTERESTED, CALLBACK, OPTED_OUT…).
- **STT / TTS** — Speech-to-Text / Text-to-Speech.
- **LLM** — Large Language Model (Sarvam), used only for off-script questions, always filtered.
- **Grounding filter** — strips unsafe content (OTP requests, invented numbers) from LLM replies.
- **VAD** — Voice Activity Detection; knows when the customer is speaking.
- **Barge-in** — the bot stopping when the customer interrupts.
- **DNC** — Do-Not-Call list.
- **Prewarm** — pre-synthesizing common TTS lines into the cache for zero-latency playback.
- **Self-training loop** — mining calls → proposing FAQ answers → human approval → live.
- **Network learning** — anonymized cross-client sharing of *question understanding* (not answers).
- **Variant** — an alternate phrasing of a gate question, auto-optimized by outcome.
- **Advisory lock** — a Postgres lock ensuring a nightly job runs once across instances.

---

*Where to start reading the code:* `apps/backend-api/src/routes/voicebot.js` (a live call) →
`services/playbooks.js` (`buildPrompt`, `voice_config`) → `services/flowLearning.js` (learning) →
`services/complianceAudit.js` (safety). The four §6, §8, §9, §11 concepts are the product's moat.

---
---

# PART II — DEEP DIVES

> Part I above is the conceptual overview (read it first). Part II is the detailed technical
> reference: exact mechanics, data shapes, timing constants, decision orders, and edge cases.
> Read the section you need when you need it.

---

## D1. The real-time voice engine — turn-taking, VAD, and barge-in

The hardest part of a voice bot is not *what* to say — it's *when*. Deciding the customer has
finished speaking, handling interruptions, and never talking over them. This all lives in
`apps/backend-api/src/routes/voicebot.js`, driven by tunable constants (all overridable by
`VOICEBOT_*` env vars; defaults shown).

### The audio path
1. Exotel opens a **WebSocket** and streams the live call as small audio frames (8 kHz PCM,
   ~20 ms each). `attachVoicebot(server)` accepts the upgrade and creates a **session object**
   holding all per-call state (the lead, the flow stage, timers, counters, the STT stream…).
2. Each incoming frame is fed to two things in parallel:
   - **VAD** (`services/vad.js`) — Voice Activity Detection. Cheap, fast: "is there speech energy
     in this frame?" Used to detect *when the customer starts and stops talking*.
   - **Live STT** (`providers/sttLive.js` → Sarvam over its own WebSocket) — converts
     the audio to text incrementally, emitting **interim** transcripts (guesses that keep changing)
     and **final** transcripts (committed text for an utterance).

### Deciding the customer is done (turn-taking)
`STRICT_TURN_TAKING` (default **on**) means the bot waits for the customer to actually finish
rather than jumping in. Signals used:
- **Interim → final promotion.** STT emits interims as the customer speaks. A final is emitted when
  STT is confident the utterance ended. Constants shape how eagerly we act on interims:
  `INTERIM_TRANSCRIPT_DELAY_MS=1200`, `INTERIM_TRANSCRIPT_FORCE_MS=2600`,
  `INTERIM_TRANSCRIPT_MIN_WORDS=2`, `INTERIM_TRANSCRIPT_MIN_CHARS=5` — i.e. only treat an interim as
  actionable after a short pause and if it has enough content, and force-commit if it's been hanging
  too long.
- **Final watchdog.** `STT_FINAL_WATCHDOG_MS=1200` — if VAD says the customer stopped but STT never
  emits a final (it sometimes drops them), a watchdog fires after 1.2 s and uses the best interim so
  the call doesn't stall in silence. (This exact bug — missing finals causing dead air — is covered
  by a regression test.)
- **Confidence gating.** `MIN_TRANSCRIPT_CONFIDENCE=0.62`. A low-confidence short transcript
  (≤ `LOW_CONFIDENCE_MAX_WORDS=3` words) is treated as "not sure what you said" → the flow's
  clarify/unclear path, rather than acting on a possibly-mangled word. This is why noisy lines get
  "sorry, didn't catch that" instead of a wrong answer.

### Barge-in (the customer interrupts while the bot is speaking)
- `STT_DURING_ASSISTANT_ENABLED` keeps STT running even while the bot talks, so we can *hear* an
  interruption.
- When VAD detects sustained customer speech during playback (`BARGE_IN_MIN_CHUNKS=3` frames after a
  `BARGE_IN_GRACE_MS=700` grace window), the bot **stops speaking immediately** (`BARGE_IN_CLEAR_ENABLED`)
  and processes the new input — exactly like a human stopping mid-sentence when interrupted.
- `INTRO_BARGE_IN_ENABLED=false` — the *opening* line is protected from barge-in by default, so the
  disclosure/identity is always fully spoken (a compliance nicety).

### Silence handling (customer says nothing)
- `NO_SPEECH_PROMPT_MS=3000` — after 3 s of silence the bot gently re-prompts ("Hello, can you hear
  me?").
- `NO_SPEECH_END_MS=3000` — after another silence it closes politely rather than hanging on a dead
  line.

### Call length cap
- `MAX_CALL_SECONDS=300` (5 min). `MAX_CALL_CLOSING_LEAD_SECONDS=5` — at 4:55 the bot starts a
  graceful closing line so it wraps up before the hard cut. Prevents runaway calls (and runaway cost).

### Stale-turn protection
Every "turn" gets a sequence number (`turnSeq`). If the customer speaks again before the bot's
previous reply finishes generating, the old reply is **dropped** (`reply_stale_dropped` event) so
the bot never speaks an out-of-date answer. Same idea guards the speech queue
(`SPEECH_QUEUE_STALE_MS=8000`).

---

## D2. The TTS pipeline, audio caching, and prewarming (why it feels instant)

Synthesizing speech from Sarvam takes a network round-trip (hundreds of ms). Doing that on every
turn would make the bot feel laggy. So:

### Three-layer audio cache
`getPcmBase64(text, session)` resolves audio in this order:
1. **In-memory LRU cache** (`pcmCache`, `PCM_CACHE_MAX=200` entries) — instant, per-process.
2. **Persistent DB cache** (`voice_audio_cache` / `call_audio_cache` tables) — survives restarts,
   shared across processes.
3. **Live synthesis** (Sarvam TTS) — only on a true cache miss, then the result is written back to
   both caches. The cache key includes the exact text + language + speaker + model + sample rate +
   volume, so any change produces a fresh key (no stale audio).

### Prewarming (the key to low latency)
At **startup** and **whenever a playbook is saved**, the system pre-synthesizes every static line a
flow can speak and stores the audio in the cache *before any call happens* (`prewarmScriptedFlows`,
`prewarmPlaybookFlow`, `flowPrewarmItems`). So the first real call already plays from cache.
**Critical invariant:** the prewarm extractor renders text through the *same* `renderFlowText`
function the live engine uses, so cached audio is byte-identical to what a live call would produce —
otherwise the cache would silently miss. Name-varying lines (containing `{{name}}`) are skipped from
prewarm since they can't be pre-rendered.

### Playback mechanics
- Audio is streamed back to Exotel in frames. `TTS_PREROLL_MS=300` sends a tiny lead-in so the first
  word isn't clipped. `PLAYBACK_MARK_WAIT_MS=900` and "playback marks" track when a line finishes
  playing (Exotel echoes a mark), so the bot knows when it's actually done speaking before it starts
  listening for the reply.
- `VOICEBOT_TTS_VOLUME` amplifies the audio for phone-line audibility.

---

## D3. `runScriptedFlow` — exact per-turn decision order

This is the function that decides the bot's reply on a scripted-flow call. Understanding its order
tells you *why* a given input produces a given reply. For each customer turn (`text` is the
normalized transcript):

```
1. Not a scripted-flow lead?            → return "" (fall through to Tez/generic/LLM logic)
2. Resolve vars {brand, assistant, website, name} for this lead.
3. FAQ interrupts:  for each flow.faq → if its named-intent detector matches, answer it.
                    (BUT a clear yes/no/backchannel skips substring-phrase FAQs, so
                     "haan loan chahiye" is treated as a gate-yes, not a loan FAQ.)
4. Terminal intents: not-interested / callback / dispute / already-done / busy →
                    set outcome, mark call to close, speak the terminal line.
5. Stage machine (session.panStage):
   • "identity": confirm the name; if asked "who is this?", answer + re-ask name;
                 on unrecognized input, re-ask JUST the name (with 3-strike give-up),
                 never replay the whole opening. On confirm → advance to gate 0.
   • a gate id:  bare "no"        → close with gate.onNo outcome.
                 "repeat?"        → "sure" + reprompt.
                 yes/backchannel  → advance to next gate (or instructions if last).
                 substantive Q    → hand ONE grounded turn to the LLM (capped 2/call).
                 anything else    → unclear reply (rephrased each strike; give up at 3).
   • "instructions_given": no-access/"no" → close with an anytime message.
                 a question      → recap the key action once, then close next turn
                                   (never an abrupt hangup after the long instructions).
                 yes             → close with thanks.
   • "closed" / anything else    → polite thanks (never falls through to other logic).
```

Two mechanisms worth internalizing:
- **`session.panShouldClose`** — the flag the async caller checks to actually hang up the call and
  record the outcome. The engine sets it; `processUserTranscript` acts on it.
- **`session.panUnclearCount`** — the 3-strike counter, reset to 0 every time a gate advances. Strike
  1 = "sorry, didn't catch that"; strike 2 = "your voice broke up a little"; strike 3 = graceful
  give-up + close. This is the anti-infinite-loop guarantee.

---

## D4. The LLM path — prompt, provider routing, circuit breaker, grounding

The scripted flow handles the common 80–90% instantly. For a genuine off-script question, exactly
one turn is handed to the LLM. Full chain:

### The prompt (`services/playbooks.js` → `buildPrompt`)
Assembles a large system prompt from: the playbook's brand/goal/steps, the resolved lead data
(name, amounts, journey stage, language), the recent transcript, learned handling notes, and a long
list of hard rules — *speak in the customer's language, never invent amounts/rates, never promise
approval, never ask for OTP/PIN/password, keep it to 1–2 short spoken sentences, always finish a
complete sentence*, etc. This is **defense layer 3** for compliance (see §8).

### Provider routing (`providers/llm.js`)
A thin entry point with a **circuit breaker**, calling **Sarvam** via `sarvamChat.js` — the only
permitted provider (see the data-residency note in §2). If it fails N times in a row
(`LLM_CIRCUIT_THRESHOLD`), the breaker "opens" and fast-fails for `LLM_CIRCUIT_RESET_MS` so a
failing provider doesn't add latency to every call. On failure, `safeGenerateReply` returns a
safe canned fallback rather than crashing the call.

**There is no cross-provider failover.** With Gemini removed, a Sarvam outage means LLM-fallback
turns degrade to the canned reply; scripted-flow turns (the majority) are unaffected because they
never call the LLM.

### The grounding filter (`groundGeneratedAssistantReply` → `assistantGroundingIssues`)
Runs on **every** LLM reply. It flags and, if any flag fires, **discards** the reply (replacing it
with a safe grounded fallback and logging an `assistant_reply_grounded` event):
- `unsupported_url:*` — a website not in the lead's allowed hosts.
- `unsupported_amount:*` — a rupee amount not equal to the lead's real offer/loan amount.
- `unsupported_rate` / `unsupported_financial_term` — any interest rate / fee / EMI / tenure number.
- `unsupported_guarantee` — "guaranteed approval" language.
- `sensitive_data_request` — **the OTP/PIN/password guardrail** (imperative + question forms, Hindi +
  English, negation-aware so the bot's own disclaimers aren't misflagged).
- `stage_mismatch:*` — claiming a different journey stage is pending than the lead's actual stage.

This is why the LLM can be used safely in a regulated context: it can only ever produce content that
survives these checks; anything unsafe is deterministically stripped.

### Latency masking
While the LLM generates, `maybeSpeakDelayedAck` can play a short filler ("haan ji, ek second") after
`FAST_ACK_DELAY_MS=650` so silence never stretches. (Off by default for scripted replies since those
are instant.)

---

## D5. The worker — queue, concurrency, channel-slot hold, retries

`apps/worker/src/index.js` is a **BullMQ Worker** on the `lead-calls` queue with
`concurrency = MAX_CONCURRENT_CALLS`. Per job (`{tenantId, campaignId, leadId, force}`):

1. **Call-window check** — computes the current hour in `callWindowTimeZone` (IST) and refuses if
   outside `[callWindowStart, callWindowEnd)`. Throwing here re-queues the job for later.
2. **Attempt cap** — if `lead.attempt_count >= maxCallAttempts`, mark the lead `max_attempts` and stop
   (no more dialing this lead).
3. **Sarvam preflight** (`assertSarvamReadyForCall`) — a cached health check so we don't dial into a
   dead voice provider.
4. **Create the `calls` row** (`status='initiated'`), then `triggerOutboundCall` (Exotel API). On
   success: `status='dialing'`, bump `attempt_count`. On dispatch failure: `status='failed'`, bump
   attempt, rethrow (BullMQ records the failure).
5. **Channel-slot hold** (`holdDispatchSlot`) — this is the concurrency-control trick. A single
   worker "slot" is held (polling the call's status every `callChannelPollMs`) until the call reaches
   a **terminal status** (completed/failed/busy/no-answer/…) or a safety cap
   (`ringTimeout + timeLimit + 15s`). This is how "1 concurrent channel" is actually enforced: the
   slot isn't freed for the next lead until this call really ends. **Important resilience fix:** a
   failure *during* the hold does **not** mark the (already-placed) call failed or burn a second
   attempt — it just logs and releases the slot.
6. **Pacing** — `callDispatchSpacingSeconds` sets a minimum spacing between calls.

The worker also runs an HTTP health server (`/health` on `WORKER_HEALTH_PORT`), and has graceful
shutdown (drains in-flight jobs on SIGTERM) plus `unhandledRejection`/`uncaughtException` guards so a
stray error can't silently kill the dialer.

---

## D6. Security & access-control model

- **Dashboard auth = JWT** (`middleware/auth.js`). On login, `signToken` issues a token carrying
  `{userId, tenantId, role, email}`, expiring in `JWT_EXPIRY` (default 8h). `requireAuth` verifies it
  on every protected route and sets `req.user`. `requireRole('admin')` / `requireRole('platform_admin')`
  gate privileged endpoints.
- **Tenant scoping = the core isolation.** Every query filters by `req.user.tenantId`. A user's token
  only ever exposes their own tenant's rows.
- **Webhook auth** (`routes/webhooks.js`) — Exotel can't sign payloads, so a shared secret
  (`EXOTEL_WEBHOOK_SECRET`) is required as `?secret=…`. **In production, missing secret = reject all
  webhooks** (fail-closed), so a forgotten config can't leave the endpoint open to forged call events.
- **Voicebot WebSocket** — protected by `VOICEBOT_TOKEN`.
- **Injection guards** — CSV export escapes formula-injection (`=,+,-,@` prefixes) since lead names
  come from uploaded files; flow FAQs match by **substring, never regex**, so mined/authored phrases
  can't inject a catastrophic regex; the seed script refuses the public default admin password in
  production.
- **CORS** — only configured frontend origins allowed in production (`index.js`).
- **Rate limiting** — auth endpoints (10/15 min per IP+email) and a general API ceiling (300/min).

**Known posture note for a new dev:** JWTs are stateless (no server-side revocation) and stored in
the browser's `localStorage`. Deleting a user doesn't invalidate their existing token until it
expires (≤ 8h). This is documented as an accepted tradeoff, not a bug — worth knowing.

---

## D7. Resilience & error handling (why one bad request won't take everything down)

- **DB pool** (`db/pool.js`) — retries transient connection errors (ECONNRESET/ETIMEDOUT/admin
  shutdown) up to 3× with backoff; has a pool `error` handler so a dropped idle connection doesn't
  crash the process.
- **Redis** (`queue.js`) — an `error` listener on the client so a transient Redis blip auto-reconnects
  instead of crashing.
- **Process guards** — both backend and worker register `unhandledRejection` (log, keep serving) and
  `uncaughtException` (log, exit for a clean orchestrator restart). Before these, a rejected promise
  in any async route could take down every live call.
- **Graceful shutdown** — on SIGTERM both apps stop accepting new work and drain in-flight
  requests/jobs (up to 30s) before exiting, so a deploy doesn't cut a live call mid-sentence.
- **Nightly jobs** are wrapped in advisory locks and try/catch; a failure in one tenant's mining
  never aborts the batch for others, and missing tables (fresh DB) are skipped gracefully.

---

## D8. Outcome classification (how a call gets its result)

`services/outcomes.js` maps what the customer said/did to one of a fixed set of **outcomes** stored
on the `calls` row: `INTERESTED`, `NOT_INTERESTED`, `CALLBACK`, `PROMISE_TO_PAY`, `PAID`,
`WRONG_NUMBER`, `VOICEMAIL`, `CALL_SCREENING`, `JOURNEY_COMPLETED`, `DISPUTE`, `OPTED_OUT`, `UNCLEAR`,
`IN_PROGRESS`. Scripted flows set outcomes directly (e.g. a gate's `onNo.outcome`), mapped to the enum
by `panOutcomeToCallOutcome`. The generic pipeline also detects terminal intents (opt-out, voicemail,
call-screening/IVR gatekeepers, wrong number) and closes appropriately. These outcomes are what the
analytics dashboard and the variant-optimization job (§11) consume — e.g. "success" for variant
weighting = `INTERESTED / JOURNEY_COMPLETED / PROMISE_TO_PAY / PAID`.

---

## D9. Event & data flow for the intelligent features

The "smart" features are all driven by structured rows written during/after calls. This table shows
the pipeline for each:

| Feature | Written during call | Nightly job reads | Produces | Human step | Ends up in |
|---------|---------------------|-------------------|----------|-----------|------------|
| Self-training (§9) | `transcripts` (miss markers) + `voicebot_events` (`flow_llm_fallback`) | `runFlowLearningBatch` | rows in `flow_improvement_proposals` | Approve/Reject | playbook `voice_config.flow.faqs` |
| Network learning (§10) | (same, on approval) | `runNetworkSeeding` | `shared_phrase_pool` + network proposals | Approve/Reject | other tenants' playbooks |
| Compliance (§8) | `transcripts` | `runComplianceAuditBatch` | rows in `call_compliance_audits` | Review flagged | Compliance dashboard |
| Variant optimization (§11) | `voicebot_events` (`flow_variant_spoken`) | `runVariantStatsBatch` | rows in `flow_variant_stats` | none (auto) | engine's variant picker |

Key insight: **the live call only writes cheap event rows.** All the expensive analysis (LLM
clustering, auditing, weight computation) happens off the critical path, at night, so it never adds
latency to a call.

---

## D10. Sequence walkthroughs (text diagrams)

**A full PAN-verification call (happy path):**
```
Exotel  ──WS connect──▶ voicebot.attachVoicebot → new session, load lead + variant weights
Bot     ──speak──▶      "Namaste, ASAP Finance se... Am I speaking with Prasheel?"   [prewarmed audio]
Cust    ──"haan ji"──▶  STT final → runScriptedFlow: identity confirmed → advance to gate "availability"
Bot     ──speak──▶      "...PAN verification pending... Is now a good time?"
Cust    ──"haan"──▶     gate yes → advance to "interest"
Bot     ──speak──▶      "Are you still interested in a loan up to ₹50,000?"
Cust    ──"kitna?"──▶   FAQ intent 'amount' → "You may be eligible up to ₹50,000..."  (stays on gate)
Cust    ──"haan"──▶     gate yes → advance to "continue_today"
Cust    ──"haan"──▶     last gate yes → instructions block, outcome=continuing
Cust    ──"ok"──▶       instructions_given + yes → close, panShouldClose=true
Bot     ──speak──▶      "Thank you for your time. Have a great day."  → finalizeCall(INTERESTED) → hang up
Night   ──▶            compliance audit scores the call; variant stats update; any miss → learning proposal
```

**The self-training loop:**
```
Day:    calls happen → "didn't catch that" + flow_llm_fallback events accumulate
21:30:  runFlowLearningBatch → group missed utterances → Sarvam clusters → proposals table (status=pending)
Human:  Playbooks page → sees "cibil kharab (5×)" proposal → clicks Approve
System: merges FAQ into playbook voice_config (transaction) → prewarms audio → (if opted-in) contributes topic+phrases to shared pool
Next call: customer says "mera cibil kharab hai" → substring match → instant compliant answer (no LLM)
```

---

## D11. Testing

`npm test` (Node's built-in test runner) runs ~188 tests. What they cover and why it matters:
- **Flow engine & PAN flow** (`test/panVerification.test.js`) — the full happy path, every negative
  scenario (busy/decline/dispute/no-access), FAQ interrupts, 3-strike give-up, repeat handling,
  gate-variant selection, and a **fully custom client flow** proving multi-client works from data.
- **Learning** (`test/flowLearning.test.js`) — phrase sanitization (no digits leak), JSON extraction
  from messy LLM output, merge/remove of learned FAQs, topic normalization.
- **Compliance** (`test/complianceAudit.test.js`) — each rule (OTP request incl. the disclaimer
  false-positive guard, guarantee, threat, opt-out, window, disclosure).
- **Variants** (`test/variantStats.test.js`) — weight smoothing, weighted selection, the 0-vs-missing
  weight bug fix, deterministic selection.
- **Voicebot core** (`test/voicebot.test.js`) — turn-taking, barge-in, grounding filter (incl. the
  strengthened OTP detection), name confirmation, dedup, currency/stage grounding.

Tests are pure-function level (no DB/network needed) — they exercise the decision logic directly, so
they run in ~1s and are safe to run constantly while developing.

---

## D12. Extending the system — detailed recipes

**Add a brand-new client with a custom script (no code):**
1. Platform-admin: `POST /admin/clients` → creates tenant + admin user.
2. That admin logs in → Playbooks → New Playbook → paste a `voice_config` JSON (copy the PAN example,
   change brand + gates + faqs + instructions). Save (audio prewarms).
3. Create a campaign on that playbook → upload leads CSV → Queue Calls.

**Add a new answerable intent to the engine (code):**
1. Add a detector fn + register it in `FLOW_INTENTS` (voicebot.js).
2. Reference it by name in a flow's `faqs[].intent` (or `GENERIC_FLOW_FAQS` for all flows).
   Prefer letting the **self-training loop** discover it from real calls instead, when possible.

**Add a compliance rule (code):**
1. Add a check + weight in `complianceAudit.js` `auditTranscript()` (and a test).

**A/B test a gate line (no code):**
1. In the playbook's `voice_config`, give a gate `questionVariants: [{hi,en}, {hi,en}]`. The system
   optimizes automatically; view results at `GET /playbooks/:key/variant-stats`.

**Adjust the AI models (config):**
1. Set `SARVAM_CHAT_MODEL` / `SARVAM_STT_MODEL` / `SARVAM_TTS_MODEL`. `config.js` validates the chat
   model and auto-upgrades deprecated values.
2. **Adding a different AI vendor requires a compliance review first** — see the data-residency note
   in §2. The single-provider constraint is deliberate, not an oversight.

---

## D13. Operational runbook (troubleshooting)

| Symptom | Likely cause | Where to look |
|---------|--------------|---------------|
| Calls silently do nothing after "Queue Calls" | Worker not running, Redis down, or outside call window | worker logs, `/health` on worker, `tenant_settings` window |
| Bot says the wrong brand / "TezCredit" | Playbook `voice_config.brand` unset or an old cached deploy | the playbook row; brand resolution order (§7) |
| Long delay before the bot speaks | TTS cache miss (line not prewarmed) or STT/turn-taking latency | `voicebot_events` timing; confirm prewarm ran at startup |
| Webhooks returning 403 | `EXOTEL_WEBHOOK_SECRET` unset (prod) or missing `?secret=` on Exotel URLs | env vars + Exotel callback config |
| Bot loops "didn't catch that" | Noisy line / STT confidence; or an intent phrasing gap | confidence constants (§D1); consider a learned FAQ |
| A compliance flag appears | An LLM reply or line tripped a rule | `call_compliance_audits.flags` (has evidence snippet) |
| Learning proposals never appear | No opted-in data, tables missing, or Sarvam key unset | run `POST /playbooks/proposals/mine`; check `SARVAM_API_KEY` |
| Process keeps restarting | Uncaught exception | logs (the crash guard logs then exits for restart) |

**Manual admin triggers** (don't wait for the nightly cron): `POST /compliance/audit/run`,
`POST /playbooks/proposals/mine`, `POST /playbooks/variant-stats/recompute`.

---

## D14. Legacy note — the TezCredit journey

The original single client was **TezCredit**, whose calls follow a multi-stage "journey" (selfie →
Aadhaar KYC → profile → bank verification → e-sign → disbursal). That logic lives in
`services/tezJourney.js` and the Tez-specific branches in voicebot.js. It predates the generic flow
engine (§6). New clients should **not** use it — they use `voice_config` flows. It remains because
real TezCredit leads (identified by `source_metadata.productName` or a `TEZ_*` playbook key) still
run on it, and its ~140 tests guard against regressions. Over time it can be re-expressed as a
`voice_config` flow like everything else.

---

*End of documentation. Keep this file updated when you add a subsystem — the §14 file map and the §13
table list are the two things that go stale fastest.*
