#!/usr/bin/env bash
# [TA-S0-003 · C1] One fresh, throwaway stand-in for a provider secret that a
# rehearsal copy's processes are wired to read (deploy/wall/rehearsal.sh).
#
#   ./deploy/wall/stand-in.sh <NAME>     prints the value on stdout, for a pipe into the store
#
# The copy sits on an internal network with no route out, so no real provider
# value is ever needed or read. But the API checks the SHAPE of some of these
# at boot, in every mode (apps/api/src/utils/boot-config.ts and the provider
# loaders), and refuses to start on a value of the wrong shape. A copy wired
# like its host (MMG checkout on, an SMS allowlist, a card provider) must boot
# in that same posture, so each stand-in has the shape its check needs:
#   - MMG checkout keys: fresh RSA keys (PEM, 4096 bits: at least the 2048 the
#     loader needs, and wide enough for the longest checkout request);
#   - the SMS allowlist: one fictional number (+5920…, never issued), so the
#     copy can text no real person even if a route existed;
#   - PowerTranz: an id within its 25 characters, a GUID gateway key;
#   - URLs (the alert webhook, Sentry's DSN): https on the reserved .invalid
#     domain, which never resolves;
#   - Stripe: a test-mode key.
# Anything else is 24 random bytes in hex, as before. No value is ever printed
# anywhere but stdout, and none is ever an argument.
# apps/api/src/__tests__/rehearsal-stand-ins.test.ts feeds every name the
# API's secret loader accepts through this script and the API's own boot
# guards: a new shape check there fails that test until it is taught here.
set -euo pipefail
umask 077
[ $# -eq 1 ] && [[ "$1" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "usage: stand-in.sh <NAME>" >&2; exit 2; }
command -v openssl >/dev/null 2>&1 || { echo "stand-in.sh: openssl is required" >&2; exit 1; }
rsa_key() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 2>/dev/null; }
case "$1" in
  MMG_CHECKOUT_PUBLIC_KEY) rsa_key | openssl pkey -pubout ;;
  MMG_CHECKOUT_PRIVATE_KEY) rsa_key ;;
  SMS_RECIPIENT_ALLOWLIST) echo '+5920000000' ;;
  POWERTRANZ_ID) openssl rand -hex 8 ;;
  POWERTRANZ_GATEWAY_KEY)
    h="$(openssl rand -hex 16)"
    echo "${h:0:8}-${h:8:4}-${h:12:4}-${h:16:4}-${h:20:12}" ;;
  CW_ALERT_WEBHOOK_URL) echo "https://rehearsal.invalid/$(openssl rand -hex 16)" ;;
  SENTRY_DSN) echo "https://$(openssl rand -hex 16)@rehearsal.invalid/1" ;;
  STRIPE_SECRET_KEY) echo "sk_test_$(openssl rand -hex 24)" ;;
  *) openssl rand -hex 24 ;;
esac
