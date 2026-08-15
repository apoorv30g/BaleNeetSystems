#!/usr/bin/env bash
#
# Nightly Postgres backup for the self-hosted deployment.
#
# Writes a compressed custom-format dump (pg_dump -Fc), which pg_restore can restore
# selectively and in parallel -- unlike a plain SQL dump.
#
# Install (on the VPS, as the deploy user):
#   crontab -e
#   15 2 * * *  /opt/loanconnect/ops/backup.sh >> /var/log/loanconnect-backup.log 2>&1
#
# Restore: see ops/restore.sh and ops/BACKUP_RUNBOOK.md
#
set -Eeuo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/loanconnect}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
COMPOSE_FILE="${COMPOSE_FILE:-/opt/loanconnect/docker-compose.prod.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-loanconnect}"
PG_DB="${POSTGRES_DB:-loanconnect}"

STAMP="$(date +%Y%m%d-%H%M%S)"
OUTFILE="${BACKUP_DIR}/loanconnect-${STAMP}.dump"

log() { echo "[$(date -Is)] $*"; }

fail() {
  log "BACKUP FAILED: $*"
  # Surface failures somewhere a human actually looks. A backup that silently stops
  # running is indistinguishable from one that never existed.
  if [[ -n "${BACKUP_ALERT_WEBHOOK:-}" ]]; then
    curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
      -d "{\"text\":\"LoanConnect DB backup FAILED on $(hostname): $*\"}" \
      "${BACKUP_ALERT_WEBHOOK}" || true
  fi
  exit 1
}
trap 'fail "unexpected error on line $LINENO"' ERR

mkdir -p "${BACKUP_DIR}"

log "starting backup -> ${OUTFILE}"
docker compose -f "${COMPOSE_FILE}" exec -T "${PG_SERVICE}" \
  pg_dump -U "${PG_USER}" -d "${PG_DB}" -Fc --no-owner --no-acl \
  > "${OUTFILE}" || fail "pg_dump returned non-zero"

# A dump that exists but is truncated is the most dangerous failure mode, because it looks
# like success. Verify the archive is readable and non-trivial before trusting it.
SIZE="$(stat -c%s "${OUTFILE}")"
[[ "${SIZE}" -gt 10000 ]] || fail "dump is implausibly small (${SIZE} bytes)"
pg_restore --list "${OUTFILE}" > /dev/null 2>&1 \
  || docker compose -f "${COMPOSE_FILE}" exec -T "${PG_SERVICE}" pg_restore --list /dev/stdin < "${OUTFILE}" > /dev/null \
  || fail "dump failed pg_restore --list verification (archive is corrupt)"

log "backup ok (${SIZE} bytes)"

# Optional off-box copy. Keep the destination India-resident to stay consistent with the
# data-residency requirement that drove the self-hosting decision in the first place.
if [[ -n "${BACKUP_REMOTE_DEST:-}" ]]; then
  log "copying to ${BACKUP_REMOTE_DEST}"
  if [[ -n "${BACKUP_GPG_RECIPIENT:-}" ]]; then
    gpg --batch --yes --encrypt --recipient "${BACKUP_GPG_RECIPIENT}" -o "${OUTFILE}.gpg" "${OUTFILE}" \
      || fail "gpg encryption failed"
    rsync -a --timeout=120 "${OUTFILE}.gpg" "${BACKUP_REMOTE_DEST}/" || fail "remote copy failed"
    rm -f "${OUTFILE}.gpg"
  else
    log "WARNING: BACKUP_GPG_RECIPIENT not set — copying unencrypted borrower data off-box"
    rsync -a --timeout=120 "${OUTFILE}" "${BACKUP_REMOTE_DEST}/" || fail "remote copy failed"
  fi
fi

log "pruning local backups older than ${RETENTION_DAYS} days"
find "${BACKUP_DIR}" -name 'loanconnect-*.dump' -mtime "+${RETENTION_DAYS}" -delete

log "done. current backups:"
ls -lh "${BACKUP_DIR}" | tail -n +2
