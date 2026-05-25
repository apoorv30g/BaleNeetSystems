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

FRONTEND_URL=https://your-dashboard-domain.com
SERVER_URL=https://your-backend-domain.com

EXOTEL_ACCOUNT_SID=
EXOTEL_API_KEY=
EXOTEL_API_TOKEN=
EXOTEL_FROM_NUMBER=
EXOTEL_API_BASE=https://api.in.exotel.com

GEMINI_API_KEY=
SARVAM_API_KEY=
DEEPGRAM_API_KEY=

CALL_WINDOW_START=9
CALL_WINDOW_END=20
MAX_CALL_ATTEMPTS=3
MAX_CONCURRENT_CALLS=20
CALL_RETRY_DELAY_MINUTES=360

LOAN_APP_URL=https://yourapp.com/apply
PAYMENT_LINK_BASE=https://yourapp.com/pay
SUPPORT_PHONE=
```

---

## 5. Worker Variables

Use the same variables as backend.

Important:

```env
MAX_CONCURRENT_CALLS=20
```

Start with 10–20.

---

## 6. Backend Deploy

```bash
cd apps/backend-api
npm install
npm run migrate
npm run seed
npm start
```

Railway start command:

```bash
npm start
```

---

## 7. Worker Deploy

```bash
cd apps/worker
npm install
npm start
```

Railway start command:

```bash
npm start
```

---

## 8. Frontend Deploy

### Option A — Vercel

```bash
cd apps/dashboard-web
npm install
vercel
```

Set:

```env
NEXT_PUBLIC_API_BASE_URL=https://your-backend-domain.com
```

### Option B — Railway

```bash
cd apps/dashboard-web
npm install
npm run build
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
- keep calls short using playbooks
- store only call metadata/transcripts for now
- do not store large recordings in DB
