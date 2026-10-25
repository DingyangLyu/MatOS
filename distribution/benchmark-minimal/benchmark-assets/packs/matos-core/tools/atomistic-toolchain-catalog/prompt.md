# Atomistic Toolchain Catalog

Use `mcp__matos_asset__atomistic_toolchain_catalog` before selecting xTB,
CREST, GROMACS, OpenMM, PLUMED, ABACUS, CP2K, Quantum ESPRESSO, Wannier90,
GW/BSE, or QMCPACK runtime paths.

The catalog returns container-visible paths and status for each tool. Treat
`status: available` as runnable. Treat `missing`, `not_installed`, or
`missing_dependencies` as not runnable, even if a downloaded package path is
reported for provenance.

For Wannier90 workflows, request `tools:["wannier90"]`. Treat the toolchain as
runnable only when `components["wannier90.x"]` and
`components["pw2wannier90.x"]` are available. Use the returned container paths;
do not hardcode host paths.

For Quantum ESPRESSO workflows, request `tools:["qe"]`. Prefer
`pw-cpu.x` for conservative CPU MPI jobs and `pw-gpu.x` for CUDA/OpenACC jobs.
`pw-gpu.x` automatically runs through the matching GPU-aware MPI runtime; use
`MATOS_QE_GPU_MPI_PROCS=<ranks>` for multi-rank GPU tests, for example
`CUDA_VISIBLE_DEVICES=0,1 MATOS_QE_GPU_MPI_PROCS=2 /opt/matos-tools/qe/bin/pw-gpu.x -in input.in`.
For explicit MPI launchers, use `qe-mpirun-cpu` or `qe-mpirun-gpu` with the
returned paths. For QMCPACK conversion from QE, use `pw2qmcpack.x`; it is a CPU
converter even when the preceding QE SCF/NSCF run used `pw-gpu.x`.

For GW/BSE workflows, request `tools:["gw"]`. Treat local GW as runnable only
when `available:true` and at least one implementation in
`availableImplementations` is present. The supported implementation groups are
Yambo (`p2y`, `yambo`, `ypp`), BerkeleyGW (`epsilon.cplx.x`, `sigma.cplx.x`),
WEST (`wstat.x`, `wfreq.x`), ABINIT (`abinit`), and GPAW (`gpaw`). If status is
`missing` or `partial`, do not pretend local GW is available; either install the
missing stack under `/opt/matos-tools` or use a explicitly configured VASP adapter.

For QMCPACK workflows, request `tools:["qmcpack"]`. Prefer the returned
`recommendedVariant` and `path` when present. `path` points to a MatOS wrapper
that pins the right OpenMPI/CUDA libraries; set `QMCPACK_MPI_RANKS=<ranks>` for
MPI parallelism, for example:
`QMCPACK_MPI_RANKS=1 /opt/matos-tools/bin/qmcpack-gpu input.xml`.
The validated local GPU default is single card:
`CUDA_VISIBLE_DEVICES=0 QMCPACK_MPI_RANKS=1 /opt/matos-tools/bin/qmcpack-gpu input.xml`
for VMC/DMC and
`CUDA_VISIBLE_DEVICES=0 QMCPACK_MPI_RANKS=1 /opt/matos-tools/bin/qmcpack-afqmc-gpu-nccl input.xml`
for AFQMC GPU/NCCL.
For AFQMC execution, prefer `recommendedAfqmcVariant`/`afqmcExecutable` only
when the selected executable exists and reports `available:true`. Use
`recommendedGpuAfqmcVariant`/`gpuAfqmcExecutable` when a CUDA/NCCL AFQMC build
is available and the task should run on GPUs; use
`recommendedComplexAfqmcVariant`/`complexAfqmcExecutable` for complex-valued
AFQMC inputs. If a probe fails, report the returned `failureReason`/stderr and
do not claim AFQMC execution is ready. The complex GPU/NCCL executable is
validated for one-rank HDF5 Factorized/Cholesky and THC inputs only when the
catalog marks it available. Do not launch one complex
Factorized/Cholesky input as a true multi-rank distributed job because upstream
QMCPACK 4.3 aborts with `Distributed Factorized hamiltonian not yet
implemented`; the MatOS complex GPU launcher maps `QMCPACK_MPI_RANKS>1` to
independent one-rank replicas for this path. Use a validated distributed input
path when true distributed multi-rank AFQMC is required. The CPU fallback is
`/opt/matos-tools/bin/qmcpack-afqmc-cpu`; the complex CPU fallback is
`/opt/matos-tools/bin/qmcpack-afqmc-complex-cpu`.
Use `workflowDependencies.afqmcPythonEnv` for AFQMC HDF5 generation/checking.
Current QMCPACK 4.3 AFQMC inputs should use HDF5 Hamiltonian/wavefunction files
and `WalkerSet type="shared"` (or omit `type`) with a `walker_type` parameter.
For old examples with `filetype=fcidump` or `WalkerSet type="distributed"`,
run `qmcpack-afqmc-migrate-input.py` from `components` to convert the FCIDUMP
Hamiltonian with AFQMCTOOLS and rewrite the XML before execution.
Use returned `components` for QMCPACK helper tools instead of guessing names:
`convert4qmc`, `ppconvert`, `convertpw4qmc`, `qmcfinitesize`, `qmca`,
`qmc-fit`, `qdens`, `qdens-radial`, `qmc-get-supercell`,
`qmc-extract-eshdf-kvectors`, `molden2qmc`, and AFQMC input conversion scripts.
Use `workflowDependencies.qePw2qmcpack` for QE-to-QMCPACK wavefunction
conversion; this converter is CPU-side even when the preceding QE `pw.x` run
used the GPU wrapper. Use `workflowDependencies.pseudopotentials.path` for
QMCPACK-compatible pseudopotentials and do not reuse VASP/QE pseudopotentials in
QMCPACK unless they have been explicitly converted and validated.
Do not use host-only mount-source paths in user-facing commands.
