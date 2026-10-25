#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

usage() {
  cat <<'USAGE'
Usage:
  scripts/matos-clean-tmp.sh [--dry-run] [--age-hours N] [--all] [--legacy-root-tmp]

Safely prune MatOS-owned temporary files from the canonical MatOS
test TMPDIR. Inside that dedicated base every top-level entry is MatOS-owned
and prunable by age; outside it nothing is touched. The name allowlist
(matos-*, qa-*, ...) applies to the optional --legacy-root-tmp pass only.
User workspaces, assets, deployment state, caches, root /tmp, and non-MatOS
temp files are not touched.

Options:
  --dry-run       Print candidates without deleting them.
  --age-hours N   Delete entries older than N hours. Default: 24.
  --all           Delete allowlisted entries regardless of age.
  --legacy-root-tmp
                  Also prune MatOS-owned temp dirs left directly under /tmp by
                  older/manual test commands. This never removes non-MatOS names.
USAGE
}

dry_run=0
legacy_root_tmp=0
age_hours="${MATOS_TEST_TMPDIR_CLEANUP_AGE_HOURS:-24}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --age-hours)
      age_hours="${2:-}"
      if [[ -z "$age_hours" || ! "$age_hours" =~ ^[0-9]+$ ]]; then
        echo "blocker: --age-hours requires a non-negative integer" >&2
        exit 2
      fi
      shift 2
      ;;
    --all)
      age_hours=0
      shift
      ;;
    --legacy-root-tmp)
      legacy_root_tmp=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "blocker: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

MATOS_TEST_TMPDIR_CREATE_SESSION=0 \
MATOS_TEST_TMPDIR_PRUNE_ON_SOURCE=0 \
  . "$ROOT/scripts/lib/matos-test-tmpdir.sh"

before="$(df -h / | awk 'NR==2 {print $4 " available (" $5 " used)"}')"
echo "root before: $before"
echo "tmp base: $MATOS_TEST_TMPDIR_BASE"
echo "age hours: $age_hours"
if [[ "$dry_run" == "1" ]]; then
  echo "mode: dry-run"
else
  echo "mode: delete"
fi

matos_test_tmpdir_cleanup_stale "$age_hours" "$dry_run"

if [[ "$legacy_root_tmp" == "1" ]]; then
  echo "legacy root tmp: /tmp"
  find_args=(
    /tmp
    -mindepth 1
    -maxdepth 1
    -type d
    '(' -name 'matos-*' -o -name 'qa-*' -o -name 'bun-matos-*' -o -name 'playwright-matos-*' ')'
  )
  if [[ "$age_hours" != "0" ]]; then
    find_args+=( -mmin "+$((age_hours * 60))" )
  fi
  if [[ "$dry_run" == "1" ]]; then
    find "${find_args[@]}" -print 2>/dev/null || true
  else
    find "${find_args[@]}" -exec rm -rf -- {} + 2>/dev/null || true
  fi
fi

after="$(df -h / | awk 'NR==2 {print $4 " available (" $5 " used)"}')"
echo "root after:  $after"
