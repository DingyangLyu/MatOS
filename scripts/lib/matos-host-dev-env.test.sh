#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$ROOT/scripts/lib/matos-host-dev-env.sh"

tmp_parent="${MATOS_TEST_TMPDIR_BASE:-$ROOT/.tmp-test}"
mkdir -p "$tmp_parent"
tmp="$(mktemp -d "$tmp_parent/matos-host-dev-env-test.XXXXXX")"
cleanup() {
  rm -rf "$tmp"
}
trap cleanup EXIT

run_env_probe() {
  local script="$1"
  env -i bash -c "$script"
}

cache_root="$tmp/cache"
output="$(
  run_env_probe '
    set -euo pipefail
    export HOME=/root
    export PWD=/repo
    export TMPDIR=/tmp
    export TMP=/tmp
    export TEMP=/tmp
    export XDG_CACHE_HOME=/root/.cache
    export BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
    export NPM_CONFIG_CACHE=/tmp/npm-cache
    export npm_config_cache=/tmp/npm-lower-cache
    export PIP_CACHE_DIR=/tmp/pip-cache
    export UV_CACHE_DIR=/tmp/uv-cache
    export MATOS_HOST_CACHE_ROOT="'"$cache_root"'"
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
    printf "XDG_CACHE_HOME=%s\n" "$XDG_CACHE_HOME"
    printf "BUN_INSTALL_CACHE_DIR=%s\n" "$BUN_INSTALL_CACHE_DIR"
    printf "NPM_CONFIG_CACHE=%s\n" "$NPM_CONFIG_CACHE"
    printf "npm_config_cache=%s\n" "$npm_config_cache"
    printf "PIP_CACHE_DIR=%s\n" "$PIP_CACHE_DIR"
    printf "UV_CACHE_DIR=%s\n" "$UV_CACHE_DIR"
  '
)"

printf '%s\n' "$output" | grep -q "^TMPDIR=$cache_root/tmp$"
printf '%s\n' "$output" | grep -q "^XDG_CACHE_HOME=$cache_root/xdg$"
printf '%s\n' "$output" | grep -q "^BUN_INSTALL_CACHE_DIR=$cache_root/bun$"
printf '%s\n' "$output" | grep -q "^NPM_CONFIG_CACHE=$cache_root/npm$"
printf '%s\n' "$output" | grep -q "^npm_config_cache=$cache_root/npm$"
printf '%s\n' "$output" | grep -q "^PIP_CACHE_DIR=$cache_root/pip$"
printf '%s\n' "$output" | grep -q "^UV_CACHE_DIR=$cache_root/uv$"
test -d "$cache_root/tmp"
test -d "$cache_root/bun"

safe_tmp="$tmp/safe-tmp"
safe_cache="$tmp/safe-cache"
mkdir -p "$safe_tmp" "$safe_cache"
output="$(
  run_env_probe '
    set -euo pipefail
    export TMPDIR="'"$safe_tmp"'"
    export XDG_CACHE_HOME="'"$safe_cache"'"
    export MATOS_HOST_CACHE_ROOT="'"$cache_root"'"
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
    printf "XDG_CACHE_HOME=%s\n" "$XDG_CACHE_HOME"
  '
)"

printf '%s\n' "$output" | grep -q "^TMPDIR=$safe_tmp$"
printf '%s\n' "$output" | grep -q "^XDG_CACHE_HOME=$safe_cache$"

forced_root="$tmp/forced"
output="$(
  run_env_probe '
    set -euo pipefail
    export TMPDIR="'"$safe_tmp"'"
    export XDG_CACHE_HOME="'"$safe_cache"'"
    export MATOS_HOST_CACHE_ROOT="'"$forced_root"'"
    export MATOS_HOST_DEV_ENV_FORCE=1
    . "'"$helper"'"
    printf "TMPDIR=%s\n" "$TMPDIR"
    printf "XDG_CACHE_HOME=%s\n" "$XDG_CACHE_HOME"
  '
)"

printf '%s\n' "$output" | grep -q "^TMPDIR=$forced_root/tmp$"
printf '%s\n' "$output" | grep -q "^XDG_CACHE_HOME=$forced_root/xdg$"
