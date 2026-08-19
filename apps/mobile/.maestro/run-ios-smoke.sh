#!/usr/bin/env bash
set -euo pipefail

readonly protected_device='8934D84E-327E-453C-9FC4-88DFE4A8589E'
readonly device="${SWIFT_IOS_SMOKE_DEVICE:-}"

if [[ -z "${device}" ]]; then
  echo 'SWIFT_IOS_SMOKE_DEVICE is required; refusing to select a simulator implicitly.' >&2
  exit 64
fi

if [[ "${device}" == "${protected_device}" ]]; then
  echo 'Refusing to run: SWIFT_IOS_SMOKE_DEVICE is the protected iPhone simulator.' >&2
  exit 64
fi

if ! xcrun simctl list devices available | grep -Fq "${device}"; then
  echo "Simulator ${device} is not available." >&2
  exit 69
fi

if ! xcrun simctl list devices | grep -F "${device}" | grep -Fq '(Booted)'; then
  echo "Simulator ${device} must already be booted; this runner will not boot or stop devices." >&2
  exit 69
fi

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export SWIFT_EXPO_DEV_URL_ENCODED="${SWIFT_EXPO_DEV_URL_ENCODED:-http%3A%2F%2F127.0.0.1%3A8081}"

if [[ ! -x "${JAVA_HOME}/bin/java" ]]; then
  echo "JAVA_HOME does not contain an executable Java runtime: ${JAVA_HOME}" >&2
  exit 69
fi

if ! command -v maestro >/dev/null 2>&1; then
  echo 'Maestro is not installed or is not on PATH.' >&2
  exit 69
fi

maestro test \
  --device "${device}" \
  --include-tags local-smoke \
  --format JUNIT \
  --output "${SWIFT_MAESTRO_REPORT:-/tmp/swift-maestro-ios-smoke.xml}" \
  .maestro/flows
