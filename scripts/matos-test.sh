#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib/matos-test-tmpdir.sh
. "$ROOT/scripts/lib/matos-test-tmpdir.sh"
# shellcheck source=scripts/lib/matos-host-dev-env.sh
. "$ROOT/scripts/lib/matos-host-dev-env.sh"
# shellcheck source=scripts/lib/matos-test-hermetic-env.sh
. "$ROOT/scripts/lib/matos-test-hermetic-env.sh"

if [[ $# -eq 0 ]]; then
  set -- src/matos
fi

echo "MatOS test TMPDIR: $TMPDIR"
test_timeout="${MATOS_TEST_TIMEOUT_MS:-30000}"
timeout_args=()
if [[ "$test_timeout" != "0" ]]; then
  timeout_args=(--timeout "$test_timeout")
fi

runner_args=()
if [[ -n "${MATOS_TEST_PARALLEL:-}" && "${MATOS_TEST_PARALLEL}" != "0" ]]; then
  # --parallel implies --isolate. Worker processes pay the per-file module-graph
  # import cost (the dominant wall-time driver on network filesystems) concurrently.
  if [[ "${MATOS_TEST_PARALLEL}" == "auto" ]]; then
    runner_args+=(--parallel)
  else
    runner_args+=(--parallel="${MATOS_TEST_PARALLEL}")
  fi
else
  runner_args+=(--isolate --max-concurrency="${MATOS_TEST_MAX_CONCURRENCY:-1}")
fi
if [[ -n "${MATOS_TEST_RETRY:-}" && "${MATOS_TEST_RETRY}" != "0" ]]; then
  runner_args+=(--retry="${MATOS_TEST_RETRY}")
fi
if [[ -n "${MATOS_TEST_JUNIT_OUT:-}" ]]; then
  mkdir -p "$(dirname "${MATOS_TEST_JUNIT_OUT}")"
  runner_args+=(--reporter=junit --reporter-outfile="${MATOS_TEST_JUNIT_OUT}")
fi

bun test \
  "${timeout_args[@]}" \
  "${runner_args[@]}" \
  "$@"
