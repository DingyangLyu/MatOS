# Conda Environment Manager

Use `mcp__matos_asset__conda_environment_manager` only after checking
`mcp__matos_asset__conda_environment_catalog`.

This tool mutates the current user's persistent runtime scope only:

- environments are created under `/workspace/caches/conda/envs/<envName>`
- packages are installed into that user environment's own `bin/python`
- shared system environments under `/opt/matos-tools/conda/envs` remain read-only
- package sources follow the MatOS runtime route returned by the catalog
- by default, pip and uv use the PyPI index
  returned by the configured package source, with persistent caches under the
  configured cache directory; do not override this with slower public PyPI
  unless the user explicitly needs an unavailable package

Do not run raw `pip install` into `/opt/matos-tools`, `/app/matos-assets`, or a
project directory. If a package is missing for a workflow, create or reuse a
focused user environment, install the package there, then run the workflow with
that environment's `python`.

For defect workflows that require `doped`, prefer:

1. call `mcp__matos_asset__conda_environment_catalog` with
   `probePackages:true` and `imports:["doped","pymatgen","atomate2"]`
2. if `doped` is absent, call this tool with
   `action:"ensure_packages"`, `envName:"defects"`,
   `packages:["doped"]`, `imports:["doped"]`
3. use the returned `python` path for subsequent defect scripts
