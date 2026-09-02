#!/usr/bin/env bash
# [TA-S0-006 / spec Q.2] ONE pinned, checksum-verified gitleaks for every job
# that scans — the history scan and the built-artifact scans alike.
#
# The old step piped a moving download straight into tar with no checksum, so
# a compromised or replaced release asset would have run as the scanner that
# decides whether main is clean. The version and the SHA-256 below are pinned
# together; bumping one without the other fails loudly instead of silently
# trusting whatever the URL serves that day.
#
#   bash scripts/fetch-gitleaks.sh            → ./gitleaks (linux x64)
set -euo pipefail

VERSION="8.24.3"
SHA256="9991e0b2903da4c8f6122b5c3186448b927a5da4deef1fe45271c3793f4ee29c"
TARBALL="gitleaks_${VERSION}_linux_x64.tar.gz"
URL="https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${TARBALL}"
TMP="$(mktemp -d)"

curl -sSfL -o "${TMP}/${TARBALL}" "${URL}"
if ! echo "${SHA256}  ${TMP}/${TARBALL}" | sha256sum -c - >/dev/null 2>&1; then
  echo "::error::gitleaks ${VERSION} tarball checksum mismatch — refusing to run an unverified scanner"
  echo "  expected ${SHA256}"
  echo "  got      $(sha256sum "${TMP}/${TARBALL}" | cut -d' ' -f1)"
  rm -rf "${TMP}"
  exit 1
fi
tar -xzf "${TMP}/${TARBALL}" -C "${TMP}" gitleaks
mv "${TMP}/gitleaks" ./gitleaks
rm -rf "${TMP}"
./gitleaks version
