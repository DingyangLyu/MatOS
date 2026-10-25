#!/usr/bin/env bash
# Focused checks for the MatOS test TMPDIR policy library. Hermetic: every
# probe runs in `env -i bash -c` with an isolated MATOS_TEST_TMPDIR base under
# this test's own scratch directory, so nothing touches the shared vePFS base
# or root /tmp.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$ROOT/scripts/lib/matos-test-tmpdir.sh"

tmp_parent="${MATOS_TEST_TMPDIR_BASE:-$ROOT/.tmp-test}"
mkdir -p "$tmp_parent"
tmp="$(mktemp -d "$tmp_parent/matos-test-tmpdir-test.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

run_env_probe() {
  local script="$1"
  env -i bash -c "$script"
}

# 1. A caller TMPDIR under root /tmp must be replaced with a policy session.
base1="$tmp/base1"
output="$(
  run_env_probe '
    set -euo pipefail
    cd "'"$tmp"'"
    export TMPDIR=/tmp/some-caller-dir
    export MATOS_TEST_TMPDIR="'"$base1"'"
    export MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE=0
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
    printf "SESSION_CREATED=%s\n" "$MATOS_TEST_TMPDIR_SESSION_CREATED"
  '
)"
printf '%s\n' "$output" | grep -q "^TMPDIR=$base1/" ||
  { echo "FAIL: TMPDIR=/tmp/subdir was not replaced by the policy base: $output" >&2; exit 1; }
printf '%s\n' "$output" | grep -q "^SESSION_CREATED=1$"
case "$(printf '%s\n' "$output" | sed -n 's/^TMPDIR=//p')" in
  /tmp|/tmp/*) echo "FAIL: exported TMPDIR still under root /tmp" >&2; exit 1 ;;
esac

# 2. A non-root TMPDIR exported by the caller is honored unchanged.
safe_tmp="$tmp/safe-tmp"
mkdir -p "$safe_tmp"
output="$(
  run_env_probe '
    set -euo pipefail
    cd "'"$tmp"'"
    export TMPDIR="'"$safe_tmp"'"
    export MATOS_TEST_TMPDIR="'"$tmp/base2"'"
    export MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE=0
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
    printf "SESSION_CREATED=%s\n" "$MATOS_TEST_TMPDIR_SESSION_CREATED"
  '
)"
printf '%s\n' "$output" | grep -q "^TMPDIR=$safe_tmp$"
printf '%s\n' "$output" | grep -q "^SESSION_CREATED=0$"

# 3. Session directories are removed on clean exit.
base3="$tmp/base3"
run_env_probe '
  set -euo pipefail
  cd "'"$tmp"'"
  unset TMPDIR
  export MATOS_TEST_TMPDIR="'"$base3"'"
  export MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE=0
  . "'"$helper"'"
  test -d "$MATOS_TEST_TMPDIR_SESSION"
'
if [[ -d "$base3" ]] && [[ -n "$(find "$base3" -mindepth 1 -maxdepth 1 2>/dev/null)" ]]; then
  echo "FAIL: session dir was not cleaned up on successful exit" >&2
  exit 1
fi

# 4. No-session mode never adopts or exports a root-/tmp TMPDIR.
base4="$tmp/base4"
output="$(
  run_env_probe '
    set -euo pipefail
    cd "'"$tmp"'"
    export TMPDIR=/tmp
    export MATOS_TEST_TMPDIR="'"$base4"'"
    export MATOS_TEST_TMPDIR_CREATE_SESSION=0
    export MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE=0
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
    printf "BASE=%s\n" "$MATOS_TEST_TMPDIR_BASE"
  '
)"
printf '%s\n' "$output" | grep -q "^TMPDIR=$base4$"
printf '%s\n' "$output" | grep -q "^BASE=$base4$"

# 5. When the configured base is uncreatable, fall back to repo-local
#    .tmp-test (created on demand), never root /tmp.
blocker="$tmp/blocker-file"
: > "$blocker"
output="$(
  run_env_probe '
    set -euo pipefail
    cd "'"$tmp"'"
    unset TMPDIR
    export MATOS_TEST_TMPDIR="'"$blocker"'/impossible-base"
    export MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE=0
    export MATOS_TEST_TMPDIR_KEEP=1
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
  ' 2>/dev/null
)"
probe_tmpdir="$(printf '%s\n' "$output" | sed -n 's/^TMPDIR=//p')"
case "$probe_tmpdir" in
  "$tmp"/.tmp-test/*) ;;
  *) echo "FAIL: uncreatable base did not fall back to repo-local .tmp-test: $probe_tmpdir" >&2; exit 1 ;;
esac

echo "ok: matos-test-tmpdir.sh policy checks passed"
