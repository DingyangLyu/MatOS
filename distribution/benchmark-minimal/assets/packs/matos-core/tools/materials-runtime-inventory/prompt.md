# Materials Runtime Inventory

Use `mcp__matos_asset__materials_runtime_inventory` first when a compute task
depends on local mounted assets and you need to know what is available before
choosing QE, LAMMPS, VASP, MLIP/MACE, Conda, or pseudopotentials.

This tool is a read-only aggregator. It does not download models, install
packages, copy databases, or run production calculations. It reports current
mount/catalog status and points to the more specific tool to call next:

- `mcp__matos_asset__local_toolchain_preflight`
- `mcp__matos_asset__conda_environment_catalog`
- `mcp__matos_asset__mlip_model_catalog`
- `mcp__matos_asset__qe_pseudopotential_catalog`

Prefer `detail:"summary"` for planning. Use `detail:"full"` only when debugging
one of the nested catalogs. Treat missing sections as local capability gaps and
report missing local prerequisites instead of guessing paths or external queues.
