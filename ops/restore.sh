#!/usr/bin/env bash
#
# Restore a Postgres dump produced by ops/backup.sh.
#
#   ./ops/restore.sh /var/backups/loanconnect/loanconnect-20260815-021500.dump
#
# By default this restores into a SCRATCH database (loanconnect_restore_test) so you can
# rehearse a restore without touching production. That is the mode you should run monthly.
#
# To actually replace production data you must pass --target-production AND type the
# confirmation phrase. This is deliberately awkward: it destroys live borrower data.
#
set -Eeuo pipefail

DUMP_FILE="${1:-}"
shift || true

COMPOSE_FILE="${COMPOSE_FILE:-/opt/loanconnect/docker-compose.prod.yml}"
PG_SERVICE="${PG_SERVICE:-postgres}"
PG_USER="${POSTGRES_USER:-loanconnect}"
PROD_DB="${POSTGRES_DB:-loanconnect}"
SCRATCH_DB="loanconnect_restore_test"

TARGET_PRODUCTION=0
for arg in "$@"; do
  [[ "${arg}" == "--target-production" ]] && TARGET_PRODUCTION=1
done

log() { echo "[$(date -Is)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

[[ -n "${DUMP_FILE}" ]] || die "usage: restore.sh <dump-file> [--target-production]"
[[ -f "${DUMP_FILE}" ]] || die "no such dump file: ${DUMP_FILE}"

psql_exec() {
  docker compose -f "${COMPOSE_FILE}" exec -T "${PG_SERVICE}" psql -U "${PG_USER}" -d postgres -v ON_ERROR_STOP=1 -c "$1"
}

if [[ "${TARGET_PRODUCTION}" -eq 1 ]]; then
  TARGET_DB="${PROD_DB}"
  cat <<WARNING

  ############################################################
  #  DESTRUCTIVE: this will DROP and recreate the database
  #  "${PROD_DB}" on $(hostname), destroying all current
  #  borrower data, calls, and transcripts.
  #
  #  Take a fresh backup FIRST if the current data has any value.
  ############################################################

WARNING
  read -r -p 'Type exactly: restore production > ' CONFIRM
  [[ "${CONFIRM}" == "restore production" ]] || die "confirmation did not match; aborting"
else
  TARGET_DB="${SCRATCH_DB}"
  log "REHEARSAL MODE — restoring into scratch database '${SCRATCH_DB}' (production untouched)"
fi

log "recreating database ${TARGET_DB}"
psql_exec "DROP DATABASE IF EXISTS ${TARGET_DB} WITH (FORCE);"
psql_exec "CREATE DATABASE ${TARGET_DB};"

log "restoring ${DUMP_FILE} -> ${TARGET_DB}"
docker compose -f "${COMPOSE_FILE}" exec -T "${PG_SERVICE}" \
  pg_restore -U "${PG_USER}" -d "${TARGET_DB}" --no-owner --no-acl --exit-on-error < "${DUMP_FILE}"

# Verification: a restore that "succeeds" but yields empty tables is the failure mode that
# actually bites. Print row counts so the operator sees real data, not just an exit code.
log "verifying restored contents:"
docker compose -f "${COMPOSE_FILE}" exec -T "${PG_SERVICE}" \
  psql -U "${PG_USER}" -d "${TARGET_DB}" -c "
    SELECT 'tenants' AS table, COUNT(*) FROM tenants
    UNION ALL SELECT 'users', COUNT(*) FROM users
    UNION ALL SELECT 'campaigns', COUNT(*) FROM campaigns
    UNION ALL SELECT 'leads', COUNT(*) FROM leads
    UNION ALL SELECT 'calls', COUNT(*) FROM calls
    UNION ALL SELECT 'transcripts', COUNT(*) FROM transcripts
    UNION ALL SELECT 'playbooks', COUNT(*) FROM playbooks;"

log "restore complete into ${TARGET_DB}"

if [[ "${TARGET_PRODUCTION}" -eq 0 ]]; then
  cat <<NEXT

Rehearsal finished. Review the row counts above — they should match production scale.

Clean up when done:
  docker compose -f ${COMPOSE_FILE} exec -T ${PG_SERVICE} psql -U ${PG_USER} -d postgres -c 'DROP DATABASE ${SCRATCH_DB};'

NEXT
fi
