---
name: answer-finalization
description: 'Finalize the answer to the exact contract the task or benchmark expects. Parse the required output format, self-check against it, and normalize types, keys, ordering, precision, and exception labels before submitting. Use this last, right before returning a final answer or writing a submission file.'
tags: [answer-contract, output-format, finalization, benchmark, self-check]
---

# Answer Finalization

Getting the science right is not enough. A correct result returned in the wrong
shape, type, unit, or surface form is scored as wrong. This skill is the final
step before you return an answer or write a submission file. Run it every time
the task states or implies an exact output contract, and always for benchmark,
grading, autotest, or "return exactly" tasks.

Real MatOS evidence for why this matters:

- On a real materials-tool programming benchmark, the underlying computation was
  correct but many answers were rejected only because of return type and key
  representation (native `bool` vs NumPy bool, `Element` object vs string keys,
  ordering, precision). A deterministic finalization pass recovered 18 subtasks
  and 12 whole cases without changing any science.
- On a chemistry/materials agent benchmark, roughly a quarter of "incorrect"
  cases were actually correct answers in a different surface form.

The lesson: reserve budget for finalization. Do not spend all effort on the
computation and then emit a hurried answer.

## Step 1: Extract the answer contract

Before finalizing, write down the contract the grader will apply. Read the task
text, any function signature, docstring, example output, and file-format
instructions. Capture:

- **Return vehicle**: a printed final line, a returned Python object, a JSON
  object, a specific file (`submission/solution.py`, `final_answer.txt`,
  `results.json`), or a named function that returns a value.
- **Type of each field**: `int`, `float`, native `bool`, `str`, list, tuple,
  dict, ndarray, or a domain object.
- **Keys and their representation**: string keys vs domain objects (for example
  pymatgen `Element("Ga")` vs the string `"Ga"`), exact key spelling, and case.
- **Shape and length**: array shape, row/column order, number of elements,
  and whether order is significant.
- **Units and numeric convention**: units, sign convention, per-atom vs total,
  eV vs Ry vs Hartree, radians vs degrees, 0-based vs 1-based indices.
- **Precision / tolerance**: decimal places, significant figures, or the
  numerical tolerance the grader uses.
- **Answer selection**: exactly what is asked (a single value, the top-k, a
  label, a name, a formula). Do not return a longer structure when one value is
  asked, and do not truncate a required structure to one value.
- **Failure encoding**: how errors or "not found" must be represented (specific
  exception type, sentinel value, empty container, or explicit message).

If the contract is ambiguous, state the interpretation you chose in one line and
pick the most standard convention rather than guessing silently.

## Step 2: Normalize to the contract

Apply only scientifically equivalence-preserving transforms. Never fabricate or
round away meaningful values to force a match.

- **Scalar types**: convert NumPy scalars to native Python (`bool(x)`,
  `int(x)`, `float(x)`). A NumPy `bool_` or `int64` frequently fails an exact
  `is`/type check even when equal.
- **Dict keys**: match the requested key representation. For pymatgen, return
  `{Element("Ga"): -1}` when element-object keys are required and
  `{"Ga": -1}` when string keys are required. Do not mix.
- **Ordering**: sort or order exactly as requested. When order is unspecified
  but the grader compares sequences, prefer a deterministic, documented order
  (for example ascending by key or by index).
- **Precision**: round to the requested decimals or significant figures only at
  the very end, once, on the final value; keep full precision during
  computation.
- **Units and conventions**: convert to the requested unit and sign/index
  convention. Show the conversion factor you applied.
- **Exceptions / sentinels**: raise the exact exception type or emit the exact
  sentinel the contract requires; do not substitute a generic message.
- **Whitespace and surface form**: for text answers, match requested casing,
  separators, list vs prose, and avoid over-normalizing (do not collapse a
  required list into a single token, and do not truncate at the first colon).

## Step 3: Self-check before submitting

Run a concrete check, not a mental one. Prefer executing a tiny verification.

- If the answer is code that must return a value, import and call it in the
  target environment and inspect the returned object's type, keys, shape, and a
  few values. Do not rely on "it should work".
- If the answer is a file, read the file back and confirm it parses and matches
  the contract exactly.
- Re-read the task's single most specific requirement and confirm the answer
  satisfies it literally.
- Confirm you answered the exact question asked (right quantity, right subset,
  right label), not a related one.
- For numeric answers, sanity-check magnitude, sign, and units against physical
  expectation and any reference value in the task.

## Step 4: Emit

Emit the final answer in the exact vehicle from Step 1. For structured
summaries, keep the answer itself unambiguous and separate from explanation. If
the task expects only a final value or a file, do not bury it in prose.

When the task asks for one value and names no other format, the answer file or
final line holds only that value: the number (with a unit only if the task asks
for one), the name, or the label. Write `11.96`, not `Psi = 11.96 (para-xylene)`,
and do not list the other candidates. Graders apply their numeric tolerance only
to a number they can parse; a labeled value is compared as text and fails even
when the number is right. Keep derivations and tables in a separate report file.

## Do not

- Do not change a scientific value to make a grader pass; only fix
  representation.
- Do not report success from intermediate reasoning; success comes from the
  final artifact or returned object.
- Do not skip finalization on "obvious" answers; type/format defects are most
  common exactly there.
