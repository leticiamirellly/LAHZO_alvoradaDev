#!/usr/bin/env bash
set -euo pipefail

cleanup_on_error() {
  local exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "docker compose up failed; cleaning up partially started services..." >&2
    docker compose down --remove-orphans
  fi

  exit "$exit_code"
}

trap cleanup_on_error EXIT

docker compose up --build --remove-orphans "$@"

trap - EXIT
