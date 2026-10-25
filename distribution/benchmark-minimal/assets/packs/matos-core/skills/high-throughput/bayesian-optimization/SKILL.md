---
name: ml-bayesian-optimization
description: Iteratively optimize expensive black-box objectives — such as materials properties, experimental yields, or simulation outputs — by learning from past evaluations to select the most promising next candidates.
category: machine-learning
---


## MatOS Runtime Note

This skill text is copied from AtomisticSkills with minimal MatOS path and environment rewrites. Before running bundled scripts, expose the integrated AtomisticSkills Python utility library:

```bash
export PYTHONPATH="${MATOS_ATOMISTIC_PYTHONPATH:-${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core}:${PYTHONPATH:-}"
```

Use `mcp__matos_asset__conda_environment_catalog` to confirm the named MatOS Conda environment exists before running commands. If the catalog reports the environment, model weights, licensed binary, or executable as missing, treat that as a real blocker rather than fabricating a result.

# Bayesian Optimization

## Goal
Efficiently find the optimal input parameters (e.g., alloy composition, simulation hyperparameters, process conditions) that minimize or maximize one or more expensive black-box objectives (e.g., formation energy, bandgap, elastic modulus) using Bayesian Optimization (BO). BO builds a probabilistic surrogate model (Gaussian Process) over the objective landscape and uses an acquisition function to intelligently select the next most informative experiments, minimizing the number of expensive evaluations required.

- **Single-objective**: Expected Improvement (EI) maximized via multi-start L-BFGS-B.
- **Multi-objective**: ParEGO — random Chebyshev scalarization with independent GPs, one weight vector per batch element, naturally steering candidates toward different Pareto-front regions.

---

## Instructions

### Step 1: Define the Search Space

Create a `search_space.yaml` in the research directory. Use the template at `resources/search_space_template.yaml` as a starting point:

```yaml
# research_dir/search_space.yaml

parameters:
  # Continuous range parameter
  - name: x_Fe
    type: range
    bounds: [0.0, 1.0]
    value_type: float

  # Integer range parameter
  - name: supercell_size
    type: range
    bounds: [2, 6]
    value_type: int

objectives:
  # Single-objective: minimize formation energy
  - name: formation_energy_eV_atom
    minimize: true

  # Multi-objective: additionally maximize bandgap (uncomment to enable)
  # - name: bandgap_eV
  #   minimize: false
```

**Guidelines:**
- Use `type: range` for continuous or integer parameters with known bounds. Only `range` parameters are passed to the GP surrogate.
- `choice` and `fixed` types are recorded in output CSVs but not optimized. Run separate campaigns per discrete choice.
- Choose bounds informed by domain knowledge; avoid unnecessarily wide ranges.

### Step 2: Initialize with Quasi-Random Sobol Samples

Generate an initial space-filling design using Sobol sequences. Use a power-of-2 `batch_size` (4, 8, 16, …) for optimal Sobol balance:

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config research_dir/search_space.yaml \
    --batch_size 8 \
    --output research_dir/candidates_round_0.csv \
    --output_dir research_dir/
```

With no `--results` provided (or fewer than `2 × N_range_params` evaluated points), the script automatically uses Sobol initialization. The output CSV lists candidate parameter values only — it does **not** evaluate the objective.

### Step 3: Evaluate Candidates Using MCP Tools

For each row in `candidates_round_0.csv`, call the appropriate MCP tool to evaluate the objective and record results. The script plays no role in this step.

| Objective type | Recommended MCP tool |
|---|---|
| Energy / formation energy | `mcp_mace_relax_structure` or `mcp_matgl_relax_structure` |
| Bandgap | `mcp_matgl_predict_bandgap` |
| Arbitrary property | `mcp_mace_predict_structure` |
| DFT reference | `mcp_atomate2_run_atomate2_vasp_calculation` |

Save all results to `evaluated.csv` — one row per candidate, parameter columns plus objective column(s):

```
x_Fe,formation_energy_eV_atom
0.12,-0.087
0.45,-0.143
0.73,-0.091
```

### Step 4: BO Loop — Suggest Next Candidates

With evaluated results, fit the GP surrogate and suggest the next batch:

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config research_dir/search_space.yaml \
    --results research_dir/evaluated.csv \
    --batch_size 4 \
    --output research_dir/candidates_round_1.csv \
    --output_dir research_dir/
```

The script will:
1. Normalize all inputs to [0, 1] per dimension.
2. Fit a GP with Matern-5/2 kernel (scikit-learn, `normalize_y=True`).
3. Single-objective: maximize EI via multi-start L-BFGS-B with diversity enforcement.
4. Multi-objective: fit one GP per batch element with a random Chebyshev weight vector (ParEGO).
5. Write the next `batch_size` candidates to the output CSV.
6. Append round metadata to `campaign_state.json` in `--output_dir`.

**Repeat Steps 3–4** until the budget is exhausted or convergence is observed.

### Step 5: Convergence Check and Analysis

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/plot_bo_results.py \
    --results research_dir/evaluated.csv \
    --config research_dir/search_space.yaml \
    --output_dir research_dir/
```

This generates:
- `convergence_curve.png` — best observed value vs. evaluation number (flat line = converged)
- `parameter_importance.png` — scatter of each parameter vs. objective across all evaluations
- `pareto_front.png` — (multi-objective only) non-dominated Pareto front
- `gp_model_1d.png` — (single range parameter only) GP mean ± 2σ and EI landscape
- `gp_model_2d.png` — (exactly two range parameters) GP mean, uncertainty, and EI as contour maps

**Convergence criteria (manual inspection):**
- Single-objective: best value improves by < 1% over the last 5 rounds.
- Multi-objective: hypervolume of the Pareto front changes by < 2% over the last 5 rounds.

**Visual Inspection**: Use `mcp_base_visualize_structure` to inspect the best-found structure, and inspect all generated plots.

---

## Examples

### Synthetic 2D Test (Branin Function)

Validate the BO workflow on a known 2D benchmark with three global minima at $f^* = 0.3979$:

```bash
# Env: matos-compute
python ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/scripts/suggest_candidates.py \
    --config ${MATOS_BUNDLED_ASSET_ROOT:-/app/matos-assets}/packs/matos-core/skills/high-throughput/bayesian-optimization/examples/branin-function/search_space.yaml \
    --batch_size 8 \
    --output /tmp/bo_test/candidates_round_0.csv \
    --output_dir /tmp/bo_test/
```

See [branin-function example](examples/branin-function/README.md) for the full walkthrough including all 8 rounds and the GP model visualization.

### Li-Ag Phase Stability (1D Composition Search)

Locate the most stable Li-Ag binary composition using Materials Project formation energies as the oracle:

See [li-ag-phases example](examples/li-ag-phases/README.md) for the full walkthrough.

---

## Constraints

- **Environment**: `matos-compute`. Dependencies: `scikit-learn`, `scipy`, `numpy`, `pandas`, `pyyaml`. No BoTorch or ax-platform required.
- **GP Scaling**: Training is O(n³). Practical upper limit is ~500 evaluated points before training time becomes noticeable.
- **Batch Size**: Use a power-of-2 for initialization (`batch_size` = 4, 8, 16, …). For BO rounds, `batch_size` ≤ 8 is recommended; larger is fine when evaluations are embarrassingly parallel.
- **Minimum Data**: The GP needs at least `2 × N_range_params` evaluated points to fit reliably. The Sobol initialization (Step 2) should provide at least this many.
- **Parameter Bounds**: Bounds in `search_space.yaml` must be physically meaningful. The GP has no information about the objective outside the specified domain.
- **Noise Handling**: For deterministic objectives (analytic functions, noiseless ML models) set `--noise_std 0`. For stochastic objectives (MD-derived properties, noisy experiments) set `--noise_std <estimated_std>`.

---

## References

- Frazier, P.I., "A Tutorial on Bayesian Optimization", *arXiv*, 2018. [arXiv:1807.02811](https://arxiv.org/abs/1807.02811)
- Knowles, J., "ParEGO: A Hybrid Algorithm with On-Line Landscape Approximation for Expensive Multiobjective Optimization Problems", *IEEE Transactions on Evolutionary Computation*, 2006. [DOI:10.1109/TEVC.2005.851274](https://doi.org/10.1109/TEVC.2005.851274)
- Balachandran, P.V. et al., "Adaptive strategies for materials design using uncertainties", *Scientific Reports*, 2016. [DOI:10.1038/srep19660](https://doi.org/10.1038/srep19660)
- Lookman, T. et al., "Active learning in materials science with emphasis on adaptive sampling using uncertainties for targeted design", *npj Computational Materials*, 2019. [DOI:10.1038/s41524-019-0153-8](https://doi.org/10.1038/s41524-019-0153-8)

---

**Author:** Bowen Deng
**Contact:** [GitHub @bowen-bd](https://github.com/bowen-bd)
