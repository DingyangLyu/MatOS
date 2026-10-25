#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


DEFAULT_CONTAINER_ROOT = Path("/opt/matos-tools")
# Non-container toolchain mount source comes from the deployment environment
# (MATOS_EXTERNAL_TOOLCHAIN_ROOT); no internal host path ships with this
# asset. When unset, the container-visible root is authoritative (host
# deployments expose it as a symlink to the real mount source).
DEFAULT_HOST_ROOT = Path(
    os.environ.get("MATOS_EXTERNAL_TOOLCHAIN_ROOT", "").strip()
    or str(DEFAULT_CONTAINER_ROOT)
)
DEFAULT_ENV_NAME = "matos-battery-electrochem-py311"
PACKAGES = {
    "pybamm": "pybamm",
    "pybop": "pybop",
    "bpx": "bpx",
    "liionpack": "liionpack",
    "openpnm": "openpnm",
}


def read_input() -> dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}
    value = payload.get("input", payload)
    return value if isinstance(value, dict) else {}


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def non_empty(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def bool_value(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def float_value(value: Any, default: float, minimum: float, maximum: float) -> float:
    if isinstance(value, (int, float)) and minimum <= float(value) <= maximum:
        return float(value)
    return default


def resolve_toolchain_root(payload: dict[str, Any]) -> Path:
    explicit = non_empty(payload.get("toolchainRoot"))
    if explicit:
        return Path(explicit)
    for key in (
        "MATOS_EXTERNAL_TOOLCHAIN_ROOT",
        "MATOS_CONTAINER_TOOLCHAIN_ROOT",
        "MATOS_COMPUTE_TOOLCHAIN_CONTAINER_ROOT",
    ):
        value = non_empty(os.environ.get(key))
        if value:
            return Path(value)
    if DEFAULT_CONTAINER_ROOT.is_dir():
        return DEFAULT_CONTAINER_ROOT
    return DEFAULT_HOST_ROOT


def to_container_path(path: Path) -> str:
    text = str(path)
    host = str(DEFAULT_HOST_ROOT)
    if text == host:
        return str(DEFAULT_CONTAINER_ROOT)
    if text.startswith(f"{host}/"):
        return f"{DEFAULT_CONTAINER_ROOT}{text[len(host):]}"
    if text.startswith("/tmp/matos-battery-env-does-not-exist"):
        suffix = text[len("/tmp/matos-battery-env-does-not-exist") :]
        return f"{DEFAULT_CONTAINER_ROOT}{suffix}"
    return text


def executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def probe_python(python: Path, timeout: float) -> dict[str, Any]:
    code = r"""
import importlib.metadata as md
import importlib.util
import json
import sys

packages = {}
for name, dist_name in json.loads(sys.argv[1]).items():
    spec = importlib.util.find_spec(name)
    version = None
    if spec is not None:
        for candidate in (dist_name, name, name.replace("_", "-")):
            try:
                version = md.version(candidate)
                break
            except md.PackageNotFoundError:
                continue
    packages[name] = {
        "available": spec is not None,
        "origin": getattr(spec, "origin", None) if spec else None,
        "package": dist_name,
        "version": version,
    }

models = []
if packages.get("pybamm", {}).get("available"):
    import pybamm
    for model in ("SPM", "SPMe", "DFN"):
        if hasattr(pybamm.lithium_ion, model):
            models.append(model)

print(json.dumps({
    "pythonVersion": sys.version.split()[0],
    "executable": sys.executable,
    "packages": packages,
    "pybammModels": models,
}, ensure_ascii=False, sort_keys=True))
"""
    try:
        env = os.environ.copy()
        env["PIP_USER"] = "0"
        env["PYTHONNOUSERSITE"] = "1"
        env.pop("PYTHONUSERBASE", None)
        result = subprocess.run(
            [str(python), "-c", code, json.dumps(PACKAGES)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            env=env,
        )
    except subprocess.TimeoutExpired as error:
        return {
            "ok": False,
            "status": "timeout",
            "stdout": error.stdout if isinstance(error.stdout, str) else "",
            "stderr": error.stderr if isinstance(error.stderr, str) else "",
        }
    except OSError as error:
        return {"ok": False, "status": "exec_error", "error": str(error)}
    if result.returncode != 0:
        return {
            "ok": False,
            "status": "failed",
            "exitCode": result.returncode,
            "stdout": result.stdout[-2000:],
            "stderr": result.stderr[-2000:],
        }
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {
            "ok": False,
            "status": "bad_json",
            "stdout": result.stdout[-2000:],
            "stderr": result.stderr[-2000:],
        }
    if isinstance(payload.get("executable"), str):
        payload["executable"] = to_container_path(Path(payload["executable"]))
    for package in payload.get("packages", {}).values():
        if isinstance(package, dict) and isinstance(package.get("origin"), str):
            package["origin"] = to_container_path(Path(package["origin"]))
    required = ["pybamm", "bpx"]
    missing_required = [
        name
        for name in required
        if not payload.get("packages", {}).get(name, {}).get("available")
    ]
    return {
        "ok": not missing_required,
        "status": "available" if not missing_required else "partial",
        "missingRequired": missing_required,
        **payload,
    }


def main() -> int:
    payload = read_input()
    root = resolve_toolchain_root(payload)
    env_name = non_empty(payload.get("envName")) or DEFAULT_ENV_NAME
    probe_packages = bool_value(payload.get("probePackages"), True)
    include_examples = bool_value(payload.get("includeExamples"), True)
    timeout = float_value(payload.get("timeoutSeconds"), 10.0, 1.0, 30.0)

    env_dir = root / "conda" / "envs" / env_name
    python = env_dir / "bin" / "python"
    environment = {
        "envName": env_name,
        "containerPath": f"/opt/matos-tools/conda/envs/{env_name}",
        "resolvedPath": to_container_path(env_dir),
        "python": to_container_path(python),
        "exists": env_dir.is_dir(),
        "pythonExecutable": executable(python),
        "status": "available" if executable(python) else "missing",
    }

    output: dict[str, Any] = {
        "ok": executable(python),
        "toolchain": {
            "root": to_container_path(root),
            "exists": root.is_dir(),
        },
        "environment": environment,
        "packages": {
            name: {
                "package": dist,
                "expectedIn": f"/opt/matos-tools/conda/envs/{env_name}",
            }
            for name, dist in PACKAGES.items()
        },
        "toolEntrypoints": {
            "catalog": "mcp__matos_asset__battery_electrochem_catalog",
            "runPyBaMM": "mcp__matos_asset__pybamm_run_model",
            "validateBPX": "mcp__matos_asset__bpx_validate",
        },
    }

    if executable(python) and probe_packages:
        probe = probe_python(python, timeout)
        output["probe"] = probe
        output["ok"] = bool(probe.get("ok"))
        output["environment"]["status"] = str(probe.get("status") or "failed")

    if include_examples:
        output["examples"] = {
            "cellModel": {
                "tool": "mcp__matos_asset__pybamm_run_model",
                "input": {
                    "model": "SPMe",
                    "cRate": 1.0,
                    "durationSeconds": 3600,
                },
            },
            "recommendedWorkflows": [
                "workflow:battery-pybamm-cell-discharge",
                "workflow:battery-model-parameterization-plan",
                "workflow:battery-pack-simulation-plan",
            ],
            "recommendedRole": "role:battery-electrochem-modeler",
        }

    if not output["ok"]:
        output["recommendedNextSteps"] = [
            f"Create /opt/matos-tools/conda/envs/{env_name} with real PyBaMM, BPX, PyBOP, liionpack, and OpenPNM packages.",
            "Run mcp__matos_asset__battery_electrochem_catalog again with probePackages=true.",
            "Use mcp__matos_asset__pybamm_run_model only after PyBaMM imports successfully.",
        ]

    print_json(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
