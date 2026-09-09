# DigitalOcean Migration Guide — Railway → DO Bangalore (BLR1)

Very detailed, click-by-click and command-by-command version of the migration, scoped to
**DigitalOcean** specifically. For the provider-agnostic version (or if you switch to AWS/E2E
later), see `ops/MIGRATION_RUNBOOK.md` — the two are kept consistent; this one just spells out
every step for DO with no gaps.

**Why this migration:**
1. **Data residency** — borrower transcripts and financial data currently live in Railway's
   `sfo` (San Francisco) region. This system serves NBFCs; that data should not be US-resident.
2. **Latency** — every conversational turn on a live call pays a SFO↔India round trip today
   (~230–280ms). Bangalore↔India is ~20–50ms. This is a real, measurable share of the call
   latency reported earlier.

**Expected downtime:** ~10–15 minutes, confined to Part 7 (cutover). Everything in Parts 1–6
runs alongside the still-live Railway deployment and is fully reversible.

**Read this whole document once before starting anything.** Several steps depend on values
captured earlier (the Reserved IP, the Postgres password, etc.) — better to know that up front.

---

## Table of contents

- [Part 0 — Prerequisites](#part-0--prerequisites)
- [Part 1 — Commit and push the code](#part-1--commit-and-push-the-code)
- [Part 2 — Create the DigitalOcean Droplet](#part-2--create-the-digitalocean-droplet)
- [Part 3 — Reserved IP](#part-3--reserved-ip)
- [Part 4 — Cloud Firewall](#part-4--cloud-firewall)
- [Part 5 — Connect and harden the server](#part-5--connect-and-harden-the-server)
- [Part 6 — Install Docker](#part-6--install-docker)
- [Part 7 — Deploy the application code](#part-7--deploy-the-application-code)
- [Part 8 — Configure environment variables](#part-8--configure-environment-variables)
- [Part 9 — Configure Caddy (TLS + reverse proxy)](#part-9--configure-caddy-tls--reverse-proxy)
- [Part 10 — Bring the stack up (pre-cutover)](#part-10--bring-the-stack-up-pre-cutover)
- [Part 11 — Create the database schema](#part-11--create-the-database-schema)
- [Part 12 — Copy data from Railway](#part-12--copy-data-from-railway)
- [Part 13 — Pre-cutover verification checklist](#part-13--pre-cutover-verification-checklist)
- [Part 14 — Cutover](#part-14--cutover)
- [Part 15 — Post-cutover tasks](#part-15--post-cutover-tasks)
- [Part 16 — Rollback procedure](#part-16--rollback-procedure)
- [Part 17 — Cost summary](#part-17--cost-summary)
- [Known gaps and limitations](#known-gaps-and-limitations)
- [Troubleshooting](#troubleshooting)

---

## Part 0 — Prerequisites

Before starting, have ready:

- [ ] A DigitalOcean account with a payment method attached
- [ ] Root/admin access to the GitHub repository (or wherever this code is hosted)
- [ ] The **Railway CLI** installed and authenticated (`railway login`) — used later to export
      the current database
- [ ] DNS management access for `baleneetsystems.in` (wherever the domain is registered)
- [ ] All current Railway environment variables — Railway dashboard → each service → **Variables**
      tab → copy every value somewhere safe (a password manager note, not a plain text file)
- [ ] An SSH client. Windows: use **Git Bash** (already installed on this machine) or **PowerShell
      with OpenSSH** — both work; the commands below are POSIX `bash` and run correctly in Git Bash
- [ ] About 60–90 minutes of uninterrupted time for Parts 2–13. Part 14 (cutover) should be
      scheduled during a low-call-volume window in case anything needs a second look

---

## Part 1 — Commit and push the code

**This is a hard blocker.** Part 7 clones the repository onto the server. If the current working
changes are not pushed, the server gets stale code — no Caddy config, no per-client caller ID, no
Postgres/Redis memory tuning, none of the recent work.

From the repo root, on your machine:

```bash
git status
```

Review what is staged/unstaged. Then:

```bash
git add -A
git commit -m "Prepare for DigitalOcean migration: Caddy, prod compose, caller ID, retention tuning"
```

**Push it yourself** — pushing is not something to automate here; do it deliberately:

```bash
git push origin main
```

Confirm on GitHub (or your git host) that the commit is visible on `main` before continuing.

---

## Part 2 — Create the DigitalOcean Droplet

1. Log in at **cloud.digitalocean.com**.
2. Click **Create → Droplets**.
3. **Choose Region** → click the region selector → select **Bangalore — BLR1**.
   > This is the *only* DigitalOcean region physically located in India. Do not proceed with
   > any other region — the entire point of this migration is data residency.
4. **Choose an image** → tab **OS** → select **Ubuntu** → version **24.04 (LTS) x64**.
   > LTS means security patches through **April 2029**. Do not pick a "Marketplace" one-click
   > app image (WordPress, LAMP, etc.) — you want a clean OS; the application stack is deployed
   > via Docker Compose in Part 10, not via a pre-baked image.
5. **Choose Size**:
   - Droplet type: **Basic**
   - CPU options: **Regular (Disk type: SSD)** — the cheapest tier; this workload is not
     CPU-bound
   - Select **$12/mo** — **2 GB RAM / 1 vCPU / 50 GB SSD / 2 TB transfer**
   > Do **not** pick the $6/mo (1 GB) plan. Runtime footprint of the five running containers is
   > ~600–900 MB before the OS even accounts for its own memory — 1 GB will swap constantly,
   > and swap-induced latency spikes land squarely inside live call audio, which is the one
   > place you cannot afford it.
   > 2 GB works because CI (GitHub Actions, already configured in this repo) builds the Docker
   > images — the Droplet only ever *runs* them, it never builds the Next.js dashboard locally.
6. **Choose Authentication Method** → **SSH Key** (not Password).
   - If you don't already have a keypair for this project, click **New SSH Key**, follow the
     on-screen instructions to generate one (`ssh-keygen -t ed25519 -C "loanconnect-prod"` on
     your machine, then paste the **public** key `.pub` content), and give it a label.
   > Password authentication on a public IP gets brute-forced within hours by internet-wide
   > scanning bots. Do not enable it, even temporarily.
7. **Finalize Details**:
   - Quantity: **1 Droplet**
   - Hostname: `loanconnect-prod`
   - Tags: optional, e.g. `production`, `loanconnect`
   - **Enable Monitoring** (free) — gives CPU/memory/disk graphs and lets you set alert
     policies later
   - **Enable Backups** (optional, +20% ≈ $2.40/mo) — whole-Droplet snapshots. This
     **complements** `ops/backup.sh` (which backs up just the database); it does not replace it.
     Recommended given this holds borrower data, but not strictly required if the DB backup
     script (Part 15) is installed promptly.
8. Click **Create Droplet**. Wait ~60 seconds for provisioning.
9. **Record the Droplet's public IPv4 address** shown on the Droplets page — you'll need it
   shortly, though Part 3 replaces it with a more stable address for DNS purposes.

---

## Part 3 — Reserved IP

Do this **before** touching DNS anywhere.

1. In the DO dashboard, go to **Networking → Reserved IPs**.
2. Click **Reserve IP**.
3. Region: **Bangalore (BLR1)** (must match the Droplet's region).
4. **Droplet**: select `loanconnect-prod` to assign it immediately.
5. Click **Reserve**. Note the Reserved IP address — call it `RESERVED_IP` for the rest of this
   guide.

**Why this matters:** the Droplet's own public IP changes if you ever rebuild, resize, or replace
it. A Reserved IP can be re-pointed to a *different* Droplet in seconds via the dashboard, with
no DNS propagation delay. Two concrete benefits:
- **Fast rollback/recovery** — if the Droplet needs rebuilding, re-point the Reserved IP instead
  of waiting for DNS TTLs to expire everywhere.
- **A stable address for Exotel** — if Exotel filters webhook/media traffic by source IP, you
  give them this address once and it survives infrastructure changes underneath it.

It's free while attached to a running Droplet.

**From this point on, `RESERVED_IP` is the address used for everything** — SSH, DNS, Exotel
allowlisting. Do not use the Droplet's original public IP anywhere.

---

## Part 4 — Cloud Firewall

This is DigitalOcean's network-level firewall, separate from and in addition to `ufw` (configured
on the OS itself in Part 5). Cloud Firewall rules are enforced *before* traffic reaches the
Droplet's network interface, so a mistake in `ufw` is not immediately catastrophic.

1. **Networking → Firewalls → Create Firewall**.
2. Name: `loanconnect-prod-fw`.
3. **Inbound Rules** — remove any defaults you don't need, and add exactly:

   | Type | Protocol | Port Range | Sources |
   |---|---|---|---|
   | SSH | TCP | 22 | Your current IP (use "My IP") if it's static; otherwise "All IPv4"/"All IPv6" |
   | HTTP | TCP | 80 | All IPv4, All IPv6 |
   | HTTPS | TCP | 443 | All IPv4, All IPv6 |

4. **Outbound Rules** — leave the defaults (all outbound allowed). The application needs to
   reach Sarvam's API, Exotel's API, and (during migration) Railway's Postgres.
5. **Apply to Droplets** → select `loanconnect-prod`.
6. Click **Create Firewall**.

> **Never** add a rule for port 5432 (Postgres) or 6379 (Redis). Both are reachable only inside
> the Docker Compose internal network in this setup (see `docker-compose.prod.yml` — neither
> service publishes a host port). There is no reason for either to be reachable from the
> internet, and doing so is one of the most common causes of a compromised database.

---

## Part 5 — Connect and harden the server

### 5.1 First connection (as root)

```bash
ssh root@RESERVED_IP
```

Accept the host key fingerprint prompt (type `yes`) on first connection.

### 5.2 Create a non-root deploy user

Running the application as root is unnecessary risk. Create a dedicated user:

```bash
adduser deploy
```

You'll be prompted for a password (used only for local `sudo` prompts, not for SSH — SSH
password auth will be disabled below) and some optional details (press Enter to skip each).

```bash
usermod -aG sudo deploy
```

Copy your SSH key so `deploy` can log in the same way `root` does:

```bash
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

### 5.3 Harden SSH

Edit the SSH daemon config:

```bash
nano /etc/ssh/sshd_config
```

Find and set (uncomment if needed) these two lines:

```
PermitRootLogin no
PasswordAuthentication no
```

Save (`Ctrl+O`, Enter) and exit (`Ctrl+X`). Restart SSH:

```bash
systemctl restart ssh
```

**Before closing this session**, open a **second** terminal and confirm the new user works:

```bash
ssh deploy@RESERVED_IP
```

If that succeeds, you can safely close the root session. If it fails, **do not close the root
session** — fix the problem first, since once you disconnect you may lose the ability to log back
in as root.

### 5.4 Configure `ufw` (OS-level firewall)

As `deploy` (or root):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80
sudo ufw allow 443
sudo ufw --force enable
```

Verify:

```bash
sudo ufw status
```

Expected output shows `22/tcp`, `80`, `443` as `ALLOW`.

> This duplicates the Cloud Firewall from Part 4 deliberately — defense in depth. Postgres
> (5432) and Redis (6379) are intentionally absent from both; they must stay unreachable from
> outside the Droplet.

---

## Part 6 — Install Docker

As `deploy`:

```bash
curl -fsSL https://get.docker.com | sh
```

This runs Docker's official convenience install script and takes 1–2 minutes.

Add your user to the `docker` group so you don't need `sudo` for every Docker command:

```bash
sudo usermod -aG docker deploy
```

**Log out and back in** for the group membership to take effect:

```bash
exit
```

```bash
ssh deploy@RESERVED_IP
```

Verify Docker works without `sudo`:

```bash
docker run --rm hello-world
```

You should see a "Hello from Docker!" message. If you get a permission error, the group change
did not take effect — log out and back in again.

Confirm Docker Compose (the plugin, not the old standalone binary) is present:

```bash
docker compose version
```

Should print a version like `Docker Compose version v2.x.x`. `get.docker.com` installs this
automatically on Ubuntu 24.04.

---

## Part 7 — Deploy the application code

```bash
sudo mkdir -p /opt/loanconnect
sudo chown deploy:deploy /opt/loanconnect
git clone <YOUR_REPO_URL> /opt/loanconnect
```

Replace `<YOUR_REPO_URL>` with the actual clone URL (e.g.
`git@github.com:your-org/loanconnect-playbook-ai.git` for SSH, or the HTTPS URL with a
personal access token if the repo is private and you haven't set up a deploy key).

> If using HTTPS with a private repo, you'll need a **GitHub Personal Access Token** — generate
> one at GitHub → Settings → Developer settings → Personal access tokens, scoped to just this
> repo if possible, and use it as the password when prompted.

```bash
cd /opt/loanconnect
```

Confirm you're on the commit you pushed in Part 1:

```bash
git log -1 --oneline
```

---

## Part 8 — Configure environment variables

Create the production `.env` file:

```bash
nano /opt/loanconnect/.env
```

Populate it using your saved Railway variables (Part 0) as the source, with the following
**changes** from what Railway had:

```bash
# --- Core ---
NODE_ENV=production

# --- Database & Redis: point at the in-compose services, NOT Railway's internal hostnames ---
POSTGRES_USER=loanconnect
POSTGRES_PASSWORD=<GENERATE — see below>
POSTGRES_DB=loanconnect
DATABASE_URL=postgresql://loanconnect:<SAME PASSWORD AS ABOVE>@postgres:5432/loanconnect
REDIS_URL=redis://redis:6379

# --- Public URLs (unchanged from Railway — same domains, new server behind them) ---
SERVER_URL=https://api.baleneetsystems.in
NEXT_PUBLIC_API_BASE_URL=https://api.baleneetsystems.in
FRONTEND_URL=https://app.baleneetsystems.in
FRONTEND_URLS=https://app.baleneetsystems.in

# --- Auth ---
JWT_SECRET=<GENERATE — see below, KEEP IDENTICAL TO RAILWAY'S VALUE if you want existing
            sessions/tokens to remain valid; otherwise all users must log in again>
JWT_EXPIRY=8h

# --- Exotel (copy from Railway unchanged) ---
EXOTEL_ACCOUNT_SID=<from Railway>
EXOTEL_API_KEY=<from Railway>
EXOTEL_API_TOKEN=<from Railway>
EXOTEL_FROM_NUMBER=<from Railway>
EXOTEL_API_BASE=https://api.in.exotel.com
EXOTEL_WEBHOOK_SECRET=<from Railway>

# --- Sarvam (copy from Railway unchanged) ---
SARVAM_API_KEY=<from Railway>
SARVAM_CHAT_MODEL=sarvam-30b
SARVAM_STT_MODEL=saaras:v3
SARVAM_TTS_MODEL=bulbul:v3

# --- Brand ---
BRAND_NAME=<from Railway>
ASSISTANT_NAME=<from Railway>

# --- NEW since the last Railway deploy (see .env.example in the repo root for full context) ---
METRICS_TOKEN=<GENERATE — see below>
ALERT_WEBHOOK_URL=<a Slack/Teams/Google Chat incoming webhook URL>
```

**Copy every other variable** present in `.env.example` (repo root) that you had set on Railway
and isn't listed above — the two files should be reconciled side by side. Open the example for
reference:

```bash
cat /opt/loanconnect/.env.example
```

### Generating secrets

Run this **three times** to generate three independent random values — one each for
`POSTGRES_PASSWORD`, `JWT_SECRET`, and `METRICS_TOKEN`:

```bash
openssl rand -base64 32
```

> **Critical:** `DATABASE_URL` embeds `POSTGRES_PASSWORD` — if you change one, update the other.
> They must match exactly or Postgres authentication fails and every service crash-loops.

> **`NEXT_PUBLIC_API_BASE_URL` is baked into the dashboard's JavaScript bundle at BUILD time**,
> not read at container start. If this value is wrong, restarting the container does nothing —
> you must rebuild the `dashboard-web` image (`docker compose -f docker-compose.prod.yml up -d
> --build dashboard-web`).

Save and exit (`Ctrl+O`, Enter, `Ctrl+X`).

**Lock down the file permissions** — it contains database and API credentials:

```bash
chmod 600 /opt/loanconnect/.env
```

---

## Part 9 — Configure Caddy (TLS + reverse proxy)

The repo includes `ops/Caddyfile`, which automatically obtains and renews Let's Encrypt TLS
certificates and reverse-proxies to the app containers — including the specific settings needed
for the long-lived voicebot WebSocket (disabled response buffering, extended timeouts).

Open it:

```bash
nano /opt/loanconnect/ops/Caddyfile
```

Update the email address near the top (used only for Let's Encrypt expiry notices):

```
email ops@baleneetsystems.in
```

Change this to a real, monitored mailbox if `ops@baleneetsystems.in` isn't one.

**Leave everything else in the file as-is** unless you know you need to change it — the
WebSocket-specific settings (`flush_interval -1`, extended `read_timeout`/`write_timeout` on the
`/webhooks/exotel/voicebot*` path) are load-bearing for live call quality; removing or "cleaning
up" them would silently reintroduce latency and mid-call disconnects.

Confirm the domains referenced in the file match what you'll point DNS at in Part 14:

```bash
grep -E '^[a-z]' /opt/loanconnect/ops/Caddyfile
```

Should show `api.baleneetsystems.in` and `app.baleneetsystems.in` (or your actual domains, if
different — update both the Caddyfile and every reference in this guide accordingly).

---

## Part 10 — Bring the stack up (pre-cutover)

DNS still points at Railway at this point — that's expected and intentional. This step starts
everything on the new server so it can be fully tested before any traffic is redirected.

```bash
cd /opt/loanconnect
docker compose -f docker-compose.prod.yml up -d --build
```

This will take a few minutes the first time — it builds three Docker images (`backend-api`,
`worker`, `dashboard-web`) and pulls three others (`caddy`, `postgres`, `redis`).

Watch the build/startup logs:

```bash
docker compose -f docker-compose.prod.yml logs -f
```

Press `Ctrl+C` to stop following once things look stable (no crash-loop restarts).

Check every container is running and healthy:

```bash
docker compose -f docker-compose.prod.yml ps
```

Expected: `postgres` and `redis` show `(healthy)`; the other four show `Up`. If anything shows
`Restarting`, jump to [Troubleshooting](#troubleshooting) before continuing.

> **Caddy will show TLS certificate errors in its logs right now — this is expected.** It cannot
> obtain a Let's Encrypt certificate until DNS actually points at this server, which doesn't
> happen until Part 14. Ignore Caddy's certificate warnings for now; everything else should be
> healthy.

---

## Part 11 — Create the database schema

```bash
docker compose -f docker-compose.prod.yml exec backend-api npm run migrate
```

Expected output ends with `Migration complete` and no errors. This creates every table fresh —
safe to run because the new Postgres container starts empty.

Smoke-test the API directly on the box (bypassing Caddy, since it has no certificate yet):

```bash
curl -fsS http://127.0.0.1:4000/health
```

Expected: a JSON response with `"ok":true` and both `database` and `redis` showing `"ok"`.

---

## Part 12 — Copy data from Railway

Run this section from **your own machine** (not the server) — it needs the Railway CLI, which
is already installed and authenticated there.

### 12.1 Export from Railway

```bash
DB_URL=$(railway run --service Postgres bash -c 'echo $DATABASE_PUBLIC_URL')
pg_dump "$DB_URL" -Fc --no-owner --no-acl -f loanconnect-cutover.dump
```

This uses Railway's **public** (external-proxy) Postgres URL rather than its internal hostname,
since your machine isn't on Railway's private network. The dump is in `pg_dump`'s custom format
(`-Fc`) — compressed, and restorable selectively with `pg_restore`.

Confirm the dump file was created and has a sensible size (not near-zero):

```bash
ls -lh loanconnect-cutover.dump
```

### 12.2 Copy it to the server

```bash
scp loanconnect-cutover.dump deploy@RESERVED_IP:/tmp/
```

### 12.3 Restore on the server

Back on the server (SSH session):

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore \
  -U loanconnect -d loanconnect --no-owner --no-acl --clean --if-exists \
  < /tmp/loanconnect-cutover.dump
```

`--clean --if-exists` drops and recreates each object before restoring it, so this is safe to
re-run if it fails partway and you need to retry.

### 12.4 Verify the data actually arrived

**This step is not optional.** An empty-but-"successful" restore is the single most dangerous
failure mode here — the command can exit with status 0 while having restored nothing useful, if
(for example) the dump referenced a role that doesn't exist on the new database.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U loanconnect -d loanconnect -c "
  SELECT 'tenants' AS table, COUNT(*) FROM tenants
  UNION ALL SELECT 'users', COUNT(*) FROM users
  UNION ALL SELECT 'campaigns', COUNT(*) FROM campaigns
  UNION ALL SELECT 'leads', COUNT(*) FROM leads
  UNION ALL SELECT 'calls', COUNT(*) FROM calls
  UNION ALL SELECT 'playbooks', COUNT(*) FROM playbooks
  UNION ALL SELECT 'transcripts', COUNT(*) FROM transcripts;"
```

**Compare every number against Railway.** Run the same query against Railway's database (via
`railway run --service Postgres psql ...` or the Railway dashboard's query tool) and confirm the
counts match. If any table shows 0 where Railway shows a nonzero count, **stop and investigate**
before proceeding — do not continue to cutover with incomplete data.

### 12.5 Re-run migrations

The dump was taken from Railway's schema, which predates the newest columns added this session
(caller ID, contact-frequency caps, token revocation, promise-to-pay). Migrations are additive
and idempotent, so re-running is safe and necessary:

```bash
docker compose -f docker-compose.prod.yml exec backend-api npm run migrate
```

Confirm it again ends with `Migration complete`.

---

## Part 13 — Pre-cutover verification checklist

Do **all** of this before touching DNS. Everything here can be tested without affecting live
traffic, since Railway is still serving `api.baleneetsystems.in` and `app.baleneetsystems.in`
at this point.

Test the new server's HTTPS path directly, overriding DNS resolution just for this one request
(the `-k` flag ignores the certificate mismatch this causes, which is expected since Caddy's
cert isn't issued yet):

```bash
curl -fsS --resolve api.baleneetsystems.in:443:127.0.0.1 https://api.baleneetsystems.in/health -k
```

Checklist — do not proceed to Part 14 until every box is checked:

- [ ] `/health` returns `"ok":true` with `database` and `redis` both `"ok"`
- [ ] Table row counts match Railway exactly (Part 12.4)
- [ ] `docker compose -f docker-compose.prod.yml ps` shows all six services healthy/running
- [ ] You can log in to the dashboard against the new backend (test via the `--resolve` trick
      above, or a temporary hosts-file entry on your laptop pointing the domain at `RESERVED_IP`)
- [ ] The call window behaves correctly. The worker computes it against `CALL_WINDOW_TIME_ZONE`
      (defaults to `Asia/Kolkata` in the code), so it does **not** depend on the server's own
      system clock/timezone — but confirm this variable was carried over correctly if you had
      customized it on Railway
- [ ] **Exotel can reach `RESERVED_IP`.** If Exotel filters webhook or media-stream traffic by
      source IP allowlist, add this address in their dashboard/support ticket *now*, not during
      cutover
- [ ] `METRICS_TOKEN` and `ALERT_WEBHOOK_URL` are set (Part 8) — otherwise `/metrics` will
      return 503 and alerting will be silent after cutover
- [ ] You have decided the per-tenant contact-frequency cap values (`max_contacts_per_day` /
      `max_contacts_per_week` in `tenant_settings`, defaulting to 1/day and 3/week) — these
      guardrails become active the moment the migrated schema is live, and if any existing
      campaign legitimately calls a borrower more often than that, calls will start being
      silently skipped (logged as `frequency_capped`)

---

## Part 14 — Cutover

Pick a low-call-volume window. Total expected downtime: 10–15 minutes.

### 14.1 Pause outbound dispatch

```bash
docker compose -f docker-compose.prod.yml stop worker
```

Wait until no call is mid-flight:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U loanconnect -d loanconnect -c "SELECT COUNT(*) FROM calls WHERE status='streaming';"
```

Wait for this to return `0` before proceeding.

> Do this on the **Railway** side too if the old worker is still running there — you do not
> want both the old and new worker dispatching calls simultaneously once DNS starts moving.

### 14.2 Update DNS

Log in to wherever `baleneetsystems.in` is managed (registrar or DNS provider) and update:

| Record type | Host | Value |
|---|---|---|
| A | `api.baleneetsystems.in` | `RESERVED_IP` |
| A | `app.baleneetsystems.in` | `RESERVED_IP` |

> If your DNS provider lets you lower the TTL, do that **a day in advance** — a 300s or 3600s
> TTL from before means old resolvers may keep sending traffic to Railway for that long after
> you flip the record. If you didn't lower it in advance, expect propagation to take up to the
> old TTL value; there's no way to force it faster after the fact.

### 14.3 Watch Caddy obtain certificates

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

Once DNS has propagated to your resolver, Caddy will automatically request and receive Let's
Encrypt certificates for both domains — watch for log lines indicating successful certificate
issuance. This can take anywhere from a few seconds to a few minutes after DNS propagates.

Press `Ctrl+C` once you see certificates issued for both domains.

### 14.4 Verify the real domain now works

```bash
curl -fsS https://api.baleneetsystems.in/health
```

Should return the same healthy JSON as before, but now via the real domain with a valid
certificate (no `-k` flag needed).

```bash
curl -fsSI https://app.baleneetsystems.in
```

Should return `HTTP/2 200`.

### 14.5 Update Exotel configuration

If any Exotel webhook URL or the voicebot WebSocket `StreamUrl` is configured with a hardcoded
IP rather than the `api.baleneetsystems.in` hostname, update it in the Exotel dashboard now.

### 14.6 Resume dispatch

```bash
docker compose -f docker-compose.prod.yml start worker
```

### 14.7 Place one real test call

Before resuming any campaign at volume, **place a single real outbound call** through the normal
dashboard flow and personally listen to it. Confirm:
- Audio is audible in both directions
- The assistant's turn-taking feels normal (not cutting itself off, not talking over you)
- Barge-in works if you interrupt it mid-sentence

This is the only test that validates the entire WebSocket media path end-to-end — everything
before this point tests the HTTP surface, not the live-audio path.

---

## Part 15 — Post-cutover tasks

Complete these **the same day**, not "eventually":

1. **Install the backup cron immediately.** Railway's automatic backups disappear the moment you
   stop paying for that service, and there is currently no backup of the new database. Follow
   `ops/BACKUP_RUNBOOK.md` §1 to install `ops/backup.sh` on a nightly cron.
2. **Rehearse a restore.** Run `ops/restore.sh` against the most recent backup — it defaults to
   restoring into a scratch database, so this is safe to do on the live server.
3. **Point monitoring at `/metrics`.** `https://api.baleneetsystems.in/metrics` with header
   `Authorization: Bearer <METRICS_TOKEN>`.
4. **Keep the Railway project running for 48 hours** as a rollback path (see Part 16) before
   deleting or downgrading anything there.
5. **Measure the latency improvement.** Compare `reply_ready` event timings in the
   `voicebot_events` table for calls before vs. after cutover — this quantifies the SFO→Bangalore
   latency win concretely.
6. **Set up offsite backups**, if not already configured — DigitalOcean **Spaces** in BLR1 is a
   natural target (S3-compatible; works with `s3cmd`/`rclone`). Confirm Spaces is actually
   available in the BLR1 region before relying on it — if not, use another India-resident
   destination so backups don't leave Indian jurisdiction.

---

## Part 16 — Rollback procedure

If a serious problem surfaces after cutover, the fastest recovery is reverting DNS to Railway:

1. Point both A records (`api.` and `app.baleneetsystems.in`) back at Railway's original
   addresses (Railway typically uses a CNAME to `*.up.railway.app` — check what was there before
   you changed it in Part 14.2, ideally noted down beforehand).
2. Ensure the Railway services are still running (they should be, if you kept the project alive
   per Part 15.4).
3. Stop the **new** worker so both old and new stacks aren't dispatching calls at once:
   ```bash
   docker compose -f docker-compose.prod.yml stop worker
   ```

> ⚠️ **Any call placed on the new server after cutover exists only in the new database.**
> Rolling back after real traffic on the new stack means either accepting the loss of those call
> records, or manually exporting them from the new database and merging into Railway's. This is
> exactly why Part 14.1 pauses the worker before DNS changes, and why Part 15.4 keeps Railway
> warm for 48 hours rather than shutting it down immediately.

---

## Part 17 — Cost summary

| Item | Monthly (USD) |
|---|---|
| Droplet — 2 GB / 1 vCPU / 50 GB | $12.00 |
| Reserved IP (attached to a running Droplet) | $0.00 |
| Automated Droplet backups (optional, +20%) | $2.40 |
| Bandwidth (2 TB included; expected usage ~60 GB/mo at current call volume) | $0.00 |
| **Subtotal** | **~$12–14.40** |
| **With 18% GST** | **≈ ₹1,150–1,450/mo** |

This is roughly **2× the ₹500/mo** currently paid to Railway, and billed in **USD** (expect minor
FX variation and a card-issuer forex fee). For context: this figure sits against a reported
**₹20,000/mo minimum Exotel billing commitment** — infrastructure is a small fraction (~6%) of
total fixed monthly cost. The decision to migrate should be driven by residency and latency, not
by this cost delta.

If an Indian-domiciled provider becomes a hard requirement later (some BFSI auditors require it,
since DigitalOcean itself is a US-domiciled company subject to US legal process even though this
Droplet is physically in India), the same steps in this document apply near-identically to a
provider like E2E Networks — only Parts 2–4 (provisioning) change.

---

## Known gaps and limitations

- **No zero-downtime cutover path.** DNS propagation means there is a window (typically seconds
  to a few minutes, bounded by the old TTL) where some traffic could still reach Railway after
  the new server is live. Pausing the worker before the DNS change (Part 14.1) prevents the
  actually damaging outcome — the same lead being dialled twice from two different stacks
  simultaneously.
- **Redis/BullMQ queue state is not migrated.** This is intentional: the queue is fully
  re-derivable from the `leads` and `campaigns` tables. Any leads that were queued but not yet
  dialled at cutover time need to be re-queued from the dashboard after the new stack is live.
- **This Droplet currently assumes a WebSocket-based telephony integration** (matching Exotel's
  Voicebot Applet model). If the Go2Market 1600-series integration turns out to require SIP
  trunking rather than WebSocket media streaming, this same Droplet will additionally need UDP
  RTP port ranges opened in both firewalls and a media gateway (e.g. Jambonz or FreeSWITCH)
  deployed alongside the existing stack. A plain VPS like this can host that; a managed PaaS
  could not — this is part of why a Droplet was chosen over, say, DigitalOcean App Platform.
- **Single point of failure.** Everything — API, worker, both databases, TLS termination — runs
  on one Droplet. There is no automatic failover. For current call volume this is an accepted
  trade-off; revisit if volume grows enough to justify the added complexity of multi-node
  deployment.

---

## Troubleshooting

**A container is stuck in `Restarting` after Part 10:**
```bash
docker compose -f docker-compose.prod.yml logs <service-name>
```
Common causes: `.env` missing a required variable (check for `?`-marked required vars in
`docker-compose.prod.yml`, e.g. `POSTGRES_PASSWORD`), or `DATABASE_URL`'s password not matching
`POSTGRES_PASSWORD` exactly.

**`docker: permission denied` after Part 6:**
The `docker` group membership hasn't taken effect in the current shell session. Fully log out
(`exit`) and reconnect via SSH — a new shell picks up group changes; the same shell session does
not.

**Caddy never issues a certificate after DNS is updated (Part 14.3):**
- Confirm DNS has actually propagated: `dig +short api.baleneetsystems.in` from your own
  machine should return `RESERVED_IP`. If it still shows Railway's address, DNS hasn't
  propagated yet — wait longer.
- Confirm ports 80 and 443 are reachable from the internet (both Cloud Firewall and `ufw` allow
  them) — Let's Encrypt's validation requires inbound access on port 80 specifically, even
  though the site is served on 443.
- Check Caddy's own logs for the specific error: `docker compose -f docker-compose.prod.yml logs caddy`.

**`pg_restore` reports errors about roles or ownership:**
Expected and harmless if `--no-owner --no-acl` was included in the restore command (Part 12.3) —
these flags specifically avoid restoring Railway's internal role/ownership metadata, which
doesn't exist on the new database. Only worry if the row-count verification (Part 12.4) shows
missing data.

**The dashboard loads but API calls fail with CORS errors:**
Check `FRONTEND_URLS` in `.env` includes `https://app.baleneetsystems.in` exactly (protocol and
domain must match what the browser sends as `Origin`).

**Calls dial out but the bot never speaks (silence on the line):**
Almost certainly a WebSocket/streaming issue rather than a application-logic issue at this stage
of a fresh migration. Check:
1. `docker compose -f docker-compose.prod.yml logs backend-api` for `voicebot` errors around
   the call's timestamp.
2. That Exotel's dashboard shows no error connecting to the `StreamUrl` — if Exotel is IP
   allowlisting and `RESERVED_IP` wasn't added (Part 13 checklist), this is the likely cause.
3. Caddy's WebSocket-specific settings in `ops/Caddyfile` weren't altered (Part 9) — a stripped
   or "simplified" Caddyfile is a common way to accidentally reintroduce response buffering that
   breaks real-time audio.
