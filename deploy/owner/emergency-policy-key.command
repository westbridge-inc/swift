#!/bin/bash
#
# Swift — create the emergency-policy signing key ON a staging/production host.
#
# Double-click this file (it opens in Terminal), or run it with arguments:
#
#   emergency-policy-key.command [swift-deploy@host] [path/to/ssh-key]
#
# Run it once per host (staging and production each get their own key).
#
# What it does: ON THE HOST, openssl draws 48 random bytes and pipes them
# straight into `sudo -n swift-secrets set EMERGENCY_POLICY_SIGNING_KEY`, which
# encrypts the value at rest bound to that host (deploy/swift-secrets). The
# value is never typed, never shown, never sent from this Mac, never a
# command-line argument and never written to a plain file: it exists only in
# the pipe between openssl and the store. This tool prints "saved ..." or a
# refusal, nothing else. No host name, address or key is stored in this file:
# it lives in a public repository.
#
# It refuses when the host already holds the key. Replacing it makes every
# phone that pinned the old PUBLIC key fall back to its bundled emergency
# numbers, so a rotation ships the new public key in an app release first
# (deploy/PILOT-RUNBOOK.md, "Emergency-policy signing key").
#
# Afterwards: deploy (deploy/pilot-up.sh restarts the store service and the
# API), then read the PUBLIC key the API prints at boot — not a secret:
#   docker compose logs api | grep 'public key to pin in the app'
# The kid and ed25519 values on that line go into
# apps/mobile/src/lib/emergencyPolicyPins.ts (a reviewed PR) before an app build.
set -euo pipefail
umask 077
export HISTFILE=/dev/null

NAME=EMERGENCY_POLICY_SIGNING_KEY
say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }

target="${1:-}"
key="${2:-}"
if [ -z "$target" ]; then IFS= read -r -p "Deploy target (swift-deploy@host): " target; fi
[[ "$target" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "the target must look like user@host"
if [ -z "$key" ]; then IFS= read -r -p "SSH private key path: " key; fi
key="${key/#\~/$HOME}"
[ -r "$key" ] || die "cannot read the SSH key at $key"

SSH=(ssh -i "$key" -o IdentitiesOnly=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=20 "$target")

# Connect once first: host-key confirmation and key problems surface here.
"${SSH[@]}" -n true </dev/null || die "cannot connect to $target with $key"

# The host-side script travels on stdin (bash -s); nothing in it is secret. The
# key value is created and consumed on the host, inside one pipe.
status=0
"${SSH[@]}" bash -s <<'REMOTE' || status=$?
set -euo pipefail
command -v openssl >/dev/null 2>&1 || exit 3
stored="$(sudo -n swift-secrets list </dev/null)" || exit 5
if printf '%s\n' "$stored" | grep -qx EMERGENCY_POLICY_SIGNING_KEY; then exit 4; fi
openssl rand -base64 48 | tr -d '\n=' | sudo -n swift-secrets set EMERGENCY_POLICY_SIGNING_KEY >/dev/null
REMOTE

case "$status" in
  0) echo "saved $NAME on $target" ;;
  3) die "openssl is not installed on $target; nothing was stored" ;;
  4) die "$target already holds $NAME; nothing was changed (a rotation needs the new public key in an app release first: deploy/PILOT-RUNBOOK.md)" ;;
  5) die "could not list the encrypted store on $target (sudo -n swift-secrets list); nothing was stored" ;;
  *) die "FAILED: the host refused it or the connection dropped (exit $status); nothing was shown" ;;
esac
say "next: deploy (pilot-up), then read the public key: docker compose logs api | grep 'public key to pin in the app'"
