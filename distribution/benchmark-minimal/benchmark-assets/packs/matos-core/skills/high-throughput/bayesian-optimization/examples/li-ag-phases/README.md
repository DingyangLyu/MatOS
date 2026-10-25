# Li-Ag Phase Stability — Bayesian Optimization Example

Demonstrates 1D Bayesian Optimization over the Li-Ag binary composition space using the
`ml-bayesian-optimization` skill scripts. The goal is to find the composition
$x_\text{Li} \in [0, 1]$ that minimizes formation energy per atom with as few evaluations
as possible.

**Database**: All 11 Li-Ag phases from the Materials Project (`li_ag_phases.csv`), fetched
via `mcp__base__search_materials_project_by_chemsys`. At each BO step, the suggested
$x_\text{Li}$ is mapped to the nearest composition in this database (nearest-neighbor
lookup), simulating an oracle evaluation.

---

## Files

| File | Description |
|---|---|
| `search_space.yaml` | BO problem definition: `x_Li ∈ [0, 1]`, minimize `formation_energy_per_atom` |
| `li_ag_phases.csv` | MP database: 11 Li-Ag phases with formation energies and hull distances |
| `candidates_round_0.csv` | 5 Sobol initialization points (round 0) |
| `candidates_round_1.csv` | 3 GP-guided candidates (round 1) |
| `candidates_round_2.csv` | 3 GP-guided candidates (round 2) |
| `evaluated.csv` | All 11 evaluated (x_Li, formation_energy_per_atom) pairs |
| `campaign_state.json` | Round-by-round metadata (n_evaluated, n_suggested per round) |
| `gp_model_1d.png` | GP posterior mean ± 2σ and EI landscape after the full campaign |
| `convergence_curve.png` | Best observed value vs. evaluation number |
| `parameter_importance.png` | x_Li vs. formation energy scatter (all evaluations) |

---

## How to Reproduce

### Step 1: Fetch the MP database

```python
mcp__base__search_materials_project_by_chemsys(chemsys="Li-Ag")
```

Then query formation energies via `mp_api` and save to `li_ag_phases.csv`.

### Step 2: Sobol initialization

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config search_space.yaml \
    --batch_size 5 \
    --output candidates_round_0.csv \
    --output_dir ./
```

`suggest_candidates.py` only outputs candidate compositions — it has no knowledge of
formation energies. You must evaluate each candidate externally and record the result.
Here, evaluation is a nearest-neighbor lookup in `li_ag_phases.csv`:

```python
# Env: matos-compute
import pandas as pd, numpy as np
db = pd.read_csv("li_ag_phases.csv")
best = db.groupby("x_Li")["formation_energy_per_atom"].min().reset_index()
cands = pd.read_csv("candidates_round_0.csv")
rows = [
    {"x_Li": r["x_Li"],
     "formation_energy_per_atom": best.iloc[np.argmin(np.abs(best["x_Li"].values - r["x_Li"]))]["formation_energy_per_atom"]}
    for _, r in cands.iterrows()
]
pd.DataFrame(rows).to_csv("evaluated.csv", index=False)
```

In a real campaign this step would call an MCP tool (e.g. `mcp_mace_relax_structure`)
or a DFT workflow for each candidate, then append the results to `evaluated.csv`.

### Step 3: BO rounds (repeat)

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config search_space.yaml \
    --results evaluated.csv \
    --batch_size 3 \
    --output candidates_round_1.csv \
    --output_dir ./
```

The script reads the already-evaluated results from `evaluated.csv` to fit the GP
surrogate and suggest the next batch. Evaluate the new candidates and **append** the
results to `evaluated.csv`, then repeat.

### Step 4: Plot results

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/plot_bo_results.py \
    --results evaluated.csv \
    --config search_space.yaml \
    --output_dir ./
```

---

## Results

| Round | Candidates | Best found |
|---|---|---|
| 0 (Sobol) | 5 | LiAg at x_Li ≈ 0.43 → **−0.222 eV/atom** |
| 1 (GP+EI) | 3 | Confirmed LiAg minimum; explored x_Li ≈ 0.36, 0.56 |
| 2 (GP+EI) | 3 | Explored x_Li > 0.7 (Li-rich region) |

The global minimum (LiAg, mp-2426, −0.222 eV/atom) was identified on the first Sobol
evaluation and confirmed by the GP in round 1. The convergence curve is flat from evaluation
1 onward — BO converged in a single round.

---

**References:**
- Frazier, P.I., "A Tutorial on Bayesian Optimization", *arXiv*, 2018. [arXiv:1807.02811](https://arxiv.org/abs/1807.02811)
- Knowles, J., "ParEGO", *IEEE Trans. Evolutionary Computation*, 2006. [DOI:10.1109/TEVC.2005.851274](https://doi.org/10.1109/TEVC.2005.851274)
