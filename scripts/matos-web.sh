#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
bundle="$(python3 "$root/scripts/matos-dsh-runtime.py" path)"
export PATH="$root/bin:$root/node_modules/.bin:$bundle/node/bin:$PATH"
action="${1:-start}"
[[ $# == 0 ]] || shift
state="${MATOS_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/matos}"
web_port="${MATOS_WEB_PORT:-17464}"
daemon_port="${MATOS_DAEMON_PORT:-17463}"
env_args=(--no-env-file)
env_file=""
asset_root=""
asset_profile=""
if [[ -f "$root/.matos/public-installation.json" ]]; then
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    case "$key" in assetRoot) asset_root="$value" ;; profile) asset_profile="$value" ;; esac
  done < <(python3 - "$root" <<'PY'
import json,sys
from pathlib import Path
r=Path(sys.argv[1]);d=json.loads((r/'.matos/public-installation.json').read_text())
for k in ['assetRoot','profile']:
 v=str((r/d[k]).resolve()) if k=='assetRoot' else d[k]
 sys.stdout.write(k+'\0'+v+'\0')
PY
)
fi
asset_profile="${asset_profile:-workspace}"
asset_selection_explicit=0
asset_root_explicit=0
asset_profile_explicit=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-dir|--port|--daemon-port|--env-file|--asset-root|--asset-profile)
      [[ $# -ge 2 && -n "$2" ]] || { echo "Missing value for $1" >&2; exit 2; }
      case "$1" in
        --state-dir) state="$2" ;;
        --port) web_port="$2" ;;
        --daemon-port) daemon_port="$2" ;;
        --env-file) env_file="$2" ;;
        --asset-root) asset_root="$2"; asset_selection_explicit=1; asset_root_explicit=1 ;;
        --asset-profile) asset_profile="$2"; asset_selection_explicit=1; asset_profile_explicit=1 ;;
      esac
      shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$action" in start|stop|status) ;; *) echo "Usage: $0 start|stop|status [--state-dir DIR] [--port N] [--daemon-port N] [--env-file FILE] [--asset-profile workspace|benchmark] [--asset-root DIR]" >&2; exit 2 ;; esac
if [[ "$asset_profile_explicit" == 1 && "$asset_root_explicit" == 0 ]]; then asset_root=""; fi
if [[ "$action" == start ]]; then python3 "$root/scripts/matos-dsh-runtime.py" verify >/dev/null; fi
command -v bun >/dev/null
command -v git >/dev/null
command -v pnpm >/dev/null
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("MatOS web requires Node 24")'
if [[ -n "$env_file" ]]; then
  [[ -f "$env_file" ]] || { echo "Environment file does not exist: $env_file" >&2; exit 2; }
  env_file="$(node -p 'require("node:path").resolve(process.argv[1])' "$env_file")"
  matos_env_done=0
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    if [[ "$key" == __MATOS_ENV_DONE ]]; then matos_env_done=1; continue; fi
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || { echo "Invalid environment key" >&2; exit 2; }
    export "$key=$value"
  done < <(cd "$root" && bun scripts/matos-web-env.ts "$env_file")
  [[ "$matos_env_done" == 1 ]] || { echo "Could not load environment file" >&2; exit 2; }
  export PATH="$root/bin:$root/node_modules/.bin:$bundle/node/bin:$PATH"
fi
mkdir -p "$state"
state="$(cd "$state" && pwd)"
if [[ "$asset_selection_explicit" == 0 && -f "$state/asset-profile.json" ]]; then
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    case "$key" in assetRoot) asset_root="$value" ;; profile) asset_profile="$value" ;; esac
  done < <(python3 - "$state/asset-profile.json" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for k in ['assetRoot','profile']:sys.stdout.write(k+'\0'+d[k]+'\0')
PY
)
fi
namespace="$(node -e 'process.stdout.write("matos-" + require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 12))' "$state")"
if [[ -z "$asset_root" ]]; then
  case "$asset_profile" in
    workspace) asset_root="$root/distribution/benchmark-minimal/assets" ;;
    benchmark) asset_root="$root/distribution/benchmark-minimal/benchmark-assets" ;;
  esac
fi
case "$asset_profile" in workspace|benchmark) ;; *) echo "Unknown asset profile: $asset_profile" >&2; exit 2 ;; esac
asset_root="$(python3 -c 'from pathlib import Path;import sys;print(Path(sys.argv[1]).resolve())' "$asset_root")"

export MATOS_BUNDLED_ASSET_ROOT="$asset_root"
if [[ "$asset_profile" == workspace || "$asset_profile" == benchmark ]]; then
  unset MATOS_ASSET_ROOTS MATOS_DEFAULT_ASSET_ROOTS MATOS_SHARED_ASSET_ROOT MATOS_TEAM_ASSET_ROOT MATOS_GLOBAL_ASSET_ROOT MATOS_INCLUDE_LEGACY_ASSETS
fi
export MATOS_BIN="$root/bin/matos" MATOS_STANDALONE=1 MATOS_OPEN_DESIGN_ENABLED=1
if [[ -x "$root/node_modules/pnpm/bin/pnpm.cjs" ]]; then
  export MATOS_DSH_PNPM_BIN="${MATOS_DSH_PNPM_BIN:-$root/node_modules/pnpm/bin/pnpm.cjs}"
fi
export MATOS_ASSETS_CWD="$state/workspace" MATOS_STANDALONE_WORKSPACE="$state/workspace" MATOS_SCOPE_REF=user:local MATOS_USER_ID=local
export MATOS_ALLOW_NON_VEPFS_DATA_ROOT=1 MATOS_DEPLOY_ROOT="$state/deployment"
export MATOS_RUNTIME_DATA_DIR="$state/runtime" MATOS_RUNTIME_MATERIALIZATION_DIR="$state/materialization"
export MATOS_GOVERNANCE_ROOT="$state/governance" MATOS_BACKUP_ROOT="$state/backups"
export MATOS_FEEDBACK_DIR="$state/feedback"
matos_short_tmp="$(cd "$root" && bun scripts/matos-standalone-tmp.ts "$state/tmp")"
export TMPDIR="$matos_short_tmp" TMP="$matos_short_tmp" TEMP="$matos_short_tmp" MATOS_HOST_TMP_DIR="$matos_short_tmp" MATOS_TMP_DIR="$matos_short_tmp"
export OD_TOOLS_DEV_STARTUP_TIMEOUT_MS="${OD_TOOLS_DEV_STARTUP_TIMEOUT_MS:-180000}"
export OD_DATA_DIR="$state/ui" MATOS_AGENT_HOME="$state/native-agent" DSH_HOME="$state/dsh" MATOS_DSH_HOME="$state/dsh"
export OD_BIND_HOST=127.0.0.1 OD_HOST=127.0.0.1
export MATOS_DSH_EXEC_BIN="$bundle/bin/dsh" MATOS_DSH_PROFILE_TEMPLATE="$bundle/profiles"
export MATOS_DSH_PNPM_BIN="$bundle/pnpm/bin/pnpm.cjs" MATOS_DSH_OFFLINE=1
export NEXT_TELEMETRY_DISABLED=1
export XDG_CACHE_HOME="$state/cache" PIP_CACHE_DIR="$state/cache/pip" UV_CACHE_DIR="$state/cache/uv"
export npm_config_cache="$state/cache/npm" npm_config_devdir="$state/cache/node-gyp"
export BUN_INSTALL_CACHE_DIR="$state/cache/bun" MPLCONFIGDIR="$state/cache/matplotlib"
export MATOS_STATE_DIR="$state"
control="${MATOS_WEB_CONTROL_ROOT:-$state/control}"
if [[ "$action" == start ]]; then
  (cd "$root/ui/open-design" && node scripts/native-doctor.ts) > "$state/native-dependencies-check.json"
  (cd "$root" && bun scripts/matos-minimal-assets-check.ts "$asset_root" "$asset_profile") > "$state/public-assets-check.json"
  # A preview keeps its original base catalog across restarts. User/project
  # accepted assets remain separate and may evolve through native services.
  python3 - "$state" "$asset_root" "$asset_profile" <<'PY'
import json,sys
from pathlib import Path
state,root,profile=sys.argv[1:]
p=Path(state)/'asset-profile.json'
binding={'assetRoot':root,'profile':profile}
if p.exists():
    if json.loads(p.read_text())!=binding:
        raise SystemExit('This state directory is bound to another asset profile; use a new --state-dir.')
elif (Path(state)/'workspace/.matos/matos.json').exists():
    raise SystemExit('An existing workspace has no minimal-profile receipt; use a new --state-dir.')
else:
    with p.open('x') as f:f.write(json.dumps(binding,indent=2)+'\n')
PY
  [[ -f "$root/ui/open-design/apps/web/out/index.html" && -f "$root/ui/open-design/apps/daemon/dist/cli.js" ]] || {
    echo "Build the OpenDesign daemon and web packages before starting MatOS." >&2; exit 2;
  }
  python3 - "$state" "$web_port" "$daemon_port" <<'PY'
import json,os,sys
from pathlib import Path
state=Path(sys.argv[1])
p=state/'runtime-config.json';stage=p.with_suffix('.pending')
stage.write_text(json.dumps({'webPort':int(sys.argv[2]),'daemonPort':int(sys.argv[3])})+'\n')
os.replace(stage,p)
PY
  mkdir -p "$MATOS_ASSETS_CWD"
  (cd "$MATOS_ASSETS_CWD" && "$MATOS_BIN" init --standalone --scope "$MATOS_SCOPE_REF")
fi
cd "$root/ui/open-design"
case "$action" in
  start) exec pnpm tools-dev start web --prod --namespace "$namespace" --tools-dev-root "$control" --daemon-port "$daemon_port" --web-port "$web_port" "${env_args[@]}" --json ;;
  stop|status) exec pnpm tools-dev "$action" --namespace "$namespace" --tools-dev-root "$control" "${env_args[@]}" --json ;;
esac
