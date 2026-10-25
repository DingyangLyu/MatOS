"""
Plot Bayesian Optimization convergence and results.

Generates:
  - convergence_curve.png     : Best observed objective value vs. number of evaluations
  - parameter_importance.png  : Scatter plots of each parameter vs. objective (visual sensitivity)
  - pareto_front.png          : (multi-objective only) Pareto front of non-dominated solutions
  - gp_model_1d.png           : (single range parameter only) GP surrogate mean ± 2σ + EI landscape

Usage:
    python plot_bo_results.py \\
        --results evaluated.csv \\
        --config search_space.yaml \\
        --output_dir bo_campaign/

Requirements:
    - Conda environment: matos-compute
    - Required packages: matplotlib, pandas, numpy, yaml, scikit-learn, scipy
"""

import argparse
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import yaml
from scipy.stats import norm
from sklearn.gaussian_process import GaussianProcessRegressor
from sklearn.gaussian_process.kernels import ConstantKernel as C, Matern, WhiteKernel


def load_config(config_path: str) -> dict:
    """
    Load the search space YAML configuration.

    Args:
        config_path: Path to search_space.yaml.

    Returns:
        Parsed configuration dict.
    """
    with open(config_path) as f:
        return yaml.safe_load(f)


def compute_pareto_front(costs: np.ndarray) -> np.ndarray:
    """
    Identify non-dominated (Pareto-optimal) solutions.

    Assumes all objectives should be minimized (negate maximization objectives before calling).

    Args:
        costs: Array of shape (n_points, n_objectives) with all objectives to minimize.

    Returns:
        Boolean mask of shape (n_points,) where True marks Pareto-optimal points.
    """
    n = len(costs)
    is_pareto = np.ones(n, dtype=bool)
    for i in range(n):
        if is_pareto[i]:
            dominated_by_i = np.all(costs[i] <= costs, axis=1) & np.any(
                costs[i] < costs, axis=1
            )
            is_pareto[dominated_by_i] = False
            is_pareto[i] = True
    return is_pareto


def plot_convergence(
    evaluated_df: pd.DataFrame,
    objectives: list[dict],
    output_dir: Path,
) -> None:
    """
    Plot best observed objective value vs. evaluation number.

    Args:
        evaluated_df: DataFrame with objective column(s).
        objectives: List of objective dicts with 'name' and 'minimize' keys.
        output_dir: Directory to save the plot.
    """
    fig, axes = plt.subplots(
        len(objectives), 1, figsize=(8, 4 * len(objectives)), squeeze=False
    )

    for ax, obj in zip(axes[:, 0], objectives):
        obj_name = obj["name"]
        minimize = obj["minimize"]

        values = evaluated_df[obj_name].to_numpy()
        if minimize:
            best_so_far = np.minimum.accumulate(values)
            ylabel = f"Best {obj_name} (min)"
        else:
            best_so_far = np.maximum.accumulate(values)
            ylabel = f"Best {obj_name} (max)"

        ax.plot(
            range(1, len(best_so_far) + 1),
            best_so_far,
            color="steelblue",
            linewidth=2,
            marker="o",
            markersize=4,
        )
        ax.scatter(
            range(1, len(values) + 1),
            values,
            color="gray",
            alpha=0.5,
            s=20,
            label="Evaluations",
            zorder=2,
        )
        ax.set_xlabel("Evaluation number", fontsize=12)
        ax.set_ylabel(ylabel, fontsize=12)
        ax.set_title(f"BO Convergence — {obj_name}", fontsize=13)
        ax.legend(fontsize=10)
        ax.grid(True, linestyle="--", alpha=0.5)

    fig.tight_layout()
    out_path = output_dir / "convergence_curve.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved convergence plot: {out_path}")


def plot_pareto_front(
    evaluated_df: pd.DataFrame,
    objectives: list[dict],
    output_dir: Path,
) -> None:
    """
    Plot the Pareto front for two-objective optimization.

    Args:
        evaluated_df: DataFrame with objective columns.
        objectives: List of two objective dicts.
        output_dir: Directory to save the plot.
    """
    if len(objectives) != 2:
        print("Pareto front plot only supported for exactly 2 objectives. Skipping.")
        return

    obj_a, obj_b = objectives[0], objectives[1]
    vals_a = evaluated_df[obj_a["name"]].to_numpy()
    vals_b = evaluated_df[obj_b["name"]].to_numpy()

    # Normalize to minimization for Pareto computation
    costs_a = vals_a if obj_a["minimize"] else -vals_a
    costs_b = vals_b if obj_b["minimize"] else -vals_b
    costs = np.column_stack([costs_a, costs_b])
    pareto_mask = compute_pareto_front(costs)

    fig, ax = plt.subplots(figsize=(7, 6))
    ax.scatter(
        vals_a[~pareto_mask],
        vals_b[~pareto_mask],
        color="lightgray",
        s=30,
        alpha=0.7,
        label="Dominated",
    )
    ax.scatter(
        vals_a[pareto_mask],
        vals_b[pareto_mask],
        color="steelblue",
        s=60,
        zorder=5,
        label=f"Pareto front (n={pareto_mask.sum()})",
    )

    # Connect Pareto front points
    pareto_vals = np.column_stack([vals_a[pareto_mask], vals_b[pareto_mask]])
    pareto_vals = pareto_vals[pareto_vals[:, 0].argsort()]
    ax.step(
        pareto_vals[:, 0],
        pareto_vals[:, 1],
        where="post",
        color="steelblue",
        linewidth=1.5,
        alpha=0.6,
    )

    xlabel = obj_a["name"] + (" (↓)" if obj_a["minimize"] else " (↑)")
    ylabel = obj_b["name"] + (" (↓)" if obj_b["minimize"] else " (↑)")
    ax.set_xlabel(xlabel, fontsize=12)
    ax.set_ylabel(ylabel, fontsize=12)
    ax.set_title("Pareto Front", fontsize=13)
    ax.legend(fontsize=10)
    ax.grid(True, linestyle="--", alpha=0.4)

    fig.tight_layout()
    out_path = output_dir / "pareto_front.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved Pareto front plot: {out_path}")


def plot_parameter_distributions(
    evaluated_df: pd.DataFrame,
    parameters: list[dict],
    objectives: list[dict],
    output_dir: Path,
) -> None:
    """
    Plot the distribution of evaluated parameter values colored by objective.

    For continuous parameters, shows scatter plots against the objective.
    Provides intuitive visual importance ranking.

    Args:
        evaluated_df: DataFrame with parameter and objective columns.
        parameters: List of parameter dicts from search_space.yaml.
        objectives: List of objective dicts.
        output_dir: Directory to save the plot.
    """
    range_params = [p for p in parameters if p["type"] == "range"]
    obj = objectives[0]
    obj_name = obj["name"]

    if not range_params or obj_name not in evaluated_df.columns:
        return

    n_params = len(range_params)
    fig, axes = plt.subplots(1, n_params, figsize=(5 * n_params, 4), squeeze=False)

    obj_vals = evaluated_df[obj_name].to_numpy()
    vmin, vmax = obj_vals.min(), obj_vals.max()

    for ax, param in zip(axes[0], range_params):
        p_name = param["name"]
        if p_name not in evaluated_df.columns:
            ax.set_visible(False)
            continue
        x = evaluated_df[p_name].to_numpy()
        sc = ax.scatter(
            x, obj_vals, c=obj_vals, cmap="viridis", vmin=vmin, vmax=vmax, s=40
        )
        ax.set_xlabel(p_name, fontsize=11)
        ax.set_ylabel(obj_name, fontsize=11)
        ax.set_title(f"{p_name} vs. {obj_name}", fontsize=12)
        ax.grid(True, linestyle="--", alpha=0.4)
        plt.colorbar(sc, ax=ax, label=obj_name)

    fig.tight_layout()
    out_path = output_dir / "parameter_importance.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved parameter importance plot: {out_path}")


def plot_gp_model_1d(
    evaluated_df: pd.DataFrame,
    config: dict,
    output_dir: Path,
    campaign_state_path: Path | None = None,
) -> None:
    """
    Plot the final GP surrogate model for a single range-parameter problem.

    Shows two panels:
      - Upper: GP posterior mean ± 2σ with evaluated points colored by BO round.
      - Lower: Expected Improvement landscape over the parameter domain.

    Args:
        evaluated_df: DataFrame with parameter and objective columns.
        config: Parsed search_space.yaml dict.
        output_dir: Directory to save the plot.
        campaign_state_path: Optional path to campaign_state.json for round coloring.
    """
    range_params = [p for p in config["parameters"] if p["type"] == "range"]
    if len(range_params) != 1:
        print("GP model plot only supported for exactly 1 range parameter. Skipping.")
        return

    param = range_params[0]
    param_name = param["name"]
    lo, hi = float(param["bounds"][0]), float(param["bounds"][1])

    obj = config["objectives"][0]
    obj_name = obj["name"]
    sign = 1.0 if obj.get("minimize", True) else -1.0

    X = evaluated_df[param_name].to_numpy().reshape(-1, 1)
    y = sign * evaluated_df[obj_name].to_numpy()

    # Normalize to [0, 1]
    X_norm = (X - lo) / (hi - lo)
    kernel = C(1.0, (1e-3, 1e3)) * Matern(
        length_scale=0.5, length_scale_bounds=(1e-2, 10.0), nu=2.5
    )
    kernel += WhiteKernel(noise_level=1e-5, noise_level_bounds=(1e-8, 1e-3))
    gp = GaussianProcessRegressor(
        kernel=kernel, n_restarts_optimizer=10, normalize_y=True, random_state=0
    )
    gp.fit(X_norm, y)

    # Dense prediction grid
    grid_norm = np.linspace(0.0, 1.0, 500).reshape(-1, 1)
    grid_phys = grid_norm * (hi - lo) + lo
    mean, std = gp.predict(grid_norm, return_std=True)
    if sign < 0:
        mean = -mean  # Convert back to original scale for display

    y_best = float(y.min())
    z = (y_best - gp.predict(grid_norm) - 0.01) / np.maximum(std, 1e-9)
    ei = (y_best - gp.predict(grid_norm) - 0.01) * norm.cdf(z) + std * norm.pdf(z)
    ei = np.maximum(ei, 0.0)

    # Round coloring from campaign_state.json
    round_labels = np.zeros(len(evaluated_df), dtype=int)
    if campaign_state_path is not None and Path(campaign_state_path).exists():
        import json

        with open(campaign_state_path) as f:
            state = json.load(f)
        cursor = 0
        for entry in state["rounds"]:
            n = entry["n_suggested"]
            round_labels[cursor : cursor + n] = entry["round"]
            cursor += n

    # Plot
    n_rounds = int(round_labels.max()) + 1
    cmap = plt.cm.get_cmap("tab10", n_rounds)

    fig, (ax_gp, ax_ei) = plt.subplots(
        2, 1, figsize=(9, 7), sharex=True, gridspec_kw={"height_ratios": [3, 1.5]}
    )

    # GP panel
    ax_gp.fill_between(
        grid_phys.ravel(),
        mean - 2 * std,
        mean + 2 * std,
        alpha=0.25,
        color="steelblue",
        label="GP ±2σ",
    )
    ax_gp.plot(grid_phys.ravel(), mean, color="steelblue", linewidth=2, label="GP mean")

    for r in range(n_rounds):
        mask = round_labels == r
        label = f"Round {r} ({'Sobol' if r == 0 else 'BO'})"
        ax_gp.scatter(
            evaluated_df[param_name].to_numpy()[mask],
            evaluated_df[obj_name].to_numpy()[mask],
            color=cmap(r),
            s=60,
            zorder=5,
            label=label,
            marker="o" if r == 0 else "^",
        )

    best_idx = (
        evaluated_df[obj_name].idxmin()
        if obj.get("minimize", True)
        else evaluated_df[obj_name].idxmax()
    )
    ax_gp.axvline(
        evaluated_df[param_name].iloc[best_idx],
        color="red",
        linestyle="--",
        alpha=0.5,
        label="Best observed",
    )
    ax_gp.set_ylabel(obj_name, fontsize=12)
    ax_gp.set_title(f"GP Surrogate — {param_name} vs. {obj_name}", fontsize=13)
    ax_gp.legend(fontsize=9, loc="upper right")
    ax_gp.grid(True, linestyle="--", alpha=0.4)

    # EI panel
    ax_ei.fill_between(grid_phys.ravel(), 0, ei, alpha=0.5, color="darkorange")
    ax_ei.plot(grid_phys.ravel(), ei, color="darkorange", linewidth=1.5)
    ax_ei.set_xlabel(param_name, fontsize=12)
    ax_ei.set_ylabel("EI", fontsize=12)
    ax_ei.set_title("Expected Improvement", fontsize=12)
    ax_ei.grid(True, linestyle="--", alpha=0.4)

    fig.tight_layout()
    out_path = output_dir / "gp_model_1d.png"
    fig.savefig(out_path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved GP model plot: {out_path}")


def plot_gp_model_2d(
    evaluated_df: pd.DataFrame,
    config: dict,
    output_dir: Path,
    campaign_state_path: Path | None = None,
    grid_resolution: int = 60,
) -> None:
    """
    Plot the final GP surrogate model for a two range-parameter problem.

    Shows three panels:
      - Left:   GP posterior mean as a filled contour with evaluated points colored by round.
      - Centre: GP posterior std (uncertainty) as a filled contour.
      - Right:  Expected Improvement landscape with the next best suggestion marked.

    Args:
        evaluated_df: DataFrame with parameter and objective columns.
        config: Parsed search_space.yaml dict.
        output_dir: Directory to save the plot.
        campaign_state_path: Optional path to campaign_state.json for round coloring.
        grid_resolution: Number of grid points per dimension for contour plots.
    """
    range_params = [p for p in config["parameters"] if p["type"] == "range"]
    if len(range_params) != 2:
        print(
            "GP model 2D plot only supported for exactly 2 range parameters. Skipping."
        )
        return

    p0, p1 = range_params
    lo0, hi0 = float(p0["bounds"][0]), float(p0["bounds"][1])
    lo1, hi1 = float(p1["bounds"][0]), float(p1["bounds"][1])

    obj = config["objectives"][0]
    obj_name = obj["name"]
    sign = 1.0 if obj.get("minimize", True) else -1.0

    X = evaluated_df[[p0["name"], p1["name"]]].to_numpy()
    y = sign * evaluated_df[obj_name].to_numpy()

    # Normalize to [0, 1]
    lo = np.array([lo0, lo1])
    hi = np.array([hi0, hi1])
    X_norm = (X - lo) / (hi - lo)

    kernel = C(1.0, (1e-3, 1e3)) * Matern(
        length_scale=[0.5, 0.5], length_scale_bounds=(1e-2, 10.0), nu=2.5
    )
    kernel += WhiteKernel(noise_level=1e-5, noise_level_bounds=(1e-8, 1e-3))
    gp = GaussianProcessRegressor(
        kernel=kernel, n_restarts_optimizer=10, normalize_y=True, random_state=0
    )
    gp.fit(X_norm, y)

    # Dense 2D grid
    g0 = np.linspace(0.0, 1.0, grid_resolution)
    g1 = np.linspace(0.0, 1.0, grid_resolution)
    G0, G1 = np.meshgrid(g0, g1)
    grid_norm = np.column_stack([G0.ravel(), G1.ravel()])
    mean, std = gp.predict(grid_norm, return_std=True)
    mean_phys = mean * sign  # Back to original sign for display

    y_best = float(y.min())
    z = (y_best - mean - 0.01) / np.maximum(std, 1e-9)
    ei = np.maximum((y_best - mean - 0.01) * norm.cdf(z) + std * norm.pdf(z), 0.0)

    # Physical grid axes
    G0_phys = G0 * (hi0 - lo0) + lo0
    G1_phys = G1 * (hi1 - lo1) + lo1

    # Round coloring
    round_labels = np.zeros(len(evaluated_df), dtype=int)
    if campaign_state_path is not None and Path(campaign_state_path).exists():
        import json

        with open(campaign_state_path) as f:
            state = json.load(f)
        cursor = 0
        for entry in state["rounds"]:
            n = entry["n_suggested"]
            round_labels[cursor : cursor + n] = entry["round"]
            cursor += n

    n_rounds = int(round_labels.max()) + 1
    cmap_rounds = plt.cm.get_cmap("tab10", n_rounds)
    X_phys = X_norm * (hi - lo) + lo

    best_idx = int(np.argmin(y))

    fig, axes = plt.subplots(1, 3, figsize=(15, 5))

    # --- Left: GP mean ---
    ax = axes[0]
    cf = ax.contourf(
        G0_phys,
        G1_phys,
        mean_phys.reshape(grid_resolution, grid_resolution),
        levels=20,
        cmap="viridis",
    )
    fig.colorbar(cf, ax=ax, label=obj_name)
    for r in range(n_rounds):
        mask = round_labels == r
        label = f"Round {r} ({'Sobol' if r == 0 else 'BO'})"
        ax.scatter(
            X_phys[mask, 0],
            X_phys[mask, 1],
            color=cmap_rounds(r),
            s=40,
            zorder=5,
            label=label,
            marker="o" if r == 0 else "^",
            edgecolors="white",
            linewidths=0.5,
        )
    ax.scatter(
        X_phys[best_idx, 0],
        X_phys[best_idx, 1],
        marker="*",
        s=250,
        color="red",
        zorder=6,
        label=f"Best ({evaluated_df[obj_name].iloc[best_idx]:.3f})",
    )
    ax.set_xlabel(p0["name"], fontsize=11)
    ax.set_ylabel(p1["name"], fontsize=11)
    ax.set_title("GP Posterior Mean", fontsize=12)
    ax.legend(fontsize=7, loc="upper right")

    # --- Centre: GP std (uncertainty) ---
    ax = axes[1]
    cf2 = ax.contourf(
        G0_phys,
        G1_phys,
        std.reshape(grid_resolution, grid_resolution),
        levels=20,
        cmap="plasma",
    )
    fig.colorbar(cf2, ax=ax, label="std")
    ax.scatter(
        X_phys[:, 0],
        X_phys[:, 1],
        c="white",
        s=25,
        zorder=5,
        edgecolors="gray",
        linewidths=0.5,
    )
    ax.set_xlabel(p0["name"], fontsize=11)
    ax.set_ylabel(p1["name"], fontsize=11)
    ax.set_title("GP Posterior Std (Uncertainty)", fontsize=12)

    # --- Right: EI landscape ---
    ax = axes[2]
    cf3 = ax.contourf(
        G0_phys,
        G1_phys,
        ei.reshape(grid_resolution, grid_resolution),
        levels=20,
        cmap="hot_r",
    )
    fig.colorbar(cf3, ax=ax, label="EI")
    ax.scatter(
        X_phys[:, 0],
        X_phys[:, 1],
        c="white",
        s=25,
        zorder=5,
        edgecolors="gray",
        linewidths=0.5,
    )
    ei_best = grid_norm[np.argmax(ei)]
    ei_best_phys = ei_best * (hi - lo) + lo
    ax.scatter(
        ei_best_phys[0],
        ei_best_phys[1],
        marker="*",
        s=250,
        color="blue",
        zorder=6,
        label="Next suggestion",
    )
    ax.set_xlabel(p0["name"], fontsize=11)
    ax.set_ylabel(p1["name"], fontsize=11)
    ax.set_title("Expected Improvement", fontsize=12)
    ax.legend(fontsize=9)

    fig.suptitle(
        f"GP Surrogate — {p0['name']} × {p1['name']} → {obj_name}", fontsize=13
    )
    fig.tight_layout()
    out_path = output_dir / "gp_model_2d.png"
    fig.savefig(out_path, dpi=120, bbox_inches="tight")
    plt.close(fig)
    print(f"Saved GP model plot: {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Plot BO convergence, Pareto front, and parameter importance."
    )
    parser.add_argument(
        "--results",
        required=True,
        help="Path to evaluated.csv with parameter and objective columns.",
    )
    parser.add_argument(
        "--config",
        required=True,
        help="Path to search_space.yaml.",
    )
    parser.add_argument(
        "--output_dir",
        required=True,
        help="Directory to save output plots.",
    )
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    config = load_config(args.config)
    evaluated_df = pd.read_csv(args.results)
    objectives = config["objectives"]
    parameters = config["parameters"]

    print(f"Loaded {len(evaluated_df)} evaluated points.")

    plot_convergence(evaluated_df, objectives, output_dir)

    if len(objectives) >= 2:
        plot_pareto_front(evaluated_df, objectives, output_dir)

    plot_parameter_distributions(evaluated_df, parameters, objectives, output_dir)

    n_range = sum(1 for p in parameters if p["type"] == "range")
    campaign_state = output_dir / "campaign_state.json"
    if n_range == 1 and len(objectives) == 1:
        plot_gp_model_1d(
            evaluated_df, config, output_dir, campaign_state_path=campaign_state
        )
    elif n_range == 2 and len(objectives) == 1:
        plot_gp_model_2d(
            evaluated_df, config, output_dir, campaign_state_path=campaign_state
        )

    print("Plotting complete.")


if __name__ == "__main__":
    main()
