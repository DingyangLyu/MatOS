#!/usr/bin/env bash
# Canonical MatOS test/smoke TMPDIR policy.
#
# Heavy test artifacts (Playwright/Chromium browser profiles, screenshots,
# bun/node scratch, mktemp working dirs) must not fill a small root disk:
# that breaks container creation, recovery checkpoints, and even shell
# heredocs. Route test temp to large storage instead.
#
# Resolution order:
#   1. A non-/tmp TMPDIR already exported by the caller is honored.
#   2. Otherwise MATOS_TEST_TMPDIR (if set) is used as the session base.
#   3. Otherwise the deployment default is used as the session base.
#   4. If that default cannot be created (e.g. on a host without it),
#      fall back to the repo-local .tmp-test directory, not root /tmp.
#
# By default this creates one per-run session directory under the base and sets
# TMPDIR/TMP/TEMP to that directory. The session directory is removed when the
# script exits successfully. On failure it is kept for debugging and its path is
# printed to stderr. Set MATOS_TEST_TMPDIR_KEEP=1 to always keep it, or
# MATOS_TEST_TMPDIR_CREATE_SESSION=0 to only export the base directory.
#
# Source this after `cd "$ROOT"` in test/smoke scripts:
#   . "$ROOT/scripts/lib/matos-test-tmpdir.sh"

matos_test_tmpdir_base_default="${MATOS_TEST_TMPDIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.tmp-test}"

# Root-/tmp detection must match the TS-side policy (preload.ts,
# src/matos/runtime/tempDirs.ts): both /tmp itself and any path under it live
# on the small root overlay and violate the MatOS temp policy.
matos_test_tmpdir_is_root_tmp() {
  case "${1:-}" in
    /tmp|/tmp/*) return 0 ;;
    *) return 1 ;;
  esac
}

matos_test_tmpdir_sanitize_label() {
  local label="${1:-matos-test}"
  label="${label##*/}"
  label="${label%.sh}"
  printf '%s' "$label" | tr -c 'A-Za-z0-9_.-' '-'
}

matos_test_tmpdir_base() {
  if mkdir -p "$matos_test_tmpdir_base_default" 2>/dev/null; then
    printf '%s' "$matos_test_tmpdir_base_default"
  else
    local local_tmp="${PWD:-.}/.tmp-test"
    mkdir -p "$local_tmp" 2>/dev/null || true
    printf '%s' "$local_tmp"
  fi
}

matos_test_tmpdir_cleanup_session() {
  local status="${1:-0}"
  if [[ "${MATOS_TEST_TMPDIR_SESSION_CREATED:-0}" != "1" || -z "${MATOS_TEST_TMPDIR_SESSION:-}" ]]; then
    return 0
  fi

  if [[ "$MATOS_TEST_TMPDIR_SESSION" != "$MATOS_TEST_TMPDIR_BASE"/* &&
        "$MATOS_TEST_TMPDIR_SESSION" != "$PWD"/.tmp-test/* ]]; then
    echo "warning: refusing to clean unexpected MATOS_TEST_TMPDIR_SESSION=$MATOS_TEST_TMPDIR_SESSION" >&2
    return 0
  fi

  if [[ "$status" == "0" && "${MATOS_TEST_TMPDIR_KEEP:-0}" != "1" ]]; then
    rm -rf -- "$MATOS_TEST_TMPDIR_SESSION"
  else
    echo "MatOS temp preserved: $MATOS_TEST_TMPDIR_SESSION" >&2
  fi
}

matos_test_tmpdir_cleanup_stale() {
  local age_hours="${1:-${MATOS_TEST_TMPDIR_CLEANUP_AGE_HOURS:-24}}"
  local dry_run="${2:-${MATOS_TEST_TMPDIR_CLEANUP_DRY_RUN:-0}}"
  local age_minutes=$((age_hours * 60))
  local roots=()
  local base
  base="$(matos_test_tmpdir_base)"
  roots+=("$base")

  local root
  for root in "${roots[@]}"; do
    [[ -d "$root" ]] || continue
    if [[ "$root" != "$base" && "$root" != "$PWD/.tmp-test" ]]; then
      echo "warning: refusing to prune unexpected temp root=$root" >&2
      continue
    fi

    if [[ "$dry_run" == "1" ]]; then
      if [[ "$age_minutes" == "0" ]]; then
        find "$root" -mindepth 1 -maxdepth 1 -print 2>/dev/null || true
      else
        find "$root" -mindepth 1 -maxdepth 1 \
          -mmin +"$age_minutes" -print 2>/dev/null || true
      fi
    else
      if [[ "$age_minutes" == "0" ]]; then
        find "$root" -mindepth 1 -maxdepth 1 \
          -exec rm -rf -- {} + 2>/dev/null || true
      else
        find "$root" -mindepth 1 -maxdepth 1 \
          -mmin +"$age_minutes" -exec rm -rf -- {} + 2>/dev/null || true
      fi
    fi
  done
}

if [[ "${MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE:-1}" == "1" ]]; then
  matos_test_tmpdir_cleanup_stale "${MATOS_TEST_TMPDIR_CLEANUP_AGE_HOURS:-24}" 0
fi

matos_test_tmpdir_should_create_session=0
if [[ "${MATOS_TEST_TMPDIR_CREATE_SESSION:-1}" == "1" ]]; then
  # A caller-exported TMPDIR under root /tmp (e.g. TMPDIR=/tmp/foo) is still on
  # the small overlay disk and must be replaced, not honored.
  if [[ -z "${TMPDIR:-}" || "${MATOS_TEST_TMPDIR_FORCE:-0}" == "1" ]] ||
     matos_test_tmpdir_is_root_tmp "${TMPDIR:-}"; then
    matos_test_tmpdir_should_create_session=1
  fi
fi

if [[ "$matos_test_tmpdir_should_create_session" == "1" ]]; then
  MATOS_TEST_TMPDIR_BASE="$(matos_test_tmpdir_base)"
  mkdir -p "$MATOS_TEST_TMPDIR_BASE" 2>/dev/null || true
  matos_test_tmpdir_label="$(matos_test_tmpdir_sanitize_label "${MATOS_TEST_TMPDIR_LABEL:-${0:-matos-test}}")"
  MATOS_TEST_TMPDIR_SESSION="$(mktemp -d "$MATOS_TEST_TMPDIR_BASE/$matos_test_tmpdir_label.XXXXXX" 2>/dev/null || { mkdir -p "$PWD/.tmp-test" 2>/dev/null; mktemp -d "$PWD/.tmp-test/matos-test.XXXXXX"; })"
  MATOS_TEST_TMPDIR_SESSION_CREATED=1
  TMPDIR="$MATOS_TEST_TMPDIR_SESSION"
else
  MATOS_TEST_TMPDIR_BASE="$(matos_test_tmpdir_base)"
  # Never export a root-/tmp TMPDIR or adopt one as the MatOS temp base; the
  # policy base replaces it so downstream consumers cannot inherit the small
  # overlay disk.
  if [[ -z "${TMPDIR:-}" ]] || matos_test_tmpdir_is_root_tmp "$TMPDIR"; then
    TMPDIR="$MATOS_TEST_TMPDIR_BASE"
  else
    MATOS_TEST_TMPDIR_BASE="$TMPDIR"
  fi
  MATOS_TEST_TMPDIR_SESSION_CREATED=0
fi

export TMPDIR
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export MATOS_TEST_TMPDIR_BASE
export MATOS_TEST_TMPDIR_SESSION="${MATOS_TEST_TMPDIR_SESSION:-}"
export MATOS_TEST_TMPDIR_SESSION_CREATED
mkdir -p "$TMPDIR" 2>/dev/null || true

if [[ "$MATOS_TEST_TMPDIR_SESSION_CREATED" == "1" && "${MATOS_TEST_TMPDIR_INSTALL_TRAP:-1}" == "1" ]]; then
  trap 'matos_test_tmpdir_cleanup_session "$?"' EXIT
fi

unset matos_test_tmpdir_should_create_session
unset matos_test_tmpdir_label
