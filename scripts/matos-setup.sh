#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
mode=""
asset_profile="${MATOS_ASSET_PROFILE:-workspace}"
asset_root=""
offline=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h) echo "Usage: $0 [--web-only|--rebuild-runtime] [--asset-profile workspace|benchmark] [--asset-root DIR] [--offline]"; exit 0 ;;
    --web-only|--rebuild-runtime) mode="$1"; shift ;;
    --offline) offline=1; shift ;;
    --asset-profile|--asset-root)
      [[ $# -ge 2 ]] || { echo "Missing value for $1" >&2; exit 2; }
      if [[ "$1" == --asset-profile ]]; then asset_profile="$2"; else asset_root="$2"; fi
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$asset_profile" in workspace|benchmark) ;; *) echo "Unknown asset profile" >&2; exit 2 ;; esac
if [[ -z "$asset_root" ]]; then
  case "$asset_profile" in
    workspace) asset_root="$root/distribution/benchmark-minimal/assets" ;;
    benchmark) asset_root="$root/distribution/benchmark-minimal/benchmark-assets" ;;
  esac
fi
asset_root="$(python3 -c 'from pathlib import Path;import sys;print(Path(sys.argv[1]).resolve())' "$asset_root")"

missing=()
for cmd in node bun git python3; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required commands: ${missing[*]}. ./deploy.sh installs a private Node and Bun; see docs/deploy.md." >&2
  exit 2
fi
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] ||
  { echo "Node 24 is required (found $(node --version)). ./deploy.sh installs a private Node 24; see docs/deploy.md." >&2; exit 2; }
[[ "$(bun --version)" == 1.3.14 ]] ||
  { echo "Bun 1.3.14 is required (found $(bun --version)). ./deploy.sh installs a private Bun; see docs/deploy.md." >&2; exit 2; }
python3 -c 'import sys; assert sys.version_info >= (3,9), "Python 3.9+ is required"'
# Reuse headers shipped with the active Node distribution when versions match.
# An explicit npm_config_nodedir always wins.
if [[ -z "${npm_config_nodedir:-}" ]]; then
  node_headers_root="$(node - <<'JS'
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(fs.realpathSync(process.execPath), '../..');
try {
  const header = fs.readFileSync(path.join(root, 'include/node/node_version.h'), 'utf8');
  const macros = Object.fromEntries([...header.matchAll(/^#define NODE_(MAJOR|MINOR|PATCH)_VERSION\s+(\d+)/gm)].map(m => [m[1], m[2]]));
  const version = ['MAJOR', 'MINOR', 'PATCH'].map(part => macros[part]).join('.');
  if (version === process.versions.node) process.stdout.write(root);
} catch {}
JS
)"
  if [[ -n "$node_headers_root" ]]; then export npm_config_nodedir="$node_headers_root"; fi
fi
export MATOS_BUILD_CACHE_DIR="${MATOS_BUILD_CACHE_DIR:-$root/.matos/build-cache}"
mkdir -p "$MATOS_BUILD_CACHE_DIR/tmp"
export TMPDIR="$MATOS_BUILD_CACHE_DIR/tmp" TMP="$MATOS_BUILD_CACHE_DIR/tmp" TEMP="$MATOS_BUILD_CACHE_DIR/tmp"
export npm_config_cache="$MATOS_BUILD_CACHE_DIR/npm" npm_config_devdir="$MATOS_BUILD_CACHE_DIR/node-gyp"
export BUN_INSTALL_CACHE_DIR="$MATOS_BUILD_CACHE_DIR/bun"
cd "$root"
if [[ "$offline" == 0 ]]; then
  bun install --frozen-lockfile
else
  python3 - "$root" <<'PY'
import json,sys,hashlib,platform
from pathlib import Path
r=Path(sys.argv[1]);p=r/'.matos/offline-dependencies.json'
if not p.exists():raise SystemExit('Offline setup requires dependencies prepared by a successful setup on the same OS/CPU.')
d=json.loads(p.read_text())
if d['platform']!=[sys.platform,platform.machine()]:raise SystemExit('Offline dependencies belong to another platform.')
for name,digest in d['locks'].items():
 if hashlib.sha256((r/name).read_bytes()).hexdigest()!=digest:raise SystemExit('Offline dependencies do not match '+name)
if not (r/'node_modules').is_dir() or not (r/'ui/open-design/node_modules').is_dir():raise SystemExit('Offline dependency directories are missing.')
PY
fi
export PATH="$root/node_modules/.bin:$PATH" NEXT_TELEMETRY_DISABLED=1
bun scripts/matos-minimal-assets-check.ts "$asset_root" "$asset_profile"
if [[ "$mode" != --web-only ]]; then
  runtime_args=()
  [[ "$offline" == 0 ]] || export MATOS_DSH_OFFLINE=1
  [[ "$mode" != --rebuild-runtime ]] || runtime_args+=(--rebuild)
  [[ -z "${MATOS_DSH_RUNTIME_SOURCE:-}" ]] || runtime_args+=(--runtime-source "$MATOS_DSH_RUNTIME_SOURCE")
  [[ -z "${MATOS_DSH_PROFILE_TEMPLATE:-}" ]] || runtime_args+=(--profile-template "$MATOS_DSH_PROFILE_TEMPLATE")
  python3 scripts/matos-dsh-runtime.py ensure --node "$(command -v node)" --pnpm-root "$root/node_modules/pnpm" "${runtime_args[@]}"
fi
cd "$root/ui/open-design"
if [[ "$offline" == 0 ]]; then
  pnpm install --frozen-lockfile
  node scripts/native-doctor.ts --repair
else
  node scripts/native-doctor.ts
fi
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/web build
pnpm --filter @open-design/web build:sidecar
pnpm --filter @open-design/tools-dev build
python3 - "$root" "$asset_root" "$asset_profile" <<'PY'
import json,sys,os,hashlib,platform
from pathlib import Path
root,assets,profile=sys.argv[1:]
root=Path(root).resolve();assets=Path(assets).resolve()
try: stored=str(assets.relative_to(root))
except ValueError: stored=str(assets)
p=root/'.matos/public-installation.json'
p.parent.mkdir(parents=True,exist_ok=True)
stage=p.with_suffix('.pending')
stage.write_text(json.dumps({'schemaVersion':1,'assetRoot':stored,'profile':profile},indent=2)+'\n')
os.replace(stage,p)
locks={name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['bun.lock','ui/open-design/pnpm-lock.yaml']}
(root/'.matos/offline-dependencies.json').write_text(json.dumps({'platform':[sys.platform,platform.machine()],'locks':locks},indent=2)+'\n')
PY
printf 'MatOS is installed. Start it with ./deploy.sh start, or: python3 scripts/matos-service.py start --state-dir DIR --env-file FILE\n'
