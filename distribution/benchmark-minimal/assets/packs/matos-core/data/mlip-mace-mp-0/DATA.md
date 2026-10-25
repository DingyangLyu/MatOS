# MACE-MP-0 foundation model

Universal MACE interatomic potential covering 89 elements, trained on MPtrj
(PBE+U). The original open materials foundation model; small/medium/large
equivariant variants. MIT-licensed.

- Package: `mace-torch` (import `mace`) · License: MIT
- Loader: `from mace.calculators import mace_mp; mace_mp(model='<localPath>')`
- Weights: github.com/ACEsuit/mace-foundations releases (`mace_mp_0`)

## Local weights

Discover with `mcp__matos_asset__mlip_model_catalog {"family":"mace"}`. When a
checkpoint is present under `/opt/matos-tools/models/mlip/mace/`, pass its
`localPath` to `mace_mp(model=...)` so no download happens at runtime. If the
catalog reports `missing_files`, fetch from the `url` in each `files[]` entry
into the model root.

## Notes

For newer/stronger materials accuracy see MACE-MPA-0 (MPtrj+sAlex) and
MACE-OMAT-0 (`data:mlip-mace-omat-0`, ASL); for organics see MACE-OFF23
(`data:mlip-mace-off23`). See `knowledge:mlip-foundation-model-ecosystem`.
