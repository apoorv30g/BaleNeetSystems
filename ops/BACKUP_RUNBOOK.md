# Backup & Restore Runbook

Covers the self-hosted Postgres deployment (`docker-compose.prod.yml`).

> **Why this matters here specifically:** the move off Railway removes platform-managed
> backups. The data at risk — borrower identities, loan details, full call transcripts — is
> precisely the data whose protection motivated the migration. Until a restore has been
> *rehearsed*, you do not have backups; you have files.

---

## 1. Install (once, on the VPS)

```bash
sudo mkdir -p /var/backups/loanconnect
sudo chown "$USER" /var/backups/loanconnect
chmod +x /opt/loanconnect/ops/backup.sh /opt/loanconnect/ops/restore.sh
```

Add to crontab (`crontab -e`) — 02:15 daily, outside the 09:00–20:00 calling window:

```
15 2 * * * /opt/loanconnect/ops/backup.sh >> /var/log/loanconnect-backup.log 2>&1
```

### Environment

| Variable | Default | Notes |
|---|---|---|
| `BACKUP_DIR` | `/var/backups/loanconnect` | Local dump location |
| `BACKUP_RETENTION_DAYS` | `14` | Local pruning window |
| `BACKUP_REMOTE_DEST` | *(unset)* | rsync target for off-box copies |
| `BACKUP_GPG_RECIPIENT` | *(unset)* | **Set this** if copying off-box — borrower data must not travel unencrypted |
| `BACKUP_ALERT_WEBHOOK` | *(unset)* | Posted to on failure |
| `COMPOSE_FILE` | `/opt/loanconnect/docker-compose.prod.yml` | |

**Keep the off-box destination India-resident.** Shipping dumps to a US bucket reintroduces
exactly the residency problem the migration was meant to solve.

---

## 2. What the backup does

- `pg_dump -Fc` (custom format — supports selective and parallel restore)
- **Verifies the archive** with `pg_restore --list` before declaring success. A truncated
  dump is the dangerous case because it looks like a success.
- Rejects implausibly small output (<10 KB)
- Optionally GPG-encrypts and rsyncs off-box
- Prunes local dumps older than the retention window
- Alerts on failure if a webhook is configured

---

## 3. Monthly rehearsal (do not skip)

An unrehearsed backup has an unknown success rate. Once a month:

```bash
/opt/loanconnect/ops/restore.sh /var/backups/loanconnect/<latest>.dump
```

This restores into a scratch database (`loanconnect_restore_test`) and leaves production
untouched. It prints row counts per table.

**Check:** the counts should be within a plausible margin of production. Compare against:

```bash
docker compose -f /opt/loanconnect/docker-compose.prod.yml exec -T postgres \
  psql -U loanconnect -d loanconnect -c \
  "SELECT 'leads', COUNT(*) FROM leads UNION ALL SELECT 'calls', COUNT(*) FROM calls;"
```

Then clean up:

```bash
docker compose -f /opt/loanconnect/docker-compose.prod.yml exec -T postgres \
  psql -U loanconnect -d postgres -c 'DROP DATABASE loanconnect_restore_test;'
```

Record the date and outcome — an auditor asking about disaster recovery will want evidence
the procedure is exercised, not just documented.

---

## 4. Real recovery

1. **Stop the apps first** so nothing writes mid-restore:
   ```bash
   docker compose -f docker-compose.prod.yml stop backend-api worker dashboard-web
   ```
2. **Back up the current state anyway**, even if it looks corrupt — it may hold data the
   dump predates:
   ```bash
   /opt/loanconnect/ops/backup.sh
   ```
3. **Restore:**
   ```bash
   /opt/loanconnect/ops/restore.sh /var/backups/loanconnect/<chosen>.dump --target-production
   ```
   Requires typing `restore production` to proceed.
4. **Re-run migrations** (harmless; idempotent, and covers a dump older than the current schema):
   ```bash
   docker compose -f docker-compose.prod.yml run --rm backend-api npm run migrate
   ```
5. **Restart and verify:**
   ```bash
   docker compose -f docker-compose.prod.yml start backend-api worker dashboard-web
   curl -fsS https://api.baleneetsystems.in/health
   ```
6. Place one test call before resuming campaigns.

---

## 5. Known gaps

- **RPO is up to 24 hours.** A daily dump means up to a day of calls and transcripts can be
  lost. If that becomes unacceptable, enable WAL archiving / PITR — materially more setup.
- **Redis is not backed up.** This is intentional: it holds only the BullMQ queue, which is
  re-derivable from `leads`/`campaigns`. In-flight jobs are lost on restore and campaigns
  must be re-queued.
- **No automated restore testing.** The rehearsal is a manual monthly task; nothing enforces
  it. Consider a calendar reminder with a named owner.
