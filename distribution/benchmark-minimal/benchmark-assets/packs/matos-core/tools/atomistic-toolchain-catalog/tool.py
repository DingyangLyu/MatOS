#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import shutil
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
SUPPORTED_TOOLS = [
    "xtb",
    "crest",
    "gromacs",
    "openmm",
    "plumed",
    "abacus",
    "cp2k",
    "qe",
    "wannier90",
    "gw",
    "qmcpack",
    "phonopy",
    "phono3py",
    "amset",
]
ATOMISTIC_ENV_NAMES = [
    "matos-atomistic",
    "matos-atomistic-base-py311",
    "matos-compute",
    "matos-mlip-gnn-py311",
    "matos-mlip-py311",
    "matos-mlip-py312",
    "matos-xrd-py311",
    "matos-cp2k",
    "matos-abacus",
    "matos-wannier90-py311",
    "matos-gw-yambo-py311",
    "matos-gw-abinit-py311",
    "matos-gw-gpaw-py311",
    "matos-gw-berkeleygw",
    "matos-gw-west",
    "matos-qmcpack-deps",
    "matos-qmcpack-afqmc-deps",
]
QMCPACK_VARIANT_ORDER = [
    "gpu-cuda-mpi",
    "cpu-mpi",
    "afqmc-phdf5-gpu-nccl-mpi",
    "afqmc-phdf5-complex-gpu-nccl-mpi",
    "afqmc-phdf5-complex-cpu-mpi",
    "afqmc-phdf5-cpu-mpi",
]
QMCPACK_AFQMC_VARIANT_ORDER = [
    "afqmc-phdf5-gpu-nccl-mpi",
    "afqmc-phdf5-complex-gpu-nccl-mpi",
    "afqmc-phdf5-complex-cpu-mpi",
    "afqmc-phdf5-cpu-mpi",
]
QMCPACK_COMPLEX_AFQMC_VARIANT_ORDER = [
    "afqmc-phdf5-complex-gpu-nccl-mpi",
    "afqmc-phdf5-complex-cpu-mpi",
]
QMCPACK_COMPLEX_GPU_AFQMC_VARIANT_ORDER = [
    "afqmc-phdf5-complex-gpu-nccl-mpi",
]
QMCPACK_VARIANT_LAUNCHERS = {
    "gpu-cuda-mpi": ["qmcpack-gpu"],
    "cpu-mpi": ["qmcpack-cpu"],
    "afqmc-phdf5-cpu-mpi": ["qmcpack-afqmc-cpu"],
    "afqmc-phdf5-complex-cpu-mpi": ["qmcpack-afqmc-complex-cpu"],
    "afqmc-phdf5-gpu-nccl-mpi": ["qmcpack-afqmc-gpu-nccl"],
    "afqmc-phdf5-complex-gpu-nccl-mpi": ["qmcpack-afqmc-complex-gpu-nccl"],
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


def timeout_seconds(value: Any) -> float:
    if isinstance(value, (int, float)) and 1 <= float(value) <= 30:
        return float(value)
    return 8.0


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


def selected_tools(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("tools")
    if not isinstance(raw, list):
        return SUPPORTED_TOOLS.copy()
    selected = [item for item in raw if isinstance(item, str) and item in SUPPORTED_TOOLS]
    return selected or SUPPORTED_TOOLS.copy()


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


def path_entries(root: Path) -> list[Path]:
    configured = [
        Path(item)
        for key in ("MATOS_RUNTIME_EXECUTABLE_PATHS", "MATOS_TOOLCHAIN_EXECUTABLE_PATHS")
        for item in os.environ.get(key, "").split(":")
        if non_empty(item)
    ]
    local = [
        root / "bin",
        *[root / "conda" / "envs" / name / "bin" for name in ATOMISTIC_ENV_NAMES],
        *[root / "conda" / "envs" / name / "sbin" for name in ATOMISTIC_ENV_NAMES],
        root / "aptroot-noble" / "usr" / "bin",
        root / "aptroot" / "usr" / "bin",
        root / "aptroot-jammy" / "usr" / "bin",
        root / "crest" / "continuous-gnu" / "crest",
        root / "plumed" / "2.10.0" / "bin",
        root / "cuda" / "12.9" / "bin",
        *[
            root / "qmcpack" / version / variant / "bin"
            for version in qmcpack_versions(root)
            for variant in QMCPACK_VARIANT_ORDER
        ],
    ]
    return [*local, *configured]


def library_entries(root: Path) -> list[Path]:
    configured = [
        Path(item)
        for key in ("MATOS_RUNTIME_LIBRARY_PATHS", "MATOS_TOOLCHAIN_LIBRARY_PATHS")
        for item in os.environ.get(key, "").split(":")
        if non_empty(item)
    ]
    local = [
        *[root / "conda" / "envs" / name / "lib" for name in ATOMISTIC_ENV_NAMES],
        *[root / "conda" / "envs" / name / "lib64" for name in ATOMISTIC_ENV_NAMES],
        *[root / "conda" / "envs" / name / "targets" / "x86_64-linux" / "lib" for name in ATOMISTIC_ENV_NAMES],
        root / "cuda" / "12.9" / "targets" / "x86_64-linux" / "lib",
        root / "cuda" / "12.9" / "lib64",
        root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu",
        root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "openmm",
        root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "blas",
        root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "lapack",
        root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "openmpi" / "lib",
        root / "aptroot" / "usr" / "lib",
        root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu",
        root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu" / "blas",
        root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu" / "lapack",
        root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu" / "openmpi" / "lib",
        root / "aptroot-jammy" / "usr" / "lib",
        root / "plumed" / "2.10.0" / "lib",
    ]
    return [*local, *configured]


def plumed_kernel(root: Path) -> Path:
    conda_kernel = root / "conda" / "envs" / "matos-cp2k" / "lib" / "libplumedKernel.so"
    if conda_kernel.exists():
        return conda_kernel
    return root / "plumed" / "2.10.0" / "lib" / "libplumedKernel.so"


def plumed_root(root: Path) -> Path:
    conda_root = root / "conda" / "envs" / "matos-cp2k" / "lib" / "plumed"
    if conda_root.exists():
        return conda_root
    return root / "plumed" / "2.10.0" / "lib"


def runtime_env(root: Path, *, include_apt_python: bool = False) -> dict[str, str]:
    env = os.environ.copy()
    paths = [str(path) for path in path_entries(root) if path.exists()]
    libs = [str(path) for path in library_entries(root) if path.exists()]
    env["PATH"] = ":".join([*paths, os.environ.get("PATH", "")])
    env["LD_LIBRARY_PATH"] = ":".join([*libs, os.environ.get("LD_LIBRARY_PATH", "")])
    py_path = root / "aptroot" / "usr" / "lib" / "python3" / "dist-packages"
    python_paths = [str(py_path)] if include_apt_python and py_path.exists() else []
    if os.environ.get("PYTHONPATH"):
        python_paths.append(os.environ["PYTHONPATH"])
    if python_paths:
        env["PYTHONPATH"] = ":".join(python_paths)
    else:
        env.pop("PYTHONPATH", None)
    conda_plumed_root = plumed_root(root)
    if conda_plumed_root.exists():
        env["PLUMED_ROOT"] = str(conda_plumed_root)
    kernel = plumed_kernel(root)
    if kernel.exists():
        env["PLUMED_KERNEL"] = str(kernel)
    for aptroot in (root / "aptroot-noble", root / "aptroot-jammy", root / "aptroot"):
        component_path = aptroot / "usr" / "lib" / "x86_64-linux-gnu" / "openmpi" / "lib" / "openmpi3"
        if component_path.exists():
            env["OPAL_PREFIX"] = str(aptroot / "usr")
            env["OMPI_MCA_mca_base_component_path"] = str(component_path)
            env["PMIX_MCA_pcompress_base_silence_warning"] = "1"
            break
    return env


def prefer_aptroot_noble_libs(env: dict[str, str], root: Path) -> None:
    lib_root = root / "aptroot-noble" / "usr" / "lib" / "x86_64-linux-gnu"
    if not lib_root.exists():
        return
    preferred = [
        lib_root,
        lib_root / "blas",
        lib_root / "lapack",
        lib_root / "openmpi" / "lib",
        root / "aptroot-noble" / "usr" / "lib",
    ]
    existing = [
        Path(item)
        for item in env.get("LD_LIBRARY_PATH", "").split(":")
        if item and "/conda/envs/" not in item
    ]
    env["LD_LIBRARY_PATH"] = ":".join(
        str(path)
        for path in [*preferred, *existing]
        if path.exists()
    )


def strip_aptroot_noble_libs(env: dict[str, str]) -> None:
    env["LD_LIBRARY_PATH"] = ":".join(
        item
        for item in env.get("LD_LIBRARY_PATH", "").split(":")
        if item
        and "/aptroot/" not in item
        and "/aptroot-jammy/" not in item
        and "/aptroot-noble/" not in item
    )


def is_toolchain_wrapper(path: Path, root: Path, name: str) -> bool:
    wrapper = root / "bin" / name
    try:
        return path.resolve() == wrapper.resolve()
    except OSError:
        return path == wrapper


def command_candidates(root: Path, name: str, extra: list[Path] | None = None) -> list[Path]:
    candidates = [
        root / "bin" / name,
        *[root / "conda" / "envs" / env_name / "bin" / name for env_name in ATOMISTIC_ENV_NAMES],
        root / "aptroot-noble" / "usr" / "bin" / name,
        root / "aptroot" / "usr" / "bin" / name,
        root / "aptroot-jammy" / "usr" / "bin" / name,
        *(extra or []),
    ]
    path = shutil.which(name, path=":".join(str(item) for item in path_entries(root)))
    if path:
        candidates.append(Path(path))
    seen: set[str] = set()
    result: list[Path] = []
    for path in candidates:
        text = str(path)
        if text in seen or not executable(path):
            continue
        seen.add(text)
        result.append(path)
    return result


def find_command(root: Path, name: str, extra: list[Path] | None = None) -> Path | None:
    return next(iter(command_candidates(root, name, extra)), None)


def qmcpack_versions(root: Path) -> list[str]:
    qmc_root = root / "qmcpack"
    if not qmc_root.exists():
        return []
    return sorted(
        path.name
        for path in qmc_root.iterdir()
        if path.is_dir() and (path.name.startswith("v") or path.name == "current")
    )


def parse_qmcpack_settings(path: Path) -> dict[str, str]:
    if not path.is_file():
        return {}
    settings: dict[str, str] = {}
    for line in path.read_text(errors="replace").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        settings[key] = value.strip()
    return settings


def settings_bool(settings: dict[str, str], key: str) -> bool | None:
    value = settings.get(key)
    if value is None:
        return None
    normalized = value.strip().upper()
    if normalized in {"ON", "TRUE", "1", "YES"}:
        return True
    if normalized in {"OFF", "FALSE", "0", "NO"}:
        return False
    return None


def qe_component(root: Path, name: str) -> dict[str, Any]:
    path = root / "qe" / "bin" / name
    available = executable(path)
    return {
        "name": name,
        "status": "available" if available else "missing",
        "available": available,
        "path": to_container_path(path if available else None),
    }


def qe_current_version(root: Path, profile: str) -> str | None:
    link = root / "qe" / f"current-{profile}"
    try:
        resolved = link.resolve()
    except OSError:
        return None
    parts = resolved.parts
    if len(parts) >= 2 and parts[-2][0].isdigit():
        return parts[-2]
    return None


def qe_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    qe_root = root / "qe"
    cpu_root = qe_root / "current-cpu"
    gpu_root = qe_root / "current-gpu"
    components = {
        name: qe_component(root, name)
        for name in (
            "pw.x",
            "pw-cpu.x",
            "pw-gpu.x",
            "ph.x",
            "ph-cpu.x",
            "ph-gpu.x",
            "pp.x",
            "projwfc.x",
            "bands.x",
            "dos.x",
            "q2r.x",
            "matdyn.x",
            "pw2wannier90.x",
            "pw2qmcpack.x",
            "qe-mpirun-cpu",
            "qe-mpirun-gpu",
        )
    }
    cpu_available = executable(cpu_root / "bin" / "pw.x") and components["pw-cpu.x"]["available"]
    gpu_available = executable(gpu_root / "bin" / "pw.x") and components["pw-gpu.x"]["available"]
    variants = {
        "cpu-mpi": {
            "status": "available" if cpu_available else "missing",
            "available": cpu_available,
            "path": components["pw-cpu.x"]["path"],
            "binaryPath": to_container_path(cpu_root / "bin" / "pw.x" if executable(cpu_root / "bin" / "pw.x") else None),
            "version": qe_current_version(root, "cpu"),
            "mpi": True,
            "accelerator": "cpu",
            "runExample": f"{components['pw-cpu.x']['path']} -in input.in" if components["pw-cpu.x"]["path"] else None,
            "mpiRunExample": f"{components['qe-mpirun-cpu']['path']} -np 4 pw.x -in input.in" if components["qe-mpirun-cpu"]["path"] else None,
        },
        "gpu-cuda-mpi": {
            "status": "available" if gpu_available else "missing",
            "available": gpu_available,
            "path": components["pw-gpu.x"]["path"],
            "binaryPath": to_container_path(gpu_root / "bin" / "pw.x" if executable(gpu_root / "bin" / "pw.x") else None),
            "version": qe_current_version(root, "gpu"),
            "mpi": True,
            "accelerator": "cuda",
            "runExample": f"CUDA_VISIBLE_DEVICES=0 {components['pw-gpu.x']['path']} -in input.in" if components["pw-gpu.x"]["path"] else None,
            "mpiRunExample": (
                f"CUDA_VISIBLE_DEVICES=0,1 MATOS_QE_GPU_MPI_PROCS=2 {components['pw-gpu.x']['path']} -in input.in"
                if components["pw-gpu.x"]["path"]
                else None
            ),
        },
    }
    recommended = "gpu-cuda-mpi" if gpu_available else "cpu-mpi" if cpu_available else None
    result: dict[str, Any] = {
        "name": "qe",
        "status": "available" if recommended else "partial" if any(item["available"] for item in components.values()) else "missing",
        "available": recommended is not None,
        "path": variants.get(recommended, {}).get("path") if recommended else None,
        "version": variants.get(recommended, {}).get("version") if recommended else None,
        "recommendedVariant": recommended,
        "variants": variants,
        "components": components,
        "qmcpackConverter": components["pw2qmcpack.x"],
        "note": (
            "Quantum ESPRESSO 7.6 CPU and GPU wrapper entries are available. Use pw-gpu.x for CUDA/OpenACC or pw-cpu.x for conservative CPU MPI."
            if gpu_available and cpu_available
            else "Quantum ESPRESSO is partially configured; inspect variants/components before use."
        ),
    }
    if probe:
        result["probe"] = {
            "ok": None,
            "status": "skipped",
            "reason": "QE startup probes require input files and may initialize MPI/GPU runtime; use the run examples or local smoke tests for execution validation.",
        }
    return result


def run_probe(
    args: list[str],
    root: Path,
    timeout: float,
    *,
    include_apt_python: bool = False,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    try:
        with tempfile.TemporaryDirectory(prefix="matos-atomistic-probe-") as cwd:
            env = runtime_env(root, include_apt_python=include_apt_python)
            if extra_env:
                env.update(extra_env)
            if args and Path(args[0]).name == "abinit":
                if is_toolchain_wrapper(Path(args[0]), root, "abinit"):
                    strip_aptroot_noble_libs(env)
                else:
                    prefer_aptroot_noble_libs(env, root)
            result = subprocess.run(
                args,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout,
                cwd=cwd,
                env=env,
                check=False,
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
    return {
        "ok": result.returncode == 0,
        "status": "available" if result.returncode == 0 else "failed",
        "exitCode": result.returncode,
        "stdout": clipped_text(result.stdout),
        "stderr": clipped_text(result.stderr),
    }


def clipped_text(value: str, limit: int = 4000) -> str:
    if len(value) <= limit:
        return value
    half = limit // 2
    return f"{value[:half]}\n...<truncated>...\n{value[-half:]}"


def version_from(text: str, patterns: list[str]) -> str | None:
    for pattern in patterns:
        match = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
        if match:
            return match.group(1).strip()
    return None


def command_tool(
    root: Path,
    name: str,
    command_name: str,
    probe_args: list[str],
    patterns: list[str],
    timeout: float,
    probe: bool,
    extra: list[Path] | None = None,
) -> dict[str, Any]:
    paths = command_candidates(root, command_name, extra)
    path = next(iter(paths), None)
    result: dict[str, Any] = {
        "name": name,
        "status": "available" if path else "missing",
        "available": path is not None,
        "path": to_container_path(path),
    }
    if not path or not probe:
        return result
    attempts: list[dict[str, Any]] = []
    selected_probe: dict[str, Any] | None = None
    selected_version: str | None = None
    selected_path = path
    ok = False
    for candidate in paths:
        probe_result = run_probe([str(candidate), *probe_args], root, timeout)
        combined = f"{probe_result.get('stdout', '')}\n{probe_result.get('stderr', '')}"
        version = version_from(combined, patterns)
        candidate_ok = bool(probe_result.get("ok") or version)
        attempts.append(
            {
                "path": to_container_path(candidate),
                "ok": candidate_ok,
                "status": "available" if candidate_ok else probe_result.get("status"),
                "exitCode": probe_result.get("exitCode"),
            }
        )
        if candidate_ok:
            selected_path = candidate
            selected_probe = probe_result
            selected_version = version
            ok = True
            break
        if selected_probe is None:
            selected_probe = probe_result
            selected_version = version
    probe_result = selected_probe or {}
    version = selected_version
    result.update(
        {
            "status": "available" if ok else str(probe_result.get("status") or "failed"),
            "available": ok,
            "path": to_container_path(selected_path),
            "version": version,
            "probe": {
                "ok": ok,
                "exitCode": probe_result.get("exitCode"),
                "status": "available" if ok else probe_result.get("status"),
            },
        }
    )
    if len(attempts) > 1:
        result["probe"]["attempts"] = attempts[:5]
    return result


def command_path_tool(
    root: Path,
    name: str,
    path: Path,
    probe_args: list[str],
    patterns: list[str],
    timeout: float,
    probe: bool,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "name": name,
        "status": "available",
        "available": True,
        "path": to_container_path(path),
    }
    if not probe:
        return result
    probe_result = run_probe([str(path), *probe_args], root, timeout)
    combined = f"{probe_result.get('stdout', '')}\n{probe_result.get('stderr', '')}"
    version = version_from(combined, patterns)
    ok = bool(probe_result.get("ok") or version)
    result.update(
        {
            "status": "available" if ok else str(probe_result.get("status") or "failed"),
            "available": ok,
            "version": version,
            "probe": {
                "ok": ok,
                "exitCode": probe_result.get("exitCode"),
                "status": "available" if ok else probe_result.get("status"),
            },
        }
    )
    return result


def openmm_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    python_candidates = [
        *[root / "conda" / "envs" / name / "bin" / "python" for name in ATOMISTIC_ENV_NAMES],
        Path("/usr/bin/python3.12"),
        Path(shutil.which("python3.12") or ""),
        Path(shutil.which("python3") or ""),
    ]
    dist = root / "aptroot" / "usr" / "lib" / "python3" / "dist-packages" / "openmm"
    python = next((path for path in python_candidates if str(path) and executable(path)), None)
    result: dict[str, Any] = {
        "name": "openmm",
        "status": "available" if python else "missing",
        "available": bool(python),
        "path": to_container_path(dist if dist.exists() else None),
        "python": to_container_path(python),
        "pythonPath": to_container_path(root / "aptroot" / "usr" / "lib" / "python3" / "dist-packages"),
    }
    if not result["available"] or not probe:
        return result
    code = (
        "import json, openmm, sys; "
        "print(json.dumps({'version': openmm.version.version, "
        "'modulePath': openmm.__file__, 'executable': sys.executable}, sort_keys=True))"
    )
    attempts: list[dict[str, Any]] = []
    probe_result: dict[str, Any] = {}
    version: str | None = None
    module_path: str | None = None
    ok = False
    selected_python = python
    for candidate in [path for path in python_candidates if str(path) and executable(path)]:
        current = run_probe([str(candidate), "-c", code], root, timeout)
        if not current.get("ok") and dist.exists():
            current = run_probe([str(candidate), "-c", code], root, timeout, include_apt_python=True)
        payload: dict[str, Any] = {}
        if current.get("ok"):
            try:
                payload = json.loads(str(current.get("stdout") or "{}"))
            except json.JSONDecodeError:
                payload = {}
        candidate_version = payload.get("version") if isinstance(payload.get("version"), str) else None
        candidate_module = payload.get("modulePath") if isinstance(payload.get("modulePath"), str) else None
        candidate_ok = bool(current.get("ok") and candidate_version)
        attempts.append(
            {
                "python": to_container_path(candidate),
                "ok": candidate_ok,
                "status": "available" if candidate_ok else current.get("status"),
                "exitCode": current.get("exitCode"),
            }
        )
        if candidate_ok:
            selected_python = candidate
            probe_result = current
            version = candidate_version
            module_path = candidate_module
            ok = True
            break
        if not probe_result:
            probe_result = current
    result.update(
        {
            "status": "available" if ok else str(probe_result.get("status") or "failed"),
            "available": ok,
            "version": version,
            "path": to_container_path(Path(module_path)) if module_path else result["path"],
            "python": to_container_path(selected_python),
            "pythonPath": to_container_path(Path(module_path).parent) if module_path else result["pythonPath"],
            "probe": {
                "ok": ok,
                "exitCode": probe_result.get("exitCode"),
                "status": "available" if ok else probe_result.get("status"),
            },
        }
    )
    if len(attempts) > 1:
        result["probe"]["attempts"] = attempts[:5]
    return result


def python_module_status(
    root: Path,
    name: str,
    import_name: str,
    command_name: str | None,
    timeout: float,
    probe: bool,
) -> dict[str, Any]:
    python_candidates = [
        *[root / "conda" / "envs" / env_name / "bin" / "python" for env_name in ATOMISTIC_ENV_NAMES],
        Path(shutil.which("python3") or ""),
    ]
    executable_candidates = command_candidates(root, command_name, []) if command_name else []
    selected_python = next((path for path in python_candidates if str(path) and executable(path)), None)
    command_path = next(iter(executable_candidates), None)
    result: dict[str, Any] = {
        "name": name,
        "status": "available" if selected_python or command_path else "missing",
        "available": bool(selected_python or command_path),
        "python": to_container_path(selected_python),
        "path": to_container_path(command_path),
    }
    if not result["available"] or not probe:
        return result
    attempts: list[dict[str, Any]] = []
    selected_probe: dict[str, Any] | None = None
    selected_command_probe: dict[str, Any] | None = None
    selected_version: str | None = None
    ok = False
    code = (
        "import importlib, json\n"
        f"m=importlib.import_module({import_name!r})\n"
        "print(json.dumps({'version': getattr(m, '__version__', None)}))\n"
    )
    for candidate in [path for path in python_candidates if str(path) and executable(path)]:
        probe_result = run_probe([str(candidate), "-c", code], root, timeout)
        version = None
        try:
            version = json.loads(str(probe_result.get("stdout") or "{}").splitlines()[-1]).get("version")
        except Exception:
            version = None
        candidate_ok = bool(probe_result.get("ok"))
        attempts.append(
            {
                "python": to_container_path(candidate),
                "ok": candidate_ok,
                "status": "available" if candidate_ok else probe_result.get("status"),
                "exitCode": probe_result.get("exitCode"),
            }
        )
        if candidate_ok:
            selected_python = candidate
            selected_probe = probe_result
            selected_version = version
            ok = True
            break
        if selected_probe is None:
            selected_probe = probe_result
    command_ok = True
    if command_name:
        command_ok = False
        if command_path:
            selected_command_probe = run_probe([str(command_path), "--help"], root, timeout)
            command_ok = bool(selected_command_probe.get("ok"))
        ok = ok and command_ok
    status = "available" if ok else str((selected_probe or {}).get("status") or "failed")
    if command_name and not command_ok:
        status = str((selected_command_probe or {}).get("status") or "missing")
    result.update(
        {
            "status": status,
            "available": ok,
            "python": to_container_path(selected_python),
            "version": selected_version,
            "probe": {
                "ok": ok,
                "exitCode": (selected_probe or {}).get("exitCode"),
                "status": "available" if ok else (selected_probe or {}).get("status"),
            },
        }
    )
    result["probe"]["attempts"] = attempts[:5]
    if command_name:
        result["commandProbe"] = {
            "ok": command_ok,
            "exitCode": (selected_command_probe or {}).get("exitCode"),
            "status": "available" if command_ok else (selected_command_probe or {}).get("status", "missing"),
        }
    return result


def ldd_missing(path: Path, root: Path, timeout: float) -> list[str]:
    if not path.exists():
        return []
    result = run_probe(["ldd", str(path)], root, timeout)
    text = f"{result.get('stdout', '')}\n{result.get('stderr', '')}"
    missing: list[str] = []
    for line in text.splitlines():
        if "not found" in line:
            missing.append(line.strip())
    return missing


def abacus_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    path = root / "conda" / "envs" / "matos-abacus" / "bin" / "abacus"
    downloaded = root / "abacus" / "3.3.0-deepmodeling" / "bin" / "abacus"
    if executable(path):
        status = command_path_tool(
            root,
            "abacus",
            path,
            ["--version"],
            [r"ABACUS(?:\s+version)?\s*[:=]?\s*([0-9][^\s]*)", r"v([0-9][^\s]*)"],
            timeout,
            probe,
        )
        status["note"] = "Runnable ABACUS detected on PATH."
        return status
    result: dict[str, Any] = {
        "name": "abacus",
        "status": "missing_dependencies" if downloaded.exists() else "not_installed",
        "available": False,
        "path": to_container_path(downloaded if downloaded.exists() else None),
        "recommendedInstall": 'conda create -n abacus_env abacus "libblas=*=*mkl" mpich -c conda-forge',
        "note": "ABACUS requires a full conda environment; the direct historical package is not exposed as runnable without its dependency graph.",
    }
    if downloaded.exists() and probe:
        result["missingLibraries"] = ldd_missing(downloaded, root, timeout)[:20]
    return result


def cp2k_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    candidates = [
        root / "conda" / "envs" / "matos-cp2k" / "bin" / "cp2k",
        root / "conda" / "envs" / "matos-cp2k" / "bin" / "cp2k.psmp",
        root / "conda" / "envs" / "matos-cp2k" / "bin" / "cp2k.ssmp",
        root / "conda" / "envs" / "matos-cp2k" / "bin" / "cp2k.popt",
    ]
    path = next((candidate for candidate in candidates if executable(candidate)), None)
    if path:
        status = command_path_tool(
            root,
            "cp2k",
            path,
            ["--version"],
            [r"CP2K version\s+([0-9][^\s]*)", r"cp2k\s+version\s+([0-9][^\s]*)"],
            timeout,
            probe,
        )
        status["note"] = "Runnable CP2K detected on PATH."
        return status
    return {
        "name": "cp2k",
        "status": "not_installed",
        "available": False,
        "path": None,
        "recommendedInstall": "conda install conda-forge::cp2k",
        "note": "CP2K is tracked by this catalog but is not currently installed in the mounted toolchain.",
    }


def wannier90_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    version_patterns = [
        r"(?:Wannier90|Postw90)\s*:\s*([0-9][^\s,]*)",
        r"Wannier90\s+(?:version\s*)?([0-9][^\s,]*)",
        r"Version\s*[:=]?\s*([0-9][^\s,]*)",
    ]
    main = command_tool(
        root,
        "wannier90.x",
        "wannier90.x",
        ["-v"],
        version_patterns,
        timeout,
        probe,
    )
    post = command_tool(
        root,
        "postw90.x",
        "postw90.x",
        ["-v"],
        version_patterns,
        timeout,
        probe,
    )
    pw2 = command_tool(
        root,
        "pw2wannier90.x",
        "pw2wannier90.x",
        ["-h"],
        [
            r"Program\s+PW2WANNIER90\s+v?([0-9][^\s]*)",
            r"Program\s+PW2WANNIER\s+v\.?([0-9][^\s]*)",
            r"Quantum ESPRESSO\s+v?([0-9][^\s]*)",
        ],
        timeout,
        False,
    )
    if pw2.get("available"):
        pw2["probe"] = {
            "ok": None,
            "status": "skipped",
            "reason": "pw2wannier90.x initializes MPI even in help mode; use local_toolchain_preflight for startup-marker validation.",
        }
    helpers = {
        "wannier_ham.x": command_tool(
            root,
            "wannier_ham.x",
            "wannier_ham.x",
            ["-h"],
            [],
            timeout,
            False,
        ),
        "wannier_plot.x": command_tool(
            root,
            "wannier_plot.x",
            "wannier_plot.x",
            ["-h"],
            [],
            timeout,
            False,
        ),
    }
    available = bool(main.get("available") and pw2.get("available"))
    partial = bool(main.get("available") or post.get("available") or pw2.get("available"))
    result: dict[str, Any] = {
        "name": "wannier90",
        "status": "available" if available else "partial" if partial else "missing",
        "available": available,
        "path": main.get("path"),
        "version": main.get("version"),
        "components": {
            "wannier90.x": main,
            "postw90.x": post,
            "pw2wannier90.x": pw2,
            **helpers,
        },
        "note": (
            "Runnable Wannier90 plus QE pw2wannier90 interface detected."
            if available
            else "Wannier90 requires wannier90.x and pw2wannier90.x for the native QE workflow."
        ),
    }
    return result


def implementation_status(
    *,
    name: str,
    required: dict[str, dict[str, Any]],
    optional: dict[str, dict[str, Any]] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    required_values = list(required.values())
    optional_values = list((optional or {}).values())
    configured = any(bool(item.get("path")) for item in [*required_values, *optional_values])
    available = bool(required_values and all(item.get("available") is True for item in required_values))
    status = "available" if available else "partial" if configured else "missing"
    return {
        "name": name,
        "status": status,
        "available": available,
        "configured": configured,
        "requiredCommands": required,
        **({"optionalCommands": optional} if optional else {}),
        **({"note": note} if note else {}),
    }


def gw_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    yambo_version_patterns = [
        r"Yambo(?:\s+version)?\s*[:=]?\s*([0-9][^\s,]*)",
        r"yambo(?:\s+version)?\s*[:=]?\s*([0-9][^\s,]*)",
    ]
    yambo = implementation_status(
        name="yambo",
        required={
            "yambo": command_tool(
                root,
                "yambo",
                "yambo",
                ["-V"],
                yambo_version_patterns,
                timeout,
                probe,
            ),
            "ypp": command_tool(
                root,
                "ypp",
                "ypp",
                ["-h"],
                [r"ypp(?:\s+version)?\s*[:=]?\s*([0-9][^\s,]*)"],
                timeout,
                False,
            ),
            "p2y": command_tool(
                root,
                "p2y",
                "p2y",
                ["-h"],
                [],
                timeout,
                False,
            ),
        },
        note="QE -> Yambo GW/BSE workflow. Requires p2y, yambo, and ypp.",
    )
    berkeleygw = implementation_status(
        name="berkeleygw",
        required={
            "epsilon.cplx.x": command_tool(
                root,
                "epsilon.cplx.x",
                "epsilon.cplx.x",
                ["--help"],
                [],
                timeout,
                False,
            ),
            "sigma.cplx.x": command_tool(
                root,
                "sigma.cplx.x",
                "sigma.cplx.x",
                ["--help"],
                [],
                timeout,
                False,
            ),
        },
        optional={
            "kernel.cplx.x": command_tool(
                root,
                "kernel.cplx.x",
                "kernel.cplx.x",
                ["--help"],
                [],
                timeout,
                False,
            ),
            "absorption.cplx.x": command_tool(
                root,
                "absorption.cplx.x",
                "absorption.cplx.x",
                ["--help"],
                [],
                timeout,
                False,
            ),
        },
        note="BerkeleyGW quasiparticle and BSE workflow.",
    )
    west = implementation_status(
        name="west",
        required={
            "wstat.x": command_tool(root, "wstat.x", "wstat.x", ["-h"], [], timeout, False),
            "wfreq.x": command_tool(root, "wfreq.x", "wfreq.x", ["-h"], [], timeout, False),
        },
        optional={
            "westpp.x": command_tool(root, "westpp.x", "westpp.x", ["-h"], [], timeout, False),
        },
        note="WEST stochastic/deterministic GW workflow for QE-family data.",
    )
    abinit = implementation_status(
        name="abinit",
        required={
            "abinit": command_tool(
                root,
                "abinit",
                "abinit",
                ["--version"],
                [r"ABINIT(?:\s+version)?\s*[:=]?\s*([0-9][^\s,]*)", r"^([0-9]+(?:\.[0-9]+)+)"],
                timeout,
                probe,
            ),
        },
        note="ABINIT native GW workflow.",
    )
    gpaw = implementation_status(
        name="gpaw",
        required={
            "gpaw": command_tool(
                root,
                "gpaw",
                "gpaw",
                ["--version"],
                [r"GPAW(?:\s+version)?\s*[:=]?\s*([0-9][^\s,]*)"],
                timeout,
                probe,
            ),
        },
        note="GPAW Python GW workflow.",
    )
    implementations = {
        "yambo": yambo,
        "berkeleygw": berkeleygw,
        "west": west,
        "abinit": abinit,
        "gpaw": gpaw,
    }
    ordered = ["yambo", "berkeleygw", "west", "abinit", "gpaw"]
    available = [name for name in ordered if implementations[name].get("available") is True]
    configured = [
        name
        for name in ordered
        if implementations[name].get("configured") is True
    ]
    recommended = next(iter(available), None)
    primary_path = None
    if recommended:
        required = implementations[recommended].get("requiredCommands")
        if isinstance(required, dict):
            first = next(iter(required.values()), {})
            if isinstance(first, dict):
                primary_path = first.get("path")
    return {
        "name": "gw",
        "status": "available" if available else "partial" if configured else "missing",
        "available": bool(available),
        "configured": bool(configured),
        "path": primary_path,
        "recommendedImplementation": recommended,
        "availableImplementations": available,
        "configuredImplementations": configured,
        "implementations": implementations,
        "note": (
            "At least one local GW implementation is available."
            if available
            else "No complete local GW implementation detected. Use remote VASP or batch workflows if configured, or install Yambo/BerkeleyGW/WEST/ABINIT/GPAW under /opt/matos-tools."
        ),
    }


def qmcpack_variant_paths(root: Path) -> dict[str, tuple[str, Path, Path]]:
    variants: dict[str, tuple[str, Path, Path]] = {}
    for version in qmcpack_versions(root):
        version_root = root / "qmcpack" / version
        for variant in QMCPACK_VARIANT_ORDER:
            path = version_root / variant / "bin" / "qmcpack"
            if executable(path):
                launcher_names = QMCPACK_VARIANT_LAUNCHERS.get(
                    variant,
                    ["qmcpack-gpu" if "cuda" in variant or "gpu" in variant else "qmcpack-cpu"],
                )
                launchers = [
                    candidate
                    for name in launcher_names
                    for candidate in (root / "bin" / name, version_root / "bin" / name)
                ]
                launcher = next((item for item in launchers if executable(item)), path)
                variants[variant] = (version, path, launcher)
    return variants


def qmcpack_binary_status(
    root: Path,
    *,
    variant: str,
    version_dir: str,
    path: Path,
    launcher: Path,
    timeout: float,
    probe: bool,
) -> dict[str, Any]:
    launcher_path = to_container_path(launcher)
    settings = parse_qmcpack_settings(path.parent / "qmcpack.settings")
    build_afqmc = settings_bool(settings, "BUILD_AFQMC")
    parallel_hdf5 = settings_bool(settings, "ENABLE_PHDF5")
    complex_build = settings_bool(settings, "QMC_COMPLEX")
    cuda_build = settings_bool(settings, "ENABLE_CUDA")
    accelerator = "cuda" if cuda_build is True or "cuda" in variant or "gpu" in variant else "cpu"
    nccl_build = settings_bool(settings, "BUILD_AFQMC_WITH_NCCL")
    nccl_available = nccl_build is True or "nccl" in variant
    result: dict[str, Any] = {
        "name": f"qmcpack-{variant}",
        "status": "available",
        "available": True,
        "path": launcher_path,
        "launcher": launcher_path,
        "binaryPath": to_container_path(path),
        "variant": variant,
        "versionDir": version_dir,
        "mpi": variant.endswith("-mpi"),
        "accelerator": accelerator,
        "cuda": accelerator == "cuda",
        "nccl": nccl_available,
        "buildAfqmc": build_afqmc,
        "parallelHdf5": parallel_hdf5,
        "complex": complex_build,
        "inputFamily": "afqmc" if variant.startswith("afqmc") else "vmc-dmc",
        "afqmcInputFormat": "hdf5" if build_afqmc is True and parallel_hdf5 is True else None,
        "settingsPath": to_container_path(path.parent / "qmcpack.settings" if (path.parent / "qmcpack.settings").is_file() else None),
        "runExample": (
            f"CUDA_VISIBLE_DEVICES=0 QMCPACK_MPI_RANKS=<ranks> {launcher_path} input.xml"
            if accelerator == "cuda"
            else f"QMCPACK_MPI_RANKS=<ranks> {launcher_path} input.xml"
        ),
    }
    if variant == "afqmc-phdf5-gpu-nccl-mpi":
        result["validatedHamiltonianTypes"] = ["Factorized"]
        result["validationNote"] = "Real-valued AFQMC CUDA/NCCL smoke passed on the Ne HDF5 Factorized test."
    elif variant == "afqmc-phdf5-complex-cpu-mpi":
        result["validatedHamiltonianTypes"] = ["Factorized", "THC"]
        result["validationNote"] = "Complex AFQMC CPU/PHDF5 smoke passed on the diamondC complex Factorized test."
    elif variant == "afqmc-phdf5-complex-gpu-nccl-mpi":
        result["validatedHamiltonianTypes"] = ["Factorized", "THC"]
        result["knownLimitations"] = [
            "Use one MPI rank per complex Factorized/Cholesky AFQMC GPU calculation; the MatOS launcher maps QMCPACK_MPI_RANKS>1 to independent one-rank replicas because upstream QMCPACK 4.3 does not implement distributed Factorized Hamiltonians.",
            "For true distributed multi-rank AFQMC, use a Hamiltonian/input path validated for distributed execution instead of one Factorized input.",
        ]
        result["validationNote"] = "Complex AFQMC CUDA/NCCL smoke passed on diamondC complex HDF5 Factorized/Cholesky and THC tests with one MPI rank."
    if not probe:
        return result

    probe_result = run_probe(
        [str(launcher), "--version"],
        root,
        timeout,
        extra_env={
            "OPAL_PREFIX": str(
                root
                / "conda"
                / "envs"
                / ("matos-qmcpack-afqmc-deps" if variant.startswith("afqmc") else "matos-qmcpack-deps")
            ),
            "OMPI_ALLOW_RUN_AS_ROOT": "1",
            "OMPI_ALLOW_RUN_AS_ROOT_CONFIRM": "1",
        },
    )
    combined = f"{probe_result.get('stdout', '')}\n{probe_result.get('stderr', '')}"
    version = version_from(
        combined,
        [r"QMCPACK version\s+([0-9][^\s]*)", r"QMCPACK\s+([0-9][^\s]*)"],
    )
    ok = bool(probe_result.get("ok") or version)
    failure_reason = None
    if not ok:
        lower_combined = combined.lower()
        if "glibc_" in lower_combined or "libc.so.6" in lower_combined:
            failure_reason = (
                "QMCPACK binary exists, but the current runtime cannot start it "
                "because the required glibc version is not visible through the "
                "launcher."
            )
        elif "opal_shmem_base_select failed" in lower_combined or "mpi_init failed" in lower_combined:
            failure_reason = (
                "QMCPACK binary exists, but MPI initialization failed in the "
                "current runtime. Check the launcher OpenMPI/PMIx component paths "
                "before production use."
            )
        elif probe_result.get("status"):
            failure_reason = f"QMCPACK probe status: {probe_result.get('status')}"
    result.update(
        {
            "status": "available" if ok else str(probe_result.get("status") or "failed"),
            "available": ok,
            "version": version,
            "probe": {
                "ok": ok,
                "exitCode": probe_result.get("exitCode"),
                "status": "available" if ok else probe_result.get("status"),
                **({"failureReason": failure_reason} if failure_reason else {}),
                **({"stdout": probe_result.get("stdout")} if not ok and probe_result.get("stdout") else {}),
                **({"stderr": probe_result.get("stderr")} if not ok and probe_result.get("stderr") else {}),
            },
            **({"failureReason": failure_reason} if failure_reason else {}),
        }
    )
    return result


def qmcpack_status(root: Path, timeout: float, probe: bool) -> dict[str, Any]:
    variants: dict[str, Any] = {}
    for variant, (version_dir, path, launcher) in qmcpack_variant_paths(root).items():
        variants[variant] = qmcpack_binary_status(
            root,
            variant=variant,
            version_dir=version_dir,
            path=path,
            launcher=launcher,
            timeout=timeout,
            probe=probe,
        )

    recommended = next(
        (
            variant
            for variant in QMCPACK_VARIANT_ORDER
            if variants.get(variant, {}).get("available") is True
        ),
        None,
    )
    recommended_afqmc = next(
        (
            variant
            for variant in QMCPACK_AFQMC_VARIANT_ORDER
            if (status := variants.get(variant, {})).get("available") is True
            and status.get("buildAfqmc") is True
            and status.get("parallelHdf5") is True
        ),
        None,
    )
    recommended_gpu_afqmc = next(
        (
            variant
            for variant in QMCPACK_AFQMC_VARIANT_ORDER
            if (status := variants.get(variant, {})).get("available") is True
            and status.get("buildAfqmc") is True
            and status.get("parallelHdf5") is True
            and status.get("cuda") is True
        ),
        None,
    )
    recommended_complex_afqmc = next(
        (
            variant
            for variant in QMCPACK_COMPLEX_AFQMC_VARIANT_ORDER
            if (status := variants.get(variant, {})).get("available") is True
            and status.get("buildAfqmc") is True
            and status.get("parallelHdf5") is True
            and status.get("complex") is True
        ),
        None,
    )
    recommended_complex_gpu_afqmc = next(
        (
            variant
            for variant in QMCPACK_COMPLEX_GPU_AFQMC_VARIANT_ORDER
            if (status := variants.get(variant, {})).get("available") is True
            and status.get("buildAfqmc") is True
            and status.get("parallelHdf5") is True
            and status.get("complex") is True
            and status.get("cuda") is True
        ),
        None,
    )
    configured = bool(variants)
    component_specs = [
        ("convert4qmc", "qmcpack-convert4qmc"),
        ("ppconvert", "qmcpack-ppconvert"),
        ("convertpw4qmc", "qmcpack-convertpw4qmc"),
        ("qmcfinitesize", "qmcpack-qmcfinitesize"),
        ("qmca", "qmcpack-qmca"),
        ("qmc-fit", "qmcpack-qmc-fit"),
        ("qdens", "qmcpack-qdens"),
        ("qdens-radial", "qmcpack-qdens-radial"),
        ("qmc-get-supercell", "qmcpack-qmc-get-supercell"),
        ("qmc-extract-eshdf-kvectors", "qmcpack-qmc-extract-eshdf-kvectors"),
        ("qmc-check-affinity", "qmcpack-qmc-check-affinity"),
        ("gpaw4qmcpack.py", "qmcpack-gpaw4qmcpack.py"),
        ("molden2qmc", "qmcpack-molden2qmc"),
        ("pyscf_to_afqmc.py", "qmcpack-pyscf_to_afqmc.py"),
        ("afqmc_to_fcidump.py", "qmcpack-afqmc_to_fcidump.py"),
        ("fcidump_to_afqmc.py", "qmcpack-fcidump_to_afqmc.py"),
        ("kp_to_sparse.py", "qmcpack-kp_to_sparse.py"),
        ("sparse_to_dense.py", "qmcpack-sparse_to_dense.py"),
        ("test_afqmc_input.py", "qmcpack-test_afqmc_input.py"),
        ("wfn_to_hdf5.py", "qmcpack-wfn_to_hdf5.py"),
        ("afqmc-migrate-input.py", "qmcpack-afqmc-migrate-input.py"),
        ("qmc-afqmc-performance", "qmcpack-qmc-afqmc-performance"),
    ]
    converters = {}
    for name, command_name in component_specs:
        converters[name] = command_tool(
            root,
            name,
            command_name,
            ["--help"],
            [],
            timeout,
            False,
            extra=[
                root / "qmcpack" / version / variant / "bin" / name
                for version in qmcpack_versions(root)
                for variant in QMCPACK_VARIANT_ORDER
            ]
            + [root / "qmcpack" / version / "bin" / name for version in qmcpack_versions(root)],
        )
        converters[name]["nativeCommand"] = name

    python_env = root / "conda" / "envs" / "matos-qmcpack-deps"
    afqmc_python_env = root / "conda" / "envs" / "matos-qmcpack-afqmc-deps"
    source_root = root / "source-library"
    manual_root = source_root / "qmcpack-manual"
    pseudo_root = root / "qmcpack" / "pseudopotentials" / "current"
    molden_root = source_root / "molden2qmc" / "current"
    afqmc_root = root / "qmcpack" / "v4.3.0" / "afqmctools"
    qe_converter = command_tool(
        root,
        "pw2qmcpack.x",
        "qe-pw2qmcpack",
        ["-h"],
        [r"Program\s+pw2qmcpack\s+v\.?([0-9][^\s]*)"],
        timeout,
        False,
        extra=[root / "qe" / "bin" / "pw2qmcpack.x"],
    )
    return {
        "name": "qmcpack",
        "status": "available" if recommended else "partial" if configured else "missing",
        "available": recommended is not None,
        "path": variants.get(recommended, {}).get("path") if recommended else None,
        "version": variants.get(recommended, {}).get("version") if recommended else None,
        "recommendedVariant": recommended,
        "recommendedAfqmcVariant": recommended_afqmc,
        "recommendedGpuAfqmcVariant": recommended_gpu_afqmc,
        "recommendedComplexAfqmcVariant": recommended_complex_afqmc,
        "recommendedComplexGpuAfqmcVariant": recommended_complex_gpu_afqmc,
        "afqmcExecutable": variants.get(recommended_afqmc) if recommended_afqmc else None,
        "gpuAfqmcExecutable": variants.get(recommended_gpu_afqmc) if recommended_gpu_afqmc else None,
        "complexAfqmcExecutable": variants.get(recommended_complex_afqmc) if recommended_complex_afqmc else None,
        "complexGpuAfqmcExecutable": variants.get(recommended_complex_gpu_afqmc) if recommended_complex_gpu_afqmc else None,
        "variants": variants,
        "components": converters,
        "workflowDependencies": {
            "nexusPythonEnv": {
                "status": "available" if executable(python_env / "bin" / "python") else "missing",
                "available": executable(python_env / "bin" / "python"),
                "path": to_container_path(python_env),
                "python": to_container_path(python_env / "bin" / "python"),
                "expectedImports": [
                    "nexus",
                    "numpy",
                    "scipy",
                    "h5py",
                    "matplotlib",
                    "pyscf",
                    "mpi4py",
                    "afqmctools",
                    "spglib",
                    "CifFile",
                    "seekpath",
                    "pydot",
                ],
            },
            "afqmcPythonEnv": {
                "status": "available" if executable(afqmc_python_env / "bin" / "python") else "missing",
                "available": executable(afqmc_python_env / "bin" / "python"),
                "path": to_container_path(afqmc_python_env),
                "python": to_container_path(afqmc_python_env / "bin" / "python"),
                "expectedImports": [
                    "numpy",
                    "scipy",
                    "h5py",
                    "mpi4py",
                    "pyscf",
                    "afqmctools",
                ],
                "note": "Use this environment for AFQMC HDF5 generation/checking; h5py is MPI-enabled and aligned with the parallel-HDF5 QMCPACK build.",
            },
            "qePw2qmcpack": qe_converter,
            "manual": {
                "status": "available" if manual_root.exists() else "missing",
                "available": manual_root.exists(),
                "path": to_container_path(manual_root),
            },
            "pseudopotentials": {
                "status": "available" if pseudo_root.exists() else "missing",
                "available": pseudo_root.exists(),
                "path": to_container_path(pseudo_root),
                "note": "Use QMCPACK-compatible pseudopotentials for QMC; QE/VASP pseudopotentials are not interchangeable unless explicitly converted/validated.",
            },
            "molden2qmc": {
                "status": "available" if (molden_root / "molden2qmc.py").exists() else "missing",
                "available": (molden_root / "molden2qmc.py").exists(),
                "path": to_container_path(molden_root),
            },
            "afqmctools": {
                "status": "available" if (afqmc_root / "afqmctools").is_dir() else "missing",
                "available": (afqmc_root / "afqmctools").is_dir(),
                "path": to_container_path(afqmc_root),
                "note": (
                    "AFQMC input-generation tools are available, and at least one AFQMC+parallel-HDF5 QMCPACK executable is available via afqmcExecutable."
                    if recommended_afqmc
                    else "AFQMC input-generation tools are available; AFQMC execution still requires a QMCPACK build with BUILD_AFQMC=ON and ENABLE_PHDF5=ON."
                ),
            },
        },
        "note": (
            "Runnable QMCPACK detected. Use the returned MatOS wrapper path; set QMCPACK_MPI_RANKS for MPI parallelism."
            if recommended
            else "QMCPACK is not installed under /opt/matos-tools/qmcpack."
        ),
    }


def main() -> None:
    payload = read_input()
    root = resolve_root(payload)
    probe = bool_value(payload.get("probe"), True)
    timeout = timeout_seconds(payload.get("timeoutSeconds"))
    tools = selected_tools(payload)
    result: dict[str, Any] = {
        "ok": True,
        "toolchainRoot": to_container_path(root),
        "runtime": {
            "pathEntries": [to_container_path(path) for path in path_entries(root) if path.exists()],
            "libraryEntries": [to_container_path(path) for path in library_entries(root) if path.exists()],
            "environment": {
                "PLUMED_ROOT": to_container_path(plumed_root(root)),
                "PLUMED_KERNEL": to_container_path(plumed_kernel(root)),
                "OPENMM_PYTHONPATH": to_container_path(
                    root / "aptroot" / "usr" / "lib" / "python3" / "dist-packages"
                ),
            },
        },
        "tools": {},
    }
    if "xtb" in tools:
        result["tools"]["xtb"] = command_tool(
            root,
            "xtb",
            "xtb",
            ["--version"],
            [r"xtb version\s+([0-9][^\s]*)"],
            timeout,
            probe,
        )
    if "crest" in tools:
        result["tools"]["crest"] = command_tool(
            root,
            "crest",
            "crest",
            ["--version"],
            [r"crest\s+([0-9][^\s]*)", r"Version\s+([0-9][^\s,]*)"],
            timeout,
            probe,
        )
    if "gromacs" in tools:
        result["tools"]["gromacs"] = command_tool(
            root,
            "gromacs",
            "gmx",
            ["--version"],
            [r"GROMACS version:\s+([^\n]+)"],
            timeout,
            probe,
        )
    if "plumed" in tools:
        result["tools"]["plumed"] = command_tool(
            root,
            "plumed",
            "plumed",
            ["info", "--version"],
            [r"^([0-9]+(?:\.[0-9]+)+)$"],
            timeout,
            probe,
            extra=[root / "plumed" / "2.10.0" / "bin" / "plumed"],
        )
    if "openmm" in tools:
        result["tools"]["openmm"] = openmm_status(root, timeout, probe)
    if "abacus" in tools:
        result["tools"]["abacus"] = abacus_status(root, timeout, probe)
    if "cp2k" in tools:
        result["tools"]["cp2k"] = cp2k_status(root, timeout, probe)
    if "qe" in tools:
        result["tools"]["qe"] = qe_status(root, timeout, probe)
    if "wannier90" in tools:
        result["tools"]["wannier90"] = wannier90_status(root, timeout, probe)
    if "gw" in tools:
        result["tools"]["gw"] = gw_status(root, timeout, probe)
    if "qmcpack" in tools:
        result["tools"]["qmcpack"] = qmcpack_status(root, timeout, probe)
    if "phonopy" in tools:
        result["tools"]["phonopy"] = python_module_status(root, "phonopy", "phonopy", "phonopy", timeout, probe)
    if "phono3py" in tools:
        result["tools"]["phono3py"] = python_module_status(root, "phono3py", "phono3py", "phono3py", timeout, probe)
    if "amset" in tools:
        result["tools"]["amset"] = python_module_status(root, "amset", "amset", "amset", timeout, probe)
    result["summary"] = {
        "available": sorted(
            name
            for name, status in result["tools"].items()
            if isinstance(status, dict) and status.get("available") is True
        ),
        "notAvailable": sorted(
            name
            for name, status in result["tools"].items()
            if isinstance(status, dict) and status.get("available") is not True
        ),
    }
    print_json(result)


if __name__ == "__main__":
    main()
