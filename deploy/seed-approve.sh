#!/usr/bin/env bash
# Sign ONE seed-ceremony request, on YOUR OWN computer, with YOUR OWN key.
#
#   ./deploy/seed-approve.sh <your-name> <your-private-key-file> < request.txt
#
# The request is what seed-production.sh printed between the ----- lines (a
# production spine apply, or a break-glass SUPER_ADMIN promotion). This script
# shows it, asks you to type yes, signs it with `ssh-keygen -Y sign` (your key's
# passphrase is asked by ssh-keygen itself), and prints ONE line to hand to the
# operator. The line is not a secret; your private key never leaves this file
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
# one trailing newline. It must be the six lines the server printed.
REQUEST="$(tr -d '\r' | awk 'NF { started = 1 } started { print }')"
[ "$(printf '%s\n' "$REQUEST" | head -1)" = "swift-seed-approval v1" ] || die "this is not a seed approval request (first line must be: swift-seed-approval v1)"
[ "$(printf '%s\n' "$REQUEST" | wc -l | tr -d ' ')" = 6 ] || die "the request must be exactly the six lines the server printed"

echo "You are about to approve, as $NAME:" >&2
printf '%s\n' "$REQUEST" | sed 's/^/    /' >&2
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
