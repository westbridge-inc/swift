#!/usr/bin/env bash
#
# The resident doctor — one command that answers "is Swift healthy right now,
# and is anything quietly rotting?" for an operator with no team.
#
# READ-ONLY BY LAW. This script never mutates anything: no writes, no
# restarts, no deletes. It looks, it reports, it exits. 0 = healthy,
# 1 = something needs a human. Every check tolerates its subject being absent
# (no docker, no gh, API down) and says so instead of crashing — a doctor that
# dies mid-examination reports nothing.
#
# Every check below exists because its failure mode actually happened:
#   - the dev DB missing a migrated column → every home-screen request 500s,
#     founder sees "nothing loads"          (2026-08-29)
#   - a db-push database with no _prisma_migrations grading constraint tests
#     it cannot see                          (2026-08-29)
#   - redis with no restart policy refusing writes after a full disk, wedging
#     docker's own CLI                       (2026-08-29)
#   - the disk itself filling to 99%         (2026-08-26, twice)
#   - backups running but never leaving the machine they protect
#
# Usage:
#   ./deploy/doctor.sh                # local dev machine
#   API_URL=https://api.example ./deploy/doctor.sh   # against a server
#   WEB_URL=https://site.example ./deploy/doctor.sh  # also check a website

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
if [ -z "${API_URL:-}" ] && [ -f "$HERE/.env" ]; then
  API_HOST="$(grep -E '^API_HOST=' "$HERE/.env" | head -1 | cut -d= -f2- || true)"
  [ -z "$API_HOST" ] || API_URL="https://$API_HOST"
fi
API_URL="${API_URL:-http://localhost:3000}"

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
warn() { WARN=$((WARN+1)); printf '  WARN  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }

echo "Swift doctor — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "──────────────────────────────────────────────"

# ── 1. The API, from the outside ────────────────────────────────────────────
# Per-dependency detail is gated behind HEALTH_DETAIL_TOKEN (x-health-detail).
# The token is a secret: read it from a file and pipe it into `curl -H @-`
# (stdin), so it appears in no argv and no output line — it is never printed.
DETAIL_FILE=""
DETAIL_READER=""
if [ -n "${HEALTH_DETAIL_TOKEN_FILE:-}" ]; then
  if [ -r "${HEALTH_DETAIL_TOKEN_FILE}" ]; then
    DETAIL_FILE="${HEALTH_DETAIL_TOKEN_FILE}"
  elif sudo -n cat "${HEALTH_DETAIL_TOKEN_FILE}" >/dev/null 2>&1; then
    DETAIL_FILE="${HEALTH_DETAIL_TOKEN_FILE}"; DETAIL_READER=sudo
  fi
fi
if [ -z "$DETAIL_FILE" ]; then
  if [ -r "/run/swift-secrets/HEALTH_DETAIL_TOKEN" ]; then
    DETAIL_FILE="/run/swift-secrets/HEALTH_DETAIL_TOKEN"
  elif sudo -n cat "/run/swift-secrets/HEALTH_DETAIL_TOKEN" >/dev/null 2>&1; then
    DETAIL_FILE="/run/swift-secrets/HEALTH_DETAIL_TOKEN"; DETAIL_READER=sudo
  fi
fi
health_curl() {
  if [ -z "$DETAIL_FILE" ]; then
    curl -fsS -m 8 "$@"
  elif [ -n "$DETAIL_READER" ]; then
    { printf 'x-health-detail: '; sudo -n cat "$DETAIL_FILE"; printf '\r\n'; } | curl -fsS -m 8 -H @- "$@"
  else
    { printf 'x-health-detail: '; cat "$DETAIL_FILE"; printf '\r\n'; } | curl -fsS -m 8 -H @- "$@"
  fi
}
HEALTH=$(health_curl "$API_URL/health" 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  bad "API unreachable at $API_URL — nothing below it can be healthy for users"
else
  case "$HEALTH" in
    # The detailed checks are visible (token accepted, or development mode).
    *'"database":"ok"'*|*'"database":"error"'*)
      case "$HEALTH" in
        *'"database":"ok"'*) ok "API + database answering" ;;
        *) bad "database check not ok: $HEALTH" ;;
      esac
      case "$HEALTH" in
        *'"redis":"ok"'*) ok "redis answering" ;;
        *) bad "redis check not ok: $HEALTH" ;;
      esac
      # [Row 312] The upload malware scanner, as the API itself sees it.
      case "$HEALTH" in
        *'"malwareScanner":"ok"'*) ok "upload malware scanner answering (uploads are scanned)" ;;
        *'"malwareScanner":"off"'*) warn "upload malware scanner is OFF (MALWARE_SCAN dark): uploads are stored unscanned" ;;
        *'"malwareScanner":"down"'*) bad "upload malware scanner is DOWN: every upload is refused until clamd answers (docker compose -f deploy/docker-compose.yml logs --tail=100 clamd)" ;;
        *) warn "upload malware scanner state not reported (an API older than the scanner deployment)" ;;
      esac
      ;;
    # No token, or a rejected one: the API hides the per-check detail and the
    # only thing a 200 tells us is the aggregate status. That is not a FAIL.
    # Distinguish the two: with a token file present the header WAS sent, so
    # a hidden body means the token was rejected or rotated — the operator
    # must hear that instead of "no token".
    *'"status":"healthy"'*)
      if [ -n "$DETAIL_FILE" ]; then
        warn "health detail hidden despite sending x-health-detail — token rejected or rotated? per-check states not shown"
      else
        warn "health detail hidden (no readable HEALTH_DETAIL_TOKEN) — per-check states not shown"
      fi
      ok "aggregate /health says healthy (HTTP 200)"
      ;;
    *)
      bad "API answered without detailed checks or a healthy status: $HEALTH"
      ;;
  esac
fi

# ── 2. The canary — the first surface to die on client-vs-DB skew ───────────
# Default selects over vendors+items: a schema column the dev DB lacks kills
# this before it kills anything else, and it is exactly what the phone shows.
CANARY=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$API_URL/api/v1/customer/home" 2>/dev/null || echo 000)
case "$CANARY" in
  200) ok "canary /customer/home → 200" ;;
  000) warn "canary unreachable (API down above?)" ;;
  5*)  bad "canary /customer/home → $CANARY — investigate schema/client skew and migration status" ;;
  *)   warn "canary /customer/home → $CANARY (auth/config, not skew)" ;;
esac

# ── 2b. The website, from the outside (only when there is one) ──────────────
# [Q11] WEB_HOST in deploy/.env turns the staging website on (pilot-up.sh);
# WEB_URL overrides it, like API_URL. Unset means no website: nothing to check.
if [ -z "${WEB_URL:-}" ] && [ -f "$HERE/.env" ]; then
  WEB_HOST="$(grep -E '^WEB_HOST=' "$HERE/.env" | head -1 | cut -d= -f2- || true)"
  [ -z "$WEB_HOST" ] || WEB_URL="https://$WEB_HOST"
fi
# [WEB-GATE] With WEB_BASIC_AUTH_HASH set in deploy/.env the website's own name
# sits behind a password: a 401 IS it answering, and a page served to a
# stranger means the password is missing. The value is never printed.
WEB_GATE=off
if [ -f "$HERE/.env" ] && [ -n "$(grep -E '^WEB_BASIC_AUTH_HASH=' "$HERE/.env" | head -1 | cut -d= -f2- || true)" ]; then
  WEB_GATE=on
fi
if [ -n "${WEB_URL:-}" ]; then
  # On no response curl still writes 000 for %{http_code}; it just exits nonzero.
  SITE=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$WEB_URL/" 2>/dev/null || true)
  case "$WEB_GATE ${SITE:-000}" in
    "on 401")      ok "website $WEB_URL → 401 (password gate on)" ;;
    "on 2"*|"on 3"*) bad "website $WEB_URL answered $SITE without its password gate (WEB_BASIC_AUTH_HASH is set in deploy/.env)" ;;
    "off 2"*|"off 3"*) ok "website $WEB_URL → $SITE" ;;
    *" 000")       bad "website unreachable at $WEB_URL — WEB_HOST is set, so it should answer (DNS, certificate, or the web container)" ;;
    *)             bad "website $WEB_URL/ → $SITE" ;;
  esac
fi

# ── 3. Containers: up, and allowed to come back ─────────────────────────────
# macOS ships no `timeout`; a missing binary must never masquerade as a wedged
# docker (this script's own first live run made exactly that misdiagnosis).
bounded() { if command -v timeout >/dev/null 2>&1; then timeout 10 "$@"; else "$@"; fi; }

if command -v docker >/dev/null 2>&1; then
  # A wedged docker CLI is itself a known failure state — bound the wait where
  # the platform allows it.
  if bounded "${COMPOSE[@]}" ps >/dev/null 2>&1; then
    for c in postgres redis clamd; do
      ID="$(bounded "${COMPOSE[@]}" ps -q "$c" 2>/dev/null || true)"
      if [ -n "$ID" ] && [ "$(docker inspect -f '{{.State.Status}}' "$ID" 2>/dev/null || true)" = running ]; then
        POLICY=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$ID" 2>/dev/null || echo '?')
        if [ "$POLICY" = "no" ] || [ -z "$POLICY" ]; then
          warn "$c running but restart policy is '$POLICY' — it will NOT survive a reboot (docker update --restart unless-stopped $c)"
        else
          ok "$c running (restart=$POLICY)"
        fi
      else
        bad "$c is not running"
      fi
    done
  else
    bad "docker CLI not answering — the wedged-docker state; a hard Docker restart has fixed this before"
  fi
else
  warn "docker not installed here — container checks skipped"
fi

# ── 4. Databases: migrations are the truth, and the dev DB carries them ─────
db_query() {
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "$1"' \
    sh "$1"
}
if command -v docker >/dev/null 2>&1 && [ -n "$(bounded "${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)" ]; then
  MIG=$(db_query \
    "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" 2>/dev/null || echo "")
  if [ -z "$MIG" ]; then
    warn "Postgres has no applied migration record; verify migrate-deploy status"
  else
    ok "Postgres carries $MIG applied migrations"
  fi
  HB=$(db_query \
    "SELECT value FROM platform_config WHERE key='last_backup_at';" 2>/dev/null | tr -d '"' || true)
  if [ -z "$HB" ]; then
    warn "no backup heartbeat recorded in this database"
  else
    ok "last verified backup: $HB"
  fi
  # [D-3] A backup is a belief until it has been restored, with a stopwatch.
  # restore.sh records each rehearsal; this is where the number gets read.
  RH=$(db_query \
    "SELECT value FROM platform_config WHERE key='last_restore_rehearsal_at';" 2>/dev/null | tr -d '"' || true)
  RS=$(db_query \
    "SELECT value FROM platform_config WHERE key='last_restore_rehearsal_seconds';" 2>/dev/null | tr -d '"' || true)
  if [ -z "$RH" ]; then
    warn "restore never rehearsed here — the recovery time is unknown. Run: ./deploy/backup.sh && ./deploy/restore.sh --project swift deploy/backups/<latest>.dump (production dumps are encrypted: the owner runs deploy/backup-drill.sh from his own computer)"
  else
    ok "last restore rehearsal: $RH — took ${RS:-?}s (that is the recovery time for this data)"
  fi
  # [Off-site erasure ledger] An erasure not shipped off-site within 10 minutes: the backup is not
  # erasure-safe (a total loss of this database would bring the person back from the newest backup).
  LEDGER=$(db_query "SELECT to_regclass('public.erasure_ledger_entry') IS NOT NULL;" 2>/dev/null | tr -d '[:space:]' || true)
  if [ "$LEDGER" = t ]; then
    LATE=$(db_query "SELECT count(*) FROM erasure_ledger_entry e WHERE e.\"createdAt\" < now()::timestamp(3) - interval '10 minutes' AND NOT EXISTS (SELECT 1 FROM erasure_ledger_shipment s WHERE s.\"entryId\" = e.id);" 2>/dev/null | tr -d '[:space:]' || true)
    if [ -z "$LATE" ]; then
      bad "could not read the off-site erasure ledger"
    elif [ "$LATE" != 0 ]; then
      bad "$LATE erasure ledger entr(ies) older than 10 minutes have not reached the off-site ledger: check swift-erasure-ledger.timer (journalctl -u swift-erasure-ledger)"
    else
      ok "every erasure older than 10 minutes has reached the off-site ledger"
    fi
  fi
fi

# [BACKUP-ENC · Opus review 14 Oct, S3-2] Production backs up hourly (owner
# ruling, 13 Oct). The timer is installed by hand (PILOT-RUNBOOK §4), and a
# missing one is silent until the freshness alarm: say it here.
if [ -f "$HERE/.env" ] && [ "$(grep -E '^PILOT_ENV=' "$HERE/.env" | head -1 | cut -d= -f2- || true)" = production ]; then
  if systemctl is-enabled --quiet swift-backup-hourly.timer 2>/dev/null && systemctl is-active --quiet swift-backup-hourly.timer 2>/dev/null; then
    ok "the hourly backup timer is enabled and active"
  else
    bad "production's hourly backup timer (swift-backup-hourly.timer) is not enabled and active: sudo systemctl enable --now swift-backup-hourly.timer (PILOT-RUNBOOK §4)"
  fi
  if systemctl is-enabled --quiet swift-erasure-ledger.timer 2>/dev/null && systemctl is-active --quiet swift-erasure-ledger.timer 2>/dev/null; then
    ok "the off-site erasure ledger timer is enabled and active"
  else
    bad "production's off-site erasure ledger timer (swift-erasure-ledger.timer) is not enabled and active: sudo systemctl enable --now swift-erasure-ledger.timer (PILOT-RUNBOOK §4)"
  fi
fi

# [TA-S0-003 · R3] The business wall's contract posture (TENANT_RLS_BIND=1 in
# deploy/.env, which adds deploy/docker-compose.wall.yml): the API and the
# worker run on the two least-privilege logins, never on the owner. Read-only:
# the role contract through deploy/rls-logins.sh roles (reason codes only),
# and each container's settings by NAME (a value is never printed).
env_line() { [ -f "$HERE/.env" ] && grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true; }
if [ "$(env_line TENANT_RLS_BIND)" = 1 ]; then
  WALL_ROLES="$("$HERE/rls-logins.sh" roles 2>/dev/null | tail -1)"
  case "$WALL_ROLES" in
    *'"status": "roles_hold"'*) ok "the least-privilege logins hold their contract (rls-logins roles)" ;;
    *) bad "the least-privilege logins do not hold their contract: ${WALL_ROLES:-no answer} (deploy/rls-logins.sh roles; never repair a role by hand)" ;;
  esac
  if command -v docker >/dev/null 2>&1; then
    for c in api worker; do
      ID="$(bounded "${COMPOSE[@]}" ps -q "$c" 2>/dev/null || true)"
      if [ -z "$ID" ]; then warn "$c is not running; its database login was not checked"; continue; fi
      # Names whose value is set; the values themselves never leave awk.
      SET_NAMES=" $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$ID" 2>/dev/null |
        awk -F= 'index($0, "=") > 1 && substr($0, index($0, "=") + 1) != "" { print $1 }' | tr '\n' ' ')"
      has_name() { case "$SET_NAMES" in *" $1 "*) return 0 ;; esac; return 1; }
      if has_name POSTGRES_PASSWORD_FILE || has_name POSTGRES_PASSWORD; then
        bad "$c still carries the database owner's password setting under TENANT_RLS_BIND=1 (deploy/docker-compose.wall.yml removes it): redeploy with ./deploy/pilot-up.sh"
      elif has_name DATABASE_URL_FILE && has_name SYSTEM_DATABASE_URL_FILE; then
        ok "$c runs on the least-privilege logins (DATABASE_URL_FILE, SYSTEM_DATABASE_URL_FILE; no owner password)"
      else
        bad "$c does not carry DATABASE_URL_FILE and SYSTEM_DATABASE_URL_FILE under TENANT_RLS_BIND=1: redeploy with ./deploy/pilot-up.sh"
      fi
    done
  fi
elif [ "$(env_line PILOT_ENV)" = production ] && command -v docker >/dev/null 2>&1 &&
     [ -n "$(bounded "${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)" ]; then
  # After Phase C production never runs on the owner again (owner ruling, 14 Oct).
  WALL_LOGINS="$(db_query "SELECT count(*) FROM pg_roles WHERE rolname IN ('swift_app_login', 'swift_system_login');" 2>/dev/null || true)"
  if [ -n "$WALL_LOGINS" ] && [ "$WALL_LOGINS" != 0 ]; then
    bad "the least-privilege logins exist (Phase C has run) but deploy/.env does not set TENANT_RLS_BIND=1: production never goes back to the owner's login (owner ruling, 14 Oct)"
  fi
fi

# [item 20] The owner wall (swift_owner_wall + OWNER_RLS_BIND=1) is switched
# separately, after its own staging journey run — never with Phase C. Until
# then deploy/.env names no OWNER_RLS_BIND and no role is a member of
# swift_owner_wall: either half alone makes the API refuse to boot or every
# owner-walled read come back empty. Read-only; a count, never a name.
if [ -n "$(env_line OWNER_RLS_BIND)" ]; then
  bad "deploy/.env sets OWNER_RLS_BIND: the owner wall is switched separately, after its own staging journey run (not with Phase C); remove the line"
fi
if command -v docker >/dev/null 2>&1 && [ -n "$(bounded "${COMPOSE[@]}" ps -q postgres 2>/dev/null || true)" ]; then
  OWNER_WALL_MEMBERS="$(db_query "SELECT count(*) FROM pg_auth_members m JOIN pg_roles w ON w.oid = m.roleid WHERE w.rolname = 'swift_owner_wall';" 2>/dev/null || true)"
  case "$OWNER_WALL_MEMBERS" in
    "") ;;
    0) ok "no database role is a member of swift_owner_wall (the owner wall stays off)" ;;
    *) bad "$OWNER_WALL_MEMBERS database role(s) are members of swift_owner_wall: the owner wall is switched separately, after its own staging journey run; revoke the grant before any deploy" ;;
  esac
fi

# ── 5. The disk — the quietest killer on this machine's record ──────────────
DISK=$(df -h / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
if [ -n "${DISK:-}" ]; then
  if [ "$DISK" -ge 92 ]; then bad "disk at ${DISK}% — redis stops accepting writes near full, and it has";
  elif [ "$DISK" -ge 80 ]; then warn "disk at ${DISK}% — clean caches before it becomes tonight's outage";
  else ok "disk at ${DISK}%"; fi
fi

# ── 6. Supply-chain: the alerts everyone learns to scroll past ──────────────
if command -v gh >/dev/null 2>&1; then
  ALERTS=$(gh api repos/westbridge-inc/swift/dependabot/alerts --jq '[.[]|select(.state=="open")]|length' 2>/dev/null || echo "")
  if [ -z "$ALERTS" ]; then warn "gh present but Dependabot alerts unreadable (auth?)";
  elif [ "$ALERTS" = "0" ]; then ok "0 open Dependabot alerts";
  else warn "$ALERTS open Dependabot alert(s) — ambient warnings train you to ignore the one that matters"; fi
else
  warn "gh CLI absent — Dependabot check skipped"
fi

echo "──────────────────────────────────────────────"
echo "ok=$PASS warn=$WARN fail=$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
