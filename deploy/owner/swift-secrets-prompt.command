#!/bin/bash
#
# Swift — enter a staging/production secret from your Mac.
#
# Double-click this file (it opens in Terminal), or run it with arguments:
#
#   swift-secrets-prompt.command [swift-deploy@host] [path/to/ssh-key] [NAME ...]
#
# Anything not given is asked for. Each value is typed with hidden input,
# confirmed once, and sent over SSH on STDIN ONLY to `sudo -n swift-secrets set
# NAME` on the host, which encrypts it at rest bound to that host
# (deploy/swift-secrets). The value is never a command-line argument, never
# written to a file, never echoed; this tool prints only "saved NAME". No host
# name, address or key is stored in this file: it lives in a public repository.
#
# Secret names are UPPER_CASE, for example JWT_SECRET, TWILIO_API_KEY_SECRET,
# SMTP_PASS, MMG_API_KEY, MMG_PASSWORD, MMG_MKEY, MMG_MSECRET,
# PAYMENT_GATEWAY_KEY, PAYMENT_GATEWAY_SECRET, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY. The full list is apps/api/src/utils/secret-files.ts.
set -euo pipefail
umask 077
export HISTFILE=/dev/null

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
valid_name() { [[ "$1" =~ ^[A-Z][A-Z0-9_]{0,127}$ ]] && [[ "$1" != *_FILE ]]; }

target="${1:-}"
key="${2:-}"
if [ $# -ge 2 ]; then shift 2; elif [ $# -eq 1 ]; then shift 1; fi

# Names given as arguments are checked before anything is asked or connected.
for name in "$@"; do
  valid_name "$name" || die "invalid secret name: $name (UPPER_CASE, not ending in _FILE)"
done

if [ -z "$target" ]; then IFS= read -r -p "Deploy target (swift-deploy@host): " target; fi
[[ "$target" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "the target must look like user@host"
if [ -z "$key" ]; then IFS= read -r -p "SSH private key path: " key; fi
key="${key/#\~/$HOME}"
[ -r "$key" ] || die "cannot read the SSH key at $key"

SSH=(ssh -i "$key" -o IdentitiesOnly=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=20 "$target")

# Connect once before any secret is typed: host-key confirmation and key
# problems surface here, with nothing sensitive in flight.
"${SSH[@]}" -n true </dev/null || die "cannot connect to $target with $key"

process_one() {
  local name="$1" value again
  valid_name "$name" || die "invalid secret name: $name (UPPER_CASE, not ending in _FILE)"
  while :; do
    IFS= read -r -s -p "Value for $name (hidden): " value || die "no input for $name"
    say ""
    if [ -z "$value" ]; then say "nothing was entered for $name, asking again"; continue; fi
    IFS= read -r -s -p "Repeat $name (hidden): " again || die "no input for $name"
    say ""
    if [ "$value" = "$again" ]; then break; fi
    say "the two entries for $name differ, asking again"
  done
  unset again
  if printf '%s' "$value" | "${SSH[@]}" "sudo -n swift-secrets set $name" >/dev/null; then
    unset value
    echo "saved $name"
  else
    unset value
    die "FAILED $name: the host refused it or the connection dropped (nothing was shown)"
  fi
}

if [ $# -gt 0 ]; then
  for name in "$@"; do process_one "$name"; done
else
  while IFS= read -r -p "Secret name (blank to finish): " name; do
    [ -n "$name" ] || break
    process_one "$name"
  done
fi
say "done. On the host: sudo systemctl restart swift-secrets.service, then restart the app."
