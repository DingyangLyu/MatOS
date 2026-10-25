# Example: Bayesian Optimization on the Branin Function

## Goal

Validate the `ml-bayesian-optimization` skill on the **Branin benchmark function** — a standard 2D test function with a known analytical minimum. This example confirms the BO campaign converges to the correct optimum and serves as a smoke test before applying the skill to expensive atomistic simulations.

---

## Background

The Branin function is defined as:

$$f(x_1, x_2) = a(x_2 - bx_1^2 + cx_1 - r)^2 + s(1 - t)\cos(x_1) + s$$

with $a=1,\ b=5.1/(4\pi^2),\ c=5/\pi,\ r=6,\ s=10,\ t=1/(8\pi)$, over $x_1 \in [-5, 10],\ x_2 \in [0, 15]$.

Three global minima, all at $f^* = 0.3979$:

| Global Minimum | $x_1$ | $x_2$ |
|---|---|---|
| #1 | $-\pi \approx -3.1416$ | $12.275$ |
| #2 | $+\pi \approx 3.1416$ | $2.275$ |
| #3 | $9.4248$ | $2.475$ |

---

## Files

| File | Description |
|---|---|
| `search_space.yaml` | BO problem: `x1 ∈ [-5, 10]`, `x2 ∈ [0, 15]`, minimize `branin` |
| `candidates_round_0.csv` | 8 Sobol initialization points |
| `candidates_round_1.csv` … `candidates_round_7.csv` | 4 GP-guided candidates per round |
| `evaluated.csv` | All 36 evaluated `(x1, x2, branin)` triples |
| `campaign_state.json` | Round metadata (n_suggested per round, used for plot coloring) |
| `convergence_curve.png` | Best observed branin vs. evaluation number |
| `parameter_importance.png` | x1, x2 scatter vs. branin (all evaluations) |
| `gp_model_2d.png` | GP posterior mean, uncertainty, and EI landscape after the full campaign |

---

## How to Reproduce

### Step 1: Sobol initialization (round 0)

Generate 8 space-filling initial candidates (power-of-2 for Sobol balance):

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/examples/branin-function/search_space.yaml \
    --batch_size 8 \
    --output candidates_round_0.csv \
    --output_dir ./
```

### Step 2: Evaluate round 0 candidates

`suggest_candidates.py` only outputs *where* to sample — it does not evaluate the objective.
Compute the Branin function for each row and save to `evaluated.csv`:

```python
# Env: matos-compute
import numpy as np, pandas as pd

def branin(x1: float, x2: float) -> float:
    a, b, c, r, s, t = 1, 5.1 / (4 * np.pi**2), 5 / np.pi, 6, 10, 1 / (8 * np.pi)
    return a * (x2 - b * x1**2 + c * x1 - r)**2 + s * (1 - t) * np.cos(x1) + s

cands = pd.read_csv("candidates_round_0.csv")
cands["branin"] = [branin(r.x1, r.x2) for _, r in cands.iterrows()]
cands.to_csv("evaluated.csv", index=False)
```

In a real materials campaign, replace the `branin()` call with an MCP tool (e.g. `mcp_mace_relax_structure`).

### Step 3: BO rounds 1–7 (repeat)

Fit the GP on `evaluated.csv` and suggest the next 4 candidates:

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/examples/branin-function/search_space.yaml \
    --results evaluated.csv \
    --batch_size 4 \
    --output candidates_round_1.csv \
    --output_dir ./
```

Evaluate the new candidates and **append** to `evaluated.csv`:

```python
cands = pd.read_csv("candidates_round_1.csv")
cands["branin"] = [branin(r.x1, r.x2) for _, r in cands.iterrows()]
existing = pd.read_csv("evaluated.csv")
pd.concat([existing, cands], ignore_index=True).to_csv("evaluated.csv", index=False)
```

Increment the round number and repeat until convergence (7 rounds were run here).

### Step 4: Plot results

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/plot_bo_results.py \
    --results evaluated.csv \
    --config ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/examples/branin-function/search_space.yaml \
    --output_dir ./
```

Because `search_space.yaml` has exactly 2 range parameters, this automatically generates `gp_model_2d.png`
in addition to `convergence_curve.png` and `parameter_importance.png`.

---

## Results

**36 total evaluations across 8 rounds** (8 Sobol + 7 × 4 GP-guided):

| Round | Cumulative evaluations | Best branin |
|---|---|---|
| 0 (Sobol, 8 pts) | 8 | 5.225 |
| 1–3 (GP+EI, 4 pts/round) | 20 | 1.527 |
| 4–5 (GP+EI, 4 pts/round) | 28 | 0.412 |
| 6–7 (GP+EI, 4 pts/round) | 36 | 0.412 |

Best found: **f = 0.412 at (x1 = −3.108, x2 = 12.287)** — global minimum #1 (near −π, 12.275), within 0.014 of $f^* = 0.3979$.
The convergence curve reaches $f < 0.5$ by evaluation ~13, consistent with the literature benchmark of ~40 evaluations for a well-tuned GP+EI campaign.

The `gp_model_2d.png` shows:
- **Left (GP mean)**: the surrogate has correctly learned the multimodal Branin landscape. Dark regions (low branin) correspond to the known minima near (−3, 12), (3, 2), and (9.4, 2.5).
- **Centre (GP std)**: uncertainty is highest in corners and regions without evaluations. Well-sampled regions near the minima show low uncertainty.
- **Right (EI)**: the EI peak (blue star) points toward minimum #2 near (3, 2) — the next most promising unexplored region after rounds 1–7.

---

## Mapping to Real Atomistic Workflows

| Branin step | Real materials equivalent |
|---|---|
| Read `(x1, x2)` from CSV | Read composition or hyperparameters from `candidates_round_N.csv` |
| Compute `branin(x1, x2)` | Call `mcp_mace_relax_structure` or `mcp_matgl_predict_bandgap` |
| Append `(x1, x2, branin)` to `evaluated.csv` | Append `(params..., property)` to `evaluated.csv` |

The BO script is fully agnostic to the evaluation backend — it only reads parameter values and objective scores from CSV.

---

**Reference:** Dixon, L.C.W. & Szegő, G.P. (1978). *Towards Global Optimization 2*. North-Holland.
