#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
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
SCIP_RELEASE = "10.0.2"
SUITE_RELEASE = "v0.12.0"


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


def timeout_seconds(value: Any) -> float:
    if isinstance(value, (int, float)) and 1 <= float(value) <= 60:
        return float(value)
    return 10.0


def resolve_root(payload: dict[str, Any]) -> Path:
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


def to_container_path(path: Path | None) -> str | None:
    if path is None:
        return None
    text = str(path)
    host = str(DEFAULT_HOST_ROOT)
    if text == host:
        return str(DEFAULT_CONTAINER_ROOT)
    if text.startswith(f"{host}/"):
        return f"{DEFAULT_CONTAINER_ROOT}{text[len(host):]}"
    return text


def executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def compact(text: str, limit: int = 4000) -> str:
    return text[-limit:] if len(text) > limit else text


def runtime_env(root: Path) -> dict[str, str]:
    env = os.environ.copy()
    scip_root = root / "scip" / "current"
    path_parts = [
        root / "bin",
        scip_root / "bin",
        root / "conda" / "envs" / "matos-scip-py313" / "bin",
        root / "scip" / "py313-pyscipopt" / "bin",
    ]
    lib_parts = [
        scip_root / "lib",
        root / "scip" / "py313-pyscipopt" / "lib",
    ]
    configured_path = [
        item
        for key in ("MATOS_RUNTIME_EXECUTABLE_PATHS", "MATOS_TOOLCHAIN_EXECUTABLE_PATHS")
        for item in env.get(key, "").split(":")
        if item
    ]
    configured_lib = [
        item
        for key in ("MATOS_RUNTIME_LIBRARY_PATHS", "MATOS_TOOLCHAIN_LIBRARY_PATHS")
        for item in env.get(key, "").split(":")
        if item
    ]
    env["PATH"] = ":".join(
        [*[str(path) for path in path_parts if path.exists()], *configured_path, env.get("PATH", "")]
    )
    env["LD_LIBRARY_PATH"] = ":".join(
        [
            *[str(path) for path in lib_parts if path.exists()],
            *configured_lib,
            env.get("LD_LIBRARY_PATH", ""),
        ]
    )
    env["SCIPOPTDIR"] = str(scip_root)
    return env


def run_probe(args: list[str], root: Path, timeout: float) -> dict[str, Any]:
    try:
        result = subprocess.run(
            args,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
            env=runtime_env(root),
        )
    except subprocess.TimeoutExpired as error:
        return {
            "ok": False,
            "status": "timeout",
            "stdout": compact(error.stdout or "" if isinstance(error.stdout, str) else ""),
            "stderr": compact(error.stderr or "" if isinstance(error.stderr, str) else ""),
        }
    except OSError as error:
        return {
            "ok": False,
            "status": "exec_error",
            "error": str(error),
        }
    return {
        "ok": result.returncode == 0,
        "status": "available" if result.returncode == 0 else "failed",
        "exitCode": result.returncode,
        "stdout": compact(result.stdout),
        "stderr": compact(result.stderr),
    }


def version_line(output: str) -> str | None:
    for line in output.splitlines():
        if "SCIP version" in line or "SoPlex" in line or "GCG" in line:
            return line.strip()
    return None


def component(path: Path, root: Path, timeout: float, probe: bool, args: list[str]) -> dict[str, Any]:
    status: dict[str, Any] = {
        "path": to_container_path(path),
        "exists": path.exists(),
        "executable": executable(path),
        "available": False,
        "status": "missing",
    }
    if not path.exists():
        return status
    if not executable(path):
        status["status"] = "not_executable"
        return status
    if not probe:
        status.update({"available": True, "status": "available"})
        return status
    result = run_probe([str(path), *args], root, timeout)
    status["probe"] = result
    status["available"] = bool(result.get("ok"))
    status["status"] = "available" if result.get("ok") else str(result.get("status") or "failed")
    line = version_line(f"{result.get('stdout', '')}\n{result.get('stderr', '')}")
    if line:
        status["versionLine"] = line
    return status


def tmp_root() -> Path:
    for value in (
        os.environ.get("TMPDIR"),
        os.environ.get("TMP"),
        os.environ.get("TEMP"),
        "/workspace/caches/tmp",
    ):
        if not value:
            continue
        path = Path(value)
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError:
            continue
        if os.access(path, os.W_OK):
            return path
    return Path.cwd()


def cli_smoke(scip: Path, root: Path, timeout: float) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="matos-scip-smoke-", dir=str(tmp_root())) as tmp:
        work = Path(tmp)
        problem = work / "simple.lp"
        solution = work / "simple.sol"
        problem.write_text(
            "\n".join(
                [
                    "Maximize",
                    " obj: 3 x + 2 y",
                    "Subject To",
                    " c1: x + y <= 4",
                    " c2: x <= 2",
                    "Bounds",
                    " 0 <= x <= 10",
                    " 0 <= y <= 10",
                    "General",
                    " x y",
                    "End",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        result = run_probe(
            [
                str(scip),
                "-c",
                f"read {problem} optimize write solution {solution} quit",
            ],
            root,
            timeout,
        )
        solution_text = solution.read_text(encoding="utf-8", errors="replace") if solution.is_file() else ""
    objective = None
    match = re.search(r"objective value:\s*([+-]?[0-9.]+)", solution_text)
    if match:
        objective = float(match.group(1))
    ok = bool(result.get("ok")) and "optimal solution found" in solution_text and objective == 10.0
    return {
        "ok": ok,
        "status": "available" if ok else "failed",
        "objective": objective,
        "expectedObjective": 10.0,
        "solverStatus": "optimal" if "optimal solution found" in solution_text else None,
        "solution": compact(solution_text, 1200),
        "probe": result,
    }


def python_smoke(python: Path, root: Path, timeout: float) -> dict[str, Any]:
    code = """
from pyscipopt import Model
m = Model("matos-scip-smoke")
m.hideOutput()
x = m.addVar("x", vtype="I")
y = m.addVar("y", vtype="I")
m.addCons(x + y <= 4)
m.addCons(x <= 2)
m.setObjective(3 * x + 2 * y, "maximize")
m.optimize()
print({"status": str(m.getStatus()), "objective": m.getObjVal(), "x": m.getVal(x), "y": m.getVal(y)})
"""
    result = run_probe([str(python), "-c", code], root, timeout)
    ok = bool(result.get("ok")) and "'status': 'optimal'" in str(result.get("stdout")) and "'objective': 10.0" in str(result.get("stdout"))
    return {
        "ok": ok,
        "status": "available" if ok else "failed",
        "probe": result,
    }


def main() -> int:
    payload = read_input()
    root = resolve_root(payload)
    probe = bool_value(payload.get("probe"), True)
    smoke = bool_value(payload.get("smoke"), False)
    timeout = timeout_seconds(payload.get("timeoutSeconds"))

    install = root / "scip" / "current"
    source = root / "source" / "scip"
    components = {
        "scip": component(root / "bin" / "scip", root, timeout, probe, ["--version"]),
        "soplex": component(root / "bin" / "soplex", root, timeout, probe, []),
        "gcg": component(root / "bin" / "gcg", root, timeout, probe, ["--version"]),
    }
    python = root / "conda" / "envs" / "matos-scip-py313" / "bin" / "python"
    if not executable(python):
        python = root / "scip" / "py313-pyscipopt" / "bin" / "python"
    python_status: dict[str, Any] = {
        "path": to_container_path(python),
        "exists": python.exists(),
        "executable": executable(python),
        "available": False,
        "status": "missing",
        "package": "PySCIPOpt",
    }
    if executable(python):
        import_probe = run_probe(
            [str(python), "-c", "import pyscipopt; print(pyscipopt.__version__)"],
            root,
            timeout,
        ) if probe else {"ok": True, "status": "available"}
        python_status.update(
            {
                "available": bool(import_probe.get("ok")),
                "status": "available" if import_probe.get("ok") else str(import_probe.get("status") or "failed"),
                "probe": import_probe,
            }
        )

    smoke_results: dict[str, Any] = {}
    if smoke:
        scip_path = root / "bin" / "scip"
        if executable(scip_path):
            smoke_results["cli"] = cli_smoke(scip_path, root, timeout)
        else:
            smoke_results["cli"] = {"ok": False, "status": "missing_scip"}
        if executable(python):
            smoke_results["python"] = python_smoke(python, root, timeout)
        else:
            smoke_results["python"] = {"ok": False, "status": "missing_pyscipopt_python"}

    available = bool(components["scip"].get("available")) and bool(components["soplex"].get("available"))
    if smoke_results:
        available = available and all(bool(item.get("ok")) for item in smoke_results.values())

    response = {
        "ok": True,
        "available": available,
        "status": "available" if available else "partial",
        "toolchain": {
            "name": "SCIP Optimization Suite",
            "scipVersion": SCIP_RELEASE,
            "suiteRelease": SUITE_RELEASE,
            "root": to_container_path(install),
            "sourceMirror": to_container_path(source),
            "downloadUrl": "https://github.com/scipopt/scipoptsuite-deploy/releases/download/v0.12.0/libscip-linux.zip",
            "sourceUrl": "https://github.com/scipopt/scip",
        },
        "components": components,
        "python": python_status,
        "runtime": {
            "path": "/opt/matos-tools/bin:$PATH",
            "ldLibraryPath": "/opt/matos-tools/scip/current/lib:/opt/matos-tools/aptroot-jammy/usr/lib/x86_64-linux-gnu:$LD_LIBRARY_PATH",
            "scipOptDir": "/opt/matos-tools/scip/current",
            "scip": "/opt/matos-tools/bin/scip",
            "soplex": "/opt/matos-tools/bin/soplex",
            "gcg": "/opt/matos-tools/bin/gcg",
            "python": to_container_path(python),
        },
        **({"smoke": smoke_results} if smoke_results else {}),
    }
    print_json(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
