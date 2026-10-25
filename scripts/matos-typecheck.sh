#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
exec node "$root/node_modules/typescript/bin/tsc" --noEmit -p tsconfig.json
