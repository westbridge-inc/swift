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

set -uo pipefail

API_URL="${API_URL:-http://localhost:3000}"
PG_CONTAINER="${PG_CONTAINER:-swift-postgres}"
PG_USER="${PG_USER:-swift}"
DEV_DB="${DEV_DB:-swift}"

PASS=0; WARN=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok    %s\n' "$1"; }
warn() { WARN=$((WARN+1)); printf '  WARN  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }

echo "Swift doctor — $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "──────────────────────────────────────────────"

# ── 1. The API, from the outside ────────────────────────────────────────────
HEALTH=$(curl -fsS -m 8 "$API_URL/health" 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  bad "API unreachable at $API_URL — nothing below it can be healthy for users"
else
  case "$HEALTH" in
    *'"database":"ok"'*) ok "API + database answering" ;;
    *) bad "API up but database check not ok: $HEALTH" ;;
  esac
  case "$HEALTH" in
    *'"redis":"ok"'*) ok "redis answering" ;;
    *) bad "redis check not ok" ;;
  esac
fi

# ── 2. The canary — the first surface to die on client-vs-DB skew ───────────
# Default selects over vendors+items: a schema column the dev DB lacks kills
# this before it kills anything else, and it is exactly what the phone shows.
CANARY=$(curl -s -o /dev/null -w '%{http_code}' -m 8 "$API_URL/api/v1/customer/home" 2>/dev/null || echo 000)
case "$CANARY" in
  200) ok "canary /customer/home → 200" ;;
  000) warn "canary unreachable (API down above?)" ;;
  5*)  bad "canary /customer/home → $CANARY — likely schema/client skew: run 'prisma db push' against the dev DB" ;;
  *)   warn "canary /customer/home → $CANARY (auth/config, not skew)" ;;
esac

# ── 3. Containers: up, and allowed to come back ─────────────────────────────
# macOS ships no `timeout`; a missing binary must never masquerade as a wedged
# docker (this script's own first live run made exactly that misdiagnosis).
bounded() { if command -v timeout >/dev/null 2>&1; then timeout 10 "$@"; else "$@"; fi; }

if command -v docker >/dev/null 2>&1; then
  # A wedged docker CLI is itself a known failure state — bound the wait where
  # the platform allows it.
  if PS_OUT=$(bounded docker ps --format '{{.Names}}' 2>/dev/null); then
    for c in "$PG_CONTAINER" swift-redis; do
      if printf '%s\n' "$PS_OUT" | grep -qx "$c"; then
        POLICY=$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$c" 2>/dev/null || echo '?')
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
if command -v docker >/dev/null 2>&1 && bounded docker ps >/dev/null 2>&1; then
  MIG=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DEV_DB" -tAc \
    "SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;" 2>/dev/null || echo "")
  if [ -z "$MIG" ]; then
    warn "dev DB '$DEV_DB' has NO _prisma_migrations — it was built by db push, so triggers/CHECKs are missing and constraint tests will lie here"
  else
    ok "dev DB carries $MIG applied migrations"
  fi
  HB=$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$DEV_DB" -tAc \
    "SELECT value FROM platform_config WHERE key='last_backup_at';" 2>/dev/null | tr -d '"' || true)
  if [ -z "$HB" ]; then
    warn "no backup heartbeat recorded in this DB (fine for dev; a FAIL on a server)"
  else
    ok "last verified backup: $HB"
  fi
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
