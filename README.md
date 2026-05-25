# LoanConnect Playbook AI

Deploy-ready MVP for AI voice calling in Indian lending workflows.

Supports:
- Cold Calling / Targeting
- Collection: Soft Payment Reminder
- Collection: Hard Payment Reminder
- Retargeting: Unapproved Users
- Retargeting: Approved Users
- Playbook-based campaign setup
- CSV lead upload
- Queue-based outbound calls
- Exotel telephony
- SarvamAI TTS-focused low-cost setup
- Gemini Flash reasoning
- PostgreSQL
- Redis + BullMQ
- Professional dark Next.js dashboard

## Quick Start

```bash
cp .env.example .env
docker compose up -d postgres redis

cd apps/backend-api
npm install
npm run migrate
npm run seed
npm run dev
```

In another terminal:

```bash
cd apps/worker
npm install
npm run dev
```

In another terminal:

```bash
cd apps/dashboard-web
npm install
cp .env.example .env.local
npm run dev
```

Open:

```txt
http://localhost:3000
```

Default admin:

```txt
admin@loanconnect.ai
Admin@123
```

## Production

See `DEPLOYMENT_GUIDE.md`.
