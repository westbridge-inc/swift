#!/usr/bin/env bash
# Source from a deployment script after starting the one-shot migrate service.
# A zero ExitCode is meaningful only after the container has exited.

wait_for_migration() {
  local container_id="$1" snapshot state code extra attempt
  for ((attempt = 0; attempt <= 120; attempt++)); do
    snapshot="$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$container_id")" || {
      echo "migration container status could not be read" >&2
      return 1
    }
    read -r state code extra <<< "$snapshot"
    if [[ -n "$extra" || ! "$code" =~ ^[0-9]+$ ]]; then
      echo "migration container status is invalid" >&2
      return 1
    fi
    case "$state" in
      exited)
        if [[ "$code" != 0 ]]; then
          echo "migrate-deploy exited with status $code" >&2
          return 1
        fi
        return 0
        ;;
      running|created)
        if (( attempt == 120 )); then
          echo "migrate-deploy timed out without exiting" >&2
          return 1
        fi
        ;;
      *)
        echo "migrate-deploy entered state $state" >&2
        return 1
        ;;
    esac
    sleep 2
  done
}
