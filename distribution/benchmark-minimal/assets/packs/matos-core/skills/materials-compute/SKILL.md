---
name: materials-compute
description: 'Master router for MatOS materials-computation skills. Use this first for compute tasks, then invoke the correct top-level skill group through the Skill tool.'
tags: [materials, computation, routing, master-index]
---

# Materials Compute Router

Use this skill as the **single entry point** for materials-science computation work in MatOS.

Do this in order:

1. Use this file to choose the right computation domain.
2. Invoke the relevant top-level skill group through the builtin `Skill` tool.
3. Use MatOS MCP tools and user-readable workspace files for concrete data, inputs, and outputs.
4. Run the calculation or analysis only after you have the exact domain workflow.

## Benchmark Guidance

For benchmark-style tasks, apply these rules before writing scripts or claiming
success:

- Prefer reusable workflow assets, published skills, and checked-in templates
  before inventing case-local helper scripts.
- Classify the evidence explicitly as `setup_only`, `fixture_backed`,
  `toy_compute`, or `production_compute`.
- Classify scientific data provenance explicitly as live API, trusted mounted
  database, checked-in trusted fixture, or model-authored/unverified runtime
  fixture.
- Treat `workflow_plan.md` as design-only evidence. Do not present a workflow
  as runnable unless it is an actual asset with `matos.workflow.json` and the
  declared graph entry.
- Final benchmark confidence comes from final artifact evidence, not from
  intermediate assistant claims. If a report cites an artifact, that artifact
  must exist.
- Prefer dedicated per-case workdirs and scoped cleanup inside those workdirs.
  Avoid repeated generic cleanup such as broad `rm -rf` patterns unless the
  user explicitly asks for them and the path scope is clear.

## Runtime Path Contract

Internal MatOS skill source paths are not user-facing. Do not browse, print, or expose runtime skill files. Use the builtin `Skill` tool for top-level groups such as `materials-compute`, `electronic-structure`, `thermal-properties`, `mlip-guide`; use MatOS MCP tools for concrete catalogs, preflights, and mounted data.

## Available Engines

- **Quantum ESPRESSO 7.6**: CPU and CUDA/OpenACC GPU profiles are exposed by
  `mcp__matos_asset__atomistic_toolchain_catalog` with `tools:["qe"]`.
  Prefer the returned `pw-cpu.x`, `pw-gpu.x`, `qe-mpirun-cpu`, and
  `qe-mpirun-gpu` paths instead of bare `mpirun pw.x`. Use `pw2qmcpack.x` from
  the same catalog entry for QE -> QMCPACK conversion.
- **LAMMPS**: `lmp`
- **RASPA3**: `raspa3`
- **Python stack**: `pymatgen`, `ASE`, `spglib`, `mp-api`, `MACE`, `numpy`, `scipy`, `matplotlib`
- **VASP**: use `vasp-hdf5-w90` for VASP 6.5.1 GPU/OpenACC jobs that
  require HDF5 output, `vaspout.h5`, VASP2WANNIER90, `LWANNIER90`,
  `LWANNIER90_RUN`, or Wannier90 files.

## Provenance And Evidence Rules

- Classify every external structure, thermodynamic entry, property value, and
  benchmark datum as `live_api`, `mounted_trusted_local_db`,
  `checked_in_fixture`, or `model_authored_unverified`.
- Do not assume Materials Project access. Check API credentials/network before
  claiming database-backed
  evidence. If neither is available, downgrade to setup-only or fixture-backed
  analysis and say which claims are unverified.
- Reusable scientific templates are acceptable for workflow design and input
  generation, but a template is not evidence that a calculation ran. A runnable
  workflow asset requires `matos.workflow.json` plus the declared graph entry;
  design-only notes should be named `workflow_plan.md`.
- `workflow_plan.yaml` is ambiguous and must not be used as pass evidence. If a
  graph is runnable, package it as a workflow asset; if it is a plan, keep it as
  Markdown.
- For NEB or reaction-path work, report optimizer convergence separately from
  physical/path validity. Check that endpoints are minima rather than the
  saddle, the highest-energy image is an interior image, images have sane
  spacing/no clashes, and the final path has not deviated to a different hop.
- Prefer scoped cleanup under a dedicated workdir. Avoid repeated generic
  `rm -rf` approvals; when cleanup is needed, ask once with the exact path and
  use rotate/archive patterns when possible.

## Local execution and explicit adapters

- Run in the current project using the installed CPU/GPU toolchain. Start with
  `mcp__matos_asset__materials_runtime_inventory` and
  `mcp__matos_asset__local_toolchain_preflight` to establish what is available.
- Discover scientific interpreters through `conda_environment_catalog` and
  solver paths through `atomistic_toolchain_catalog`; do not invent paths or
  assume the original MatOS server's software is installed.
- Keep task inputs unchanged. Write scripts, logs and results in the project.
  Set explicit resource and time limits before expensive local calculations.
- For GPU calculations, use only preflight-recommended idle GPU indices and
  set CUDA_VISIBLE_DEVICES explicitly. When resources are unavailable, report
  the requirement; do not silently submit work to an external platform.
- The BACKEND workflow interface accepts an explicit adapter tool reference.
  External services are available only when the operator configures that
  adapter, its authentication and its resource policy.
- Native tool names are engine calls, not shell programs. Call them directly
  through the tool interface and report actual outputs and limitations.

## Domain Routing

Choose the domain below, then read its index file before opening a concrete skill:

| Domain                                                 | Read This Next                                                 | Use For                                                                                                 |
| ------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Foundations, Data & Workflows                          | `materials-compute/foundations-data-workflows/SKILL.md`        | databases, interfaces, automation, screening, general scientific utilities, MLIP workflow setup         |
| Structures, Low-Dimensional Systems & Microstructure   | `materials-compute/structures-low-dimensional/SKILL.md`        | structure editing, builders, interfaces, heterostructures, moire systems, low-dimensional preparation   |
| Electronic, Spin & Spectroscopic Response              | `materials-compute/electronic-spin-spectroscopy/SKILL.md`      | SCF, bands, DOS, Fermi surfaces, electronic corrections, spin, topology, optical and transport response |
| Mechanical, Thermal & Ferroic Properties               | `materials-compute/mechanical-thermal-ferroic/SKILL.md`        | elastic constants, EOS, phonons, MD analysis, thermal transport, polarization and piezoelectricity      |
| Defects, Surfaces & Electrochemistry                   | `materials-compute/defects-surfaces-electrochemistry/SKILL.md` | point defects, migration barriers, adsorption, catalysis, surface energetics, battery electrode tasks   |
| Thermodynamics, Phase Stability & Statistical Sampling | `materials-compute/phase-stability-statistical/SKILL.md`       | alloy disorder, convex hulls, phase transitions, Monte Carlo, adsorption and statistical sampling       |
| Molecular, Biomolecular & Cheminformatics              | `materials-compute/molecular-bio-cheminfo/SKILL.md`            | molecular quantum chemistry, biomolecular MD, cheminformatics, molecular ML                             |

## Fast Routing For Common Tasks

- **Band structure / DOS / projected DOS**
  - Domain: `electronic-spin-spectroscopy`
  - Concrete groups: `electronic-structure`, `band-advanced`, `kpath-utilities`
- **Phonons / thermal conductivity / free energy**
  - Domain: `mechanical-thermal-ferroic`
  - Concrete groups: `thermal-properties`, `thermoconductivity`, `kpath-utilities`
- **Electron-phonon transport / superconductivity**
  - Domain: `electronic-spin-spectroscopy`
  - Concrete groups: `electron-phonon`, `electronic-structure`
- **Defect formation / migration barrier / NEB**
  - Domain: `defects-surfaces-electrochemistry`
  - Concrete groups: `defects-reactions`, `catalysis-electrochem`
- **Surface adsorption / surface energy / Wulff shape**
  - Domain: `defects-surfaces-electrochemistry`
  - Concrete groups: `surface-energy`, `defects-reactions`, `catalyst-screening`
- **Structure preparation / supercell / interfaces / moire**
  - Domain: `structures-low-dimensional`
  - Concrete groups: `structure-tools`, `structure-models`, `interface`, `2d-materials`
- **Elastic tensor / EOS / stress-strain**
  - Domain: `mechanical-thermal-ferroic`
  - Concrete groups: `mechanical-properties`
- **High-throughput screening / batch workflows**
  - Domain: `foundations-data-workflows`
  - Concrete groups: `high-throughput`, `materials-databases`, `code-interfaces`, `mlip-guide`
- **Molecular QC / biomolecular simulation**
  - Domain: `molecular-bio-cheminfo`
  - Concrete groups: `molecular-qchem`, `biomolecular-md`, `rdkit`, `deepchem`

## Flat Group IDs To Preserve

The current concrete compute groups remain the authoritative flat group IDs:

- `2d-materials`
- `advanced-electronic`
- `alloy-disorder`
- `band-advanced`
- `battery-electrode`
- `biomolecular-md`
- `bonding-analysis`
- `catalysis-electrochem`
- `catalyst-screening`
- `code-interfaces`
- `deepchem`
- `defects-reactions`
- `dft-corrections`
- `electron-phonon`
- `electronic-structure`
- `fermi-surface`
- `ferroelectric`
- `general-tools`
- `high-throughput`
- `interface`
- `kpath-utilities`
- `magnetic-properties`
- `materials-databases`
- `mechanical-properties`
- `mlip-guide`
- `molecular-qchem`
- `monte-carlo`
- `optical-properties`
- `phase-diagram`
- `phase-transition`
- `piezoelectric`
- `potential-analysis`
- `rdkit`
- `semiconductor-kit`
- `spectroscopy`
- `spin-texture`
- `structure-models`
- `structure-tools`
- `surface-energy`
- `thermal-properties`
- `thermoconductivity`
- `topological`
- `transport-properties`
- `wannier-functions`
- `wavefunction-analysis`

## Usage Rule

Read this file once to route. Then move immediately to the domain index and the concrete skill file you need. Do not keep rereading the full compute index during the same task.
