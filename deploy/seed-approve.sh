#!/usr/bin/env bash
# Sign ONE seed-ceremony request, on YOUR OWN computer, with YOUR OWN key.
#
#   ./deploy/seed-approve.sh <your-name> <your-private-key-file> < request.txt
#
# The request is what seed-production.sh printed between the ----- lines (a
# production spine apply, or a break-glass SUPER_ADMIN promotion). This script
# shows you what it changes — the database, the configuration and FX rate, the
# first admin's phone (last four digits) and every change — asks you to type
# yes, signs it with `ssh-keygen -Y sign` (your key's passphrase is asked by
# ssh-keygen itself), and prints ONE line to hand to the operator. The server
# rebuilds those words when it applies and refuses an approval whose words
# differ from the change it is about to make. The line is not a secret; your private key never leaves this file
# system, and the server cannot sign for you.
#
# Your key, made once on your own computer (choose a passphrase):
#   ssh-keygen -t ed25519 -f ~/.ssh/swift_seed_approver -C <your-name>
# Give the operator only the PUBLIC line (~/.ssh/swift_seed_approver.pub). The
# server pins it, by your name, in its encrypted store (SEED_APPROVER_KEYS).
set -euo pipefail
umask 077

die() { echo "seed-approve: $*" >&2; exit 1; }
NAME="${1:-}"
KEY="${2:-}"
[[ "$NAME" =~ ^[a-z][a-z0-9-]{1,31}$ ]] || die "your name must be 2-32 lowercase letters, digits or hyphens (as pinned on the server)"
[ -n "$KEY" ] && [ -r "$KEY" ] || die "pass your private key file (e.g. ~/.ssh/swift_seed_approver)"
for tool in ssh-keygen base64 awk tr; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
[ ! -t 0 ] || die "give the request on stdin:  ./deploy/seed-approve.sh $NAME $KEY < request.txt"

# The request exactly: carriage returns dropped, blank lines around it dropped,
# one trailing newline. It must be the whole request the server printed, from
# its first line to its `end` line.
REQUEST="$(tr -d '\r' | awk 'NF { started = 1 } started { print }')"
[ "$(printf '%s\n' "$REQUEST" | head -1)" = "swift-seed-approval v2" ] || die "this is not a seed approval request (first line must be: swift-seed-approval v2)"
[ "$(printf '%s\n' "$REQUEST" | tail -1)" = end ] || die "the request is cut short or has something after it: its last line must be: end"
[ "$(printf '%s\n' "$REQUEST" | wc -l | tr -d ' ')" -le 4000 ] || die "the request is too long to be one the server printed"
# Nothing hidden from you: no control characters (they can hide a line on a terminal).
if printf '%s\n' "$REQUEST" | LC_ALL=C grep -q '[[:cntrl:]]'; then die "the request contains control characters; ask the operator for the request exactly as the server printed it"; fi
# It must say what it approves, in words: the database, and the configuration
# with its FX rate (a plan) or the promotion (a break-glass promotion).
printf '%s\n' "$REQUEST" | grep -q '^database: ' || die "the request does not name the database; ask the operator for the full request"
KIND="$(printf '%s\n' "$REQUEST" | sed -n 's/^kind: //p' | head -1)"
case "$KIND" in
  plan) printf '%s\n' "$REQUEST" | grep -q '^config: ' || die "this plan request does not show its configuration and FX rate; ask the operator for the full request" ;;
  promote) printf '%s\n' "$REQUEST" | grep -q '^promote: ' || die "this promotion request does not say who is promoted; ask the operator for the full request" ;;
  *) die "the request kind must be plan or promote" ;;
esac

{
  echo "You are about to approve, as $NAME, this ${KIND} change:"
  echo
  printf '%s\n' "$REQUEST" | grep -E '^(database|config|admin phone|promote): ' | sed 's/^/    /'
  if [ "$KIND" = plan ]; then
    echo "    changes:"
    printf '%s\n' "$REQUEST" | grep '^change: ' | sed 's/^change: /      /' || echo "      (none: the database already matches; your approval is still used up)"
  fi
  echo
  echo "    $(printf '%s\n' "$REQUEST" | grep '^issued: ')   $(printf '%s\n' "$REQUEST" | grep '^expires: ')"
  echo
  echo "Signed exactly as (the digests bind the database and the change):"
  printf '%s\n' "$REQUEST" | sed 's/^/    | /'
} >&2
if [ "${SEED_APPROVE_YES:-}" != 1 ]; then
  [ -r /dev/tty ] || die "no terminal to confirm on; read the request and run this in your own terminal"
  printf 'Type yes to sign: ' >&2
  read -r answer < /dev/tty
  [ "$answer" = yes ] || die "not signed"
fi

SIG="$(printf '%s\n' "$REQUEST" | ssh-keygen -q -Y sign -f "$KEY" -n swift-seed-approval)" || die "ssh-keygen could not sign (wrong key or passphrase?)"
BODY="$(printf '%s\n' "$SIG" | awk '/^-----/ { next } { printf "%s", $0 }')"
[ -n "$BODY" ] || die "ssh-keygen returned no signature"
REQ64="$(printf '%s\n' "$REQUEST" | base64 | tr -d '\n')"
printf '{"approver":"%s","request":"%s","signature":"%s"}\n' "$NAME" "$REQ64" "$BODY"
