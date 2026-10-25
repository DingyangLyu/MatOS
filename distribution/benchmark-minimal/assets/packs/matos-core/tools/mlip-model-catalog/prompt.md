# MLIP Model Catalog

Use `mcp__matos_asset__mlip_model_catalog` before writing MACE, CHGNet,
MatGL, SevenNet, ORB, MatterSim, FairChem, NequIP, Allegro, or TorchSim scripts.

The tool reports:

- mounted MLIP model assets from the scope-filtered native registry (explicit roots only for standalone use)
- local model file paths that are visible inside the current runtime
- module-spec availability in the catalog interpreter only, NOT managed-environment availability or successful inference
- loader hints and model-specific warnings from the asset manifest

If packages report false, call `conda_environment_catalog` with `probePackages=true`
and the required imports. Use its recommended interpreter and perform a tiny
real loader/energy/forces check. Never replace a requested model with a toy
potential merely because the catalog's own Python lacks that package.

When a local path is returned for MACE, pass that path to `mace_mp(model=...)`
instead of using aliases like `model="medium"`, because aliases may trigger a
network download in a user session.

Use the returned verified local model path. An explicitly configured external adapter must stage the selected model and verify its checksum before execution.
