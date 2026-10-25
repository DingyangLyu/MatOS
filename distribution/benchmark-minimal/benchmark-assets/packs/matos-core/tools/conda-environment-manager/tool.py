#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any


DEFAULT_USER_ENV_ROOT = "/workspace/caches/conda/envs"
DEFAULT_PIP_INDEX_URL = "https://pypi.org/simple/"
DEFAULT_PIP_DEFAULT_TIMEOUT_SECONDS = "60"
DEFAULT_PIP_RETRIES = "8"
ENV_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
PYTHON_VERSION_RE = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}$")
PACKAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.\-\[\],=<>!~]*$")
IMPORT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")


def read_input() -> dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}
    value = payload.get("input", payload)
    return value if isinstance(value, dict) else {}


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def fail(code: str, message: str, **extra: Any) -> int:
    print_json({"ok": False, "code": code, "error": message, **extra})
    return 1


def bool_value(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def float_value(value: Any, default: float, minimum: float, maximum: float) -> float:
    if isinstance(value, (int, float)) and minimum <= float(value) <= maximum:
        return float(value)
    return default


def user_env_root() -> Path:
    value = os.environ.get("MATOS_USER_CONDA_ENVS_PATH") or DEFAULT_USER_ENV_ROOT
    return Path(value)


def user_cache_root() -> Path:
    value = os.environ.get("MATOS_USER_CACHE_ROOT")
    if value:
        return Path(value)
    return user_env_root().parent


def resolve_user_env(env_name: Any) -> tuple[Path, str] | str:
    if not isinstance(env_name, str) or not ENV_NAME_RE.fullmatch(env_name.strip()):
        return "invalid_env_name"
    cleaned = env_name.strip()
    root = user_env_root()
    prefix = root / cleaned
    root_resolved = root.resolve(strict=False)
    prefix_resolved = prefix.resolve(strict=False)
    try:
        prefix_resolved.relative_to(root_resolved)
    except ValueError:
        return "env_outside_user_scope"
    return prefix, cleaned


def clean_python_version(value: Any) -> str | None:
    text = value if isinstance(value, str) else "3.11"
    text = text.strip()
    return text if PYTHON_VERSION_RE.fullmatch(text) else None


def clean_packages(value: Any) -> list[str] | str:
    if value is None:
        return []
    if not isinstance(value, list):
        return "invalid_packages"
    packages: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return "invalid_packages"
        text = item.strip()
        if not text or text.startswith("-") or not PACKAGE_RE.fullmatch(text):
            return "invalid_package_spec"
        if text not in packages:
            packages.append(text)
    return packages


def clean_imports(value: Any, packages: list[str]) -> list[str] | str:
    raw = value if isinstance(value, list) else packages
    imports: list[str] = []
    for item in raw:
        if not isinstance(item, str):
            return "invalid_imports"
        text = item.strip().split("==", 1)[0].split(">=", 1)[0].split("<=", 1)[0]
        text = text.replace("-", "_")
        if not text or not IMPORT_RE.fullmatch(text):
            return "invalid_import_name"
        if text not in imports:
            imports.append(text)
    return imports


def source_route_env(*, ensure_dirs: bool = True) -> dict[str, str]:
    env = os.environ.copy()
    cache_root = user_cache_root()
    pip_index_url = os.environ.get(
        "MATOS_PIP_INDEX_URL",
        os.environ.get("PIP_INDEX_URL", DEFAULT_PIP_INDEX_URL),
    )
    uv_index_url = os.environ.get(
        "MATOS_UV_INDEX_URL",
        os.environ.get("UV_INDEX_URL", pip_index_url),
    )
    pip_extra_index_url = os.environ.get(
        "MATOS_PIP_EXTRA_INDEX_URL",
        os.environ.get("PIP_EXTRA_INDEX_URL", ""),
    )
    uv_extra_index_url = os.environ.get(
        "MATOS_UV_EXTRA_INDEX_URL",
        os.environ.get("UV_EXTRA_INDEX_URL", pip_extra_index_url),
    )
    env["PIP_INDEX_URL"] = pip_index_url
    env["MATOS_PIP_INDEX_URL"] = pip_index_url
    env["UV_INDEX_URL"] = uv_index_url
    env["MATOS_UV_INDEX_URL"] = uv_index_url
    env.setdefault("MATOS_PACKAGE_SOURCE_PROFILE", "pypi")
    if pip_extra_index_url:
        env["PIP_EXTRA_INDEX_URL"] = pip_extra_index_url
        env["MATOS_PIP_EXTRA_INDEX_URL"] = pip_extra_index_url
    if uv_extra_index_url:
        env["UV_EXTRA_INDEX_URL"] = uv_extra_index_url
        env["MATOS_UV_EXTRA_INDEX_URL"] = uv_extra_index_url
    env.setdefault("PIP_DEFAULT_TIMEOUT", DEFAULT_PIP_DEFAULT_TIMEOUT_SECONDS)
    env.setdefault("PIP_RETRIES", DEFAULT_PIP_RETRIES)
    env.setdefault("PIP_DISABLE_PIP_VERSION_CHECK", "1")
    env["PIP_USER"] = "0"
    env["PYTHONNOUSERSITE"] = "1"
    env.pop("PYTHONUSERBASE", None)
    env.setdefault("PIP_CACHE_DIR", str(cache_root / "pip"))
    env.setdefault("UV_CACHE_DIR", str(cache_root / "uv"))
    env.setdefault("CONDA_PKGS_DIRS", str(cache_root / "pkgs"))
    env.setdefault("CONDA_ENVS_PATH", str(user_env_root()))
    env.setdefault("TMPDIR", str(cache_root / "tmp"))
    env.setdefault("TMP", env["TMPDIR"])
    env.setdefault("TEMP", env["TMPDIR"])
    if ensure_dirs:
        for key in ("PIP_CACHE_DIR", "UV_CACHE_DIR", "CONDA_PKGS_DIRS", "TMPDIR"):
            Path(env[key]).mkdir(parents=True, exist_ok=True)
    home = env.get("HOME")
    if ensure_dirs and home:
        try:
            Path(home, ".conda").mkdir(parents=True, exist_ok=True)
        except OSError:
            fallback_home = cache_root / "home"
            fallback_home.mkdir(parents=True, exist_ok=True)
            Path(fallback_home, ".conda").mkdir(parents=True, exist_ok=True)
            env["HOME"] = str(fallback_home)
    return env


def source_routing_summary() -> dict[str, Any]:
    env = source_route_env(ensure_dirs=False)
    conda_channels = conda_channel_args()
    return {
        "profile": env.get("MATOS_PACKAGE_SOURCE_PROFILE", "pypi"),
        "pip": {
            "indexUrl": env.get("PIP_INDEX_URL", DEFAULT_PIP_INDEX_URL),
            **(
                {"extraIndexUrl": env["PIP_EXTRA_INDEX_URL"]}
                if env.get("PIP_EXTRA_INDEX_URL")
                else {}
            ),
            "cacheDir": env.get("PIP_CACHE_DIR"),
            "defaultTimeoutSeconds": env.get("PIP_DEFAULT_TIMEOUT"),
            "retries": env.get("PIP_RETRIES"),
        },
        "uv": {
            "indexUrl": env.get("UV_INDEX_URL", env.get("PIP_INDEX_URL")),
            **(
                {"extraIndexUrl": env["UV_EXTRA_INDEX_URL"]}
                if env.get("UV_EXTRA_INDEX_URL")
                else {}
            ),
            "cacheDir": env.get("UV_CACHE_DIR"),
        },
        "conda": {
            "channelArgs": conda_channels,
            "pkgsDir": env.get("CONDA_PKGS_DIRS"),
            "envsPath": env.get("CONDA_ENVS_PATH"),
        },
    }


def conda_channel_args() -> list[str]:
    channels_text = os.environ.get("MATOS_CONDA_CHANNELS") or os.environ.get("CONDA_CHANNELS")
    if not channels_text:
        return []
    if channels_text.strip().startswith("["):
        try:
            parsed = json.loads(channels_text)
        except json.JSONDecodeError:
            parsed = []
        channels = [str(item).strip() for item in parsed if str(item).strip()]
    else:
        channels = [item.strip() for item in channels_text.split(",") if item.strip()]
    if not channels:
        return []
    args = ["--override-channels"]
    for channel in channels:
        args.extend(["-c", channel])
    return args


def conda_executable() -> str | None:
    for key in ("CONDA_EXE", "MAMBA_EXE", "MICROMAMBA_EXE"):
        value = os.environ.get(key)
        if value and Path(value).is_file() and os.access(value, os.X_OK):
            return value
    for name in ("conda", "mamba", "micromamba"):
        found = shutil.which(name)
        if found:
            return found
    return None


def summarize_command(command: list[str]) -> list[str]:
    return [str(item) for item in command]


def run_command(command: list[str], timeout: float) -> dict[str, Any]:
    try:
        result = subprocess.run(
            command,
            env=source_route_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
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
        "status": "ok" if result.returncode == 0 else "failed",
        "exitCode": result.returncode,
        "stdout": result.stdout[-4000:],
        "stderr": result.stderr[-4000:],
    }


def env_python(prefix: Path) -> Path:
    return prefix / "bin" / "python"


def probe_python(python: Path, imports: list[str], timeout: float) -> dict[str, Any]:
    if not python.is_file() or not os.access(python, os.X_OK):
        return {"ok": False, "status": "missing_python", "python": str(python)}
    code = r"""
import importlib.metadata as md
import importlib.util
import json
import sys

imports = json.loads(sys.argv[1])
packages = {}
for name in imports:
    spec = importlib.util.find_spec(name)
    version = None
    package_name = name.replace("_", "-")
    if spec is not None:
        for candidate in (package_name, name):
            try:
                version = md.version(candidate)
                break
            except md.PackageNotFoundError:
                continue
    packages[name] = {
        "available": spec is not None,
        "origin": getattr(spec, "origin", None) if spec else None,
        "package": package_name,
        "version": version,
    }
print(json.dumps({
    "ok": True,
    "status": "available",
    "pythonVersion": sys.version.split()[0],
    "executable": sys.executable,
    "packages": packages,
}, ensure_ascii=False, sort_keys=True))
"""
    result = run_command([str(python), "-c", code, json.dumps(imports)], timeout)
    if not result.get("ok"):
        return result
    try:
        return json.loads(str(result.get("stdout") or "{}"))
    except json.JSONDecodeError:
        return {"ok": False, "status": "bad_json", "stdout": result.get("stdout")}


def create_env(prefix: Path, python_version: str, timeout: float, dry_run: bool) -> dict[str, Any]:
    python = env_python(prefix)
    if python.is_file():
        return {
            "ok": True,
            "status": "exists",
            "existed": True,
            "command": None,
            "python": str(python),
        }
    conda = conda_executable()
    if not conda:
        return {"ok": False, "status": "missing_conda", "error": "No conda, mamba, or micromamba executable found."}
    prefix.parent.mkdir(parents=True, exist_ok=True)
    command = [
        conda,
        "create",
        "-y",
        *conda_channel_args(),
        "-p",
        str(prefix),
        f"python={python_version}",
    ]
    if dry_run:
        return {"ok": True, "status": "planned", "command": summarize_command(command), "python": str(python)}
    result = run_command(command, timeout)
    return {
        **result,
        "command": summarize_command(command),
        "python": str(python),
    }


def pip_install(prefix: Path, packages: list[str], timeout: float, dry_run: bool, upgrade: bool) -> dict[str, Any]:
    python = env_python(prefix)
    command = [str(python), "-m", "pip", "install"]
    if upgrade:
        command.append("--upgrade")
    command.extend(packages)
    if dry_run:
        return {"ok": True, "status": "planned", "command": summarize_command(command)}
    if not python.is_file() or not os.access(python, os.X_OK):
        return {"ok": False, "status": "missing_python", "error": "Target user environment does not contain an executable bin/python.", "python": str(python)}
    return {**run_command(command, timeout), "command": summarize_command(command)}


def main() -> int:
    payload = read_input()
    action = payload.get("action")
    if action not in {"create_env", "pip_install", "ensure_packages", "probe"}:
        return fail("invalid_action", "action must be create_env, pip_install, ensure_packages, or probe")

    resolved = resolve_user_env(payload.get("envName"))
    if isinstance(resolved, str):
        return fail(resolved, "envName must be a simple user environment name without slashes or traversal.")
    prefix, env_name = resolved

    python_version = clean_python_version(payload.get("pythonVersion"))
    if python_version is None:
        return fail("invalid_python_version", "pythonVersion must look like 3.11 or 3.11.9")
    packages = clean_packages(payload.get("packages"))
    if isinstance(packages, str):
        return fail(packages, "packages must be PyPI-style specifiers without URLs, paths, whitespace, or leading options.")
    imports = clean_imports(payload.get("imports"), packages)
    if isinstance(imports, str):
        return fail(imports, "imports must be valid Python module names.")

    timeout = float_value(payload.get("timeoutSeconds"), 600.0, 5.0, 1200.0)
    dry_run = bool_value(payload.get("dryRun"), False)
    upgrade = bool_value(payload.get("upgrade"), False)

    response: dict[str, Any] = {
        "ok": True,
        "action": action,
        "scope": "user",
        "envName": env_name,
        "prefix": str(prefix),
        "python": str(env_python(prefix)),
        "userEnvRoot": str(user_env_root()),
        "sourceRouting": source_routing_summary(),
        "dryRun": dry_run,
    }

    if action in {"create_env", "ensure_packages"}:
        created = create_env(prefix, python_version, timeout, dry_run)
        response["create"] = created
        if not created.get("ok"):
            print_json({**response, "ok": False})
            return 1
    elif action in {"pip_install", "probe"} and not env_python(prefix).is_file():
        return fail(
            "missing_user_env",
            "Target user environment is missing. Call create_env or ensure_packages first.",
            envName=env_name,
            prefix=str(prefix),
        )

    if action in {"pip_install", "ensure_packages"}:
        if not packages:
            return fail("missing_packages", "packages is required for pip_install or ensure_packages")
        installed = pip_install(prefix, packages, timeout, dry_run, upgrade)
        response["install"] = installed
        if not installed.get("ok"):
            print_json({**response, "ok": False})
            return 1

    if action in {"pip_install", "ensure_packages", "probe"} and not dry_run:
        response["probe"] = probe_python(env_python(prefix), imports, min(timeout, 60.0))
    print_json(response)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print_json({"ok": False, "code": "interrupted", "error": "interrupted"})
        raise SystemExit(130)
