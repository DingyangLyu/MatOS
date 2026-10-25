# SCIP Toolchain Catalog

Use `mcp__matos_asset__scip_toolchain_catalog` before running SCIP, SoPlex,
GCG, or PySCIPOpt. The tool returns container-visible paths under
`/opt/matos-tools` and can run a small real optimization smoke test.

Treat `available:true` as runnable. Treat missing paths, failed probes, failed
smoke tests, or import failures as not ready; report the returned reason and do
not invent alternate paths.

Use the returned paths rather than host-only mount-source paths. Preferred
entry points are:

- SCIP CLI: `/opt/matos-tools/bin/scip`
- SoPlex CLI: `/opt/matos-tools/bin/soplex`
- GCG CLI: `/opt/matos-tools/bin/gcg`
- PySCIPOpt Python: `/opt/matos-tools/conda/envs/matos-scip-py313/bin/python`

For a first validation, call with:

```json
{"probe": true, "smoke": true}
```

For Python modeling, use PySCIPOpt from the returned `python.path`. For file
based modeling, write LP/MPS/CIP/NL files under the user workspace and call
SCIP with `read <file> optimize write solution <file> quit`.
