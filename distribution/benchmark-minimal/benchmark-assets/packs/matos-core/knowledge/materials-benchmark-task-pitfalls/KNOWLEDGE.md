# Materials and Chemistry Data-Task Common Pitfalls

This note lists concrete, recurring failures observed on materials/chemistry
data-analysis, modeling, and visualization tasks, with the specific fix for
each. Read the relevant entry before starting one of these task types, then
verify your output against it during answer finalization. These are reusable
lessons; each entry states the symptom and the correction, not a specific
dataset answer.

## Phonon band structure plots

- Symptom: the dispersion looks like a real band plot but fails because the
  frequency axis scale or unit is wrong.
- Fix: confirm the required frequency unit (THz vs cm^-1 vs meV) from the task
  and convert explicitly. Label the axis with the unit. Check the high-symmetry
  k-path ordering and tick labels match the requested path. Verify acoustic
  branches go to ~0 at Gamma.

## Phonon density of states (DOS)

- Symptom: DOS peak shape and frequency range do not match the reference.
- Fix: use the same frequency unit and range as the band plot; normalize the
  DOS consistently (states per unit frequency per cell/atom as required); use an
  appropriate smearing/broadening and bin width; ensure the integral of the DOS
  equals the expected number of modes.

## Charge-density difference plots

- Symptom: the curve has locally similar shape but the vertical scale is wrong
  and a required cumulative integral is missing.
- Fix: compute the planar-averaged difference with correct sign convention and
  units; include the cumulative integral (running integral along the axis) when
  the task asks for charge transfer; label both the differential and cumulative
  curves; verify the difference integrates to ~0 over the full cell when it
  should.

## Formation-energy and band-gap property prediction

- Symptom: wrong target column name or wrong units gives a valid-looking model
  with a bad score.
- Fix: read the dataset schema and use the exact target column name (for
  example the experimental band-gap column name as written, not a guessed one).
  Confirm per-atom vs per-formula-unit and eV units. Keep a held-out split and
  report the metric the task asks for (MAE/MSE) in the requested units.

## Refractive-index and similar regression tasks

- Symptom: the model runs but MAE/MSE is too high, or a featurization API is
  misused.
- Fix: verify the featurizer API signature before calling it (for example
  MODNet `MODData` construction and `featurize` usage, matminer featurizers, or
  DeepChem featurizers); confirm feature/target alignment and scaling; do not
  invent method names or argument order. Validate on a small split before full
  training.

## QSAR classification vs regression typing

- Symptom: a classification metric fails because the model emitted continuous
  values, or balanced-accuracy is computed on the wrong type.
- Fix: match the task's problem type. For classification, threshold or use a
  classifier and return discrete labels of the required dtype; for regression,
  return continuous values. Check the metric's expected input type
  (probabilities vs labels) before computing it.

## Dataset column-name and field-structure errors

- Symptom: `KeyError` on names/columns, or wrong columns used (for example
  ClinTox `FDA_APPROVED`/`CT_TOX`, ligand/protein `names` fields).
- Fix: never assume column or field names. Load the dataset and print
  `columns`/keys and dtypes first; index by the exact verified names; handle
  multi-output targets and sample weights per the dataset's real structure.

## Compound / bioactivity filtering (e.g. Papyrus)

- Symptom: filtering conditions do not match, returning 0 hits or wrong overlap.
- Fix: read the exact filter criteria (pchembl threshold, assay type/quality,
  target accession, activity relation) and apply them literally; check
  inclusive vs exclusive bounds; verify the count of surviving rows is
  plausible and non-zero before proceeding; deduplicate as specified.

## Fingerprint / similarity matrices

- Symptom: heatmap structure roughly right but off-diagonal pattern or scaling
  differs.
- Fix: use the required fingerprint type and similarity metric (for example
  Tanimoto on the specified fingerprint); build the matrix in the requested
  order; set the color scale and diagonal convention explicitly; confirm the
  matrix is symmetric when it should be.

## General discipline for these tasks

- Inspect the real input (schema, columns, shapes, units) before coding.
- Reserve budget to check units, axis scales, normalization, and required
  auxiliary curves/fields.
- Validate against any provided example or a known limiting case before final
  submission, and finalize the output to the exact requested contract.
