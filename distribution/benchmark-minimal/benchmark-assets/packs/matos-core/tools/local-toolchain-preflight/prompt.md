# Local Toolchain Preflight

Check the current MatOS local/container scientific toolchain before direct
local execution of Quantum ESPRESSO, LAMMPS, OpenFOAM, VASP wrapper commands,
Elk workflows, Wannier90 commands, GW/BSE commands, ORCA, Thermo-Calc, or the toolchain Conda
environment. It can also inspect local/container GPU visibility and utilization
with `checks:["gpu"]`.

Use this tool when a user asks for a local/container smoke run or when you are
deciding between local execution and a separately configured backend. It does not
run production calculations. It only inspects mounts and runs cheap
help/version probes where safe.

For Elk, call it with `checks:["elk"]` (the legacy `tools:["elk"]` alias is
also accepted). Elk is built in place and is intentionally not required to be
on `PATH`; `command -v elk`, guessed `bin/` paths, and broad filesystem scans
are not availability checks. A passing result reports the located executable
and species directory, but execution must still go through
`workflow:elk-soc-band-structure-evidence` and that workflow's exact-parameter
preflight.

Call `mcp__matos_asset__local_toolchain_preflight` before direct local
`pw.x`, `lmp`, `blockMesh`, `icoFoam`, `simpleFoam`, `vasp_std`, or toolchain
`conda` usage. If a tool reports `blocked_glibc_mismatch`,
`blocked_missing_node`, or
`blocked_missing_runtime_libs`, do not continue with local production compute;
report the exact blocker or use an explicitly configured adapter.
For OpenFOAM CFD, call it with `checks:["openfoam"]` before local case setup or
solver execution; a passing check confirms the `/opt/matos-tools/bin/openfoam`
wrapper activates OpenFOAM and that `blockMesh` and `icoFoam` entrypoints are
callable from the mounted toolchain. The OpenFOAM result also includes
`tools.openfoam.catalyticFoam`, which reports catalyticFoam solver alias
`catalyticFoam`, real solver `catalyticPimpleFOAM`,
`catalyticFoam_CHEMKINPreProcessor`, and `libCatalyticWall.so` availability for
catalytic reacting-flow cases.
For Wannier90 workflows, call it with `checks:["qe","wannier90"]` before
running `pw.x`, `wannier90.x`, `postw90.x`, or `pw2wannier90.x`; a passing
Wannier90 check requires healthy `wannier90.x` and `pw2wannier90.x` components.
For GW/BSE workflows, call it with `checks:["gw"]`, or
`checks:["qe","gw"]` for QE-derived Yambo/WEST flows, before running local
`yambo`, `ypp`, `p2y`, BerkeleyGW, WEST, ABINIT, or GPAW commands. A passing GW
check requires one complete implementation; `partial` means some commands are
mounted but the stack is not safe for production local GW.
For Thermo-Calc / TC-Python CALPHAD workflows, call it with
`checks:["thermocalc"]` before importing `tc_python`, running Console Mode, or
claiming access to proprietary Thermo-Calc databases. A passing Thermo-Calc
check requires a mounted installation, a working `tc_python` import, and at
least one configured license variable. The tool redacts license values and only
reports variable names. If Thermo-Calc is missing or partial, use pycalphad with
legitimate `.tdb` files or report the exact blocker.
For GPU routing, call it with `checks:["gpu"]` and `detail:"summary"` before
remote queue selection. When `tools.gpu.status:"available"` has non-empty
`recommendedGpuIndices`, prefer local execution first and set
`CUDA_VISIBLE_DEVICES` to those indices. The GPU summary includes every visible
GPU's index, UUID, memory usage, utilization percentage, idle flag, and compute
process count, so an agent can tell whether other users are occupying the same
host GPUs.
Use `detail:"summary"` when you only need routing/readiness status; use
`detail:"full"` when diagnosing library paths or stderr. The `summary` field is
stable and compact. If QE reports `status:"available"` with a non-zero
`exitCode`, check `exitCodeInterpretation`; help-mode startup markers can prove
the binary is callable even when `pw.x -h` exits non-zero.
Do not call `/opt/matos-tools/vasp/bin/.real/vasp_*` directly; those binaries
depend on runtime library roots that MatOS manages through the wrapper or the
explicitly configured remote job prefix.
When `tools.vasp.profiles` includes a healthy profile, select it by setting
`MATOS_VASP_PROFILE=<profile-id>` on the MatOS VASP wrapper invocation. For
example, use `MATOS_VASP_PROFILE=vasp-hdf5-w90 vasp_std` for local VASP builds
that expose HDF5 and VASP2WANNIER90 support. Still do not call
`/opt/matos-tools/vasp/profiles/<profile-id>/bin/.real/vasp_*` directly from a
user workspace.
