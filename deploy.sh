#!/usr/bin/env bash
# MatOS one-command deployment. Usage and troubleshooting: docs/deploy.md
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if ! command -v python3 >/dev/null 2>&1 ||
   ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' 2>/dev/null; then
  echo "需要 Python 3.9 或更高版本（python3）。安装后重新运行；详见 docs/deploy.md 第 6 节 C04。" >&2
  echo "Python 3.9+ (python3) is required; see docs/deploy.md, section 6, C04." >&2
  exit 1
fi
exec python3 "$root/scripts/matos-deploy.py" "$@"
