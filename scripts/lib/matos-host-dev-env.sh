#!/usr/bin/env bash
# Host-side MatOS development/cache policy.
#
# This helper is intentionally shell-only so build, checkpoint, smoke, and
# maintenance scripts can source it before invoking bun/npm/pip or mktemp-heavy
# work. It keeps transient host artifacts off the small root volume and on the
# MatOS temp root.

if [[ "${MATOS_HOST_DEV_ENV_DISABLED:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

matos_host_dev_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
matos_host_dev_repo_root="$(cd "$matos_host_dev_script_dir/../.." && pwd)"

matos_host_dev_cache_root_default() {
  if [[ -n "${MATOS_HOST_CACHE_ROOT:-}" ]]; then
    printf '%s\n' "$MATOS_HOST_CACHE_ROOT"
    return 0
  fi
  if [[ -n "${MATOS_DEPLOY_ROOT:-}" ]]; then
    printf '%s\n' "${MATOS_DEPLOY_ROOT%/}/tmp/host-dev-cache"
    return 0
  fi
  printf '%s\n' "$matos_host_dev_repo_root/.matos/build-cache"
}

matos_host_dev_prepare_root() {
  local root="$1"
  if mkdir -p "$root" 2>/dev/null && [[ -w "$root" ]]; then
    printf '%s\n' "$root"
    return 0
  fi
  root="$matos_host_dev_repo_root/.matos/tmp/host-dev-cache"
  mkdir -p "$root" 2>/dev/null || true
  printf '%s\n' "$root"
}

matos_host_dev_path_is_root_backed() {
  local path="${1:-}"
  # A short socket alias may point to the configured large-volume storage.
  # Classify its destination, otherwise we silently replace the caller's root.
  if [[ -d "$path" ]]; then
    path="$(cd "$path" && pwd -P)"
  fi
  case "$path" in
    ''|/tmp|/tmp/*|/var/tmp|/var/tmp/*|/root|/root/*|/ebs|/ebs/*|/ebs/docker|/ebs/docker/*)
      return 0
      ;;
  esac
  return 1
}

matos_host_dev_set_cache_path() {
  local var="$1"
  local desired="$2"
  local current="${!var:-}"
  if [[ "${MATOS_HOST_DEV_ENV_FORCE:-0}" == "1" ]] ||
     [[ -z "$current" ]] ||
     matos_host_dev_path_is_root_backed "$current"; then
    export "$var=$desired"
  fi
}

MATOS_HOST_CACHE_ROOT="$(matos_host_dev_prepare_root "$(matos_host_dev_cache_root_default)")"
export MATOS_HOST_CACHE_ROOT

matos_host_dev_set_cache_path TMPDIR "$MATOS_HOST_CACHE_ROOT/tmp"
matos_host_dev_set_cache_path TMP "$TMPDIR"
matos_host_dev_set_cache_path TEMP "$TMPDIR"
matos_host_dev_set_cache_path XDG_CACHE_HOME "$MATOS_HOST_CACHE_ROOT/xdg"
matos_host_dev_set_cache_path BUN_INSTALL_CACHE_DIR "$MATOS_HOST_CACHE_ROOT/bun"
matos_host_dev_set_cache_path NPM_CONFIG_CACHE "$MATOS_HOST_CACHE_ROOT/npm"
matos_host_dev_set_cache_path npm_config_cache "$NPM_CONFIG_CACHE"
matos_host_dev_set_cache_path PIP_CACHE_DIR "$MATOS_HOST_CACHE_ROOT/pip"
matos_host_dev_set_cache_path UV_CACHE_DIR "$MATOS_HOST_CACHE_ROOT/uv"
matos_host_dev_set_cache_path PLAYWRIGHT_BROWSERS_PATH "$MATOS_HOST_CACHE_ROOT/playwright"
matos_host_dev_set_cache_path CYPRESS_CACHE_FOLDER "$MATOS_HOST_CACHE_ROOT/cypress"

export NEXT_TELEMETRY_DISABLED="${NEXT_TELEMETRY_DISABLED:-1}"
export npm_config_cache

mkdir -p \
  "$TMPDIR" \
  "$XDG_CACHE_HOME" \
  "$BUN_INSTALL_CACHE_DIR" \
  "$NPM_CONFIG_CACHE" \
  "$PIP_CACHE_DIR" \
  "$UV_CACHE_DIR" \
  "$PLAYWRIGHT_BROWSERS_PATH" \
  "$CYPRESS_CACHE_FOLDER" 2>/dev/null || true

if [[ ! -w "$TMPDIR" ]]; then
  echo "blocker: MatOS host TMPDIR is not writable: $TMPDIR" >&2
  return 2 2>/dev/null || exit 2
fi

unset -f matos_host_dev_cache_root_default
unset -f matos_host_dev_prepare_root
unset -f matos_host_dev_path_is_root_backed
unset -f matos_host_dev_set_cache_path
unset matos_host_dev_script_dir
unset matos_host_dev_repo_root
