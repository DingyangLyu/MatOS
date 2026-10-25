# Conda Environment Catalog

Use `mcp__matos_asset__conda_environment_catalog` before selecting Python for
materials, MLIP, or local compute scripts.

The tool reports:

- shared system Conda environments mounted under `/opt/matos-tools/conda/envs`
- current-user persistent environments under `/workspace/caches/conda/envs`
- the runtime-selected pip/conda source route for creating user environments
- package/import availability and Torch CUDA metadata when probing is enabled
- `summaryStats` for fast routing across scopes, executables, package imports,
  and optional Torch CUDA status
- `recommended` for currently executable model/tool to environment mapping;
  full format validates all recommendation imports, while summary format keeps
  explicit `imports` narrow and reports recommendations relevant to them
- `recommendedByModel` for configured primary stacks, including unavailable
  diagnostics
- `optionalByModel` for optional/deferred stacks such as MatterGen, DiffCSP,
  ADiT, ORCA, and drug-MD tooling
- `unavailableRecommended` for primary configured stacks that are not executable
- `deferredOptionalStacks` for optional stacks that are not executable in this
  runtime
- commands for creating user-private persistent environments

The default `format: "summary"` is bounded for Agent routing. It returns only
the requested import probes and relevant recommendation details. Use
`format: "full"` only for operator diagnostics that need every configured
recommendation, deferred stack, and runtime hint.

System environments are shared and read-only. User-created environments must be
created under the reported `userEnvironmentPolicy.persistentEnvRoot`; those
directories are backed by the current user's MatOS scope and are not visible to
other users.

The package source route is injected by MatOS from non-secret environment
variables such as `MATOS_PIP_INDEX_URL`, `MATOS_CONDA_CHANNELS`, and
`MATOS_PACKAGE_SOURCE_PROFILE`. Do not hardcode a mirror when the catalog
returns a route.
For the default public profile, `pip` and `uv` should use the returned configured
PyPI index and persistent caches. Conda channel mirrors are used only when
`MATOS_CONDA_CHANNELS` is explicitly configured; do not invent an unverified
Anaconda mirror URL.

Default calls are fast inventory calls (`probePackages:false`, `includeGpu:false`).
Set `probePackages:true` only when import-level validation is needed, and set
`includeGpu:true` only when CUDA package metadata is necessary.
If the response includes `warnings`, treat them as partial scan diagnostics:
one unreadable environment path or binary was skipped, but the rest of the
catalog remains valid. Do not treat a single `PermissionError` warning as proof
that the requested environment stack is unavailable unless the relevant
`recommendedByModel` or `unavailableRecommended` entry says so.
For MACE, MLIP, molecular dynamics, ORCA, or generative-structure work, prefer
the returned `recommended` executable. Do not call `unavailableRecommended` or
`deferredOptionalStacks` entries as if they were installed; use those entries
only to explain missing toolchains or to plan an environment installation.
Check `summaryStats.packageAvailability` before attempting package installs.
Legacy TensorFlow M3GNet is isolated in `matos-m3gnet-py311`; do not install it
into PyTorch GNN environments such as `matos-mlip-gnn-py311`.

For ChengUCB MACE+LES tasks, use the `mace-les`, `mace-les-train`, or
`chengucb-mace-les` recommendation. This stack is an opt-in source overlay on
top of `matos-compute`, not a separate Conda environment. Use the returned
`runtimeHints.overlayRuntime.commands` wrappers, such as
`/opt/matos-tools/mace-les/bin/mace-les-run-train`, and do not override the
default stable `mace_run_train` command. The `les` package is intended for
Python import (`from les import Les`); do not call a raw `les` executable.

For PyVista/VTK 3D mesh rendering, use the returned `pyvista`, `vtk`,
`mesh-visualization`, or `scientific-3d-visualization` recommendation. In
headless MatOS containers check `runtimeLibraryStatus` first. If it reports
`preferredPyVistaBackend: "vtkOSOpenGLRenderWindow"`, set
`PYVISTA_OFF_SCREEN=true` and
`VTK_DEFAULT_OPENGL_WINDOW=vtkOSOpenGLRenderWindow`. If it reports EGL instead,
use `VTK_DEFAULT_OPENGL_WINDOW=vtkEGLRenderWindow`. Warnings such as
`libOSMesa not found` or `Failed to initialize OpenGL functions` mean the
workspace image is missing headless OpenGL runtime libraries; do not keep
retrying the same backend or claim rendering succeeded. Use a refreshed MatOS
workspace image, then write a screenshot file and verify that it exists and is
non-empty.
