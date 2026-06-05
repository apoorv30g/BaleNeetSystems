# Deployment Guide — LoanConnect Playbook AI

## 1. Architecture

```txt
Next.js Dashboard
      ↓
Backend API
      ↓
PostgreSQL
      ↓
Redis / BullMQ
      ↓
Worker Service
      ↓
Exotel Outbound Call
      ↓
AI Playbook Engine
      ↓
SarvamAI / Gemini
```

This version is designed for:

```txt
~200–500 calls/day
~25,000 minutes/month foundation
```

without overbuilding websocket interruption infrastructure in Phase 1.

---

## 2. Services Needed

Create these Railway services:

```txt
backend-api
worker
postgres
redis
```

Deploy frontend on Railway or Vercel.

For a Railway-only deployment, create three application services from this repo and set each service root directory:

```txt
backend-api     root: apps/backend-api
worker          root: apps/worker
dashboard-web   root: apps/dashboard-web
```

Keep PostgreSQL and Redis as Railway database services.

---

## 3. Railway Setup

### PostgreSQL

Railway:

```txt
New → Database → PostgreSQL
```

Copy `DATABASE_URL`.

### Redis

Railway:

```txt
New → Database → Redis
```

Copy `REDIS_URL`.

---

## 4. Backend Variables

Set these in Railway backend service:

```env
NODE_ENV=production
PORT=4000

DATABASE_URL=
REDIS_URL=

JWT_SECRET=replace_with_64_char_random_secret

FRONTEND_URL=https://your-dashboard-service.up.railway.app
FRONTEND_URLS=https://your-dashboard-service.up.railway.app
CORS_ORIGIN_SUFFIXES=.baleneetsystems.in
SERVER_URL=https://your-backend-service.up.railway.app

EXOTEL_ACCOUNT_SID=
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
EXOTEL_FROM_NUMBER=
EXOTEL_API_BASE=https://api.in.exotel.com
EXOTEL_OUTBOUND_COST_PER_MINUTE_INR=0.60
EXOTEL_INBOUND_COST_PER_MINUTE_INR=0.20
EXOTEL_ATTEMPT_COST_INR=0.06
EXOTEL_CHANNEL_MONTHLY_COST_INR=1500
EXOTEL_CHANNEL_COUNT=1
EXOTEL_MIN_MONTHLY_BILLING_INR=20000

GEMINI_API_KEY=
SARVAM_API_KEY=
DEEPGRAM_API_KEY=
DEEPGRAM_MODEL=nova-2
DEEPGRAM_LANGUAGE=multi

CALL_WINDOW_START=9
CALL_WINDOW_END=20
MAX_CALL_ATTEMPTS=3
MAX_CONCURRENT_CALLS=20
CALL_DISPATCH_SPACING_SECONDS=0
CALL_RETRY_DELAY_MINUTES=360

LOAN_APP_URL=https://yourapp.com/apply
PAYMENT_LINK_BASE=https://yourapp.com/pay
SUPPORT_PHONE=
VOICEBOT_TOKEN=
```

Optional notification webhooks can be configured from the dashboard Compliance page after login:

```txt
SMS webhook URL
WhatsApp webhook URL
AI disclosure text
Call window
Max attempts
Retry delay
```

---

## 5. Worker Variables

Use the same database, Redis, Exotel and public backend URL variables as backend.

Important:

```env
NODE_ENV=production
DATABASE_URL=
REDIS_URL=
SERVER_URL=https://your-backend-service.up.railway.app
EXOTEL_CHANNEL_COUNT=1
MAX_CONCURRENT_CALLS=20
CALL_DISPATCH_SPACING_SECONDS=0
CALL_CHANNEL_HOLD_MAX_SECONDS=0
CALL_CHANNEL_POLL_MS=1000
```

Set `EXOTEL_CHANNEL_COUNT` to the number of paid WSS/concurrent calling channels confirmed by Exotel. Leave `MAX_CONCURRENT_CALLS` unset to use that channel count automatically, or set it explicitly to the same number. If you need one active phone call at a time, set both to `1`; the worker holds that channel slot until the Exotel call reaches a terminal status or the safety timeout expires. `CALL_CHANNEL_HOLD_MAX_SECONDS=0` uses ring timeout + call time limit + buffer.

---

## 6. Backend Deploy

In Railway, set root directory to `apps/backend-api`.

Railway start command:

```bash
npm start
```

After the first successful deploy, run these once from Railway shell or a one-off job:

```bash
npm run migrate
npm run seed
```

Run migrations again after pulling this version because it adds tenant settings, durable short-lived audio cache, notification events, and migration tracking tables.

**Hotfix — `updated_at` column on campaigns table**

If your deployment is returning `column "updated_at" of relation "campaigns" does not exist` errors (causing all `/campaigns/*` API calls to fail with 500), run the migration immediately from the Railway shell:

```bash
# Option A — run the dedicated SQL migration directly against the database
psql $DATABASE_URL -f apps/backend-api/migrations/001_add_campaigns_updated_at.sql

# Option B — re-run the full migrate script (idempotent, safe to run again)
npm run migrate
```

Both options are fully idempotent. The migration adds the missing `updated_at` column, back-fills existing rows, and installs a trigger that keeps the column current on every UPDATE.

---

## 7. Worker Deploy

In Railway, set root directory to `apps/worker`.

Railway start command:

```bash
npm start
```

---

## 8. Frontend Deploy

In Railway, set root directory to `apps/dashboard-web`.

Set:

```env
NEXT_PUBLIC_API_BASE_URL=https://your-backend-service.up.railway.app
```

### Option A — Vercel

```bash
cd apps/dashboard-web
npm install
vercel
```

Set the same frontend variable:

```env
NEXT_PUBLIC_API_BASE_URL=https://your-backend-domain.com
```

### Option B — Railway

Railway build command:

```bash
npm run build
```

Railway start command:

```bash
npm start
```

---

## 9. Exotel Setup

You need:

- Account SID
- API Key
- API Token
- Exophone / caller ID
- approved outbound calling account

Status webhook:

```txt
https://your-backend-domain.com/webhooks/exotel/status
```

Answer webhook:

```txt
https://your-backend-domain.com/webhooks/exotel/answer
```

For the Exotel Voicebot applet, use this WSS URL:

```txt
wss://your-backend-domain.com/webhooks/exotel/voicebot
```

If you set `VOICEBOT_TOKEN`, include it in the WSS URL:

```txt
wss://your-backend-domain.com/webhooks/exotel/voicebot?token=your_shared_token
```

If your Exotel flow can pass dynamic parameters, prefer:

```txt
wss://your-backend-domain.com/webhooks/exotel/voicebot?token=your_shared_token&leadId=<leadId>&campaignId=<campaignId>
```

Enable recording in the applet. The WSS endpoint streams Exotel PCM audio into Deepgram live STT, sends final transcripts to Gemini, converts Sarvam output to 16-bit Linear PCM 8kHz mono via ffmpeg, and sends media back to Exotel.

WSS health metadata:

```txt
https://your-backend-domain.com/webhooks/exotel/voicebot-health
```

Passthru endpoint to place after the Voicebot applet:

```txt
https://your-backend-domain.com/webhooks/exotel/passthru
```

The answer webhook now returns a gather/response loop and can serve short generated audio from:

```txt
https://your-backend-domain.com/webhooks/audio/:token
```

Make sure `SERVER_URL` is the public Railway backend URL so Exotel can reach these callbacks.

Before live volume, place one test call through Exotel and confirm:

- `Calls/connect.json` accepts the worker parameters in `apps/worker/src/exotel.js`
- Exotel accepts the `<Gather input="speech dtmf">` response format
- Voicebot applet connects successfully to `/webhooks/exotel/voicebot`
- `SpeechResult` or equivalent speech payload reaches `/webhooks/exotel/respond`
- If Exotel sends `RecordingUrl`, `RecordingURL`, `AudioUrl`, or `AudioURL` instead of speech text, Deepgram transcribes that audio and writes a `call_stt_events` row
- Sarvam audio, if enabled, plays from `/webhooks/audio/:token`

The worker triggers outbound calls through Exotel. Some Exotel accounts require slightly different call-flow parameters; adjust `apps/worker/src/exotel.js` after confirming with Exotel support.

---

## 10. CSV Upload Format

```csv
name,phone,campaignType,playbookType,dropStage,dueDate,loanAmount,offerAmount,language
Rahul,9876543210,COLLECTION,SOFT_PAYMENT_REMINDER,EMI_DUE,2026-06-01,50000,,Hinglish
Priya,9988776655,RETARGETING,UNAPPROVED_USERS,DOC_NOT_UPLOADED,,75000,60000,Hinglish
Amit,9876501234,TARGETING,FRESH_LEAD,COLD_CALL,,,100000,Hindi
```

Minimum required:

```csv
name,phone,playbookType
```

---

## 11. Supported Playbooks

```txt
SOFT_PAYMENT_REMINDER
HARD_PAYMENT_REMINDER
UNAPPROVED_USERS
APPROVED_USERS
FRESH_LEAD
```

---

## 12. Low-Cost Strategy

Use:

```txt
SarvamAI for voice
Gemini Flash for reasoning
Playbook-controlled calls
Short replies
Max call duration policy
Queue-based outbound calling
```

Avoid in Phase 1:

```txt
full websocket audio
barge-in
human transfer
predictive retries
```

---

## 13. Production Checklist

Before live calls:

- [ ] Exotel outbound call tested
- [ ] Call window enforcement enabled
- [ ] Max attempts enabled
- [ ] Opt-out/DNC flow enabled
- [ ] No OTP/PIN/password asked by prompt
- [ ] CSV validation working
- [ ] Call outcomes stored
- [ ] Campaign pause/edit/delete tested
- [ ] Compliance settings saved from dashboard
- [ ] SMS/WhatsApp webhook provider tested if link sending is enabled
- [ ] Worker running separately
- [ ] Dashboard shows campaigns/leads/calls
- [ ] Test campaign on your own number

---

## 14. Scale Notes

For 25,000 minutes/month:

- keep API and worker separate
- keep Redis mandatory
- start concurrency at 10–20
- increase only after Exotel confirms allowed channels
- keep `EXOTEL_CHANNEL_COUNT` aligned with paid Exotel channels/concurrent calling capacity
- keep calls short using playbooks
- store only call metadata/transcripts for now
- do not store large recordings in DB
