---
name: scientific-programming
description: 'Write correct scientific/numerical code under hidden tests. Extract the function contract (I/O shapes, units, tolerances) first, write local self-tests, run import/smoke checks, and repair failing code before final submission. Use for SciCode-style, ScienceAgentBench-style, and any exact-implementation coding task.'
tags: [scientific-programming, numerical, hidden-tests, test-first, repair-loop]
---

# Scientific Programming Under Hidden Tests

Use this skill for tasks that ask you to implement a scientific or numerical
function that will be graded by tests you cannot see, or by exact numerical
comparison. Examples: SciCode steps, ScienceAgentBench programs, MatTools
functions, and any "implement this function / reproduce this metric" task.

These benchmarks are unforgiving: one wrong array shape, unit, index base,
interpolation convention, normalization, or edge case fails the whole problem
even when most of the logic is right. Step-level progress shows MatOS is close;
the losses come from exact implementation discipline, not scientific
understanding. Work test-first.

## Step 1: Extract the function contract before writing code

Do not start coding from intuition. First write down, from the prompt,
signature, docstring, and any provided background:

- Exact function name(s), argument names, and argument types.
- Input shapes and meaning of each dimension; input units and conventions.
- Output type, shape, units, sign convention, and index base (0 vs 1).
- Numerical tolerance or expected precision.
- Dependencies and any required library API and version.
- Provided helper functions or previous-step functions you must call rather than
  re-derive.

For multi-step problems, respect the dependency order: later steps usually must
call earlier step functions with the earlier step's exact output contract.

## Step 2: Nail the common failure modes

These specific mistakes cause most hidden-test failures. Check each before
submitting:

- **Array shape and orientation**: row-major vs column-major, `(n,)` vs
  `(n,1)`, transposed matrices, and broadcasting that silently changes shape.
- **Units and constants**: use the exact unit system the task expects; carry
  physical constants at full precision; convert energies (eV/Ry/Hartree),
  angles (rad/deg), and lengths consistently.
- **Index conventions**: 0-based vs 1-based; inclusive vs exclusive ranges;
  which axis a reduction runs over.
- **Interpolation / discretization**: grid spacing, endpoints, normalization of
  integrals and sums, and whether a cumulative integral or derivative is
  required.
- **Data access**: for HDF5/`.h5`, `.npz`, CSV, or dataframe inputs, verify the
  exact dataset path, column name, and dtype before indexing; do not assume
  column names.
- **Normalization**: probability/DOS/weight normalization, per-atom vs total,
  and whether to divide by cell volume or number of samples.
- **Edge cases**: empty inputs, single-element inputs, zeros/NaNs, degenerate
  or symmetric configurations.
- **API misuse**: confirm the real signature of any library call (for example
  DeepChem, MODNet, torch_geometric, pymatgen) instead of guessing method names
  or argument order; a wrong or nonexistent API is a frequent failure.

## Step 3: Write local self-tests first

Before or alongside the implementation, write cheap local checks and run them in
the target environment:

- A shape/type check on the return value for a small synthetic input.
- A known analytic or limiting case where you can compute the expected result by
  hand (for example: uniform input, single peak, identity transform, zero
  field).
- A monotonicity, symmetry, conservation, or bounds check appropriate to the
  physics.
- If any public example, sample input/output, or non-hidden test is provided,
  run against it exactly.

Prefer running real code over reasoning about it. Use the shared scientific
Conda environment through the normal preflight/catalog tools when the task needs
specific packages.

## Step 4: Repair loop before final submission

Run a cheap import/smoke pass on every generated file and fix failures before
invoking the real or hidden evaluator:

1. Import the module / run the entry function on a tiny input.
2. If it errors, read the traceback and fix the specific cause (missing import,
   wrong shape, wrong API, wrong path). Do not rewrite blindly.
3. Re-run the local self-tests from Step 3.
4. Only when import, smoke, and self-tests pass, finalize.

Record per-step failures you hit (shape handling, interpolation, HDF5 access,
normalization, API misuse) so the same mistake is not repeated across steps.

## Step 5: Finalize to the exact contract

Before returning or writing the submission file, apply the `answer-finalization`
skill: confirm return type, keys, shape, units, ordering, precision, and the
exact submission vehicle (for example `submission/solution.py` with the exact
required function name). Keep problem-level and step-level correctness in mind:
even when a full problem will not pass, correct individual steps still score.
