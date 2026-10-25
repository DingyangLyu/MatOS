#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$root"
export MATOS_TEST_PARALLEL="${MATOS_TEST_PARALLEL:-4}"
bash scripts/matos-test.sh src/matos
. scripts/lib/matos-test-tmpdir.sh
python3 scripts/matos-dsh-prepare-runtime.test.py
python3 scripts/matos-dsh-runtime.test.py
python3 scripts/matos-dsh-profile.test.py
python3 scripts/matos-state.test.py
python3 scripts/matos-deploy.test.py
python3 scripts/matos-minimal-assets.test.py
python3 scripts/matos-benchmark-contracts.test.py
python3 scripts/matos-rcbench-dsh.test.py
bun scripts/matos-minimal-assets-check.ts distribution/benchmark-minimal/assets workspace
bun scripts/matos-minimal-assets-check.ts distribution/benchmark-minimal/benchmark-assets benchmark
bash scripts/matos-typecheck.sh
if [[ -e "$root/.git" ]]; then git diff --check; fi
