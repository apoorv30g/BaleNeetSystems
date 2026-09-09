# Infrastructure Migration Runbook — Railway (SFO) → India VPS

Moving off Railway's `sfo` region to an India-resident host.

**Two reasons, both real:**
1. **Data residency** — borrower transcripts and financial context currently sit in the US.
2. **Latency** — every conversational turn pays a San Francisco ↔ India round trip
   (~230–280ms). From Mumbai/Bangalore it is ~20–50ms. This is likely a meaningful share of
   the call latency you reported.

**Expected downtime: ~10–15 minutes**, and only during the final cutover (step 7). Everything
before that runs alongside the live system.

---

## 0. Before you start

**Provider** — the steps below are provider-agnostic. Pricing checked August 2026; verify
before committing, as Indian VPS pricing moves and E2E raised rates on 1 July 2026.

| Provider | Region | 2 GB ~Cost/mo | Domicile | Note |
|---|---|---|---|---|
| **Vultr** | Mumbai | **₹590–730** | US | Recommended default — ~cost-neutral vs Railway |
| **DigitalOcean** | Bangalore | **₹590–730** | US | Equivalent; best documentation |
| **E2E Networks** | Mumbai/Delhi/Bengaluru | **from ₹880** | **Indian** | Cleanest audit answer; INR billing + GST invoice |
| Budget Indian hosts | Mumbai | ₹299–450 | Indian | YouStable/HostAsia/HostItSmart — cheap, but smaller operations; check SLA and support before trusting borrower data to them |

> **Jurisdiction ≠ location.** DigitalOcean's Bangalore DC and Vultr's Mumbai DC are physically
> in India, but both companies are US-domiciled and therefore reachable by US legal process
> (CLOUD Act). If the NBFC's auditor cares about that distinction — and for BFSI many do — pick
> an Indian-domiciled provider. E2E is the mainstream choice, ~₹150–280/mo more.
>
> **Practical bonus of an Indian provider:** billing in INR with a GST invoice, so input tax
> credit is claimable. Vultr/DO bill in USD, which the finance team may find inconvenient.

**Recommendation:** start on **Vultr Mumbai or DO Bangalore at 2 GB** (~₹600–730 — about what
Railway costs you today). Move to **E2E** only if the NBFC's compliance team rejects a
US-domiciled provider; the migration is then a repeat of this same runbook, not new work.

**Sizing:** 2 GB works **only if you build images in CI** (the GitHub Actions workflow already
does). Building Next.js on a 2 GB box will OOM. 4 GB if you want to build on the server.

**You will need:**
- Root SSH access to the new box
- Your Railway env vars (Railway dashboard → Variables → copy all)
- DNS control for `baleneetsystems.in`
- The GitHub repo accessible from the server (deploy key or PAT)

---

## 0a. AWS setup (recommended path — Lightsail Mumbai)

Steps 1–9 are provider-agnostic; this section is only about getting a box to run them on.

Lightsail is chosen over EC2 deliberately: flat pricing with bandwidth included, no separate
EBS/egress/VPC to configure, but still inside the AWS compliance umbrella that makes the NBFC
audit conversation short. You can move to EC2 later without changing vendor.

### A1. Account and identity (do this properly — it is a BFSI system)

1. Create or sign in to the AWS account.
2. **Enable MFA on the root user** (IAM → Security credentials). Then stop using root.
3. Create an **IAM user** for yourself with console access and the `AdministratorAccess` policy;
   enable MFA on it too. Do all further work as this user.
4. **Set a billing alarm** — Billing → Budgets → create a monthly cost budget (say $25) with an
   email alert. This is how you find out about a runaway resource in days rather than at
   month end.

> Root credentials with no MFA on an account holding borrower data is the finding an auditor
> will lead with. Five minutes now.

### A2. Create the instance

Console → **Lightsail** → Create instance.

| Field | Value |
|---|---|
| **Region** | **Mumbai, `ap-south-1`** — click "Change region", do not accept the default |
| Availability Zone | any (`ap-south-1a` is fine) |
| Platform | Linux/Unix |
| Blueprint | Switch the tab from **"Apps + OS"** to **"OS Only"**, then pick **Ubuntu 24.04 LTS** |
| Plan | **$12/mo — 2 GB RAM, 2 vCPU, 60 GB SSD, 3 TB transfer** |
| SSH key | Create a new key pair, **download the `.pem`** and keep it safe |
| Name | `loanconnect-prod` |

> **The blueprint tab matters.** Lightsail defaults to "Apps + OS", which lists WordPress,
> LAMP, Node.js and so on. **Do not** pick any of them — including the Node.js one, despite it
> looking like a match. Those images pre-install a fixed Node/nginx/PM2 stack you would have to
> work around; you are running five services under Docker Compose with Caddy in front, so you
> want a clean OS. Most of them are also flagged "no longer maintained".
>
> The $5 plan (1 GB) is too small — runtime alone is ~600–900 MB before the OS.
> Note this $12 tier gives 2 vCPU and 3 TB transfer, where DigitalOcean's $12 gives 1 vCPU and
> 2 TB. Better value at the same price.

### A3. Static IP (do this before touching DNS)

Lightsail → **Networking** → **Create static IP** → attach it to `loanconnect-prod`.

Free while attached. Point DNS at *this*, never the instance's default address — it survives
stopping, rebuilding, or replacing the instance, and it is the stable address you give Exotel
for allowlisting.

### A4. Firewall

Instance → **Networking** tab → IPv4 Firewall. Keep only:

| Application | Protocol | Port | Restrict to |
|---|---|---|---|
| SSH | TCP | 22 | **your IP**, if it is static |
| HTTP | TCP | 80 | Any |
| HTTPS | TCP | 443 | Any |

Delete anything else. **Never** add 5432 or 6379 — Postgres and Redis are reachable only on the
internal Docker network by design.

This is separate from `ufw` (step 1). Run both: the Lightsail firewall filters before traffic
reaches the box, so a `ufw` mistake is not immediately fatal.

### A5. Snapshots

Instance → **Snapshots** tab → enable **automatic snapshots**, pick an hour outside your
calling window (e.g. 03:00 IST).

Whole-instance snapshots complement `ops/backup.sh`; they do not replace it. A snapshot restores
the whole box to a point in time; the `pg_dump` restores just the database, which is what you
usually want.

### A6. Connect

```bash
chmod 400 ~/Downloads/LightsailDefaultKey-ap-south-1.pem
```

```bash
ssh -i ~/Downloads/LightsailDefaultKey-ap-south-1.pem ubuntu@YOUR_STATIC_IP
```

The default user is **`ubuntu`** (not `root`), and it has passwordless sudo — so in step 1 you
can skip creating a `deploy` user and simply harden the existing one.

### A7. Offsite backups (optional but recommended)

Create an **S3 bucket in `ap-south-1`** (Mumbai) for encrypted dumps. Enable Block Public
Access and default encryption. Create a scoped IAM user with write access to just that bucket,
and use its credentials with `aws s3 cp` or `rclone` as `BACKUP_REMOTE_DEST`.

> Keep the bucket in **`ap-south-1`**. An S3 bucket in another region reintroduces exactly the
> residency problem this migration exists to solve.

### A8. Cost

| | Monthly |
|---|---|
| Lightsail 2 GB | $12.00 |
| Static IP (attached) | $0 |
| Automatic snapshots (~60 GB) | ~$3.00 |
| Data transfer (3 TB included; you use ~60 GB) | $0 |
| S3 backups (a few GB) | <$1 |
| **Subtotal** | **~$15–16** |
| **With 18% GST** | **≈ ₹1,550–1,700/mo** |

Against a ₹20,000 Exotel minimum, this is ~7% of fixed cost. Billed in USD — expect FX variation
and a card forex fee.

**→ Now continue from step 1 below.** On Lightsail, in step 1 you can skip creating a new user
and just harden `ubuntu`.

---

## 0b. DigitalOcean specifics (alternative)

Skip if using another provider — steps 1–9 are identical everywhere.

### What to create

| Item | Setting | Why |
|---|---|---|
| **Droplet region** | **Bangalore — BLR1** | The only DO region in India. Non-negotiable for residency. |
| **Image** | Ubuntu 24.04 LTS | LTS through 2029 |
| **Size** | Basic → Regular → **2 GB / 1 vCPU / 50 GB** ($12/mo) | Enough because CI builds the images. 1 GB is too small — runtime alone is ~600–900 MB before the OS. |
| **Authentication** | **SSH key**, not password | Password auth on a public IP is brute-forced within hours |
| **Reserved IP** | Attach one | **Do this — see below** |
| **Monitoring** | Enable (free) | Droplet CPU/memory/disk graphs and alert policies |
| **Backups** | Optional (+20% ≈ $2.40/mo) | Whole-droplet snapshots. Complements `ops/backup.sh`, does not replace it |

### Attach a Reserved IP before you touch DNS

A Reserved IP (DO's floating IP) can be re-pointed between droplets in seconds. Put your DNS
records on the Reserved IP rather than the droplet's own address, and you get:

- **Instant rollback** — re-point the Reserved IP at a rebuilt droplet without waiting for DNS
  propagation, which is otherwise the slowest part of any recovery
- **A stable IP to give Exotel** for allowlisting, which survives rebuilding the droplet

It is free while attached to a running droplet.

### Cloud Firewall

Configure DO's Cloud Firewall *in addition to* `ufw` — it filters before traffic reaches the
droplet, so a `ufw` misconfiguration is not immediately fatal.

Inbound: SSH 22 (restrict to your IP if it is static), HTTP 80, HTTPS 443. Nothing else —
**never** open 5432 or 6379.

### Offsite backups

DO Spaces is the natural `BACKUP_REMOTE_DEST` target (S3-compatible, works with `s3cmd`/`rclone`).
**Confirm Spaces is available in BLR1 before relying on it** — if it is not, sending dumps to a
Spaces region outside India would reintroduce the residency problem the migration exists to fix.
Falling back to another India-resident store, or a second BLR1 droplet, is fine.

### Skip these

- **Managed Postgres** (~$15/mo) — you would be paying to manage a 144 MB database
- **App Platform** — its managed proxy has idle timeouts you do not control, which breaks the
  long-lived voicebot WebSocket. This is the main reason the plan uses a plain droplet.

### Cost reality

| | Monthly |
|---|---|
| Droplet 2 GB | $12 |
| Automated backups (optional) | $2.40 |
| Reserved IP (attached) | $0 |
| Bandwidth (2 TB included; you will use ~60 GB) | $0 |
| **Subtotal** | **~$12–15** |
| **With 18% GST** | **≈ ₹1,200–1,500/mo** |

> This is roughly **2× the ₹500 you pay Railway**, not the ₹590–730 quoted earlier in planning —
> that figure was the 1–2 GB *range*, and the ₹590 end is the 1 GB tier, which is too small here.
> DO bills in **USD**, so expect FX variation and a card-issuer forex fee. If INR billing with a
> GST invoice matters to your accounting, an Indian provider is the better fit.

---

## 1. Provision and harden the server

**On AWS Lightsail** you already connect as `ubuntu` with passwordless sudo, so skip straight to
hardening SSH below — there is no need to create another user.

**On other providers**, where you land as root:

```bash
adduser deploy && usermod -aG sudo deploy && rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Then lock down SSH on any provider (`/etc/ssh/sshd_config`: `PermitRootLogin no`,
`PasswordAuthentication no`) and restart it. Open only what is needed:

```bash
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
```

> Postgres (5432) and Redis (6379) are deliberately **not** opened — they are reachable only
> on the internal Docker network. Do not expose them.

---

## 2. Install Docker

```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker deploy
```

Log out and back in so the group membership applies, then verify:

```bash
docker run --rm hello-world
```

---

## 3. Deploy the code

```bash
sudo mkdir -p /opt/loanconnect && sudo chown deploy:deploy /opt/loanconnect && git clone <YOUR_REPO_URL> /opt/loanconnect
```

Create `/opt/loanconnect/.env` from your Railway variables. **Changes from Railway:**

```bash
# Point at the in-compose services, NOT Railway's internal hostnames
DATABASE_URL=postgresql://loanconnect:<STRONG_PASSWORD>@postgres:5432/loanconnect
REDIS_URL=redis://redis:6379
POSTGRES_USER=loanconnect
POSTGRES_PASSWORD=<STRONG_PASSWORD>
POSTGRES_DB=loanconnect

# Unchanged public URLs
SERVER_URL=https://api.baleneetsystems.in
NEXT_PUBLIC_API_BASE_URL=https://api.baleneetsystems.in
FRONTEND_URLS=https://app.baleneetsystems.in

NODE_ENV=production

# New since the last deploy — see .env.example
METRICS_TOKEN=<generate one>
ALERT_WEBHOOK_URL=<your Slack/Teams webhook>
```

Generate the secrets:

```bash
openssl rand -base64 32
```

> `NEXT_PUBLIC_API_BASE_URL` is baked into the dashboard bundle at **build** time. Getting it
> wrong means rebuilding, not just restarting.

Set the Caddy email address in `ops/Caddyfile` (line 12).

---

## 4. Bring the stack up (still on the old DNS)

```bash
cd /opt/loanconnect && docker compose -f docker-compose.prod.yml up -d --build
```

Caddy will fail to get certificates until DNS points here — expected at this stage. Check the
app containers are healthy:

```bash
docker compose -f docker-compose.prod.yml ps
```

Create the schema:

```bash
docker compose -f docker-compose.prod.yml exec backend-api npm run migrate
```

Smoke-test locally on the box:

```bash
curl -fsS http://127.0.0.1:4000/health
```

---

## 5. Copy the data from Railway

On your **laptop** (needs the Railway CLI, already installed):

```bash
DB_URL=$(railway run --service Postgres bash -c 'echo $DATABASE_PUBLIC_URL') && pg_dump "$DB_URL" -Fc --no-owner --no-acl -f loanconnect-cutover.dump
```

Copy it up and restore:

```bash
scp loanconnect-cutover.dump deploy@NEW_SERVER_IP:/tmp/
```

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U loanconnect -d loanconnect --no-owner --no-acl --clean --if-exists < /tmp/loanconnect-cutover.dump
```

Verify the data actually arrived — an empty-but-successful restore is the failure mode that
bites:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres psql -U loanconnect -d loanconnect -c "SELECT 'tenants' t, COUNT(*) FROM tenants UNION ALL SELECT 'leads', COUNT(*) FROM leads UNION ALL SELECT 'calls', COUNT(*) FROM calls UNION ALL SELECT 'playbooks', COUNT(*) FROM playbooks;"
```

Re-run migrations (the dump predates the newest columns):

```bash
docker compose -f docker-compose.prod.yml exec backend-api npm run migrate
```

---

## 6. Pre-cutover checks

Do these **before** touching DNS. Test with a `Host` header override so you exercise the real
routing without moving traffic:

```bash
curl -fsS --resolve api.baleneetsystems.in:443:127.0.0.1 https://api.baleneetsystems.in/health -k
```

Checklist:
- [ ] `/health` returns `ok: true` with database and redis both `ok`
- [ ] Row counts match Railway
- [ ] `docker compose ps` shows every service healthy
- [ ] Login works against the new stack
- [ ] Call window behaves correctly. The worker computes it against
      `CALL_WINDOW_TIME_ZONE` (defaults to `Asia/Kolkata`), so it does not depend on the
      server's own clock zone — but confirm the var is carried over if you had overridden it
- [ ] **Exotel can reach the new IP** — allowlist it with Exotel if they filter by source IP

---

## 7. Cutover

**Pause dispatch first** so no call is in flight during the switch:

```bash
docker compose -f docker-compose.prod.yml stop worker
```

Wait for any live calls to finish (`SELECT COUNT(*) FROM calls WHERE status='streaming';` → 0).

**Then update DNS** — lower the TTL to 60s a day beforehand if you can:

| Record | Value |
|---|---|
| `api.baleneetsystems.in` A | NEW_SERVER_IP |
| `app.baleneetsystems.in` A | NEW_SERVER_IP |

Watch Caddy issue certificates:

```bash
docker compose -f docker-compose.prod.yml logs -f caddy
```

Once certificates are issued:

```bash
curl -fsS https://api.baleneetsystems.in/health
```

Update the Exotel webhook/stream URLs if they are pinned to an IP rather than the hostname.

**Restart the worker:**

```bash
docker compose -f docker-compose.prod.yml start worker
```

**Place one real test call** before resuming campaigns. Confirm audio is two-way and that
turn-taking feels normal — this is what validates the WebSocket path end to end.

---

## 8. After cutover

1. **Install backups immediately** — Railway's are gone the moment you shut it down.
   See `ops/BACKUP_RUNBOOK.md` §1.
2. **Rehearse a restore** (`ops/restore.sh`, defaults to a scratch DB).
3. Point monitoring at `https://api.baleneetsystems.in/metrics` (bearer `METRICS_TOKEN`).
4. **Keep Railway running for ~48h** as a rollback path before deleting anything.
5. Measure the latency win — compare `reply_ready` elapsed times in `voicebot_events` before
   and after.

---

## 9. Rollback

If something is wrong after cutover, DNS back to Railway is the fastest recovery:

1. Point both A records back at the Railway domains (CNAME to `*.up.railway.app`)
2. Restart the Railway services
3. Stop the new worker so both do not dial simultaneously:
   ```bash
   docker compose -f docker-compose.prod.yml stop worker
   ```

> ⚠️ **Any calls made on the new box after cutover exist only in the new database.** Rolling
> back after real traffic means you must dump the new DB and merge it into Railway's, or accept
> losing those records. This is why step 7 pauses the worker and step 8 keeps Railway warm.

---

## Known gaps in this plan

- **No zero-downtime path.** DNS propagation means a few minutes where calls could hit either
  side. Pausing the worker avoids double-dialling, which is the outcome that actually matters.
- **Redis is not migrated.** Intentional — the queue is re-derivable from `leads`/`campaigns`.
  Any queued-but-undialled leads must be re-queued from the dashboard after cutover.
- **If Go2Market turns out to be SIP-only**, this box will additionally need UDP RTP port
  ranges opened and a media gateway. A plain VPS can host that; a PaaS could not — which is
  part of why this shape was chosen.
