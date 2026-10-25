#!/usr/bin/env bash
set -euo pipefail

dsh_version="${MATOS_DSH_VERSION:-0.2.1-alpha.2}"
dsh_exec_bin="${MATOS_DSH_EXEC_BIN:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Explicit prepared/staging bundles also work while the active pointer needs repair.
# Runtime preparation invokes this launcher before its new manifest is written.
if [[ -n "$dsh_exec_bin" ]]; then
  bundled_runtime="$(dirname "$(dirname "$dsh_exec_bin")")"
else
  bundled_runtime="$(python3 "$repo_root/scripts/matos-dsh-runtime.py" path)"
fi
if [[ -x "$bundled_runtime/bin/dsh" ]]; then
  export PATH="$bundled_runtime/node/bin:$PATH"
  dsh_exec_bin="${dsh_exec_bin:-$bundled_runtime/bin/dsh}"
  export MATOS_DSH_PNPM_BIN="${MATOS_DSH_PNPM_BIN:-$bundled_runtime/pnpm/bin/pnpm.cjs}"
  # An explicitly empty template requests a clean bootstrap during preparation.
  export MATOS_DSH_PROFILE_TEMPLATE="${MATOS_DSH_PROFILE_TEMPLATE-$bundled_runtime/profiles}"
  export MATOS_DSH_OFFLINE="${MATOS_DSH_OFFLINE:-1}"
fi
npx_bin=""
if [[ -n "$dsh_exec_bin" ]]; then
  if [[ ! -x "$dsh_exec_bin" ]]; then
    echo "DSH preinstalled executable is missing or not executable: $dsh_exec_bin" >&2
    exit 127
  fi
elif [[ "${MATOS_DSH_OFFLINE:-0}" == "1" ]]; then
  echo "Offline DSH requires a preinstalled runtime; set MATOS_DSH_EXEC_BIN" >&2
  exit 127
else
  npx_bin="${MATOS_NPX_BIN:-$(command -v npx || true)}"
  if [[ ! -x "$npx_bin" ]]; then
    npx_bin="$(command -v npx || true)"
  fi
  if [[ -z "$npx_bin" || ! -x "$npx_bin" ]]; then
    echo "DSH launcher cannot find npx; set MATOS_NPX_BIN" >&2
    exit 127
  fi
fi
if [[ "${MATOS_DSH_OFFLINE:-0}" == "1" ]]; then
  export npm_config_offline=true
  export COREPACK_ENABLE_NETWORK=0
fi

# DSH itself only reads DSH_HOME. Keep MATOS_DSH_HOME as the MatOS-facing
# override, but export the canonical name so direct launcher calls stay scoped.
export DSH_HOME="${DSH_HOME:-${MATOS_DSH_HOME:-$HOME/.dsh}}"

dsh_run() {
  if [[ -n "$dsh_exec_bin" ]]; then
    "$dsh_exec_bin" "$@"
  else
    "$npx_bin" --yes "@deepseek-ai/dsh@${dsh_version}" "$@"
  fi
}

# Profile installation invokes pnpm. Prefer an operator-pinned binary or an
# already cached Corepack payload; never let a first turn block on an implicit
# Corepack download. If no cached binary exists, retain normal PATH resolution
# and let setup report the missing dependency.
dsh_pnpm_bin="${MATOS_DSH_PNPM_BIN:-}"
if [[ -z "$dsh_pnpm_bin" && -x "$repo_root/node_modules/pnpm/bin/pnpm.cjs" ]]; then
  dsh_pnpm_bin="$repo_root/node_modules/pnpm/bin/pnpm.cjs"
fi
if [[ -z "$dsh_pnpm_bin" ]]; then
  dsh_pnpm_bin="$(command -v pnpm || true)"
fi
if [[ -n "$dsh_pnpm_bin" && -x "$dsh_pnpm_bin" && "${1:-}" == "--profile" ]]; then
  mkdir -p "$DSH_HOME/.bin"
  cat > "$DSH_HOME/.bin/pnpm" <<EOF
#!/usr/bin/env bash
exec "${dsh_pnpm_bin}" "\$@"
EOF
  chmod 700 "$DSH_HOME/.bin/pnpm"
  export PATH="$DSH_HOME/.bin:$PATH"
  export COREPACK_ENABLE_PROJECT_SPEC=0
fi

if [[ "${MATOS_DSH_ENABLE_MATOS_PLUGIN:-1}" == "1" && "${1:-}" == "--profile" && -n "${2:-}" ]]; then
  profile="$2"
  dsh_home="$DSH_HOME"
  plugin_path="${MATOS_DSH_PLUGIN_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/vendor/deepseek-harness/matos-plugin}"
  sdk_plugin_path="${MATOS_DSH_SDK_PLUGIN_PATH:-$(dirname "$plugin_path")/matos-sdk-profile}"
  if [[ "$profile" == sdk && "${MATOS_DSH_NATIVE_SDK:-0}" == 1 && -n "${MATOS_DSH_PROFILE_TEMPLATE:-}" ]]; then
    profile="$(python3 "$repo_root/scripts/matos-dsh-profile.py" --home "$dsh_home" --template "$MATOS_DSH_PROFILE_TEMPLATE" --profile sdk --version "$dsh_version" --plugin "$plugin_path" --sdk-plugin "$sdk_plugin_path")"
    set -- --profile "$profile" "${@:3}"
  fi
  marker="$dsh_home/profiles/$profile/.matos-plugin-installed"
  if [[ -d "$plugin_path" ]]; then
    if [[ "$profile" == *'/'* || "$profile" == '.' || "$profile" == '..' ]]; then
      echo "DSH profile must be a simple profile name" >&2
      exit 64
    fi
    mkdir -p "$dsh_home/profiles"
    # Templates contain package dependencies only. Every scope gets its own
    # writable profile and session store; never point a user at the template.
    exec 8>"$dsh_home/profiles/.matos-bootstrap.lock"
    flock -w "${MATOS_DSH_PLUGIN_LOCK_TIMEOUT_SEC:-180}" 8
    template="${MATOS_DSH_PROFILE_TEMPLATE:-}"
    if [[ ! -f "$dsh_home/profiles/$profile/package.json" && -n "$template" ]]; then
      if [[ ! -f "$template/$profile/.matos-plugin-installed" ]]; then
        echo "Prepared DSH profile template is missing: $profile" >&2
        exit 78
      fi
      mkdir -p "$dsh_home/profiles/$profile"
      cp -a "$template/$profile/." "$dsh_home/profiles/$profile/"
      chmod -R u+rwX "$dsh_home/profiles/$profile"
    fi
    flock -u 8
    exec 8>&-
    mkdir -p "$dsh_home/profiles/$profile"
    lock="$dsh_home/profiles/$profile/.matos-plugin.lock"
    exec 9>"$lock"
    lock_timeout="${MATOS_DSH_PLUGIN_LOCK_TIMEOUT_SEC:-180}"
    if ! flock -w "$lock_timeout" 9; then
      echo "DSH plugin installation lock timed out after ${lock_timeout}s" >&2
      exit 75
    fi
    stamp_files=("$plugin_path/package.json" "$plugin_path"/*.js "$plugin_path/cordis.patch.yml")
    if [[ "${MATOS_DSH_NATIVE_SDK:-0}" == "1" ]]; then
      stamp_files+=("$sdk_plugin_path/package.json" "$sdk_plugin_path"/*.js "$sdk_plugin_path/cordis.patch.yml")
    fi
    plugin_stamp="$({ printf '%s\n' "$dsh_version"; for stamp_file in "${stamp_files[@]}"; do [[ "$stamp_file" == *.test.js ]] && continue; sha256sum "$stamp_file" | awk '{print $1}'; done; } | sha256sum | awk '{print $1}')"
    installed_stamp="$(cat "$marker" 2>/dev/null || true)"
    if [[ -z "$plugin_stamp" || "$installed_stamp" != "$plugin_stamp" ]]; then
      if [[ "${MATOS_DSH_OFFLINE:-0}" == "1" ]]; then
        echo "Offline DSH profile is not prepared for this MatOS version; preinstall the matching plugins before export" >&2
        exit 78
      fi
      dsh_run plugin --profile "$profile" add "file:$plugin_path" >/dev/null
      if [[ "${MATOS_DSH_NATIVE_SDK:-0}" == "1" ]]; then
        dsh_run plugin --profile "$profile" add "file:$sdk_plugin_path" >/dev/null
      fi
      printf '%s\n' "$plugin_stamp" > "$marker"
    fi
    flock -u 9
    exec 9>&-
  else
    echo "MatOS DSH plugin bundle is missing: $plugin_path" >&2
    exit 78
  fi
fi

if [[ -n "$dsh_exec_bin" ]]; then
  exec "$dsh_exec_bin" "$@"
fi
exec "$npx_bin" --yes "@deepseek-ai/dsh@${dsh_version}" "$@"
