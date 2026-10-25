# Materials Project Query

Look up crystal structures and computed properties from the Materials
Project (https://materialsproject.org) database.

## Input

One of:

- `formula` — chemical formula string, e.g. `"Si"`, `"SiO2"`,
  `"BaTiO3"`. Returns matching entries (up to 20, ranked by
  energy-above-hull).
- `material_id` — a specific Materials Project id like `"mp-149"`.
  Returns the single entry.

Optional:

- `fields` — list of property names to return. Common values:
  `"formula_pretty"`, `"structure"`, `"band_gap"`, `"formation_energy_per_atom"`,
  `"energy_above_hull"`, `"volume"`, `"density"`, `"nsites"`,
  `"symmetry"`, `"spacegroup"`. Default: a compact summary.

## Output

JSON with `count` and `entries[]`, each entry carrying the requested
fields. Structures are returned in the pymatgen canonical dict form.

## Notes

- Requires `MP_API_KEY` in the session environment (the tool requests
  it through `permissions.secrets`). Get one from the Materials
  Project dashboard.
- Network access is required. The query is routed through the MP
  REST v2 endpoint.
- Read-only — this tool never mutates the workspace or remote state.
