#!/usr/bin/env bash
# The public benchmark entrypoint: pinned DSH, full MatOS context, isolated state.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
work="$PWD"
asset_root="${MATOS_BENCH_ASSET_ROOT:-$root/distribution/benchmark-minimal/benchmark-assets}"
asset_root="$(python3 -c 'import pathlib,sys;p=pathlib.Path(sys.argv[1]).resolve();assert p.is_dir(), "Asset root does not exist";print(p)' "$asset_root")"
if [[ -n "${MATOS_BENCH_ENV_FILE:-}" ]]; then
  complete=0
  while IFS= read -r -d '' key && IFS= read -r -d '' value; do
    if [[ "$key" == __MATOS_ENV_DONE ]]; then complete=1; continue; fi
    export "$key=$value"
  done < <(cd "$root" && bun scripts/matos-web-env.ts "$MATOS_BENCH_ENV_FILE")
  [[ "$complete" == 1 ]] || { echo 'Could not read benchmark provider environment' >&2; exit 2; }
fi
bundle="$(python3 "$root/scripts/matos-dsh-runtime.py" path)"
[[ -f "$bundle/manifest.json" ]] || { echo 'Run scripts/matos-setup.sh before benchmark execution.' >&2; exit 2; }
export PATH="$bundle/node/bin:$bundle/bin:$root/node_modules/.bin:$PATH"
unset MATOS_SCOPE_ID MATOS_SCOPE_REF MATOS_PROJECT_CWD MATOS_ORIGINAL_CWD MATOS_USER_ID MATOS_STANDALONE MATOS_STANDALONE_WORKSPACE MATOS_ASSETS_CWD
export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-}"
[[ -n "$DEEPSEEK_API_KEY" ]] || { echo 'DEEPSEEK_API_KEY is required.' >&2; exit 2; }
export DEEPSEEK_BASE_URL="${DEEPSEEK_BASE_URL:-https://api.deepseek.com/anthropic}"
export MATOS_DSH_MODEL=deepseek-flash MATOS_DSH_EFFORT=max MATOS_DSH_PROVIDER=deepseek-official MATOS_DSH_TIMEOUT_MS=43200000
export MATOS_DSH_BIN="$root/scripts/matos-dsh-launcher.sh" MATOS_DSH_EXEC_BIN="$bundle/bin/dsh"
export MATOS_DSH_PNPM_BIN="$root/node_modules/pnpm/bin/pnpm.cjs" MATOS_DSH_PROFILE_TEMPLATE="$bundle/profiles"
export MATOS_DSH_HOME="$work/.matos/dsh" DSH_HOME="$work/.matos/dsh" MATOS_DSH_OFFLINE=1 MATOS_RUNTIME_COMPILED=0
export MATOS_BUNDLED_ASSET_ROOT="$asset_root" MATOS_ASSET_ROOTS="$asset_root"
export MATOS_ALLOW_NON_VEPFS_DATA_ROOT=1 MATOS_DEPLOY_ROOT="$work/.matos/deployment"
export MATOS_RUNTIME_MATERIALIZATION_DIR="$work/.matos/runtime" MATOS_RUNTIME_DATA_DIR="$work/.matos/runtime-data" MATOS_WORKFLOW_RUNS_DIR="$work/.matos/workflows/runs"
export MATOS_AGENT_HOME="$work/.matos/agent"
export TMPDIR="$work/.matos/tmp" TMP="$work/.matos/tmp" TEMP="$work/.matos/tmp" MATOS_HOST_TMP_DIR="$work/.matos/tmp" MATOS_TMP_DIR="$work/.matos/tmp"
export XDG_CACHE_HOME="$work/.matos/cache" PIP_CACHE_DIR="$work/.matos/cache/pip" MPLCONFIGDIR="$work/.matos/cache/matplotlib" MPLBACKEND=Agg
export MATOS_DISABLE_EVOLUTION=1 MATOS_DISABLE_EVOLUTION_WORKER=1 MATOS_DISABLE_EVOLUTION_JOBS=1 MATOS_DISABLE_ALWAYS_ON_LEARNING=1 MATOS_DISABLE_SELF_EVOLUTION=1 MATOS_EVOLUTION_PROVIDER=disabled MATOS_BENCHMARK_MODE=1
export OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 NUMEXPR_NUM_THREADS=4 PYTHONUNBUFFERED=1
matos_short_tmp="$(cd "$root" && bun scripts/matos-standalone-tmp.ts "$work/.matos/tmp")"
export TMPDIR="$matos_short_tmp" TMP="$matos_short_tmp" TEMP="$matos_short_tmp" MATOS_HOST_TMP_DIR="$matos_short_tmp" MATOS_TMP_DIR="$matos_short_tmp"
mkdir -p "$TMPDIR" "$MATOS_AGENT_HOME"
python3 - "$asset_root" "$work" <<'PY'
import json,sys
from pathlib import Path
asset_root,work=map(Path,sys.argv[1:]);p=work/'.matos/matos.json'
if p.exists():
 config=json.loads(p.read_text())
 roots=[str((p.parent/Path(r)).resolve()) for r in config.get('assetRoots',[])]
 if roots!=[str(asset_root)] or config.get('includeDefaultAssetRoots',True) or config.get('assetSources') or config.get('assetMounts'):
  raise SystemExit('Benchmark workspace uses different assets; choose a new run directory.')
else:
 p.write_text(json.dumps({'version':1,'name':work.name,'assetRoots':[str(asset_root)],'includeDefaultAssetRoots':False,'assetSources':[],'assetMounts':[]},indent=2)+'\n')
PY
exec "$root/bin/matos" "$@"
