"""
Bayesian Optimization: GP surrogate + Expected Improvement.

Single-objective: Gaussian Process (scikit-learn) + EI maximized via multi-start L-BFGS-B.
Multi-objective: ParEGO — Chebyshev scalarization with random weight vectors, one GP per
                 batch element, naturally covering different regions of the Pareto front.

Usage:
    # Initialization (no evaluated data yet)
    python suggest_candidates.py \
        --config search_space.yaml \
        --batch_size 8 \
        --output candidates_round_0.csv \
        --output_dir bo_campaign/

    # BO round (with evaluated results)
    python suggest_candidates.py \
        --config search_space.yaml \
        --results evaluated.csv \
        --batch_size 4 \
        --output candidates_round_1.csv \
        --output_dir bo_campaign/

Requirements:
    Conda environment: matos-compute
    Packages: scikit-learn, scipy, numpy, pandas, pyyaml
"""

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
import yaml
from scipy.optimize import minimize
from scipy.stats import norm, qmc
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel as C, Matern, WhiteKernel


def load_config(config_path: str) -> dict:
    """Load and validate search_space.yaml."""
    with open(config_path) as f:
        config = yaml.safe_load(f)
    missing = {"parameters", "objectives"} - set(config)
    if missing:
        raise ValueError(f"search_space.yaml missing required keys: {missing}")
    if not config["parameters"]:
        raise ValueError("At least one parameter must be defined.")
    if not config["objectives"]:
        raise ValueError("At least one objective must be defined.")
    return config


def get_range_params(
    parameters: list[dict],
) -> tuple[list[str], list[tuple[float, float]]]:
    """Extract continuous/integer 'range' parameters and their bounds."""
    names, bounds = [], []
    for p in parameters:
        if p["type"] == "range":
            names.append(p["name"])
            bounds.append((float(p["bounds"][0]), float(p["bounds"][1])))
    if not names:
        raise ValueError("At least one 'range' parameter is required.")
    return names, bounds


def sobol_init(bounds: list[tuple], n: int, seed: int) -> np.ndarray:
    """Generate n quasi-random Sobol points within bounds."""
    sampler = qmc.Sobol(d=len(bounds), scramble=True, seed=seed)
    unit_pts = sampler.random(n)
    lo = np.array([b[0] for b in bounds])
    hi = np.array([b[1] for b in bounds])
    return qmc.scale(unit_pts, lo, hi)


def normalize(X: np.ndarray, bounds: list[tuple]) -> np.ndarray:
    """Scale X from physical bounds to [0, 1] per dimension."""
    lo = np.array([b[0] for b in bounds])
    hi = np.array([b[1] for b in bounds])
    return (X - lo) / (hi - lo)


def denormalize(X_norm: np.ndarray, bounds: list[tuple]) -> np.ndarray:
    """Scale X from [0, 1] back to physical bounds."""
    lo = np.array([b[0] for b in bounds])
    hi = np.array([b[1] for b in bounds])
    return X_norm * (hi - lo) + lo


def fit_gp(
    X: np.ndarray, y: np.ndarray, noise_std: float, seed: int
) -> GaussianProcessRegressor:
    """Fit a GP with Matern-5/2 kernel on normalized inputs."""
    kernel = C(1.0, (1e-3, 1e3)) * Matern(
        length_scale=[0.5] * X.shape[1],
        length_scale_bounds=(1e-2, 10.0),
        nu=2.5,
    )
    if noise_std > 0:
        kernel += WhiteKernel(noise_level=noise_std**2, noise_level_bounds=(1e-7, 1.0))
    else:
        kernel += WhiteKernel(noise_level=1e-5, noise_level_bounds=(1e-8, 1e-3))

    gp = GaussianProcessRegressor(
        kernel=kernel,
        n_restarts_optimizer=10,
        normalize_y=True,
        random_state=seed,
    )
    gp.fit(X, y)
    return gp


def _neg_ei(
    x: np.ndarray, gp: GaussianProcessRegressor, y_best: float, xi: float = 0.01
) -> float:
    """Negative Expected Improvement at point x (for minimization by scipy)."""
    mean, std = gp.predict(x.reshape(1, -1), return_std=True)
    std = max(float(std[0]), 1e-9)
    z = (y_best - float(mean[0]) - xi) / std
    return -(((y_best - float(mean[0]) - xi) * norm.cdf(z)) + std * norm.pdf(z))


def maximize_ei(
    gp: GaussianProcessRegressor,
    y_best: float,
    n_restarts: int = 20,
    seed: int = 42,
) -> np.ndarray:
    """Multi-start L-BFGS-B maximization of EI over the unit hypercube [0,1]^d."""
    rng = np.random.default_rng(seed)
    d = gp.X_train_.shape[1]
    unit_bounds = [(0.0, 1.0)] * d
    best_x, best_val = None, np.inf

    for x0 in rng.uniform(0.0, 1.0, size=(n_restarts, d)):
        res = minimize(
            _neg_ei, x0, args=(gp, y_best), method="L-BFGS-B", bounds=unit_bounds
        )
        if res.fun < best_val:
            best_val = res.fun
            best_x = np.clip(res.x, 0.0, 1.0)

    return best_x


def suggest_single_objective(
    config: dict,
    evaluated_df: pd.DataFrame,
    batch_size: int,
    noise_std: float,
    seed: int,
) -> pd.DataFrame:
    """GP + EI Bayesian Optimization for a single objective."""
    param_names, bounds = get_range_params(config["parameters"])
    obj = config["objectives"][0]
    obj_name = obj["name"]
    sign = 1.0 if obj.get("minimize", True) else -1.0  # Always minimize internally

    X = evaluated_df[param_names].to_numpy()
    y = sign * evaluated_df[obj_name].to_numpy()

    X_norm = normalize(X, bounds)
    gp = fit_gp(X_norm, y, noise_std, seed)
    print(f"  GP kernel: {gp.kernel_}")

    y_best = float(y.min())
    candidates_norm = []
    rejected_norm = list(X_norm)  # Avoid re-suggesting already-evaluated points
    d = X_norm.shape[1]

    for i in range(batch_size):
        # Try multi-start L-BFGS-B first
        x_next = None
        for attempt in range(15):
            x_cand = maximize_ei(
                gp, y_best, n_restarts=20, seed=seed + i * 100 + attempt
            )
            if all(np.linalg.norm(x_cand - r) > 0.05 for r in rejected_norm):
                x_next = x_cand
                break

        # Fallback: grid scan — pick the highest-EI diverse point
        if x_next is None:
            rng = np.random.default_rng(seed + i + 9999)
            grid = rng.uniform(0.0, 1.0, size=(5000, d))
            ei_vals = np.array([-_neg_ei(x, gp, y_best) for x in grid])
            for idx in np.argsort(ei_vals)[::-1]:
                if all(np.linalg.norm(grid[idx] - r) > 0.05 for r in rejected_norm):
                    x_next = grid[idx]
                    break
            # Last resort: uniform random
            if x_next is None:
                x_next = rng.uniform(0.0, 1.0, size=d)

        candidates_norm.append(x_next)
        rejected_norm.append(x_next)

    candidates = [denormalize(x, bounds) for x in candidates_norm]
    return pd.DataFrame(candidates, columns=param_names)


def suggest_multi_objective(
    config: dict,
    evaluated_df: pd.DataFrame,
    batch_size: int,
    noise_std: float,
    seed: int,
) -> pd.DataFrame:
    """
    Multi-objective BO via ParEGO (Knowles, 2006).

    For each batch slot, draw a random weight vector on the simplex and compute
    an augmented Chebyshev scalarization of the normalized objectives. Fit a GP
    on the scalarized values and maximize EI. Different weight vectors steer
    candidates toward different regions of the Pareto front.
    """
    param_names, bounds = get_range_params(config["parameters"])
    objectives = config["objectives"]

    X = evaluated_df[param_names].to_numpy()
    X_norm = normalize(X, bounds)

    # Build objective matrix; internally always minimize
    Y = np.column_stack(
        [
            evaluated_df[obj["name"]].to_numpy()
            * (1.0 if obj.get("minimize", True) else -1.0)
            for obj in objectives
        ]
    )

    # Normalize each objective to [0, 1] over observed range for Chebyshev scalarization
    y_lo = Y.min(axis=0)
    y_hi = Y.max(axis=0)
    Y_norm = (Y - y_lo) / np.maximum(y_hi - y_lo, 1e-8)

    rng = np.random.default_rng(seed)
    candidates = []

    for i in range(batch_size):
        # Sample weight vector uniformly on the probability simplex
        w = rng.exponential(1.0, size=len(objectives))
        w /= w.sum()

        # Augmented Chebyshev scalarization (rho=0.05 for strict convexity)
        y_scalar = np.max(w * Y_norm, axis=1) + 0.05 * (w * Y_norm).sum(axis=1)

        gp = fit_gp(X_norm, y_scalar, noise_std, seed + i)
        y_best = float(y_scalar.min())
        x_next = maximize_ei(gp, y_best, n_restarts=20, seed=seed + i)
        candidates.append(denormalize(x_next, bounds))

    return pd.DataFrame(candidates, columns=param_names)


def run_initialization(config: dict, batch_size: int, seed: int) -> pd.DataFrame:
    """Quasi-random Sobol initialization."""
    param_names, bounds = get_range_params(config["parameters"])
    pts = sobol_init(bounds, batch_size, seed)
    return pd.DataFrame(pts, columns=param_names)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Lightweight Bayesian Optimization using GP + EI (single) or ParEGO (multi-objective)."
    )
    parser.add_argument("--config", required=True, help="Path to search_space.yaml.")
    parser.add_argument("--results", default=None, help="Path to evaluated.csv.")
    parser.add_argument(
        "--batch_size", type=int, default=4, help="Number of candidates to suggest."
    )
    parser.add_argument(
        "--output", required=True, help="Output CSV path for suggested candidates."
    )
    parser.add_argument(
        "--output_dir", required=True, help="Directory for campaign state JSON."
    )
    parser.add_argument(
        "--noise_std", type=float, default=0.0, help="Estimated observation noise std."
    )
    parser.add_argument("--seed", type=int, default=42, help="Random seed.")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    config = load_config(args.config)
    n_range_params = sum(1 for p in config["parameters"] if p["type"] == "range")
    n_objectives = len(config["objectives"])
    min_points = max(2, 2 * n_range_params)

    # Load evaluated results if available
    n_evaluated = 0
    evaluated_df = None
    if args.results is not None:
        results_path = Path(args.results)
        if results_path.exists():
            evaluated_df = pd.read_csv(results_path)
            n_evaluated = len(evaluated_df)

    # Determine round number from campaign state
    state_path = output_dir / "campaign_state.json"
    state = {"rounds": []}
    if state_path.exists():
        with open(state_path) as f:
            state = json.load(f)
    round_num = len(state["rounds"])

    # Run initialization or BO
    if evaluated_df is None or n_evaluated < min_points:
        print(
            f"Initialization (round 0): {n_evaluated}/{min_points} points — using Sobol sampling."
        )
        candidates_df = run_initialization(config, args.batch_size, args.seed)
        round_num = 0
    else:
        print(f"Round {round_num}: GP surrogate on {n_evaluated} evaluated points.")
        if n_objectives == 1:
            candidates_df = suggest_single_objective(
                config, evaluated_df, args.batch_size, args.noise_std, args.seed
            )
        else:
            print(f"Multi-objective ({n_objectives} objectives): ParEGO scalarization.")
            candidates_df = suggest_multi_objective(
                config, evaluated_df, args.batch_size, args.noise_std, args.seed
            )

    candidates_df.to_csv(output_path, index=False)
    print(f"\nSuggested {len(candidates_df)} candidates → {output_path}")
    print(candidates_df.to_string(index=False))

    # Update campaign state
    state["rounds"].append(
        {
            "round": round_num,
            "n_evaluated": n_evaluated,
            "n_suggested": len(candidates_df),
        }
    )
    with open(state_path, "w") as f:
        json.dump(state, f, indent=2)


if __name__ == "__main__":
    main()
