#!/usr/bin/env python3
import csv
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from typing import Any


DEFAULT_CHECKS = ["vasp", "qe", "lammps", "conda", "python"]
AVAILABLE_CHECKS = [
    *DEFAULT_CHECKS,
    "elk",
    "openfoam",
    "gpu",
    "wannier90",
    "gw",
    "orca",
    "thermocalc",
]
DEFAULT_TIMEOUT_SECONDS = 20.0
CONTAINER_TOOLCHAIN_ROOT = "/opt/matos-tools"


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


def resolve_root(input_payload: dict[str, Any]) -> Path:
    explicit = non_empty(input_payload.get("toolchainRoot"))
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
    return Path("/opt/matos-tools")


def selected_checks(input_payload: dict[str, Any]) -> list[str]:
    raw = input_payload.get("checks")
    if not isinstance(raw, list):
        # Older role prompts and some model-generated calls use `tools` for the
        # same selector. Keep the alias fail-safe instead of silently running
        # the unrelated default check set.
        raw = input_payload.get("tools")
    if not isinstance(raw, list):
        return DEFAULT_CHECKS.copy()
    selected = [item for item in raw if isinstance(item, str) and item in AVAILABLE_CHECKS]
    return selected or DEFAULT_CHECKS.copy()


def timeout_seconds(input_payload: dict[str, Any]) -> float:
    value = input_payload.get("timeoutSeconds")
    if isinstance(value, (int, float)) and 1 <= float(value) <= 30:
        return float(value)
    return DEFAULT_TIMEOUT_SECONDS


def toolchain_root_aliases(root: Path) -> list[str]:
    aliases: list[str] = []
    for candidate in (root,):
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        for value in (candidate, resolved):
            text = str(value)
            if text and text != CONTAINER_TOOLCHAIN_ROOT and value.name == "matos-tools":
                aliases.append(text)
    return sorted(set(aliases), key=len, reverse=True)


def containerize_text_paths(text: str, root: Path) -> str:
    output = text
    for alias in toolchain_root_aliases(root):
        output = output.replace(alias, CONTAINER_TOOLCHAIN_ROOT)
    return output


def containerize_paths(value: Any, root: Path) -> Any:
    if isinstance(value, str):
        return containerize_text_paths(value, root)
    if isinstance(value, list):
        return [containerize_paths(item, root) for item in value]
    if isinstance(value, dict):
        return {key: containerize_paths(item, root) for key, item in value.items()}
    return value


def bounded_int(
    input_payload: dict[str, Any],
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int,
) -> int:
    value = input_payload.get(key)
    if isinstance(value, (int, float)):
        parsed = int(value)
        if minimum <= parsed <= maximum:
            return parsed
    return default


def detail_level(input_payload: dict[str, Any]) -> str:
    value = input_payload.get("detail")
    return value if value in {"summary", "full"} else "full"


def requires_toolchain_root(checks: list[str]) -> bool:
    return any(
        check
        in {
            "vasp",
            "qe",
            "lammps",
            "elk",
            "openfoam",
            "conda",
            "wannier90",
            "gw",
            "orca",
            "thermocalc",
        }
        for check in checks
    )


def executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def runtime_path(root: Path) -> str:
    configured = [
        item
        for key in ("MATOS_RUNTIME_EXECUTABLE_PATHS", "MATOS_TOOLCHAIN_EXECUTABLE_PATHS")
        for item in os.environ.get(key, "").split(":")
        if non_empty(item)
    ]
    parts = [
        root / "bin",
        root / "vasp" / "bin",
        root / "qe" / "bin",
        root / "lammps" / "bin",
        root / "conda" / "envs" / "matos-compute" / "bin",
        root / "conda" / "envs" / "matos-compute" / "sbin",
        root / "conda" / "envs" / "matos-atomistic-base-py311" / "bin",
        root / "conda" / "envs" / "matos-atomistic-base-py311" / "sbin",
        root / "conda" / "envs" / "matos-openfoam" / "bin",
        root / "conda" / "envs" / "matos-openfoam" / "sbin",
        root / "conda" / "envs" / "matos-orca-py311" / "bin",
        root / "conda" / "envs" / "matos-orca-py311" / "sbin",
        root / "orca" / "current",
        root / "thermocalc" / "current" / "bin",
        root / "thermocalc" / "current" / "Console",
        root / "thermocalc" / "current" / "SDK" / "TC-Python" / "bin",
        root / "thermocalc" / "current" / "SDK" / "TC-Python" / "python" / "bin",
        root / "conda" / "envs" / "matos-thermocalc-py311" / "bin",
        root / "conda" / "envs" / "matos-thermocalc-py311" / "sbin",
        root / "conda" / "envs" / "matos-mlip-py311" / "bin",
        root / "conda" / "envs" / "matos-mlip-py311" / "sbin",
        root / "conda" / "envs" / "matos-mlip-py312" / "bin",
        root / "conda" / "envs" / "matos-mlip-py312" / "sbin",
        root / "conda" / "envs" / "matos-xrd-py311" / "bin",
        root / "conda" / "envs" / "matos-xrd-py311" / "sbin",
        root / "conda" / "envs" / "matos-mlip-gnn-py311" / "bin",
        root / "conda" / "envs" / "matos-mlip-gnn-py311" / "sbin",
        root / "conda" / "envs" / "matos-wannier90-py311" / "bin",
        root / "conda" / "envs" / "matos-wannier90-py311" / "sbin",
        root / "conda" / "envs" / "matos-gw-yambo-py311" / "bin",
        root / "conda" / "envs" / "matos-gw-yambo-py311" / "sbin",
        root / "conda" / "envs" / "matos-gw-abinit-py311" / "bin",
        root / "conda" / "envs" / "matos-gw-abinit-py311" / "sbin",
        root / "conda" / "envs" / "matos-gw-gpaw-py311" / "bin",
        root / "conda" / "envs" / "matos-gw-gpaw-py311" / "sbin",
        root / "conda" / "envs" / "matos-gw-berkeleygw" / "bin",
        root / "conda" / "envs" / "matos-gw-berkeleygw" / "sbin",
        root / "conda" / "envs" / "matos-gw-west" / "bin",
        root / "conda" / "envs" / "matos-gw-west" / "sbin",
        root / "conda" / "bin",
        root / "aptroot-noble" / "usr" / "bin",
        root / "nvhpc" / "Linux_x86_64" / "25.3" / "compilers" / "bin",
        root / "nvhpc" / "Linux_x86_64" / "25.3" / "cuda" / "11.8" / "bin",
        root / "nvhpc" / "Linux_x86_64" / "25.3" / "cuda" / "12.8" / "bin",
        root
        / "nvhpc"
        / "Linux_x86_64"
        / "25.3"
        / "comm_libs"
        / "11.8"
        / "openmpi4"
        / "openmpi-4.1.5"
        / "bin",
        root
        / "nvhpc"
        / "Linux_x86_64"
        / "25.3"
        / "comm_libs"
        / "12.8"
        / "openmpi4"
        / "openmpi-4.1.5"
        / "bin",
        root / "aptroot" / "usr" / "bin",
        root / "aptroot-jammy" / "usr" / "bin",
    ]
    existing = [str(path) for path in parts if path.exists()]
    return ":".join([*configured, *existing, os.environ.get("PATH", "")])


def runtime_library_paths(root: Path) -> list[str]:
    candidates: list[Path] = []
    for key in ("MATOS_RUNTIME_LIBRARY_PATHS", "MATOS_TOOLCHAIN_LIBRARY_PATHS"):
        for item in os.environ.get(key, "").split(":"):
            value = non_empty(item)
            if value:
                candidates.append(Path(value))
    for key in ("MATOS_MKL_ROOT", "MKLROOT", "MKL_ROOT"):
        value = non_empty(os.environ.get(key))
        if value:
            base = Path(value)
            candidates.extend([base / "lib", base])
    candidates.extend(
        [
            root / "vasp" / "lib",
            root / "conda" / "envs" / "matos-compute" / "lib",
            root / "conda" / "envs" / "matos-atomistic-base-py311" / "lib",
            root / "conda" / "envs" / "matos-openfoam" / "lib",
            root / "conda" / "envs" / "matos-orca-py311" / "lib",
            root / "orca" / "current",
            root / "orca" / "current" / "lib",
            root / "thermocalc" / "current" / "lib",
            root / "thermocalc" / "current" / "bin",
            root / "thermocalc" / "current" / "SDK" / "TC-Python" / "lib",
            root / "conda" / "envs" / "matos-wannier90-py311" / "lib",
            root
            / "conda"
            / "envs"
            / "matos-wannier90-py311"
            / "lib64",
            root / "conda" / "envs" / "matos-gw-yambo-py311" / "lib",
            root / "conda" / "envs" / "matos-gw-yambo-py311" / "lib64",
            root / "conda" / "envs" / "matos-gw-abinit-py311" / "lib",
            root / "conda" / "envs" / "matos-gw-abinit-py311" / "lib64",
            root / "conda" / "envs" / "matos-gw-gpaw-py311" / "lib",
            root / "conda" / "envs" / "matos-gw-gpaw-py311" / "lib64",
            root / "conda" / "envs" / "matos-gw-berkeleygw" / "lib",
            root / "conda" / "envs" / "matos-gw-berkeleygw" / "lib64",
            root / "conda" / "envs" / "matos-gw-west" / "lib",
            root / "conda" / "envs" / "matos-gw-west" / "lib64",
            root
            / "conda"
            / "envs"
            / "matos-compute"
            / "targets"
            / "x86_64-linux"
            / "lib",
            root / "conda" / "lib",
            root / "nvhpc" / "Linux_x86_64" / "25.3" / "compilers" / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "math_libs"
            / "11.8"
            / "targets"
            / "x86_64-linux"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "math_libs"
            / "12.8"
            / "targets"
            / "x86_64-linux"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "cuda"
            / "11.8"
            / "targets"
            / "x86_64-linux"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "cuda"
            / "12.8"
            / "targets"
            / "x86_64-linux"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "compilers"
            / "extras"
            / "qd"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "11.8"
            / "openmpi4"
            / "openmpi-4.1.5"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "11.8"
            / "nccl"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "11.8"
            / "nvshmem"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "12.8"
            / "openmpi4"
            / "openmpi-4.1.5"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "12.8"
            / "nccl-2.25"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "12.8"
            / "nccl-2.18"
            / "lib",
            root
            / "nvhpc"
            / "Linux_x86_64"
            / "25.3"
            / "comm_libs"
            / "12.8"
            / "nvshmem"
            / "lib",
            root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu",
            root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "blas",
            root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "lapack",
            root / "aptroot" / "usr" / "lib" / "x86_64-linux-gnu" / "openmpi" / "lib",
            root / "aptroot" / "usr" / "lib",
            root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu",
            root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu" / "blas",
            root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu" / "lapack",
            root / "aptroot-jammy" / "usr" / "lib" / "x86_64-linux-gnu" / "openmpi" / "lib",
            root / "aptroot-jammy" / "usr" / "lib",
        ]
    )
    existing: list[str] = []
    seen: set[str] = set()
    for path in candidates:
        if path.exists():
            item = str(path)
            if item not in seen:
                existing.append(item)
                seen.add(item)
    return existing


def runtime_library_path(root: Path, extra_paths: list[Path] | None = None) -> str:
    extras = [str(path) for path in (extra_paths or []) if path.exists()]
    return ":".join(
        [*extras, *runtime_library_paths(root), os.environ.get("LD_LIBRARY_PATH", "")]
    )


def configure_openmpi_env(env: dict[str, str], root: Path) -> None:
    for aptroot in (root / "aptroot-noble", root / "aptroot-jammy", root / "aptroot"):
        component_path = (
            aptroot
            / "usr"
            / "lib"
            / "x86_64-linux-gnu"
            / "openmpi"
            / "lib"
            / "openmpi3"
        )
        if not component_path.exists():
            continue
        env["OPAL_PREFIX"] = str(aptroot / "usr")
        env["OMPI_MCA_mca_base_component_path"] = str(component_path)
        env["PMIX_MCA_pcompress_base_silence_warning"] = "1"
        return


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


def run_probe(
    args: list[str],
    *,
    root: Path,
    timeout: float,
    extra_library_paths: list[Path] | None = None,
    inherit_library_environment: bool = False,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    env = os.environ.copy()
    if extra_env:
        env.update(extra_env)
    env["PATH"] = runtime_path(root)
    if not inherit_library_environment:
        env["LD_LIBRARY_PATH"] = runtime_library_path(root, extra_library_paths)
        configure_openmpi_env(env, root)
    if args and Path(args[0]).name == "abinit":
        if is_toolchain_wrapper(Path(args[0]), root, "abinit"):
            strip_aptroot_noble_libs(env)
        else:
            prefer_aptroot_noble_libs(env, root)
    try:
        with tempfile.TemporaryDirectory(prefix="matos-toolchain-probe-") as cwd:
            # MPI runtimes inherit their session directory from the parent
            # environment. A stale /workspace/caches/tmp/ompi.* entry can make
            # otherwise healthy QE/LAMMPS probes fail before the binary starts.
            # Give every probe an isolated, writable temp root instead.
            env["TMPDIR"] = cwd
            env["TMP"] = cwd
            env["TEMP"] = cwd
            env["OMPI_MCA_orte_tmpdir_base"] = cwd
            env["PMIX_MCA_ptl_base_tmpdir"] = cwd
            result = subprocess.run(
                args,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=timeout,
                env=env,
                check=False,
                cwd=cwd,
            )
    except subprocess.TimeoutExpired as error:
        stdout = (
            error.stdout.decode(errors="replace")
            if isinstance(error.stdout, bytes)
            else (error.stdout or "")
        )
        stderr = (
            error.stderr.decode(errors="replace")
            if isinstance(error.stderr, bytes)
            else (error.stderr or "")
        )
        return {
            "exitCode": None,
            "stdout": stdout[-4000:],
            "stderr": stderr[-4000:],
            "timedOut": True,
        }
    except OSError as error:
        return {
            "exitCode": None,
            "stdout": "",
            "stderr": str(error),
            "errorCode": getattr(error, "errno", None),
        }
    return {
        "exitCode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
        "timedOut": False,
    }


def classify_probe(probe: dict[str, Any]) -> tuple[bool, str]:
    combined = f"{probe.get('stdout', '')}\n{probe.get('stderr', '')}"
    if "GLIBC_" in combined and "not found" in combined:
        return False, "blocked_glibc_mismatch"
    if "not found" in combined and (".so" in combined or "shared object" in combined):
        return False, "blocked_missing_runtime_libs"
    if probe.get("timedOut"):
        return False, "blocked_timeout"
    if probe.get("exitCode") == 0:
        return True, "available"
    if probe.get("exitCode") in (126, 127):
        return False, "blocked_execution_error"
    return False, "smoke_failed"


def is_safe_profile_id(value: str) -> bool:
    if not value or value in {".", ".."}:
        return False
    return all(character.isalnum() or character in {"-", "_", "."} for character in value)


def read_path_list(path: Path) -> list[Path]:
    if not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    items: list[Path] = []
    for line in text.splitlines():
        clean = line.split("#", 1)[0].strip()
        if not clean:
            continue
        for part in clean.split(":"):
            value = part.strip()
            if value:
                items.append(Path(value))
    return items


def read_json_file(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def vasp_profile_library_paths(profile_root: Path) -> list[Path]:
    candidates = [
        profile_root / "lib-compat",
        profile_root / "lib",
        profile_root / "deps" / "hdf5" / "lib",
        profile_root / "deps" / "wannier90" / "lib",
        *read_path_list(profile_root / "vasp-library-path.txt"),
    ]
    paths: list[Path] = []
    seen: set[str] = set()
    for path in candidates:
        text = str(path)
        if text not in seen:
            paths.append(path)
            seen.add(text)
    return paths


def check_vasp_profile(root: Path, profile_id: str, timeout: float) -> dict[str, Any]:
    profile_root = root / "vasp" / "profiles" / profile_id
    manifest = read_json_file(profile_root / "manifest.json")
    bin_dir = profile_root / "bin" / ".real"
    binaries = {
        name: str(bin_dir / name)
        for name in ("vasp_std", "vasp_gam", "vasp_ncl")
        if (bin_dir / name).exists()
    }
    primary = bin_dir / "vasp_std"
    features = manifest.get("features")
    if not isinstance(features, list):
        features = []
    status: dict[str, Any] = {
        "id": profile_id,
        "root": str(profile_root),
        "manifest": str(profile_root / "manifest.json"),
        "configured": primary.exists(),
        "healthy": False,
        "status": "missing",
        "binary": str(primary),
        "binaries": binaries,
        "features": [item for item in features if isinstance(item, str)],
        "version": manifest.get("vaspVersion") or manifest.get("version"),
        "wrapperEnv": {"MATOS_VASP_PROFILE": profile_id},
    }
    if not profile_root.is_dir():
        return status
    if not primary.exists():
        return status
    if not executable(primary):
        status["status"] = "not_executable"
        return status
    ldd = shutil.which("ldd", path=runtime_path(root))
    if not ldd:
        status["status"] = "present_unverified"
        return status
    probe = run_probe(
        [ldd, str(primary)],
        root=root,
        timeout=timeout,
        extra_library_paths=vasp_profile_library_paths(profile_root),
    )
    combined = f"{probe.get('stdout', '')}\n{probe.get('stderr', '')}"
    if "not a dynamic executable" in combined:
        status.update({"healthy": True, "status": "available"})
        return status
    healthy, classification = classify_probe(probe)
    status.update(
        {
            "healthy": healthy,
            "status": classification,
            "missingLibraries": sorted(
                {
                    line.strip().split()[0]
                    for line in combined.splitlines()
                    if "not found" in line and line.strip()
                }
            ),
        }
    )
    return status


def discover_vasp_profiles(root: Path, timeout: float) -> list[dict[str, Any]]:
    profiles_root = root / "vasp" / "profiles"
    if not profiles_root.is_dir():
        return []
    profiles: list[dict[str, Any]] = []
    for child in sorted(profiles_root.iterdir(), key=lambda item: item.name):
        if not child.is_dir() or not is_safe_profile_id(child.name):
            continue
        profiles.append(check_vasp_profile(root, child.name, timeout))
    return profiles


def check_vasp(root: Path, timeout: float) -> dict[str, Any]:
    wrapper = root / "vasp" / "bin" / "vasp_std"
    direct = root / "vasp" / "bin" / ".real" / "vasp_std"
    profiles = discover_vasp_profiles(root, timeout)
    node_path = shutil.which("node", path=runtime_path(root))
    wrapper_status: dict[str, Any] = {
        "binary": str(wrapper),
        "configured": wrapper.exists(),
        "healthy": False,
        "status": "missing",
        "node": node_path,
        "runnerUrlConfigured": bool(non_empty(os.environ.get("MATOS_VASP_RUNNER_URL"))),
    }
    if wrapper.exists() and not executable(wrapper):
        wrapper_status.update({"status": "not_executable"})
    elif wrapper.exists() and not node_path:
        wrapper_status.update({"status": "blocked_missing_node"})
    elif wrapper.exists() and not wrapper_status["runnerUrlConfigured"]:
        wrapper_status.update({"status": "blocked_missing_vasp_runner"})
    elif wrapper.exists():
        wrapper_status.update({"healthy": True, "status": "available"})

    direct_status: dict[str, Any] = {
        "binary": str(direct),
        "configured": direct.exists(),
        "healthy": False,
        "status": "missing",
    }
    if direct.exists() and not executable(direct):
        direct_status.update({"status": "not_executable"})
    elif direct.exists():
        ldd = shutil.which("ldd", path=runtime_path(root))
        if not ldd:
            direct_status.update({"status": "present_unverified"})
        else:
            probe = run_probe([ldd, str(direct)], root=root, timeout=timeout)
            combined = f"{probe.get('stdout', '')}\n{probe.get('stderr', '')}"
            if "not a dynamic executable" in combined:
                direct_status.update({"healthy": True, "status": "available"})
            else:
                healthy, status = classify_probe(probe)
                direct_status.update(
                    {
                        "healthy": healthy,
                        "status": status,
                        "missingLibraries": sorted(
                            {
                                line.strip().split()[0]
                                for line in combined.splitlines()
                                if "not found" in line and line.strip()
                            }
                        ),
                    }
                )

    return {
        "configured": wrapper_status["configured"] or direct_status["configured"],
        "healthy": bool(wrapper_status["healthy"] or direct_status["healthy"]),
        "status": "available"
        if wrapper_status["healthy"] or direct_status["healthy"]
        else wrapper_status["status"],
        "wrapper": wrapper_status,
        "direct": direct_status,
        "profilesRoot": str(root / "vasp" / "profiles"),
        "defaultProfile": non_empty(os.environ.get("MATOS_VASP_DEFAULT_PROFILE")),
        "profiles": profiles,
    }


def check_executable_tool(
    *,
    root: Path,
    name: str,
    candidates: list[Path],
    args: list[str],
    timeout: float,
    startup_markers: list[str] | None = None,
    managed_wrapper_dir: Path | None = None,
    probe_env: dict[str, str] | None = None,
) -> dict[str, Any]:
    binary = next((path for path in candidates if path.exists()), candidates[0])
    status: dict[str, Any] = {
        "binary": str(binary),
        "configured": binary.exists(),
        "healthy": False,
        "status": "missing",
    }
    if not binary.exists():
        return status
    if not executable(binary):
        status["status"] = "not_executable"
        return status
    probe = run_probe(
        [str(binary), *args],
        root=root,
        timeout=timeout,
        inherit_library_environment=(
            managed_wrapper_dir is not None and binary.parent == managed_wrapper_dir
        ),
        extra_env=probe_env,
    )
    combined = f"{probe.get('stdout', '')}\n{probe.get('stderr', '')}"
    if startup_markers and all(marker in combined for marker in startup_markers):
        status.update(
            {
                "healthy": True,
                "status": "available",
                "exitCode": probe.get("exitCode"),
                "exitCodeInterpretation": (
                    "startup_markers_confirmed; non-zero startup-probe exit code is not treated as a runtime failure"
                    if probe.get("exitCode") not in (0, None)
                    else "zero_exit"
                ),
                "healthSource": "startup_markers",
            }
        )
        return status
    healthy, classification = classify_probe(probe)
    status.update(
        {
            "healthy": healthy,
            "status": classification,
            "exitCode": probe.get("exitCode"),
        }
    )
    if classification != "available":
        status["diagnostic"] = "\n".join(
            part
            for part in [
                str(probe.get("stderr") or "").strip(),
                str(probe.get("stdout") or "").strip(),
            ]
            if part
        )[-1000:]
    elif name == "conda":
        status["version"] = str(probe.get("stdout") or "").strip().splitlines()[:1]
    return status


def check_elk(root: Path) -> dict[str, Any]:
    """Discover Elk's build-in-place layout without starting the solver."""

    binary_candidates = [
        root / "elk" / "bin" / "elk",
        *sorted(root.glob("elk/src/*/src/elk"), reverse=True),
        *sorted(root.glob("elk/*/src/elk"), reverse=True),
    ]
    species_candidates = [
        root / "elk" / "species",
        *sorted(root.glob("elk/src/*/species"), reverse=True),
        *sorted(root.glob("elk/*/species"), reverse=True),
    ]
    binary = next((path for path in binary_candidates if path.is_file()), binary_candidates[0])
    species_directory = next(
        (path for path in species_candidates if path.is_dir()),
        species_candidates[0],
    )
    species_count = (
        sum(1 for path in species_directory.glob("*.in") if path.is_file())
        if species_directory.is_dir()
        else 0
    )
    binary_ready = executable(binary)
    species_ready = species_count > 0
    healthy = binary_ready and species_ready
    if healthy:
        status = "available_via_workflow"
    elif binary.is_file() and not binary_ready:
        status = "not_executable"
    elif binary_ready:
        status = "missing_species_data"
    else:
        status = "missing"
    return {
        "binary": str(binary),
        "speciesDirectory": str(species_directory),
        "speciesFileCount": species_count,
        "configured": binary.is_file() or species_directory.is_dir(),
        "healthy": healthy,
        "status": status,
        "healthSource": "workflow_managed_toolchain_layout" if healthy else "filesystem",
        "requiresWorkflowPreflight": True,
        "directInvocationSupported": False,
    }


def check_present_executable(
    *,
    candidates: list[Path],
) -> dict[str, Any]:
    binary = next((path for path in candidates if path.exists()), candidates[0])
    status: dict[str, Any] = {
        "binary": str(binary),
        "configured": binary.exists(),
        "healthy": False,
        "status": "missing",
    }
    if not binary.exists():
        return status
    if not executable(binary):
        status["status"] = "not_executable"
        return status
    status.update({"healthy": True, "status": "available"})
    return status


def parse_env_lines(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if separator and key:
            values[key] = value
    return values


def probe_contains(probe: dict[str, Any], markers: list[str]) -> bool:
    combined = f"{probe.get('stdout', '')}\n{probe.get('stderr', '')}"
    return all(marker in combined for marker in markers)


def command_probe_status(
    path: Path,
    root: Path,
    timeout: float,
    markers: list[str],
    *,
    args: list[str] | None = None,
) -> dict[str, Any]:
    status: dict[str, Any] = {
        "path": str(path),
        "available": executable(path),
        "status": "available" if executable(path) else "missing",
    }
    if not executable(path):
        return status
    probe = run_probe([str(path), *(args or ["-help"])], root=root, timeout=timeout)
    ok = probe_contains(probe, markers)
    status["probe"] = {
        "ok": ok,
        "exitCode": probe.get("exitCode"),
        "status": "available" if ok else probe.get("status"),
    }
    if not ok:
        status["status"] = str(probe.get("status") or "probe_failed")
    return status


def writable_openfoam_tmp_base() -> Path | None:
    candidates: list[Path] = []
    for value in (
        os.environ.get("MATOS_TOOLCHAIN_PREFLIGHT_TMPDIR"),
        os.environ.get("TMPDIR"),
        "/workspace/caches/tmp",
        "/home/workspace/.cache/tmp",
    ):
        if value:
            candidates.append(Path(value))
    for candidate in candidates:
        try:
            candidate.mkdir(parents=True, exist_ok=True)
        except OSError:
            continue
        if candidate.is_dir() and os.access(candidate, os.W_OK):
            return candidate
    return None


def run_openfoam_compile_probe(wrapper: Path, root: Path, timeout: float) -> dict[str, Any]:
    if not executable(wrapper):
        return {
            "healthy": False,
            "status": "missing_wrapper",
            "exitCode": None,
        }
    base = writable_openfoam_tmp_base()
    try:
        with tempfile.TemporaryDirectory(
            prefix="matos-openfoam-compile-",
            dir=str(base) if base else None,
        ) as directory:
            build = Path(directory) / "matosPreflightFoam"
            make_dir = build / "Make"
            make_dir.mkdir(parents=True, exist_ok=True)
            (build / "matosPreflightFoam.C").write_text(
                "\n".join(
                    [
                        '#include "argList.H"',
                        '#include "IOstreams.H"',
                        "using namespace Foam;",
                        "int main(int argc, char *argv[])",
                        "{",
                        "    argList args(argc, argv);",
                        '    Info<< "matos openfoam compile ok" << nl;',
                        "    return 0;",
                        "}",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            (make_dir / "files").write_text(
                "matosPreflightFoam.C\nEXE = $(FOAM_USER_APPBIN)/matosPreflightFoam\n",
                encoding="utf-8",
            )
            (make_dir / "options").write_text(
                "\n".join(
                    [
                        "EXE_INC = \\",
                        "    -I$(LIB_SRC)/OpenFOAM/lnInclude",
                        "EXE_LIBS = \\",
                        "    -lOpenFOAM",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            env = os.environ.copy()
            env["PATH"] = runtime_path(root)
            env["LD_LIBRARY_PATH"] = runtime_library_path(root)
            env["BUILD_DIR"] = str(build)
            configure_openmpi_env(env, root)
            result = subprocess.run(
                [
                    str(wrapper),
                    "run",
                    "bash",
                    "-lc",
                    (
                        'trap \'rm -f "${FOAM_USER_APPBIN:-}/matosPreflightFoam" 2>/dev/null || true\' EXIT; '
                        'cd "$BUILD_DIR" && wmake && "${FOAM_USER_APPBIN}/matosPreflightFoam"'
                    ),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=max(timeout, 30.0),
                env=env,
                check=False,
                cwd=str(build),
            )
    except subprocess.TimeoutExpired as error:
        return {
            "healthy": False,
            "status": "blocked_timeout",
            "exitCode": None,
            "stdout": (error.stdout or "")[-4000:] if isinstance(error.stdout, str) else "",
            "stderr": (error.stderr or "")[-4000:] if isinstance(error.stderr, str) else "",
            "timedOut": True,
        }
    except OSError as error:
        return {
            "healthy": False,
            "status": "probe_error",
            "exitCode": None,
            "stdout": "",
            "stderr": str(error),
            "errorCode": getattr(error, "errno", None),
        }
    output = f"{result.stdout}\n{result.stderr}"
    healthy = result.returncode == 0 and "matos openfoam compile ok" in output
    if healthy:
        status = "available"
    elif "Read-only file system" in output or "Permission denied" in output:
        status = "blocked_output_not_writable"
    elif "cannot find -lOpenFOAM" in output:
        status = "blocked_missing_openfoam_link_flags"
    else:
        status = "compile_failed"
    return {
        "healthy": healthy,
        "status": status,
        "exitCode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
        "timedOut": False,
    }


def check_openfoam(root: Path, timeout: float) -> dict[str, Any]:
    env_prefix = root / "conda" / "envs" / "matos-openfoam"
    wrapper = root / "bin" / "openfoam"
    block_mesh = root / "bin" / "blockMesh"
    ico_foam = root / "bin" / "icoFoam"
    catalytic_solver = root / "bin" / "catalyticPimpleFOAM"
    catalytic_alias = root / "bin" / "catalyticFoam"
    catalytic_preprocessor = root / "bin" / "catalyticFoam_CHEMKINPreProcessor"
    catalytic_wall_library = env_prefix / "lib" / "libCatalyticWall.so"
    status: dict[str, Any] = {
        "envPrefix": str(env_prefix),
        "wrapper": str(wrapper),
        "configured": env_prefix.exists() or wrapper.exists(),
        "healthy": False,
        "status": "missing",
        "commands": {
            "blockMesh": str(block_mesh),
            "icoFoam": str(ico_foam),
            "catalyticPimpleFOAM": str(catalytic_solver),
            "catalyticFoam": str(catalytic_alias),
            "catalyticFoam_CHEMKINPreProcessor": str(catalytic_preprocessor),
        },
    }
    if not env_prefix.exists():
        status["status"] = "missing_env"
        return status
    if not wrapper.exists():
        status["status"] = "missing_wrapper"
        return status
    if not executable(wrapper):
        status["status"] = "wrapper_not_executable"
        return status
    if not executable(block_mesh) or not executable(ico_foam):
        status["status"] = "missing_command_symlink"
        return status

    env_probe = run_probe(
        [
            str(wrapper),
            "run",
            "bash",
            "-lc",
            (
                'printf "WM_PROJECT_VERSION=%s\\nFOAM_APPBIN=%s\\nFOAM_LIBBIN=%s\\nWM_PROJECT_DIR=%s\\n" '
                '"${WM_PROJECT_VERSION:-}" "${FOAM_APPBIN:-}" "${FOAM_LIBBIN:-}" "${WM_PROJECT_DIR:-}"; '
                'printf "WM_PROJECT_USER_DIR=%s\\nFOAM_USER_APPBIN=%s\\nFOAM_USER_LIBBIN=%s\\nFOAM_EXTRA_LDFLAGS=%s\\nTMPDIR=%s\\n" '
                '"${WM_PROJECT_USER_DIR:-}" "${FOAM_USER_APPBIN:-}" "${FOAM_USER_LIBBIN:-}" "${FOAM_EXTRA_LDFLAGS:-}" "${TMPDIR:-}"'
            ),
        ],
        root=root,
        timeout=timeout,
    )
    env_values = parse_env_lines(str(env_probe.get("stdout") or ""))
    env_ok = (
        env_probe.get("exitCode") == 0
        and env_values.get("WM_PROJECT_VERSION")
        and env_values.get("FOAM_APPBIN")
        and env_values.get("FOAM_LIBBIN")
    )

    block_probe = run_probe([str(block_mesh), "-help"], root=root, timeout=timeout)
    block_ok = block_probe.get("exitCode") == 0 and probe_contains(
        block_probe,
        ["Usage: blockMesh"],
    )

    ico_probe = run_probe([str(ico_foam), "-help"], root=root, timeout=timeout)
    ico_ok = ico_probe.get("exitCode") == 0 and probe_contains(
        ico_probe,
        ["OpenFOAM", "icoFoam"],
    )

    catalytic_solver_status = command_probe_status(
        catalytic_solver,
        root,
        timeout,
        ["Usage: catalyticPimpleFOAM"],
    )
    catalytic_alias_status = command_probe_status(
        catalytic_alias,
        root,
        timeout,
        ["Usage: catalyticPimpleFOAM"],
    )
    catalytic_preprocessor_status = command_probe_status(
        catalytic_preprocessor,
        root,
        timeout,
        ["OpenSMOKE_CHEMKIN_PreProcessor"],
    )
    catalytic_library_status = {
        "path": str(catalytic_wall_library),
        "available": catalytic_wall_library.is_file(),
        "status": "available" if catalytic_wall_library.is_file() else "missing",
    }
    catalytic_available = bool(
        catalytic_solver_status["available"]
        and catalytic_alias_status["available"]
        and catalytic_preprocessor_status["available"]
        and catalytic_library_status["available"]
        and catalytic_solver_status.get("probe", {"ok": True}).get("ok", True)
        and catalytic_alias_status.get("probe", {"ok": True}).get("ok", True)
        and catalytic_preprocessor_status.get("probe", {"ok": True}).get("ok", True)
    )
    status["catalyticFoam"] = {
        "available": catalytic_available,
        "status": "available" if catalytic_available else "partial",
        "solver": catalytic_solver_status,
        "alias": catalytic_alias_status,
        "preprocessor": catalytic_preprocessor_status,
        "boundaryLibrary": catalytic_library_status,
    }

    user_appbin = env_values.get("FOAM_USER_APPBIN") or ""
    user_libbin = env_values.get("FOAM_USER_LIBBIN") or ""
    project_user_dir = env_values.get("WM_PROJECT_USER_DIR") or ""
    output_dirs_probe = run_probe(
        [
            str(wrapper),
            "run",
            "bash",
            "-lc",
            (
                'test -n "${FOAM_USER_APPBIN:-}" && test -d "${FOAM_USER_APPBIN:-}" && test -w "${FOAM_USER_APPBIN:-}" && '
                'test -n "${FOAM_USER_LIBBIN:-}" && test -d "${FOAM_USER_LIBBIN:-}" && test -w "${FOAM_USER_LIBBIN:-}" && '
                'printf "openfoam user build dirs writable\\n"'
            ),
        ],
        root=root,
        timeout=timeout,
    )
    output_dirs_ok = output_dirs_probe.get("exitCode") == 0 and probe_contains(
        output_dirs_probe,
        ["openfoam user build dirs writable"],
    )
    compile_probe = run_openfoam_compile_probe(wrapper, root, timeout)

    healthy = bool(env_ok and block_ok and ico_ok and output_dirs_ok and compile_probe.get("healthy"))
    if healthy:
        status.update(
            {
                "healthy": True,
                "status": "available",
                "version": env_values.get("WM_PROJECT_VERSION"),
                "foamAppBin": env_values.get("FOAM_APPBIN"),
                "foamLibBin": env_values.get("FOAM_LIBBIN"),
            }
        )
    else:
        if (
            env_probe.get("timedOut")
            or block_probe.get("timedOut")
            or ico_probe.get("timedOut")
            or output_dirs_probe.get("timedOut")
            or compile_probe.get("timedOut")
        ):
            status["status"] = "blocked_timeout"
        elif not env_ok:
            status["status"] = "activation_failed"
        elif not block_ok:
            status["status"] = "blockmesh_probe_failed"
        elif not ico_ok:
            status["status"] = "icofoam_probe_failed"
        elif not output_dirs_ok:
            status["status"] = "blocked_user_build_dirs_not_writable"
        else:
            status["status"] = str(compile_probe.get("status") or "compile_failed")

    status["userBuild"] = {
        "wmProjectUserDir": project_user_dir,
        "foamUserAppBin": user_appbin,
        "foamUserLibBin": user_libbin,
        "foamExtraLdflags": env_values.get("FOAM_EXTRA_LDFLAGS") or "",
        "writable": output_dirs_ok,
        "compile": compile_probe,
    }

    status["probes"] = {
        "env": env_probe,
        "blockMesh": block_probe,
        "icoFoam": ico_probe,
        "userBuildDirs": output_dirs_probe,
    }
    return status


def check_wannier90(root: Path, timeout: float) -> dict[str, Any]:
    env_prefix = root / "conda" / "envs" / "matos-wannier90-py311"
    main = check_executable_tool(
        root=root,
        name="wannier90",
        candidates=[
            root / "bin" / "wannier90.x",
            env_prefix / "bin" / "wannier90.x",
            root / "aptroot-jammy" / "usr" / "bin" / "wannier90.x",
            root / "aptroot" / "usr" / "bin" / "wannier90.x",
        ],
        args=["-v"],
        timeout=timeout,
        startup_markers=["Wannier90"],
    )
    post = check_executable_tool(
        root=root,
        name="postw90",
        candidates=[
            root / "bin" / "postw90.x",
            env_prefix / "bin" / "postw90.x",
            root / "aptroot-jammy" / "usr" / "bin" / "postw90.x",
            root / "aptroot" / "usr" / "bin" / "postw90.x",
        ],
        args=["-v"],
        timeout=timeout,
        startup_markers=["Wannier90"],
    )
    pw2 = check_executable_tool(
        root=root,
        name="pw2wannier90",
        candidates=[
            root / "bin" / "pw2wannier90.x",
            env_prefix / "bin" / "pw2wannier90.x",
            root / "qe" / "bin" / "pw2wannier90.x",
            root / "aptroot-jammy" / "usr" / "bin" / "pw2wannier90.x",
            root / "aptroot" / "usr" / "bin" / "pw2wannier90.x",
        ],
        args=["-h"],
        timeout=timeout,
        startup_markers=["Program PW2WANNIER"],
    )
    ham = check_present_executable(
        candidates=[
            env_prefix / "bin" / "wannier_ham.x",
            root / "aptroot-jammy" / "usr" / "bin" / "wannier_ham.x",
            root / "aptroot" / "usr" / "bin" / "wannier_ham.x",
        ],
    )
    plot = check_present_executable(
        candidates=[
            env_prefix / "bin" / "wannier_plot.x",
            root / "aptroot-jammy" / "usr" / "bin" / "wannier_plot.x",
            root / "aptroot" / "usr" / "bin" / "wannier_plot.x",
        ],
    )
    components = {
        "wannier90.x": main,
        "postw90.x": post,
        "pw2wannier90.x": pw2,
        "wannier_ham.x": ham,
        "wannier_plot.x": plot,
    }
    healthy = bool(main.get("healthy") and pw2.get("healthy"))
    configured = any(bool(value.get("configured")) for value in components.values())
    optional_blockers = [
        name
        for name, value in (("postw90.x", post), ("wannier_ham.x", ham), ("wannier_plot.x", plot))
        if value.get("configured") and value.get("healthy") is not True
    ]
    if healthy:
        status = "available"
    elif configured:
        status = "partial"
    else:
        status = "missing"
    result: dict[str, Any] = {
        "configured": configured,
        "healthy": healthy,
        "status": status,
        "envPrefix": str(env_prefix),
        "binary": main.get("binary"),
        "components": components,
        "requiredComponents": ["wannier90.x", "pw2wannier90.x"],
    }
    if optional_blockers:
        result["optionalComponentWarnings"] = optional_blockers
    return result


def implementation_health(
    *,
    name: str,
    required: dict[str, dict[str, Any]],
    optional: dict[str, dict[str, Any]] | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    required_values = list(required.values())
    optional_values = list((optional or {}).values())
    configured = any(bool(item.get("configured")) for item in [*required_values, *optional_values])
    healthy = bool(required_values and all(item.get("healthy") is True for item in required_values))
    if healthy:
        status = "available"
    elif configured:
        status = "partial"
    else:
        status = "missing"
    return {
        "name": name,
        "configured": configured,
        "healthy": healthy,
        "status": status,
        "requiredCommands": required,
        **({"optionalCommands": optional} if optional else {}),
        **({"note": note} if note else {}),
    }


def check_gw(root: Path, timeout: float) -> dict[str, Any]:
    yambo_env = root / "conda" / "envs" / "matos-gw-yambo-py311"
    berkeleygw_env = root / "conda" / "envs" / "matos-gw-berkeleygw"
    west_env = root / "conda" / "envs" / "matos-gw-west"
    abinit_env = root / "conda" / "envs" / "matos-gw-abinit-py311"
    gpaw_env = root / "conda" / "envs" / "matos-gw-gpaw-py311"
    yambo = implementation_health(
        name="yambo",
        required={
            "yambo": check_executable_tool(
                root=root,
                name="yambo",
                candidates=[
                    yambo_env / "bin" / "yambo",
                    root / "bin" / "yambo",
                    root / "aptroot-jammy" / "usr" / "bin" / "yambo",
                    root / "aptroot" / "usr" / "bin" / "yambo",
                ],
                args=["-V"],
                timeout=timeout,
                startup_markers=["Yambo"],
            ),
            "ypp": check_present_executable(
                candidates=[
                    yambo_env / "bin" / "ypp",
                    root / "bin" / "ypp",
                    root / "aptroot-jammy" / "usr" / "bin" / "ypp",
                    root / "aptroot" / "usr" / "bin" / "ypp",
                ],
            ),
            "p2y": check_present_executable(
                candidates=[
                    yambo_env / "bin" / "p2y",
                    root / "bin" / "p2y",
                    root / "aptroot-jammy" / "usr" / "bin" / "p2y",
                    root / "aptroot" / "usr" / "bin" / "p2y",
                ],
            ),
        },
        note="QE -> Yambo GW/BSE workflow.",
    )
    berkeleygw = implementation_health(
        name="berkeleygw",
        required={
            "epsilon.cplx.x": check_present_executable(
                candidates=[
                    berkeleygw_env / "bin" / "epsilon.cplx.x",
                    root / "bin" / "epsilon.cplx.x",
                ],
            ),
            "sigma.cplx.x": check_present_executable(
                candidates=[
                    berkeleygw_env / "bin" / "sigma.cplx.x",
                    root / "bin" / "sigma.cplx.x",
                ],
            ),
        },
        optional={
            "kernel.cplx.x": check_present_executable(
                candidates=[
                    berkeleygw_env / "bin" / "kernel.cplx.x",
                    root / "bin" / "kernel.cplx.x",
                ],
            ),
            "absorption.cplx.x": check_present_executable(
                candidates=[
                    berkeleygw_env / "bin" / "absorption.cplx.x",
                    root / "bin" / "absorption.cplx.x",
                ],
            ),
        },
        note="BerkeleyGW quasiparticle and BSE workflow.",
    )
    west = implementation_health(
        name="west",
        required={
            "wstat.x": check_present_executable(
                candidates=[west_env / "bin" / "wstat.x", root / "bin" / "wstat.x"],
            ),
            "wfreq.x": check_present_executable(
                candidates=[west_env / "bin" / "wfreq.x", root / "bin" / "wfreq.x"],
            ),
        },
        optional={
            "westpp.x": check_present_executable(
                candidates=[west_env / "bin" / "westpp.x", root / "bin" / "westpp.x"],
            ),
        },
        note="WEST GW workflow.",
    )
    abinit = implementation_health(
        name="abinit",
        required={
            "abinit": check_executable_tool(
                root=root,
                name="abinit",
                candidates=[
                    abinit_env / "bin" / "abinit",
                    root / "bin" / "abinit",
                    root / "aptroot-noble" / "usr" / "bin" / "abinit",
                    root / "aptroot-jammy" / "usr" / "bin" / "abinit",
                    root / "aptroot" / "usr" / "bin" / "abinit",
                ],
                args=["--version"],
                timeout=timeout,
                startup_markers=["ABINIT"],
            ),
        },
        note="ABINIT native GW workflow.",
    )
    gpaw = implementation_health(
        name="gpaw",
        required={
            "gpaw": check_executable_tool(
                root=root,
                name="gpaw",
                candidates=[
                    gpaw_env / "bin" / "gpaw",
                    root / "bin" / "gpaw",
                ],
                args=["--version"],
                timeout=timeout,
                startup_markers=["GPAW"],
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
    healthy = [name for name in ordered if implementations[name].get("healthy") is True]
    configured = [
        name
        for name in ordered
        if implementations[name].get("configured") is True
    ]
    recommended = next(iter(healthy), None)
    status = "available" if healthy else "partial" if configured else "missing"
    result: dict[str, Any] = {
        "configured": bool(configured),
        "healthy": bool(healthy),
        "status": status,
        "recommendedImplementation": recommended,
        "availableImplementations": healthy,
        "configuredImplementations": configured,
        "implementations": implementations,
        "requiredImplementations": [
            "One complete implementation: yambo, berkeleygw, west, abinit, or gpaw"
        ],
    }
    return result


def check_orca(root: Path) -> dict[str, Any]:
    binary = check_present_executable(
        candidates=[
            root / "bin" / "orca",
            root / "orca" / "current" / "orca",
        ],
    )
    python = check_present_executable(
        candidates=[root / "conda" / "envs" / "matos-orca-py311" / "bin" / "python"],
    )
    binary_ready = bool(binary.get("healthy"))
    python_ready = bool(python.get("healthy"))
    configured = bool(binary.get("configured")) or bool(python.get("configured"))
    healthy = binary_ready and python_ready
    return {
        "configured": configured,
        "healthy": healthy,
        "status": "available" if healthy else "partial" if configured else "missing",
        "binary": binary,
        "python": python,
        "environment": str(root / "conda" / "envs" / "matos-orca-py311"),
        "runtimeEnv": {"ORCA_HOME": str(root / "orca" / "current")},
    }


def configured_thermocalc_roots(root: Path) -> list[Path]:
    roots: list[Path] = []
    for key in (
        "THERMOCALC_HOME",
        "THERMO_CALC_HOME",
        "THERMOCALC_ROOT",
        "TC_HOME",
        "TC_ROOT",
    ):
        value = non_empty(os.environ.get(key))
        if value:
            roots.append(Path(value))
    roots.extend(
        [
            root / "thermocalc" / "current",
            root / "Thermo-Calc" / "current",
            root / "thermo-calc" / "current",
            root / "thermocalc",
            root / "Thermo-Calc",
            root / "thermo-calc",
        ]
    )
    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in roots:
        text = str(candidate)
        if text in seen:
            continue
        seen.add(text)
        unique.append(candidate)
    return unique


def thermocalc_python_candidates(root: Path, install_roots: list[Path]) -> list[Path]:
    candidates = [
        root / "conda" / "envs" / "matos-thermocalc-py311" / "bin" / "python",
    ]
    for base in install_roots:
        candidates.extend(
            [
                base / "bin" / "python",
                base / "bin" / "python3",
                base / "python" / "bin" / "python",
                base / "SDK" / "TC-Python" / "bin" / "python",
                base / "SDK" / "TC-Python" / "bin" / "python3",
                base / "SDK" / "TC-Python" / "python" / "bin" / "python",
                base / "SDK" / "TC-Python" / "Python" / "bin" / "python",
            ]
        )
    return candidates


def thermocalc_console_candidates(root: Path, install_roots: list[Path]) -> list[Path]:
    candidates = [
        root / "bin" / "thermocalc",
        root / "bin" / "Thermo-Calc",
        root / "bin" / "tc",
    ]
    names = ["thermocalc", "Thermo-Calc", "tc", "tc_console", "console"]
    for base in install_roots:
        for directory in (base / "bin", base / "Console", base):
            candidates.extend(directory / name for name in names)
    return candidates


def license_variable_names_present() -> list[str]:
    candidates = [
        "THERMOCALC_LICENSE_FILE",
        "TC_LICENSE_FILE",
        "LM_LICENSE_FILE",
        "RLM_LICENSE",
        "LSHOST",
    ]
    return [name for name in candidates if non_empty(os.environ.get(name))]


def check_python_import(
    *,
    candidates: list[Path],
    root: Path,
    timeout: float,
    module: str,
) -> dict[str, Any]:
    python = next((path for path in candidates if path.exists()), candidates[0])
    status: dict[str, Any] = {
        "python": str(python),
        "configured": python.exists(),
        "healthy": False,
        "status": "missing",
        "requiredImport": module,
    }
    if not python.exists():
        return status
    if not executable(python):
        status["status"] = "not_executable"
        return status
    probe = run_probe(
        [str(python), "-c", f"import {module}; print({module}.__name__)"],
        root=root,
        timeout=timeout,
    )
    healthy, classification = classify_probe(probe)
    status.update(
        {
            "healthy": healthy,
            "status": classification,
            "probe": probe,
        }
    )
    return status


def check_thermocalc(root: Path, timeout: float) -> dict[str, Any]:
    install_roots = configured_thermocalc_roots(root)
    existing_roots = [path for path in install_roots if path.is_dir()]
    console = check_present_executable(
        candidates=thermocalc_console_candidates(root, install_roots),
    )
    tc_python = check_python_import(
        candidates=thermocalc_python_candidates(root, install_roots),
        root=root,
        timeout=min(timeout, 10.0),
        module="tc_python",
    )
    license_names = license_variable_names_present()
    configured = bool(existing_roots) or bool(console.get("configured")) or bool(
        tc_python.get("configured")
    )
    python_ready = bool(tc_python.get("healthy"))
    console_ready = bool(console.get("healthy"))
    license_ready = bool(license_names)
    healthy = configured and python_ready and license_ready
    if healthy:
        status = "available"
    elif configured and (python_ready or console_ready):
        status = "partial"
    else:
        status = "missing"
    return {
        "configured": configured,
        "healthy": healthy,
        "status": status,
        "installRoots": [str(path) for path in existing_roots],
        "checkedRootCandidates": [str(path) for path in install_roots],
        "tcPython": tc_python,
        "console": console,
        "license": {
            "configured": license_ready,
            "variableNamesPresent": license_names,
            "valuesRedacted": True,
        },
        "runtimeEnv": {
            "THERMOCALC_HOME": str(existing_roots[0]) if existing_roots else str(root / "thermocalc" / "current"),
            "licenseVariableNames": [
                "THERMOCALC_LICENSE_FILE",
                "TC_LICENSE_FILE",
                "LM_LICENSE_FILE",
                "RLM_LICENSE",
                "LSHOST",
            ],
        },
        "usage": {
            "preferred": "TC-Python SDK when tc_python import and license are available",
            "fallback": "Thermo-Calc console mode if a console executable is available; otherwise use pycalphad skills with legitimate .tdb files",
        },
    }


def check_python() -> dict[str, Any]:
    imports: dict[str, bool] = {}
    for module in ("numpy", "scipy", "matplotlib", "ase", "pymatgen"):
        try:
            __import__(module)
            imports[module] = True
        except Exception:
            imports[module] = False
    required_ok = imports["numpy"] and imports["scipy"] and imports["matplotlib"]
    return {
        "configured": True,
        "healthy": required_ok,
        "status": "available" if required_ok else "partial",
        "executable": sys.executable,
        "version": sys.version.split()[0],
        "imports": imports,
    }


def parse_int(value: Any) -> int | None:
    if not isinstance(value, str):
        return None
    cleaned = (
        value.strip()
        .replace("%", "")
        .replace("MiB", "")
        .replace("Mib", "")
        .replace("mib", "")
    )
    if not cleaned or cleaned.upper() in {"N/A", "[NOT SUPPORTED]"}:
        return None
    try:
        return int(float(cleaned))
    except ValueError:
        return None


def csv_rows(text: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for row in csv.reader(text.splitlines()):
        cleaned = [cell.strip() for cell in row]
        if any(cleaned):
            rows.append(cleaned)
    return rows


def gpu_visibility_constraint() -> tuple[str, list[str]] | None:
    key = "CUDA_VISIBLE_DEVICES"
    if key not in os.environ:
        return None
    raw = os.environ.get(key, "").strip()
    if raw.lower() == "all":
        return key, []
    if not raw or raw.lower() in {"none", "void", "nodevfiles", "-1"}:
        return key, ["__none__"]
    return key, [item.strip() for item in raw.split(",") if item.strip()]


def gpu_matches_visibility(index: str, uuid: str, selectors: list[str]) -> bool:
    if not selectors:
        return True
    for selector in selectors:
        if selector == index or selector == uuid:
            return True
        if selector.startswith("GPU-") and uuid.startswith(selector):
            return True
    return False


def check_gpu(
    root: Path,
    timeout: float,
    *,
    idle_utilization_max: int,
    idle_memory_used_mib_max: int,
) -> dict[str, Any]:
    nvidia_smi = shutil.which("nvidia-smi", path=runtime_path(root))
    status: dict[str, Any] = {
        "binary": nvidia_smi,
        "configured": bool(nvidia_smi),
        "healthy": False,
        "status": "missing",
        "idleUtilizationMaxPercent": idle_utilization_max,
        "idleMemoryUsedMiBMax": idle_memory_used_mib_max,
    }
    visibility = gpu_visibility_constraint()
    if visibility is not None:
        status["visibilityConstraint"] = {
            "source": visibility[0],
            "value": os.environ.get(visibility[0], ""),
        }
    if not nvidia_smi:
        return status

    gpu_probe = run_probe(
        [
            nvidia_smi,
            "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
        ],
        root=root,
        timeout=timeout,
    )
    if gpu_probe.get("timedOut"):
        status.update({"status": "blocked_timeout"})
        return status
    if gpu_probe.get("exitCode") != 0:
        combined = f"{gpu_probe.get('stdout', '')}\n{gpu_probe.get('stderr', '')}"
        if "No devices were found" in combined or "has failed" in combined:
            status.update({"status": "no_visible_gpus"})
        else:
            status.update(
                {
                    "status": "probe_failed",
                    "diagnostic": combined.strip()[-1000:],
                    "exitCode": gpu_probe.get("exitCode"),
                }
            )
        return status

    process_probe = run_probe(
        [
            nvidia_smi,
            "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
            "--format=csv,noheader,nounits",
        ],
        root=root,
        timeout=timeout,
    )
    processes_by_uuid: dict[str, list[dict[str, Any]]] = {}
    if process_probe.get("exitCode") == 0:
        for row in csv_rows(str(process_probe.get("stdout") or "")):
            if len(row) < 4:
                continue
            used_memory = parse_int(row[3])
            process = {
                "pid": row[1],
                "processName": row[2],
                "usedMemoryMiB": used_memory,
            }
            processes_by_uuid.setdefault(row[0], []).append(process)

    gpus: list[dict[str, Any]] = []
    for row in csv_rows(str(gpu_probe.get("stdout") or "")):
        if len(row) < 6:
            continue
        if visibility is not None and not gpu_matches_visibility(
            row[0], row[1], visibility[1]
        ):
            continue
        memory_total = parse_int(row[3])
        memory_used = parse_int(row[4])
        utilization = parse_int(row[5])
        memory_free = (
            memory_total - memory_used
            if memory_total is not None and memory_used is not None
            else None
        )
        gpu_processes = processes_by_uuid.get(row[1], [])
        idle = (
            utilization is not None
            and memory_used is not None
            and utilization <= idle_utilization_max
            and memory_used <= idle_memory_used_mib_max
        )
        gpus.append(
            {
                "index": row[0],
                "uuid": row[1],
                "name": row[2],
                "memoryTotalMiB": memory_total,
                "memoryUsedMiB": memory_used,
                "memoryFreeMiB": memory_free,
                "utilizationGpuPercent": utilization,
                "idle": idle,
                "processCount": len(gpu_processes),
                "processes": gpu_processes,
            }
        )

    if not gpus:
        status.update({"status": "no_visible_gpus"})
        return status

    idle_gpus = [gpu for gpu in gpus if gpu.get("idle") is True]
    status.update(
        {
            "healthy": True,
            "status": "available",
            "visibleGpuCount": len(gpus),
            "idleGpuCount": len(idle_gpus),
            "busyGpuCount": len(gpus) - len(idle_gpus),
            "recommendedGpuIndices": [gpu["index"] for gpu in idle_gpus],
            "gpus": gpus,
        }
    )
    return status


def compact_tool_status(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {"configured": False, "healthy": False, "status": "missing"}
    keys = [
        "configured",
        "healthy",
        "status",
        "exitCode",
        "exitCodeInterpretation",
        "healthSource",
        "version",
        "runnerUrlConfigured",
        "missingLibraries",
        "visibleGpuCount",
        "idleGpuCount",
        "busyGpuCount",
        "recommendedGpuIndices",
        "idleUtilizationMaxPercent",
        "idleMemoryUsedMiBMax",
        "visibilityConstraint",
        "envPrefix",
        "wrapper",
        "foamAppBin",
        "foamLibBin",
        "wmProjectUserDir",
        "foamUserAppBin",
        "foamUserLibBin",
        "foamExtraLdflags",
        "writable",
        "recommendedImplementation",
        "availableImplementations",
        "configuredImplementations",
        "requiredImplementations",
        "speciesDirectory",
        "speciesFileCount",
        "requiresWorkflowPreflight",
        "directInvocationSupported",
    ]
    compact = {key: value[key] for key in keys if key in value}
    if "gpus" in value:
        compact["gpus"] = [
            {
                key: gpu.get(key)
                for key in (
                    "index",
                    "uuid",
                    "name",
                    "memoryTotalMiB",
                    "memoryUsedMiB",
                    "memoryFreeMiB",
                    "utilizationGpuPercent",
                    "idle",
                    "processCount",
                )
                if key in gpu
            }
            for gpu in value.get("gpus", [])
            if isinstance(gpu, dict)
        ]
    for path_key in ("binary", "executable"):
        if path_key in value:
            compact[path_key] = value[path_key]
    components = value.get("components")
    if isinstance(components, dict):
        compact["components"] = {
            name: compact_tool_status(component)
            for name, component in components.items()
            if isinstance(component, dict)
        }
    for command_group in ("requiredCommands", "optionalCommands"):
        commands = value.get(command_group)
        if isinstance(commands, dict):
            compact[command_group] = {
                name: compact_tool_status(command)
                for name, command in commands.items()
                if isinstance(command, dict)
            }
    implementations = value.get("implementations")
    if isinstance(implementations, dict):
        compact["implementations"] = {
            name: compact_tool_status(implementation)
            for name, implementation in implementations.items()
            if isinstance(implementation, dict)
        }
    for nested_key in (
        "catalyticFoam",
        "solver",
        "alias",
        "preprocessor",
        "boundaryLibrary",
        "userBuild",
        "compile",
    ):
        nested = value.get(nested_key)
        if isinstance(nested, dict):
            compact[nested_key] = compact_tool_status(nested)
    return compact


def compact_tools(tools: dict[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for name, value in tools.items():
        if name == "vasp" and isinstance(value, dict):
            result[name] = {
                "configured": value.get("configured"),
                "healthy": value.get("healthy"),
                "status": value.get("status"),
                "wrapper": compact_tool_status(value.get("wrapper")),
                "direct": compact_tool_status(value.get("direct")),
                "defaultProfile": value.get("defaultProfile"),
                "profiles": [
                    {
                        key: profile.get(key)
                        for key in (
                            "id",
                            "configured",
                            "healthy",
                            "status",
                            "binary",
                            "features",
                            "version",
                            "wrapperEnv",
                        )
                        if key in profile
                    }
                    for profile in value.get("profiles", [])
                    if isinstance(profile, dict)
                ],
            }
            continue
        result[name] = compact_tool_status(value)
    return result


def summary_payload(
    *,
    ok: bool,
    root: Path,
    checks: list[str],
    tools: dict[str, Any],
    recommendations_list: list[str],
) -> dict[str, Any]:
    return {
        "ok": ok,
        "toolchain": {
            "root": str(root),
            "exists": root.exists(),
            "isDirectory": root.is_dir(),
        },
        "checks": checks,
        "tools": compact_tools(tools),
        "recommendations": recommendations_list,
    }


def recommendations(root: Path, checks: list[str], tools: dict[str, Any]) -> list[str]:
    items: list[str] = []
    if requires_toolchain_root(checks) and not root.exists():
        items.append("Ensure the runtime profile mounts the external toolchain at /opt/matos-tools.")
    if any(
        tools.get(name, {}).get("status") == "blocked_glibc_mismatch"
        for name in ("qe", "lammps")
    ):
        items.append(
            "Install a compatible local QE/LAMMPS runtime when preflight reports a GLIBC mismatch."
        )
    elk = tools.get("elk", {})
    if isinstance(elk, dict) and elk.get("status") == "available_via_workflow":
        items.append(
            "Elk is available in its build-in-place layout. Use the published Elk workflow and its preflight; command -v elk is not an availability check."
        )
    elif isinstance(elk, dict) and elk.get("status") not in (None, "available_via_workflow"):
        items.append(
            "Elk did not pass layout discovery under the mounted toolchain root; run the published Elk workflow preflight before selecting a lower-fidelity method."
        )
    vasp = tools.get("vasp", {})
    wrapper = vasp.get("wrapper", {}) if isinstance(vasp, dict) else {}
    direct = vasp.get("direct", {}) if isinstance(vasp, dict) else {}
    if wrapper.get("status") == "blocked_missing_node":
        items.append(
            "Rebuild the matos-openvscode image with the persistent node compatibility shim before using VASP wrappers locally."
        )
    if wrapper.get("status") == "blocked_missing_vasp_runner":
        items.append(
            "Configure the local VASP wrapper and its required runner before executing a VASP calculation."
        )
    if direct.get("status") == "blocked_missing_runtime_libs":
        items.append(
            "Provide the declared runtime libraries before starting a VASP calculation."
        )
    profiles = vasp.get("profiles", []) if isinstance(vasp, dict) else []
    if isinstance(profiles, list):
        hdf5_wannier_profiles = [
            profile
            for profile in profiles
            if isinstance(profile, dict)
            and profile.get("healthy") is True
            and {"hdf5", "wannier90"}.issubset(
                {str(item).lower() for item in profile.get("features", [])}
            )
        ]
        if hdf5_wannier_profiles:
            profile_id = hdf5_wannier_profiles[0].get("id")
            items.append(
                "For local VASP HDF5/Wannier90 workflows, use the MatOS VASP wrapper with "
                f"MATOS_VASP_PROFILE={profile_id}; do not call profile .real binaries directly."
            )
    gpu = tools.get("gpu", {})
    if isinstance(gpu, dict) and gpu.get("status") == "available":
        recommended_indices = gpu.get("recommendedGpuIndices")
        if isinstance(recommended_indices, list) and recommended_indices:
            items.append(
                "Prefer local GPU execution first; set CUDA_VISIBLE_DEVICES="
                + ",".join(str(item) for item in recommended_indices)
                + " for local runs before using remote queues."
            )
        elif gpu.get("visibilityConstraint"):
            items.append(
                "The assigned CUDA-visible GPU allocation is currently busy; preserve "
                "that allocation and use its configured workflow/scheduler queue or "
                "retry later instead of selecting another physical GPU."
            )
        else:
            items.append(
                "Local GPUs are visible but currently busy; prefer an idle remote batch queue or retry local execution later."
            )
    elif isinstance(gpu, dict) and gpu.get("configured") is False:
        items.append(
            "nvidia-smi is not visible in this workspace; restart the workspace with MATOS_WORKSPACE_GPUS configured before local GPU routing."
        )
    openfoam = tools.get("openfoam", {})
    if isinstance(openfoam, dict) and openfoam.get("configured") is False:
        items.append(
            "Install OpenFOAM under /opt/matos-tools/conda/envs/matos-openfoam and expose /opt/matos-tools/bin/openfoam before local CFD runs."
        )
    elif isinstance(openfoam, dict) and openfoam.get("status") not in (None, "available"):
        items.append(
            "OpenFOAM is present but did not pass activation/help probes; run /opt/matos-tools/bin/openfoam env and blockMesh -help before production CFD."
        )
    wannier90 = tools.get("wannier90", {})
    if isinstance(wannier90, dict) and wannier90.get("status") == "missing":
        items.append(
            "Install Wannier90 under /opt/matos-tools/conda/envs/matos-wannier90-py311 and expose pw2wannier90.x before local QE+Wannier90 workflows."
        )
    elif isinstance(wannier90, dict) and wannier90.get("status") == "partial":
        items.append(
            "Wannier90 toolchain is only partially available; require healthy wannier90.x and pw2wannier90.x before running the native QE+Wannier90 workflow."
        )
    gw = tools.get("gw", {})
    if isinstance(gw, dict) and gw.get("status") == "missing":
        items.append(
            "Install a complete GW stack under /opt/matos-tools, such as matos-gw-yambo-py311 with p2y/yambo/ypp, BerkeleyGW epsilon/sigma, WEST wstat/wfreq, ABINIT, or GPAW; otherwise route GW work through a configured remote VASP or batch workflow."
        )
    elif isinstance(gw, dict) and gw.get("status") == "partial":
        items.append(
            "GW toolchain is only partially available; require one complete implementation before local GW/BSE production runs."
        )
    orca = tools.get("orca", {})
    if isinstance(orca, dict) and orca.get("status") == "missing":
        items.append(
            "Install ORCA under /opt/matos-tools/orca/current and expose /opt/matos-tools/bin/orca before local molecular ORCA workflows."
        )
    elif isinstance(orca, dict) and orca.get("status") == "partial":
        items.append(
            "ORCA support is partial; require both /opt/matos-tools/bin/orca and the matos-orca-py311 Python environment before running ORCA skills."
        )
    thermocalc = tools.get("thermocalc", {})
    if isinstance(thermocalc, dict) and thermocalc.get("status") == "missing":
        items.append(
            "Thermo-Calc is not mounted in this workspace. Install or mount a licensed Thermo-Calc tree under /opt/matos-tools/thermocalc/current, or use pycalphad with a legitimate .tdb file."
        )
    elif isinstance(thermocalc, dict) and thermocalc.get("status") == "partial":
        items.append(
            "Thermo-Calc support is partial; require a working tc_python import and configured license variables before TC-Python production calculations."
        )
    if not items:
        items.append("Local toolchain preflight passed for the selected checks.")
    return items


def main() -> int:
    input_payload = read_input()
    root = resolve_root(input_payload)
    checks = selected_checks(input_payload)
    timeout = timeout_seconds(input_payload)
    detail = detail_level(input_payload)
    idle_utilization_max = bounded_int(
        input_payload,
        "gpuIdleUtilizationMaxPercent",
        default=5,
        minimum=0,
        maximum=100,
    )
    idle_memory_used_mib_max = bounded_int(
        input_payload,
        "gpuIdleMemoryUsedMiBMax",
        default=1024,
        minimum=0,
        maximum=1048576,
    )
    tools: dict[str, Any] = {}

    if "vasp" in checks:
        tools["vasp"] = check_vasp(root, timeout)
        tools["vaspWrapper"] = tools["vasp"]["wrapper"]
        tools["vaspDirect"] = tools["vasp"]["direct"]
    if "qe" in checks:
        tools["qe"] = check_executable_tool(
            root=root,
            name="qe",
            candidates=[
                root / "qe" / "bin" / "pw.x",
                root / "aptroot-jammy" / "usr" / "bin" / "pw.x",
                root / "aptroot" / "usr" / "bin" / "pw.x",
            ],
            args=["--version"],
            timeout=timeout,
            startup_markers=["Program PWSCF", "Quantum ESPRESSO"],
            managed_wrapper_dir=root / "qe" / "bin",
            probe_env={
                "OMPI_ALLOW_RUN_AS_ROOT": "1",
                "OMPI_ALLOW_RUN_AS_ROOT_CONFIRM": "1",
            },
        )
    if "lammps" in checks:
        tools["lammps"] = check_executable_tool(
            root=root,
            name="lammps",
            candidates=[
                root / "lammps" / "bin" / "lmp",
                root / "aptroot" / "usr" / "bin" / "lmp",
            ],
            args=["-h"],
            timeout=timeout,
            # The managed wrapper selects either the image-native LAMMPS or
            # the mounted aptroot binary and owns the matching MPI runtime
            # environment. Injecting the generic mounted Open MPI prefix here
            # can mix that runtime with /usr/bin/lmp and make singleton
            # MPI_Init fail before LAMMPS starts.
            managed_wrapper_dir=root / "lammps" / "bin",
        )
    if "elk" in checks:
        tools["elk"] = check_elk(root)
    if "openfoam" in checks:
        tools["openfoam"] = check_openfoam(root, timeout)
    if "wannier90" in checks:
        tools["wannier90"] = check_wannier90(root, timeout)
    if "gw" in checks:
        tools["gw"] = check_gw(root, timeout)
    if "orca" in checks:
        tools["orca"] = check_orca(root)
    if "thermocalc" in checks:
        tools["thermocalc"] = check_thermocalc(root, timeout)
    if "conda" in checks:
        tools["conda"] = check_executable_tool(
            root=root,
            name="conda",
            candidates=[root / "conda" / "bin" / "conda"],
            args=["--version"],
            timeout=timeout,
        )
    if "python" in checks:
        tools["python"] = check_python()
    if "gpu" in checks:
        tools["gpu"] = check_gpu(
            root,
            timeout,
            idle_utilization_max=idle_utilization_max,
            idle_memory_used_mib_max=idle_memory_used_mib_max,
        )

    checked_tools = [
        value
        for key, value in tools.items()
        if key not in ("vaspWrapper", "vaspDirect") and isinstance(value, dict)
    ]
    ok = (
        (not requires_toolchain_root(checks) or root.is_dir())
        and all(tool.get("healthy") is True for tool in checked_tools)
    )
    recommendation_list = recommendations(root, checks, tools)
    summary = summary_payload(
        ok=ok,
        root=root,
        checks=checks,
        tools=tools,
        recommendations_list=recommendation_list,
    )
    response_tools = compact_tools(tools) if detail == "summary" else tools
    response: dict[str, Any] = {
        "ok": ok,
        "toolchain": summary["toolchain"],
        "checks": checks,
        "tools": response_tools,
        "recommendations": recommendation_list,
        "summary": summary,
    }
    if detail == "full":
        response["runtimeLibraries"] = {
            "paths": runtime_library_paths(root),
            "mklRoot": non_empty(os.environ.get("MATOS_MKL_ROOT")),
        }
    print_json(containerize_paths(response, root))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
