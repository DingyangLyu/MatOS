#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$root/scripts/lib/matos-test-tmpdir.sh"
python3 "$root/scripts/matos-benchmark-contracts.test.py" MatToolsProjection
