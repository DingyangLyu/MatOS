#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
from typing import Any


KNOWN_PACKAGES = {
    "mace": {"import": "mace", "package": "mace-torch"},
    "chgnet": {"import": "chgnet", "package": "chgnet"},
    "matgl": {"import": "matgl", "package": "matgl"},
    "sevennet": {"import": "sevenn", "package": "sevenn"},
    "orb": {"import": "orb_models", "package": "orb-models"},
    "mattersim": {"import": "mattersim", "package": "mattersim"},
    "fairchem": {"import": "fairchem", "package": "fairchem-core"},
    "nequip": {"import": "nequip", "package": "nequip"},
    "allegro": {"import": "allegro", "package": "nequip-allegro"},
    "torchsim": {"import": "torch_sim", "package": "torch-sim-atomistic"},
}

# The deployment data root is deployment-specific and must come from the
# environment (MATOS_DEPLOY_ROOT); no internal host path ships with this
# asset. Without it, shared/global asset roots are simply not appended and
# MATOS_ASSET_ROOTS remains authoritative.
DEFAULT_MATOS_DEPLOY_ROOT = ""


def read_input() -> dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}
    value = payload.get("input", payload)
    return value if isinstance(value, dict) else {}


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def str_value(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def bool_value(value: Any, default: bool = False) -> bool:
    return value if isinstance(value, bool) else default


def limit_value(value: Any) -> int:
    if isinstance(value, int) and 1 <= value <= 500:
        return value
    return 100


def metadata_object(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def asset_roots() -> list[Path]:
    raw_parts: list[str] = []
    for key in ("MATOS_ASSET_ROOTS", "MATOS_DEFAULT_ASSET_ROOTS", "MATOS_BUNDLED_ASSET_ROOT"):
        raw = os.environ.get(key)
        if raw:
            raw_parts.extend(part for part in raw.split(":") if part)
    deploy_root = os.environ.get("MATOS_DEPLOY_ROOT") or DEFAULT_MATOS_DEPLOY_ROOT
    if deploy_root:
        raw_parts.extend(
            [
                str(Path(deploy_root) / "assets" / "shared"),
                str(Path(deploy_root) / "assets" / "global"),
            ],
        )
    roots: list[Path] = []
    for part in raw_parts:
        path = Path(part)
        if path.exists() and path not in roots:
            roots.append(path)
    return roots


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def package_status() -> dict[str, dict[str, Any]]:
    status: dict[str, dict[str, Any]] = {}
    for family, spec in KNOWN_PACKAGES.items():
        import_name = spec["import"]
        module = importlib.util.find_spec(import_name)
        status[family] = {
            "package": spec["package"],
            "import": import_name,
            "available": module is not None,
            "origin": getattr(module, "origin", None) if module else None,
            "probeScope": "catalog-interpreter-only",
            "pythonExecutable": sys.executable,
            "managedEnvironmentAvailable": None,
            "nextTool": "mcp__matos_asset__conda_environment_catalog",
        }
    return status


def manifest_files(roots: list[Path]) -> list[Path]:
    # Native composition supplies the exact visible registry winners. Do not
    # rescan a parent checkout (or fall back on malformed/empty allowlists):
    # that could expose unaccepted versions or assets outside this scope.
    raw = os.environ.get("MATOS_MLIP_MODEL_MANIFESTS")
    if raw is not None:
        entries = json.loads(raw)
        if not isinstance(entries, list) or not all(isinstance(p, str) for p in entries):
            raise ValueError("MATOS_MLIP_MODEL_MANIFESTS must be a JSON path array")
        return sorted({Path(p) for p in entries if Path(p).is_file()})
    files: list[Path] = []
    for root in roots:
        try:
            files.extend(path for path in root.rglob("asset.json") if path.is_file())
        except OSError:
            continue
    return sorted(files)


def model_file_entries(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    raw = metadata.get("files") or metadata.get("localFiles")
    if isinstance(raw, list):
        return [item for item in raw if isinstance(item, dict)]
    default_file = str_value(metadata.get("defaultFile")) or str_value(
        metadata.get("localPath"),
    )
    return [{"path": default_file}] if default_file else []


def is_mlip_model_asset(manifest: dict[str, Any]) -> bool:
    if manifest.get("type") != "data":
        return False
    metadata = metadata_object(manifest.get("metadata"))
    tags = string_list(manifest.get("tags"))
    return (
        metadata.get("kind") == "mlip-model"
        or metadata.get("family") in KNOWN_PACKAGES
        or "mlip-model" in tags
    )


def serialize_model_asset(
    manifest_path: Path,
    manifest: dict[str, Any],
    verify_checksum: bool,
) -> dict[str, Any]:
    metadata = metadata_object(manifest.get("metadata"))
    version = str_value(manifest.get("version"))
    asset_type = str_value(manifest.get("type")) or "data"
    asset_id = str_value(manifest.get("id")) or manifest_path.parent.name
    manifest_dir = manifest_path.parent
    family = str_value(metadata.get("family")) or str_value(metadata.get("framework"))
    files: list[dict[str, Any]] = []

    for entry in model_file_entries(metadata):
        rel = str_value(entry.get("path"))
        if not rel:
            continue
        path = Path(rel)
        absolute = path if path.is_absolute() else manifest_dir / path
        exists = absolute.is_file()
        expected = str_value(entry.get("sha256")) or str_value(metadata.get("sha256"))
        actual = sha256_file(absolute) if exists and verify_checksum else None
        files.append(
            {
                "path": str(absolute),
                "relativePath": rel,
                "exists": exists,
                "sizeBytes": absolute.stat().st_size if exists else None,
                "sha256": expected,
                "sha256Actual": actual,
                "checksumOk": (actual == expected) if actual and expected else None,
            },
        )

    local_file = next((item for item in files if item["exists"]), None)
    package = KNOWN_PACKAGES.get(family or "", {})
    return {
        "id": asset_id,
        "type": asset_type,
        "canonicalKey": f"{asset_type}:{asset_id}@{version}" if version else f"{asset_type}:{asset_id}",
        "name": manifest.get("name") or asset_id,
        "version": version,
        "description": manifest.get("description"),
        "family": family,
        "framework": metadata.get("framework"),
        "modelName": metadata.get("modelName"),
        "license": metadata.get("license"),
        "sourceUrl": metadata.get("sourceUrl"),
        "loader": metadata.get("loader"),
        "status": "available" if local_file else "missing_files",
        "localPath": local_file["path"] if local_file else None,
        "files": files,
        "package": metadata.get("package") or package.get("package"),
        "import": metadata.get("packageImport") or package.get("import"),
        "warnings": metadata.get("warnings") or [],
        "manifestPath": str(manifest_path),
    }


def main() -> int:
    payload = read_input()
    family_filter = str_value(payload.get("family"))
    available_only = bool_value(payload.get("availableOnly"))
    include_packages = bool_value(payload.get("includePackages"), True)
    verify_checksum = bool_value(payload.get("verifyChecksum"))
    limit = limit_value(payload.get("limit"))

    roots = asset_roots()
    models: list[dict[str, Any]] = []
    for manifest_path in manifest_files(roots):
        manifest = read_json(manifest_path)
        if not manifest or not is_mlip_model_asset(manifest):
            continue
        item = serialize_model_asset(manifest_path, manifest, verify_checksum)
        if family_filter and item.get("family") != family_filter:
            continue
        if available_only and item.get("status") != "available":
            continue
        models.append(item)

    models = sorted(models, key=lambda item: str(item.get("id")))[:limit]
    print_json(
        {
            "ok": True,
            "assetRoots": [str(root) for root in roots],
            "count": len(models),
            "models": models,
            "packages": package_status() if include_packages else {},
            "discoverySource": "native-registry" if "MATOS_MLIP_MODEL_MANIFESTS" in os.environ else "explicit-roots",
            "managedEnvironmentProbe": {"status": "not-probed", "tool": "mcp__matos_asset__conda_environment_catalog",
                                        "input": {"probePackages": True, "imports": ["mace"], "includeGpu": False}},
            "note": (
                "Use localPath for model loaders when status is available. "
                "For MACE, pass localPath to mace_mp(model=...) to avoid runtime downloads. "
                "Package availability is only a module-spec check in this tool's interpreter, not a loader test. "
                "A false value does not mean managed Conda environments are unavailable; probe them with conda_environment_catalog."
            ),
        },
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print_json({"ok": False, "error": "interrupted"})
        sys.exit(130)
