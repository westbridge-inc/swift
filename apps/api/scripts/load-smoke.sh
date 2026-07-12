#!/usr/bin/env bash
# Load smoke for the hot read paths. NOT a production load test (that belongs
# on staging with realistic data + a proxy) — a local regression tripwire so a
# change that makes vendor-detail 5x slower shows up before it ships.
#
# Baseline captured 2026-07-12 (M-series dev box, 20 conns × 12s, warm DB,
# rate limiter raised via RATE_LIMIT_MAX so we measure the handler, not the
# limiter). 100% 2xx on every path:
#
#   path                       p50     p97.5   req/sec avg
#   customer/home              15 ms    34 ms   ~1,110
#   customer/vendors/:id       41 ms    99 ms     ~445   <- heaviest, watch this
#   search?q=                  25 ms    79 ms     ~660
#   customer/cart (quote)      11 ms    29 ms   ~1,560
#
# Usage: RATE_LIMIT_MAX=1000000 pnpm dev   # in one shell
#        ./scripts/load-smoke.sh           # in another
set -euo pipefail

API="${API_URL:-http://localhost:3000}"
PHONE="${SMOKE_PHONE:-+5926003000}"
CONNS="${CONNS:-20}"
DURATION="${DURATION:-12}"

command -v npx >/dev/null || { echo "npx required"; exit 1; }

curl -s -X POST "$API/api/v1/auth/request-otp" -H 'Content-Type: application/json' -d "{\"phone\":\"$PHONE\"}" >/dev/null
TOKEN=$(curl -s -X POST "$API/api/v1/auth/verify-otp" -H 'Content-Type: application/json' \
  -d "{\"phone\":\"$PHONE\",\"code\":\"000000\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['tokens']['accessToken'])")
[ -n "$TOKEN" ] || { echo "no token — is the API up with DEV_OTP_BYPASS?"; exit 1; }

# Any vendor id for the detail path.
VID=$(curl -s "$API/api/v1/customer/vendors?limit=1" -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; d=json.load(sys.stdin)['data']; print((d[0] if isinstance(d,list) else d.get('vendors',d.get('items',[]))[0])['id'])")

smoke() {
  echo "── $1"
  npx autocannon -c "$CONNS" -d "$DURATION" -H "Authorization=Bearer $TOKEN" "$2" 2>&1 \
    | grep -E "Latency|Req/Sec|2xx responses|non 2xx"
  echo
}

smoke "home"       "$API/api/v1/customer/home?lat=6.8&lng=-58.15"
smoke "vendor"     "$API/api/v1/customer/vendors/$VID"
smoke "search"     "$API/api/v1/search?q=rice"
smoke "cart-quote" "$API/api/v1/customer/cart?lat=6.8&lng=-58.15"
