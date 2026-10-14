#!/usr/bin/env bash
# Single-host cutover, for the STAGING or the PRODUCTION host (PILOT_ENV in
# deploy/.env). Invoke with an approved full origin/main SHA.
# This script intentionally stops the old API/worker before migration. When
# deploy/.env sets WEB_HOST it also builds and serves the website (apps/web)
# for the same SHA, behind an optional password; without WEB_HOST it does
# nothing more. ADMIN_HOST does the same for the admin console (apps/admin),
# behind an optional second gate.
#
#   ./deploy/pilot-up.sh <sha>               the whole stack
#   ./deploy/pilot-up.sh --data-only <sha>   [PROD-PATH] the database only:
#       every check below, then Postgres, Redis, search and routing up and the
#       migrations applied. The API, worker, website, console and Caddy are
#       never started, stopped or replaced — refused outright while an API or
#       worker is running. For a new host before its provider credentials and
#       its DNS exist: migrate, back up, rehearse a restore, seed.
#   ./deploy/pilot-up.sh --no-public <sha>   [PROD-PATH] production only: the
#       first boot before DNS moves. Every check below except DNS, then the
#       migrations and the API and worker, ready inside the private network.
#       Caddy, the website and the console are never started (nothing is
#       public); refused while Caddy is running.
#
# [PROD-PATH] PILOT_ENV=production adds production-only refusals, each before
# the stack changes (all but the backup-key check also before the checkout
# moves; that one reads the store after the switch to the requested SHA, before
# any store restart or Docker change): NODE_ENV must be production; no served name may be a
# staging name; documents in object storage, never on this disk; the backup
# keys in the store; no unfilled site details; and, for the whole stack, every
# served name must already resolve to THIS host (Caddy obtains certificates
# for them, and the public names stay on the old host until DNS moves).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DATA_ONLY=0
NO_PUBLIC=0
PLACES_PHOTON=0
if [ "${1:-}" = "--data-only" ]; then DATA_ONLY=1; shift;
elif [ "${1:-}" = "--no-public" ]; then NO_PUBLIC=1; shift; fi
SHA="${1:-}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
ROUTING=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.routing.yml")

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}

# A setting as Compose reads it: an unquoted value ends before " #".
env_setting() {
  env_value "$1" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "pass a full 40-character git commit SHA"
[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
[ -f "$HERE/.env" ] || die "deploy/.env is missing"
# [PROD-PATH] One reading of deploy/.env. Compose takes the LAST of two lines
# for the same name and honours `export NAME=` lines; every check here reads
# the first plain `NAME=` line. So the file must be plain: each line blank, a
# comment, or `NAME=value` at the start of the line, and each name once.
# Anything else is refused (the line number or name, never a value).
env_shape="$(awk '{ l = $0; sub(/^[ \t]+/, "", l); if (l == "" || substr(l, 1, 1) == "#") next
  if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) { print "line " NR " is not a plain NAME=value setting (no export, no indentation)"; exit }
  k = $0; sub(/=.*/, "", k); if (seen[k]++) { print k " is set twice (Compose would take the last)"; exit } }' "$HERE/.env")"
[ -z "$env_shape" ] || die "deploy/.env: $env_shape; fix the file so it has one plain setting per name"
# [PROD-PATH] One configuration. Compose fills every ${NAME} in its files
# from THIS shell before deploy/.env, but every check below reads deploy/.env.
# A name exported here (NODE_ENV=development, WEB_HOST, …) would make Compose
# run what no check saw, so it is refused. SWIFT_TAG and SWIFT_WEB_CHANNEL are
# set by this script itself; the COMPOSE_* switches change what Compose runs.
compose_names="$(cat "$HERE/docker-compose.yml" "$HERE/docker-compose.routing.yml" |
  grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' | sed 's/^..//' | sort -u)"
for name in $compose_names COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE COMPOSE_ENV_FILES; do
  case "$name" in SWIFT_TAG | SWIFT_WEB_CHANNEL) continue ;; esac
  [ -z "${!name+set}" ] ||
    die "$name is set in this shell, and Compose would use it instead of deploy/.env (which every check here reads); unset it, or run from a clean shell"
done
# [PROD-PATH] One Docker: this host's own daemon. DOCKER_HOST, DOCKER_CONTEXT or
# DOCKER_CONFIG in this shell would point every docker call below — the checks
# and the deploy alike — at another daemon (another machine's stack).
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG; do
  [ -z "${!name+set}" ] ||
    die "$name is set in this shell, and Docker would act on another daemon than this host's; unset it, or run from a clean shell"
done
PILOT_ENV="$(env_value PILOT_ENV)"
case "$PILOT_ENV" in
  staging | production) ;;
  *) die "PILOT_ENV must be staging or production" ;;
esac
[ "$NO_PUBLIC" -eq 0 ] || [ "$PILOT_ENV" = production ] ||
  die "--no-public is for the production host (the first boot before its DNS moves); a staging host deploys the whole stack"
API_HOST="$(env_value API_HOST)"
[[ "$API_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] ||
  die "API_HOST must be a DNS hostname for $PILOT_ENV HTTPS"
[ "$API_HOST" != localhost ] || die "API_HOST cannot be localhost"
# [Q11] The website is optional: a DNS name in WEB_HOST turns it on, and every
# Compose call below then includes its profile (so the port and isolation
# checks cover it too). Without WEB_HOST nothing below changes.
WEB_HOST="$(env_value WEB_HOST)"
if [ -n "$WEB_HOST" ]; then
  [[ "$WEB_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] ||
    die "WEB_HOST must be a DNS hostname for staging HTTPS, or empty for no website"
  [ "$(printf '%s' "$WEB_HOST" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$API_HOST" | tr '[:upper:]' '[:lower:]')" ] ||
    die "WEB_HOST must differ from API_HOST"
  COMPOSE+=(--profile web)
fi
# [STORE-1] Optional second API name (the store build's fixed API name while no
# production stack exists). Same shape rules as API_HOST, and it must be neither
# the primary API name nor the website's: a website name in the API matcher
# would serve the API in place of the site.
API_ALIAS_HOST="$(env_value API_ALIAS_HOST)"
if [ -n "$API_ALIAS_HOST" ]; then
  [[ "$API_ALIAS_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] ||
    die "API_ALIAS_HOST must be a DNS hostname for HTTPS, or empty for no alias"
  alias_lc="$(printf '%s' "$API_ALIAS_HOST" | tr '[:upper:]' '[:lower:]')"
  [ "$alias_lc" != "$(printf '%s' "$API_HOST" | tr '[:upper:]' '[:lower:]')" ] ||
    die "API_ALIAS_HOST must differ from API_HOST"
  [ -z "$WEB_HOST" ] || [ "$alias_lc" != "$(printf '%s' "$WEB_HOST" | tr '[:upper:]' '[:lower:]')" ] ||
    die "API_ALIAS_HOST must differ from WEB_HOST"
fi
# [Item 8] Optional extra names for the WEBSITE (the public apex and www while no
# production stack exists), space-separated. Same shape rules as the other
# names; none may be the API's, the API alias's or the website's own name, nor
# repeat: a website name in the API matcher would serve the API in place of the
# site. They name the website, so they need it. Split without globbing.
WEB_ALIAS_HOSTS="$(env_value WEB_ALIAS_HOSTS)"
if [ -n "$WEB_ALIAS_HOSTS" ]; then
  [ -n "$WEB_HOST" ] || die "WEB_ALIAS_HOSTS needs WEB_HOST: the aliases name the website, which is off without it"
  lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
  read -r -a web_aliases <<< "$WEB_ALIAS_HOSTS"
  seen=" "
  for web_alias in "${web_aliases[@]}"; do
    [[ "$web_alias" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] ||
      die "WEB_ALIAS_HOSTS must be DNS hostnames for HTTPS separated by spaces, or empty for none"
    web_alias_lc="$(lower "$web_alias")"
    [ "$web_alias_lc" != "$(lower "$API_HOST")" ] || die "WEB_ALIAS_HOSTS must differ from API_HOST"
    [ -z "$API_ALIAS_HOST" ] || [ "$web_alias_lc" != "$(lower "$API_ALIAS_HOST")" ] ||
      die "WEB_ALIAS_HOSTS must differ from API_ALIAS_HOST"
    [ "$web_alias_lc" != "$(lower "$WEB_HOST")" ] || die "WEB_ALIAS_HOSTS must differ from WEB_HOST"
    case "$seen" in *" $web_alias_lc "*) die "WEB_ALIAS_HOSTS must not repeat a name" ;; esac
    seen="$seen$web_alias_lc "
  done
fi
# [Item 7 · S1] The website's pre-launch switch, read by the site while it runs
# (not baked into its build): `live`, or nothing (the public site shows the
# "Launching soon" front door). A near miss such as `Live` would quietly keep
# the public site closed, so it is refused.
case "$(env_value WEB_ORDERING)" in
  "" | live) ;;
  *) die "WEB_ORDERING must be live or empty" ;;
esac
[ "$(env_value MAPS_PROVIDER)" = osrm ] || die "pilot requires MAPS_PROVIDER=osrm"
[ "$(env_value OSRM_URL)" = http://osrm:5000 ] || die "OSRM_URL must use the private routing service"
# Secrets are not in this file (the encrypted store holds them; checked below
# against the exact revision being deployed). The database password is
# percent-encoded by the app when it assembles DATABASE_URL, so it no longer
# has to be URL-safe.
[ -n "$(env_value BACKUP_BUCKET)" ] || die "BACKUP_BUCKET is missing"
[ -f "$HERE/routing-data/osrm/guyana-latest.osrm" ] ||
  die "OSRM extract is missing; run deploy/setup-routing.sh first"
# [ADMIN-CONSOLE] The admin console is optional: a DNS name in ADMIN_HOST turns
# it on, and every Compose call below then includes its profile. Same shape
# rules as the other names, and it is none of them (case-insensitive): its
# route comes first in the Caddyfile, so a shared name would hand that name to
# the console. The website's extra names (WEB_ALIAS_HOSTS, space-separated)
# count too. The console signs in with the API's cookies, which the API honours
# only from an origin in CORS_ORIGIN, so that must name it.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
ADMIN_HOST="$(env_value ADMIN_HOST)"
ADMIN_BASIC_AUTH_HASH="$(env_value ADMIN_BASIC_AUTH_HASH)"
if [ -n "$ADMIN_HOST" ]; then
  [[ "$ADMIN_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] ||
    die "ADMIN_HOST must be a DNS hostname for HTTPS, or empty for no admin console"
  admin_lc="$(lower "$ADMIN_HOST")"
  [ "$admin_lc" != "$(lower "$API_HOST")" ] || die "ADMIN_HOST must differ from API_HOST"
  [ -z "$API_ALIAS_HOST" ] || [ "$admin_lc" != "$(lower "$API_ALIAS_HOST")" ] ||
    die "ADMIN_HOST must differ from API_ALIAS_HOST"
  [ -z "$WEB_HOST" ] || [ "$admin_lc" != "$(lower "$WEB_HOST")" ] || die "ADMIN_HOST must differ from WEB_HOST"
  read -r -a web_alias_names <<< "$WEB_ALIAS_HOSTS"
  for web_alias_name in "${web_alias_names[@]+"${web_alias_names[@]}"}"; do
    [ "$admin_lc" != "$(lower "$web_alias_name")" ] || die "ADMIN_HOST must differ from WEB_ALIAS_HOSTS"
  done
  # Entries are compared whole: scheme, name and port, without spaces, quotes
  # or a trailing slash (the API normalises those the same way).
  cors_origins=",$(env_value CORS_ORIGIN | tr -d " \t\"'" | tr '[:upper:]' '[:lower:]' | sed 's#/,#,#g; s#/$##'),"
  case "$cors_origins" in
    *",https://$admin_lc,"*) ;;
    *) die "CORS_ORIGIN must include https://$ADMIN_HOST: the console signs in with the API's cookies, which the API honours only from an allowed origin" ;;
  esac
  COMPOSE+=(--profile admin)
fi
# The optional gates (the console's second gate, the website's password) are
# each a bcrypt hash of cost 10 or more, in single quotes (unquoted, Compose
# would read its `$` signs as variables). A refusal names the setting, never
# its value.
bcrypt_re='^[$]2[aby][$](1[0-9]|2[0-9]|3[01])[$][./A-Za-z0-9]{53}$'
quoted_bcrypt() {
  local inner=""
  case "$1" in
    \'*\') inner="${1:1:${#1}-2}" ;;
  esac
  [[ "$inner" =~ $bcrypt_re ]]
}
if [ -n "$ADMIN_BASIC_AUTH_HASH" ]; then
  [ -n "$ADMIN_HOST" ] ||
    die "ADMIN_BASIC_AUTH_HASH needs ADMIN_HOST: the gate stands in front of the admin console, which is off without it"
  quoted_bcrypt "$ADMIN_BASIC_AUTH_HASH" ||
    die "ADMIN_BASIC_AUTH_HASH must be a bcrypt hash of cost 10 or more in single quotes (see PILOT-RUNBOOK.md 3d), or empty for no gate"
fi
# [WEB-GATE] The optional password in front of the website's own name
# (WEB_HOST only; the public names stay open). It stands in front of the
# website, so it needs WEB_HOST.
WEB_BASIC_AUTH_HASH="$(env_value WEB_BASIC_AUTH_HASH)"
if [ -n "$WEB_BASIC_AUTH_HASH" ]; then
  [ -n "$WEB_HOST" ] ||
    die "WEB_BASIC_AUTH_HASH needs WEB_HOST: the password stands in front of the website, which is off without it"
  quoted_bcrypt "$WEB_BASIC_AUTH_HASH" ||
    die "WEB_BASIC_AUTH_HASH must be a bcrypt hash of cost 10 or more in single quotes (see PILOT-RUNBOOK.md 3e), or empty for no password"
fi
# [PROD-PATH] A name a production stack serves, links to or trusts is never a
# staging name, nor a test-environment one: a label that is (or starts) uat,
# test, sandbox, dev, qa or demo.
production_name() {
  case "$(lower "$1")" in
    *staging*) die "PILOT_ENV=production refuses the staging name $1: a production stack never answers a staging name" ;;
  esac
  read -r -a name_labels <<< "$(lower "$1" | tr '.' ' ')"
  for name_label in "${name_labels[@]}"; do
    case "$name_label" in
      uat | uat-* | uat[0-9]* | test | test-* | test[0-9]* | testing | sandbox | sandbox-* | dev | dev-* | dev[0-9]* | qa | qa-* | demo | demo-*)
        die "PILOT_ENV=production refuses the test-environment name $1" ;;
    esac
  done
}
# [PROD-PATH] The production host's own refusals. Each names its setting and
# runs before anything changes; staging is exactly as it was.
if [ "$PILOT_ENV" = production ]; then
  [ "$(env_setting NODE_ENV)" = production ] ||
    die "PILOT_ENV=production needs NODE_ENV=production: the production host never runs a development, loadtest or test posture"
  read -r -a served_names <<< "$API_HOST $API_ALIAS_HOST $WEB_HOST $WEB_ALIAS_HOSTS $ADMIN_HOST"
  for served_name in "${served_names[@]}"; do production_name "$served_name"; done
  # The public origins the API hands out and trusts: https, a public DNS name
  # (no localhost, no address, no wildcard, no path), never staging or test.
  https_origin_re='^https://([a-zA-Z0-9][a-zA-Z0-9.-]*[.][a-zA-Z]{2,})(:[0-9]{1,5})?/?$'
  # API_PUBLIC_URL: storage links and card return pages are built from it.
  api_public_url="$(env_setting API_PUBLIC_URL)"
  [[ "$api_public_url" =~ $https_origin_re ]] && [ -z "${BASH_REMATCH[2]}" ] && [ "$(lower "${BASH_REMATCH[1]}")" = "$(lower "$API_HOST")" ] ||
    die "PILOT_ENV=production needs API_PUBLIC_URL=https://$API_HOST: storage links and card return pages are built from it"
  # APP_PUBLIC_URL: every printed QR code and trip-share link names it.
  app_public_url="$(env_setting APP_PUBLIC_URL)"
  [[ "$app_public_url" =~ $https_origin_re ]] && [ -z "${BASH_REMATCH[2]}" ] ||
    die "PILOT_ENV=production needs APP_PUBLIC_URL to be the public website's https:// origin (printed QR codes and trip-share links name it)"
  production_name "${BASH_REMATCH[1]}"
  # CORS_ORIGIN: the browser origins allowed to call the API with its cookies.
  cors_setting="$(env_setting CORS_ORIGIN | tr -d " \t\"'")"
  [ -n "$cors_setting" ] || die "PILOT_ENV=production needs CORS_ORIGIN: the https:// origins allowed to call the API"
  IFS=',' read -r -a cors_entries <<< "$cors_setting"
  for cors_entry in "${cors_entries[@]}"; do
    [ -n "$cors_entry" ] || continue
    [[ "$cors_entry" =~ $https_origin_re ]] ||
      die "PILOT_ENV=production refuses the CORS_ORIGIN entry $cors_entry: only https:// origins of public names (no http, localhost, address or wildcard)"
    production_name "${BASH_REMATCH[1]}"
  done
  case "$(env_setting STORAGE_PROVIDER)" in
    s3 | r2) ;;
    *) die "PILOT_ENV=production needs STORAGE_PROVIDER=s3 or r2: identity documents never live on this disk" ;;
  esac
  case "$(env_setting STORAGE_ALLOW_LOCAL)" in
    "" | 0) ;;
    *) die "PILOT_ENV=production refuses STORAGE_ALLOW_LOCAL: identity documents never live on this disk" ;;
  esac
  case "$(env_setting WEB_ALLOW_SITE_TOKENS)" in
    "" | 0) ;;
    *) die "PILOT_ENV=production refuses WEB_ALLOW_SITE_TOKENS: the public site never shows unfilled company details" ;;
  esac
  # [BACKUP-ENC] Owner ruling, 13 Oct: production backups leave the host only
  # encrypted to the owner's PUBLIC key (deploy/backup.sh). The key file lives
  # outside the checkout and its fingerprint is pinned here; backup.sh proves
  # the file holds exactly that one public key before every dump.
  [[ "$(env_setting BACKUP_GPG_FINGERPRINT)" =~ ^[0-9A-F]{40}$ ]] ||
    die "PILOT_ENV=production needs BACKUP_GPG_FINGERPRINT (the owner's backup key fingerprint, 40 upper-case hex): production backups are encrypted to the owner's key (owner ruling, 13 Oct)"
  backup_recipient="$(env_setting BACKUP_GPG_RECIPIENT_FILE)"
  [[ "$backup_recipient" == /* ]] && [[ "$backup_recipient" != "$ROOT"/* ]] ||
    die "PILOT_ENV=production needs BACKUP_GPG_RECIPIENT_FILE: an absolute path to the owner's exported PUBLIC backup key, outside the checkout"
  # [S3-2] The freshness alarm (modules/ops/backup-freshness.ts) defaults to
  # 26 hours, a nightly cadence. Production backs up hourly (owner ruling #12,
  # 13 Oct): two missed runs must page, not a day of them.
  [[ "$(env_setting BACKUP_MAX_AGE_HOURS)" =~ ^[1-3]$ ]] ||
    die "PILOT_ENV=production needs BACKUP_MAX_AGE_HOURS=1, 2 or 3: the backup freshness alarm must match the hourly backups (owner ruling, 13 Oct)"
  # Owner ruling, 8 Oct: production launches with admin top-ups ON HOLD. The
  # API refuses every manual credit of fee paid ahead (503 TOPUP_ON_HOLD,
  # nothing recorded) exactly when BILLING_TOPUP_HOLD=1, read from this file.
  [ "$(env_setting BILLING_TOPUP_HOLD)" = 1 ] ||
    die "PILOT_ENV=production needs BILLING_TOPUP_HOLD=1: admin top-ups stay on hold in production (owner ruling, 8 Oct)"
  # Partners pay the weekly fee only on the MMG checkout page, never through an
  # agent or a Swift Number. The agent-cash webhook answers 503 while its
  # secret is unset, so production never sets it (named, never echoed).
  for agent_cash_name in AGENT_CASH_WEBHOOK_SECRET AGENT_CASH_WEBHOOK_SECRET_FILE; do
    [ -z "$(env_setting "$agent_cash_name")" ] ||
      die "PILOT_ENV=production refuses the agent-cash webhook ($agent_cash_name is set): partners pay the weekly fee only on the MMG checkout page"
  done
  # [LAUNCH-LOCK] Owner ruling, 13 Oct: until an attorney signs off,
  # production takes no card payment and runs no ads. The API's boot guard
  # refuses the same settings (boot-config.ts assertProductionLaunchLocks);
  # turning either on is a reviewed code change in both, never an .env edit.
  [ "$(env_setting PAYMENT_PROVIDER)" = disabled ] ||
    die "PILOT_ENV=production needs PAYMENT_PROVIDER=disabled: no card payment until an attorney signs off (owner ruling, 13 Oct)"
  [ "$(env_setting CARD_RAIL_KILL)" = 1 ] ||
    die "PILOT_ENV=production needs CARD_RAIL_KILL=1: no card payment until an attorney signs off (owner ruling, 13 Oct)"
  for locked_name in CARD_RAIL_V2 CARD_RAIL_V2_DRAIN CARD_RAIL_ENROLL ADS_ENABLED; do
    case "$(env_setting "$locked_name")" in
      "" | 0) ;;
      *) die "PILOT_ENV=production refuses $locked_name unless it is unset or 0: no card payment and no ads until an attorney signs off (owner ruling, 13 Oct)" ;;
    esac
  done
  # Address search (the API refuses to boot in production without a provider,
  # #1563): osm, the private Photon service this script then starts, or
  # google, the owner's key in the encrypted store. Which one is the owner's
  # decision. Only a stage that starts the API asks; --data-only does not.
  if [ "$DATA_ONLY" -eq 0 ]; then
    case "$(env_setting PLACES_PROVIDER)" in
      osm)
        [ "$(env_setting PHOTON_URL)" = http://photon:2322 ] ||
          die "PLACES_PROVIDER=osm needs PHOTON_URL=http://photon:2322: the private Photon service (geocoding profile) this script starts"
        ROUTING+=(--profile geocoding)
        PLACES_PHOTON=1 ;;
      google)
        [ "$(env_setting GOOGLE_MAPS_API_KEY_BACKEND_FILE)" = /run/secrets/GOOGLE_MAPS_API_KEY_BACKEND ] ||
          die "PLACES_PROVIDER=google needs GOOGLE_MAPS_API_KEY_BACKEND_FILE=/run/secrets/GOOGLE_MAPS_API_KEY_BACKEND: the owner's key, in the encrypted store" ;;
      *)
        die "PILOT_ENV=production needs PLACES_PROVIDER=osm or google (the owner's choice): production has no local-only address search" ;;
    esac
  fi
fi
for tool in git docker curl python3; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
# [PROD-PATH] The production stack obtains certificates for every name it
# serves, so each must already resolve to this host. Until DNS moves, the
# public names still reach the old host: starting here would fail its own
# readiness check after stopping nothing, or worse, after a migration. IPv6
# counts too: an AAAA record left on the old host sends IPv6 clients — and the
# certificate authority, which prefers IPv6 — elsewhere. The database-only
# stage serves nothing and needs no name.
if [ "$PILOT_ENV" = production ] && [ "$DATA_ONLY" -eq 0 ] && [ "$NO_PUBLIC" -eq 0 ]; then
  for tool in getent hostname; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
  host_addresses=" $(hostname -I 2>/dev/null | tr '[:upper:]' '[:lower:]' || true) "
  read -r -a served_names <<< "$API_HOST $API_ALIAS_HOST $WEB_HOST $WEB_ALIAS_HOSTS $ADMIN_HOST"
  for served_name in "${served_names[@]}"; do
    resolved="$(getent ahostsv4 "$served_name" 2>/dev/null | awk '{print $1}' | sort -u || true)"
    [ -n "$resolved" ] || die "$served_name does not resolve yet; point its DNS at this host before the production stack starts (the database-only stage needs none: --data-only)"
    # Query AAAA even on IPv4-only hosts: getent otherwise uses AI_ADDRCONFIG
    # and hides the stale IPv6 answers this guard must detect. A missing name
    # (2) is allowed; an unsupported option/resolver command failure is not.
    dns6_status=0
    resolved6="$(getent --no-addrconfig ahostsv6 "$served_name" 2>/dev/null)" || dns6_status=$?
    case "$dns6_status" in
      0 | 2) ;;
      *) die "cannot check $served_name IPv6 addresses without address-family filtering; getent --no-addrconfig is required" ;;
    esac
    resolved6="$(printf '%s\n' "$resolved6" | awk '{print tolower($1)}' | grep -v '^::ffff:' | sort -u || true)"
    # The refusal names the record, never the address: deploy logs are kept
    # as stand-up evidence, which carries no addresses (#1448 review).
    for address in $resolved; do
      case "$host_addresses" in
        *" $address "*) ;;
        *) die "$served_name has an IPv4 (A) address that is not this host; move its DNS here before the production stack starts (the database-only stage needs none: --data-only)" ;;
      esac
    done
    for address in $resolved6; do
      case "$host_addresses" in
        *" $address "*) ;;
        *) die "$served_name has an IPv6 (AAAA) address that is not this host; move its DNS here or remove the stale AAAA record before the production stack starts (the database-only stage needs none: --data-only)" ;;
      esac
    done
  done
fi
# [PROD-PATH] And Docker's own persisted choice of daemon (docker context use)
# is this host's: every call below acts on the daemon the checks above vouch for.
# [BACKUP-ENC · Opus review 14 Oct] Two read-only proofs, after the name
# checks and before anything changes.
# S3-3: the backup key file itself exists and holds exactly the pinned public
# key and no private key. The proof is backup.sh's own (the one every dump
# runs), read from the same raw deploy/.env lines systemd hands the backup
# unit, where an inline comment is part of the value. Without it a deploy went
# green and every hourly backup then failed.
# S3-2: the one-hour recovery point rests on the hourly timer (PILOT-RUNBOOK
# §4). A stage that starts the API needs it enabled and running; the
# database-only stage comes before it is installed.
if [ "$PILOT_ENV" = production ]; then
  env -u BACKUP_GPG_RECIPIENT_FILE -u BACKUP_GPG_FINGERPRINT -u PILOT_ENV "$HERE/backup.sh" --check-key >/dev/null ||
    die "PILOT_ENV=production: the backup key file is not the owner's pinned public key (backup.sh --check-key refused it; its reason is above)"
  if [ "$DATA_ONLY" -eq 0 ]; then
    systemctl is-enabled --quiet swift-backup-hourly.timer && systemctl is-active --quiet swift-backup-hourly.timer ||
      die "PILOT_ENV=production needs the hourly backup timer enabled and active before the API starts (sudo systemctl enable --now swift-backup-hourly.timer; PILOT-RUNBOOK §4)"
  fi
fi
if [ "$PILOT_ENV" = production ]; then
  [ "$(docker context show 2>/dev/null || true)" = default ] ||
    die "docker's current context is not this host's own daemon (default); run: docker context use default"
fi

cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] ||
  die "checkout has local changes; refusing to change the revision"
git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main ||
  die "the requested SHA is not on current origin/main"
git switch --detach "$SHA"
[ "$(git rev-parse HEAD)" = "$SHA" ] || die "checkout differs from requested SHA"
export SWIFT_TAG="$SHA"
# [PROD-PATH] The website's build channel follows the host: the staging site
# calls the staging API, the production site the production API, and the
# site's own origin law refuses any other pairing at build time.
export SWIFT_WEB_CHANNEL="$PILOT_ENV"

# ── secrets store checks (begin) ──────────────────────────────────────────
# Secrets never live in deploy/.env: the encrypted host store holds them
# (deploy/swift-secrets) and swift-secrets.service materializes them on tmpfs
# for the containers. Graded against THIS revision's allowlist and Compose file.
. "$HERE/secret-names.sh"
SECRET_NAMES="$(secret_allowlist "$ROOT")" ||
  die "could not read the secret allowlist from apps/api/src/utils/secret-files.ts"
# Every spelling Compose would load counts as a declaration — bare, indented
# by any Unicode whitespace, after a file-leading BOM, `export`-prefixed, with
# `=` or `:`, or a bare NAME passed through from this shell — and so do the
# aliases the images read (PGPASSWORD, MEILI_MASTER_KEY). One reader, one call.
DECLARED="$(env_file_declared_names "$HERE/.env" $SECRET_NAMES $SECRET_CONSUMER_ALIASES)"
if [ -n "$DECLARED" ]; then
  name="${DECLARED%%$'\n'*}"
  die "$name is declared in deploy/.env; secrets belong in the encrypted store (sudo swift-secrets set $name) and are wired as ${name}_FILE"
fi
STORE_BIN="$(command -v swift-secrets || true)"
[ -n "$STORE_BIN" ] || STORE_BIN="$HERE/swift-secrets"
[ -x "$STORE_BIN" ] || die "swift-secrets is not installed (install -m 0755 -o root -g root deploy/swift-secrets /usr/local/sbin/swift-secrets)"
# The store's parent (/etc/credstore.encrypted) is root-only (0700, the systemd
# default), so the list runs through sudo like the restart below; an unreadable
# store fails loudly rather than reading as empty.
STORED="$(sudo -n "$STORE_BIN" list)" || die "swift-secrets list failed (it reads the root-only credential store through sudo -n)"
# Everything wired as NAME_FILE — hardwired in Compose or switched on in .env —
# must be in the store, or the app refuses to boot after the old one is stopped.
WIRED="$({
  grep -oE '^[[:space:]]+[A-Z][A-Z0-9_]*_FILE: /run/secrets/[A-Z][A-Z0-9_]*' "$HERE/docker-compose.yml" || true
  grep -oE '^[A-Z][A-Z0-9_]*_FILE=/run/secrets/[A-Z][A-Z0-9_]*' "$HERE/.env" || true
} | sed -E 's#.*/run/secrets/##' | sort -u)"
for name in $WIRED; do
  grep -qx "$name" <<< "$STORED" ||
    die "$name is wired as ${name}_FILE but is not in the encrypted store; run: sudo swift-secrets set $name"
done
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if ! grep -qx "$name" <<< "$STORED"; then
    # [PROD-PATH] Production never runs a day without its off-site backup.
    [ "${PILOT_ENV:-}" != production ] ||
      die "$name is not in the encrypted store; production never runs without its off-site backup keys (sudo swift-secrets set $name)"
    echo "WARNING: $name is not in the encrypted store; the nightly backup unit (BACKUP_REQUIRED=1) fails until it is" >&2
  fi
done
# Fresh files for this deploy, and proof the unit is installed.
sudo -n systemctl restart swift-secrets.service ||
  die "swift-secrets.service could not materialize the store; inspect: sudo systemctl status swift-secrets.service"
# ── secrets store checks (end) ────────────────────────────────────────────

docker network inspect swift-pilot-private >/dev/null 2>&1 ||
  docker network create --driver bridge swift-pilot-private >/dev/null
[ "$(docker network inspect -f '{{.Driver}}' swift-pilot-private)" = bridge ] ||
  die "swift-pilot-private is not a bridge network"
"${COMPOSE[@]}" config --quiet
"${ROUTING[@]}" config --quiet
verify_private_ports() {
  "${COMPOSE[@]}" config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
def ports(name):
    return {(str(p.get("published")), str(p.get("target")), p.get("protocol", "tcp")) for p in s[name].get("ports", [])}
required = {("80", "80", "tcp"), ("443", "443", "tcp")}
if "caddy" not in s or ports("caddy") != required or any(ports(n) for n in s if n != "caddy"):
    sys.exit("refusing Compose configuration with non-proxy public ports")
' || die "main Compose port isolation failed"
  "${ROUTING[@]}" config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
if "osrm" not in s or any(x.get("ports") for x in s.values()):
    sys.exit("refusing routing configuration with public ports")
' || die "routing Compose port isolation failed"
  # [PROD-PATH] Production never hosts journeys, so the staging-only override
  # is never rendered there: its api-journeys extends the public api and
  # inherits this host's NODE_ENV (production), so --require-journeys (which
  # demands loadtest) could never pass and production could never stand up.
  # Instead, prove none of it is in production's configuration: no Compose
  # command here names the override or its profile, the rendered stack holds
  # neither journey service, and the Caddyfile routes to neither.
  if [ "$PILOT_ENV" = production ]; then
    for compose_arg in "${COMPOSE[@]}" "${ROUTING[@]}"; do
      case "$compose_arg" in
        journeys | *docker-compose.journeys.yml)
          die "PILOT_ENV=production: a Compose command here names the journeys override or profile; production never hosts journeys" ;;
      esac
    done
    "${COMPOSE[@]}" config --format json |
      python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" --forbid-journeys >/dev/null ||
      die "production journeys exclusion failed"
  fi
  # The public API never carries DEV_OTP_BYPASS or TEST_CONTROL_ENABLED (every
  # host), and on staging the journeys override (api-journeys + the one-shot
  # runner) never publishes a port, leaves the private network or gets a Caddy
  # route.
  "${COMPOSE[@]}" config --format json |
    python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" >/dev/null ||
    die "public API isolation failed"
  if [ "$PILOT_ENV" != production ] && [ -f "$HERE/docker-compose.journeys.yml" ]; then
    "${COMPOSE[@]}" -f "$HERE/docker-compose.journeys.yml" --profile journeys config --format json |
      python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" --require-journeys >/dev/null ||
      die "journeys override isolation failed"
  fi
}
verify_private_ports

# [PROD-PATH] The database-only stage never runs under a serving API: a
# migration under a live old binary is exactly what the full deploy stops
# the API to avoid. Refused before anything is pulled or built.
if [ "$DATA_ONLY" -eq 1 ]; then
  for service in api worker; do
    # Fail closed: no answer from Docker is not "not running".
    running="$("${COMPOSE[@]}" ps -q "$service")" ||
      die "--data-only could not ask Docker whether $service is running; refusing to migrate without that answer"
    [ -z "$running" ] ||
      die "--data-only refuses a stack whose $service is running; use the full deploy, which stops it before migrating"
  done
fi
# [PROD-PATH] --no-public never takes a public stack back: Caddy running means
# the names already serve, and only the full deploy replaces that stack.
if [ "$NO_PUBLIC" -eq 1 ]; then
  running="$("${COMPOSE[@]}" ps -q caddy)" ||
    die "--no-public could not ask Docker whether caddy is running; refusing to deploy without that answer"
  [ -z "$running" ] ||
    die "--no-public refuses a stack whose caddy is running (it already serves its public names); use the full deploy"
fi

# Pull versioned infrastructure images, then build the exact checked-out API.
"${COMPOSE[@]}" pull postgres redis meilisearch caddy
"${ROUTING[@]}" pull osrm
[ "$PLACES_PHOTON" -eq 0 ] || "${ROUTING[@]}" pull photon
"${COMPOSE[@]}" build api
# [Q11] The website's image for the same exact commit, built before anything
# is stopped: a site that does not build leaves the running stack untouched.
if [ -n "$WEB_HOST" ] && [ "$DATA_ONLY" -eq 0 ] && [ "$NO_PUBLIC" -eq 0 ]; then
  "${COMPOSE[@]}" build web
fi
# [ADMIN-CONSOLE] The same for the admin console: built before anything stops.
if [ -n "$ADMIN_HOST" ] && [ "$DATA_ONLY" -eq 0 ] && [ "$NO_PUBLIC" -eq 0 ]; then
  "${COMPOSE[@]}" build admin
fi
"${COMPOSE[@]}" up -d --wait postgres redis meilisearch
# [S3-L1] The database says which deployment it belongs to (deployment_identity,
# written once when it is set up; seed-production.sh reads it the same way). A
# staging host never deploys onto the production database, nor a production
# host onto another deployment's: refused here, before anything is stopped or
# migrated. The API and worker refuse to start on a mismatch as well
# (apps/api/src/utils/deployment-identity.ts). A database not set up yet (no
# table or no row) passes here; production writes its row before the first boot.
DB_IDENTITY="$("${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) || chr(58) || coalesce(max(environment), chr(32)) FROM deployment_identity;"' 2>/dev/null || true)"
DB_IDENTITY_ENV=""
if [ "${DB_IDENTITY%%:*}" = "1" ]; then DB_IDENTITY_ENV="${DB_IDENTITY#*:}"; fi
if [ "$PILOT_ENV" = production ]; then
  [ -z "$DB_IDENTITY_ENV" ] || [ "$DB_IDENTITY_ENV" = production ] ||
    die "PILOT_ENV=production, but this database's deployment_identity is not production: a production host never deploys onto another deployment's database. Nothing was stopped or migrated"
else
  [ "$DB_IDENTITY_ENV" != production ] ||
    die "PILOT_ENV=$PILOT_ENV, but this database's deployment_identity says production: a staging host never deploys onto the production database. Nothing was stopped or migrated"
fi
# [PROD-PATH] Photon only with PLACES_PROVIDER=osm on production; never
# Nominatim (the geocoding profile's other, heavy member).
if [ "$PLACES_PHOTON" -eq 1 ]; then
  "${ROUTING[@]}" up -d --wait osrm photon
else
  "${ROUTING[@]}" up -d --wait osrm
fi

# Check routing from the same private Docker network that the API uses.
docker run --rm --network swift-pilot-private --entrypoint node "swift-api:$SHA" \
  -e "fetch('http://osrm:5000/nearest/v1/driving/-58.16,6.80').then(async r => { if (!r.ok || (await r.json()).code !== 'Ok') process.exit(1) }).catch(() => process.exit(1))"
# [PROD-PATH · DS963] Address search, the same way, before the running API is
# stopped: Photon has no healthcheck, so `up --wait` returns while its first
# start is still downloading and importing the index. A Georgetown search must
# answer, within 5 seconds, with a named place that has coordinates (what the
# API's provider keeps). Until it does, nothing was stopped or migrated.
if [ "$PLACES_PHOTON" -eq 1 ]; then
  PHOTON_READY=0
  for _ in $(seq 1 90); do
    if docker run --rm --network swift-pilot-private --entrypoint node "swift-api:$SHA" \
      -e "fetch('http://photon:2322/api?q=Georgetown&limit=1', { signal: AbortSignal.timeout(5000) }).then(async r => { const d = r.ok ? await r.json() : null; const usable = d && Array.isArray(d.features) && d.features.some(f => f && f.geometry && Array.isArray(f.geometry.coordinates) && f.geometry.coordinates.length === 2 && f.properties && f.properties.name); if (!usable) process.exit(1) }).catch(() => process.exit(1))" >/dev/null 2>&1; then
      PHOTON_READY=1
      break
    fi
    sleep 2
  done
  [ "$PHOTON_READY" = 1 ] ||
    die "address search is not ready: Photon does not answer a Georgetown search yet (its first start downloads and imports a ~6.7 GB index). The running API and the database were not changed; rerun once docker compose -f deploy/docker-compose.routing.yml --profile geocoding logs photon shows it serving"
fi

[ "${DATA_ONLY:-0}" -eq 1 ] || "${COMPOSE[@]}" stop api worker
"${COMPOSE[@]}" up -d --force-recreate migrate
MIGRATE_ID="$("${COMPOSE[@]}" ps -a -q migrate)"
[ -n "$MIGRATE_ID" ] || die "migration container was not created"
. "$HERE/wait-for-migration.sh"
wait_for_migration "$MIGRATE_ID" || die "migration did not complete successfully"
if [ "${DATA_ONLY:-0}" -eq 1 ]; then
  echo "DATABASE READY at exact SHA $SHA ($PILOT_ENV; migrations applied; the API, worker and Caddy were not started)"
  exit 0
fi

"${COMPOSE[@]}" up -d --no-deps --force-recreate api worker
if [ "$NO_PUBLIC" -eq 1 ]; then
  # Ready inside the private network: the API container is healthy, the
  # worker runs, and /ready answers from inside the API container. Nothing
  # listens publicly (only Caddy publishes 80/443, and it is not started).
  API_READY=0
  for _ in $(seq 1 90); do
    API_ID="$("${COMPOSE[@]}" ps -q api)"
    WORKER_ID="$("${COMPOSE[@]}" ps -q worker)"
    if [ -n "$API_ID" ] && [ -n "$WORKER_ID" ] &&
       [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_ID")" = healthy ] &&
       [ "$(docker inspect -f '{{.State.Status}}' "$WORKER_ID")" = running ] &&
       "${COMPOSE[@]}" exec -T api node -e "fetch('http://127.0.0.1:3000/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))" >/dev/null 2>&1; then
      API_READY=1
      break
    fi
    sleep 2
  done
  [ "$API_READY" = 1 ] || die "API/worker readiness did not become healthy (no public address); inspect: docker compose -f deploy/docker-compose.yml logs --tail=100 api worker"
  echo "API READY at exact SHA $SHA (production, no public address: Caddy, the website and the console were not started)"
  exit 0
fi
"${COMPOSE[@]}" up -d --no-deps --force-recreate caddy
API_READY=0
for _ in $(seq 1 90); do
  API_ID="$("${COMPOSE[@]}" ps -q api)"
  WORKER_ID="$("${COMPOSE[@]}" ps -q worker)"
  if [ -n "$API_ID" ] && [ -n "$WORKER_ID" ] &&
     [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_ID")" = healthy ] &&
     [ "$(docker inspect -f '{{.State.Status}}' "$WORKER_ID")" = running ] &&
     curl -fsS --resolve "$API_HOST:443:127.0.0.1" --connect-timeout 5 --max-time 8 "https://$API_HOST/ready" >/dev/null 2>&1; then
    API_READY=1
    break
  fi
  sleep 2
done
[ "$API_READY" = 1 ] || die "API/worker/HTTPS readiness did not become healthy; inspect Compose logs"

# [Q11] The website starts once the API it calls is ready. It is stateless and
# only a client of that API, so it needs no migration and is simply replaced.
# Ready means its own probe is healthy AND Caddy serves its home page over
# HTTPS on this host (the certificate for WEB_HOST included).
# [WEB-GATE] With the password on, the home page must instead refuse a
# stranger with exactly 401 (a website reachable without the password it was
# configured with fails the deploy, as the console does), and the website's
# own answer comes from an open path with no side effects: the app-link file
# it serves under /.well-known/ must answer exactly 200. Never /pay/mmg/,
# which posts to a billing endpoint.
web_status() {
  curl -sS -o /dev/null -w '%{http_code}' --resolve "$WEB_HOST:443:127.0.0.1" \
    --connect-timeout 5 --max-time 8 "https://$WEB_HOST$1" 2>/dev/null || true
}
if [ -n "$WEB_HOST" ]; then
  "${COMPOSE[@]}" up -d --no-deps --force-recreate web
  WEB_GATE=off
  [ -z "$WEB_BASIC_AUTH_HASH" ] || WEB_GATE=on
  WEB_FILE=/.well-known/apple-app-site-association
  WEB_READY=0
  WEB_WHY="the web container never reported healthy"
  for _ in $(seq 1 90); do
    WEB_ID="$("${COMPOSE[@]}" ps -q web)"
    if [ -n "$WEB_ID" ] &&
       [ "$(docker inspect -f '{{.State.Health.Status}}' "$WEB_ID")" = healthy ]; then
      if [ "$WEB_GATE" = off ]; then
        if curl -fsS --resolve "$WEB_HOST:443:127.0.0.1" --connect-timeout 5 --max-time 8 "https://$WEB_HOST/" >/dev/null 2>&1; then
          WEB_READY=1
          break
        fi
      else
        WEB_FILE_ANSWER="$(web_status "$WEB_FILE")"
        WEB_HOME_ANSWER="$(web_status /)"
        if [ "$WEB_FILE_ANSWER" != 200 ]; then
          WEB_WHY="https://$WEB_HOST$WEB_FILE answered ${WEB_FILE_ANSWER:-000}, not 200"
        elif [ "$WEB_HOME_ANSWER" != 401 ]; then
          WEB_WHY="https://$WEB_HOST/ answered ${WEB_HOME_ANSWER:-000}, not 401"
        else
          WEB_READY=1
          break
        fi
      fi
    fi
    sleep 2
  done
  if [ "$WEB_READY" != 1 ]; then
    [ "$WEB_GATE" = off ] ||
      die "the website is not ready at https://$WEB_HOST: $WEB_WHY (password gate on; the API is serving $SHA); inspect: docker compose -f deploy/docker-compose.yml --profile web logs --tail=100 web caddy"
    die "the website did not become ready at https://$WEB_HOST (the API is serving $SHA); inspect: docker compose -f deploy/docker-compose.yml --profile web logs --tail=100 web caddy"
  fi
  echo "WEBSITE READY at https://$WEB_HOST (exact SHA $SHA; password gate $WEB_GATE)"
fi

# [ADMIN-CONSOLE] The console starts once the API it calls is ready; like the
# website it is stateless and simply replaced. Ready means its own probe is
# healthy AND Caddy answers its sign-in page over HTTPS on this host with
# exactly the status the gate setting implies: 200 with no gate, 401 with one.
# A console reachable without the gate it was configured with fails the deploy.
if [ -n "$ADMIN_HOST" ]; then
  "${COMPOSE[@]}" up -d --no-deps --force-recreate admin
  ADMIN_GATE=off
  ADMIN_EXPECT=200
  if [ -n "$ADMIN_BASIC_AUTH_HASH" ]; then ADMIN_GATE=on; ADMIN_EXPECT=401; fi
  ADMIN_READY=0
  ADMIN_ANSWER=""
  for _ in $(seq 1 90); do
    ADMIN_ID="$("${COMPOSE[@]}" ps -q admin)"
    if [ -n "$ADMIN_ID" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$ADMIN_ID")" = healthy ]; then
      ADMIN_ANSWER="$(curl -sS -o /dev/null -w '%{http_code}' --resolve "$ADMIN_HOST:443:127.0.0.1" \
        --connect-timeout 5 --max-time 8 "https://$ADMIN_HOST/login" 2>/dev/null || true)"
      if [ "$ADMIN_ANSWER" = "$ADMIN_EXPECT" ]; then
        ADMIN_READY=1
        break
      fi
    fi
    sleep 2
  done
  if [ "$ADMIN_READY" != 1 ]; then
    admin_why="the admin container never reported healthy"
    [ -z "$ADMIN_ANSWER" ] || admin_why="https://$ADMIN_HOST/login answered $ADMIN_ANSWER, not $ADMIN_EXPECT"
    die "the admin console is not ready at https://$ADMIN_HOST: $admin_why (extra sign-in gate $ADMIN_GATE; the API is serving $SHA); inspect: docker compose -f deploy/docker-compose.yml --profile admin logs --tail=100 admin caddy"
  fi
  echo "ADMIN CONSOLE READY at https://$ADMIN_HOST (exact SHA $SHA; extra sign-in gate $ADMIN_GATE)"
fi
echo "$(printf '%s' "$PILOT_ENV" | tr '[:lower:]' '[:upper:]') READY at exact SHA $SHA"
