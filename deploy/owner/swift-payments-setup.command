#!/bin/bash
#
# Swift — set up the payment providers on a staging or production server, then
# check them. For the owner. Double-click it (it opens in Terminal), or run:
#
#   swift-payments-setup.command [swift-deploy@host] [path/to/ssh-key] [card|mmg|both]
#
# It asks for exactly these, by provider, and nothing else:
#   card  (the card provider, PowerTranz)
#         POWERTRANZ_ID, POWERTRANZ_PASSWORD ........ hidden prompts
#         POWERTRANZ_GATEWAY_KEY ..................... hidden, optional (Enter = none issued yet)
#         test system or live cards; the hosted payment page's set and name; a short label
#         for the merchant account; this server's public API address (none of them secrets);
#         for live cards, the production API address PowerTranz gave you (not a secret)
#   mmg   (the MMG checkout)
#         MMG_CHECKOUT_PRIVATE_KEY, MMG_CHECKOUT_PUBLIC_KEY .. PEM key FILES, by path (never pasted)
#         MMG_CHECKOUT_SECRET_KEY .......................... hidden prompt
#
# Each secret goes over SSH on STDIN only to `sudo -n swift-secrets set NAME` on
# the host, which encrypts it at rest bound to that host (deploy/swift-secrets).
# A value is never a command-line argument, never written to a file here, never
# echoed: this tool prints only "saved NAME". No host name, address or key is
# stored in this file: it lives in a public repository.
#
# Then the server checks what was entered and prints only OK / FAIL lines
# (dist/boot/payments-self-check.js in a one-off API container): never a value
# and never a provider's answer. The check moves no money.
#
# Card payments stay OFF: this tool never switches anything on and never
# restarts the running app. Switching cards on is the owner's "go", done with
# the coordinator, after the bank and PCI paperwork.
set -euo pipefail
umask 077
export HISTFILE=/dev/null

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

SWIFT_DIR="${SWIFT_DIR:-/opt/swift}"
[[ "$SWIFT_DIR" =~ ^/[A-Za-z0-9/_.-]+$ ]] || die "SWIFT_DIR must be an absolute path"

target="${1:-}"
key="${2:-}"
which="${3:-}"

if [ -z "$target" ]; then IFS= read -r -p "Deploy target (swift-deploy@host): " target; fi
[[ "$target" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "the target must look like user@host"
if [ -z "$key" ]; then IFS= read -r -p "SSH private key path: " key; fi
key="${key/#\~/$HOME}"
[ -r "$key" ] || die "cannot read the SSH key at $key"
if [ -z "$which" ]; then IFS= read -r -p "Set up which payments? card, mmg or both: " which; fi
case "$which" in card|mmg|both) ;; *) die "answer card, mmg or both" ;; esac

SSH=(ssh -i "$key" -o IdentitiesOnly=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=20 "$target")

# Connect once before any secret is typed: host-key confirmation and key
# problems surface here, with nothing sensitive in flight.
"${SSH[@]}" -n true </dev/null || die "cannot connect to $target with $key"

# ask_hidden NAME OPTIONAL — a value typed twice at a hidden prompt, sent on stdin only.
# LAST_SAVED says whether THIS run saved it (an optional one may be skipped).
LAST_SAVED=0
ask_hidden() {
  local name="$1" optional="$2" value again
  LAST_SAVED=0
  while :; do
    IFS= read -r -s -p "Value for $name (hidden${optional:+, Enter to skip}): " value || die "no input for $name"
    say ""
    if [ -z "$value" ]; then
      if [ -n "$optional" ]; then say "skipped $name (none will be used)"; return 0; fi
      say "nothing was entered for $name, asking again"; continue
    fi
    IFS= read -r -s -p "Repeat $name (hidden): " again || die "no input for $name"
    say ""
    if [ "$value" = "$again" ]; then break; fi
    say "the two entries for $name differ, asking again"
  done
  unset again
  if printf '%s' "$value" | "${SSH[@]}" "sudo -n swift-secrets set $name" >/dev/null; then
    unset value
    LAST_SAVED=1
    echo "saved $name"
  else
    unset value
    die "FAILED $name: the host refused it or the connection dropped (nothing was shown)"
  fi
}

# send_pem NAME KIND — a PEM key FILE, by path, sent on stdin only. KIND is PRIVATE or PUBLIC.
send_pem() {
  local name="$1" kind="$2" path first
  while :; do
    IFS= read -r -p "Path to the $name file (PEM): " path || die "no input for $name"
    path="${path/#\~/$HOME}"
    if [ ! -r "$path" ]; then say "cannot read $path, asking again"; continue; fi
    IFS= read -r first < "$path" || first=""
    if [[ "$first" == "-----BEGIN "*"$kind KEY-----"* ]]; then break; fi
    say "$path does not start like a PEM $kind key, asking again (nothing was shown)"
  done
  if cat -- "$path" | "${SSH[@]}" "sudo -n swift-secrets set $name" >/dev/null; then
    echo "saved $name"
  else
    die "FAILED $name: the host refused it or the connection dropped (nothing was shown)"
  fi
}

# A visible setting (never a secret): letters, digits, space and . _ / - only.
ask_setting() {
  local prompt="$1" rule="$2" value
  while :; do
    IFS= read -r -p "$prompt: " value || die "no input"
    if [[ "$value" =~ $rule ]]; then printf '%s' "$value"; return 0; fi
    say "that does not look right, asking again"
  done
}

CHECK_ENV=()
PARTS=()
ENV_LINES=()

if [ "$which" = card ] || [ "$which" = both ]; then
  say ""
  say "Card payments (PowerTranz). Use the values PowerTranz sent you."
  env_choice="$(ask_setting "Test system (sandbox) or live cards? type sandbox or live" '^(sandbox|live)$')"
  if [ "$env_choice" = live ]; then say "Live cards are accepted only by the PRODUCTION server: any other server answers FAIL and refuses to start with them."; fi
  account="$(ask_setting "A short label for this merchant account (letters, digits . _ -), e.g. swift-gy" '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')"
  public_url="$(ask_setting "This server's own public API address (https://... with no path)" '^https://[A-Za-z0-9.-]+$')"
  page_set="$(ask_setting "Hosted payment page SET (pages made in the merchant portal start with PTZ/)" '^[A-Za-z0-9 _./-]{1,50}$')"
  page_name="$(ask_setting "Hosted payment page NAME" '^[A-Za-z0-9 _./-]{1,50}$')"
  api_url=""
  if [ "$env_choice" = live ]; then
    api_url="$(ask_setting "Production API address PowerTranz gave you (https://… with no path)" '^https://[A-Za-z0-9.-]+$')"
    if [[ "$api_url" =~ (staging|sandbox|test|uat) ]]; then die "that address is a test system; live cards need the production address"; fi
  fi
  ask_hidden POWERTRANZ_ID ""
  ask_hidden POWERTRANZ_PASSWORD ""
  ask_hidden POWERTRANZ_GATEWAY_KEY optional
  gateway_key_saved="$LAST_SAVED"
  CHECK_ENV+=(-e CARD_RAIL_PROVIDER=powertranz -e "CARD_RAIL_ENVIRONMENT=$env_choice" -e "CARD_RAIL_ACCOUNT=$account" -e "API_PUBLIC_URL=$public_url"
    -e "POWERTRANZ_PAGE_SET=$page_set" -e "POWERTRANZ_PAGE_NAME=$page_name"
    -e POWERTRANZ_ID_FILE=/run/secrets/POWERTRANZ_ID -e POWERTRANZ_PASSWORD_FILE=/run/secrets/POWERTRANZ_PASSWORD)
  ENV_LINES+=("CARD_RAIL_PROVIDER=powertranz" "CARD_RAIL_ENVIRONMENT=$env_choice" "CARD_RAIL_ACCOUNT=$account" "API_PUBLIC_URL=$public_url" "POWERTRANZ_PAGE_SET=$page_set" "POWERTRANZ_PAGE_NAME=$page_name"
    "POWERTRANZ_ID_FILE=/run/secrets/POWERTRANZ_ID" "POWERTRANZ_PASSWORD_FILE=/run/secrets/POWERTRANZ_PASSWORD")
  # Only a gateway key entered in THIS run is used, and only this run's address.
  # Both are ALWAYS passed to the check, empty when not given: the one-off
  # container also reads the server's deploy/.env, so a value left there by an
  # earlier run (a test-system key, a live address) would otherwise be checked
  # in their place. An empty value means "none" to the server. The settings
  # lines below carry the same empty values, so the server's deploy/.env loses
  # the stale ones too: the check certifies exactly what will run.
  gateway_key_file=""
  if [ "$gateway_key_saved" = 1 ]; then gateway_key_file=/run/secrets/POWERTRANZ_GATEWAY_KEY; fi
  CHECK_ENV+=(-e "POWERTRANZ_GATEWAY_KEY_FILE=$gateway_key_file" -e "POWERTRANZ_API_URL=$api_url")
  ENV_LINES+=("POWERTRANZ_GATEWAY_KEY_FILE=$gateway_key_file" "POWERTRANZ_API_URL=$api_url")
  PARTS+=(card)
fi

if [ "$which" = mmg ] || [ "$which" = both ]; then
  say ""
  say "MMG checkout. Choose the key FILES MMG and you exchanged; nothing is pasted."
  send_pem MMG_CHECKOUT_PRIVATE_KEY PRIVATE
  send_pem MMG_CHECKOUT_PUBLIC_KEY PUBLIC
  ask_hidden MMG_CHECKOUT_SECRET_KEY ""
  CHECK_ENV+=(-e MMG_CHECKOUT_PRIVATE_KEY_FILE=/run/secrets/MMG_CHECKOUT_PRIVATE_KEY
    -e MMG_CHECKOUT_PUBLIC_KEY_FILE=/run/secrets/MMG_CHECKOUT_PUBLIC_KEY
    -e MMG_CHECKOUT_SECRET_KEY_FILE=/run/secrets/MMG_CHECKOUT_SECRET_KEY)
  ENV_LINES+=("MMG_CHECKOUT_PRIVATE_KEY_FILE=/run/secrets/MMG_CHECKOUT_PRIVATE_KEY" "MMG_CHECKOUT_PUBLIC_KEY_FILE=/run/secrets/MMG_CHECKOUT_PUBLIC_KEY"
    "MMG_CHECKOUT_SECRET_KEY_FILE=/run/secrets/MMG_CHECKOUT_SECRET_KEY")
  PARTS+=(mmg)
fi

# The check, on the server: the store is decrypted onto tmpfs, then a ONE-OFF
# API container (never the running app) reads it and prints OK / FAIL lines.
remote="cd $(printf '%q' "$SWIFT_DIR") && sudo -n systemctl restart swift-secrets.service && docker compose --project-directory deploy -f deploy/docker-compose.yml run --rm --no-deps"
for arg in "${CHECK_ENV[@]}"; do remote+=" $(printf '%q' "$arg")"; done
remote+=" api node dist/boot/payments-self-check.js ${PARTS[*]}"

say ""
say "Checking on the server (OK / FAIL only; nothing is charged)..."
set +e
answer="$("${SSH[@]}" -n "$remote" </dev/null 2>/dev/null)"
status=$?
set -e
lines="$(printf '%s\n' "$answer" | grep -E '^(OK  |FAIL) ' || true)"
unset answer
if [ -n "$lines" ]; then printf '%s\n' "$lines"; fi

say ""
say "Send these settings lines to the coordinator for the server's deploy/.env (no secrets in them):"
for line in "${ENV_LINES[@]}"; do say "  $line"; done
say "Card payments stay OFF until your go: the coordinator switches them on with you."
if [ "$status" -eq 0 ]; then say "All checks passed."
elif [ -z "$lines" ]; then say "The check could not run on the server (no OK / FAIL lines came back). Nothing was shown; tell the coordinator."
else say "Some checks did not pass: see the FAIL lines above."; fi
exit "$status"
