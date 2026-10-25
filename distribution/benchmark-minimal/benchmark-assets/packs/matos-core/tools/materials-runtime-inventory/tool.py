#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


TOOLS_ROOT = Path(__file__).resolve().parent.parent

def read_input() -> dict[str, Any]:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return {}
    value = payload.get("input", payload)
    return value if isinstance(value, dict) else {}


def print_json(value: dict[str, Any]) -> None:
    print(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True))


def bool_value(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def float_value(value: Any, default: float, minimum: float, maximum: float) -> float:
    if isinstance(value, (int, float)) and minimum <= float(value) <= maximum:
        return float(value)
    return default


def detail_value(value: Any) -> str:
    return value if value in {"summary", "full"} else "summary"


def compact_text(value: str, limit: int = 1600) -> str:
    return value[-limit:] if len(value) > limit else value


def parse_json_stdout(stdout: str) -> Any:
    try:
        return json.loads(stdout)
    except json.JSONDecodeError:
        return None


def run_tool(tool_id: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
    tool_path = TOOLS_ROOT / tool_id / "tool.py"
    if not tool_path.is_file():
        return {
            "ok": False,
            "status": "missing_tool",
            "tool": tool_id,
            "path": str(tool_path),
        }
    try:
        result = subprocess.run(
            [sys.executable, str(tool_path)],
            input=json.dumps({"input": payload}),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return {"ok": False, "status": "timeout", "tool": tool_id}
    except OSError as error:
        return {
            "ok": False,
            "status": "exec_error",
            "tool": tool_id,
            "error": str(error),
        }

    parsed = parse_json_stdout(result.stdout)
    if isinstance(parsed, dict):
        return {
            **parsed,
            "_toolExitCode": result.returncode,
            **({"_stderr": compact_text(result.stderr)} if result.stderr else {}),
        }
    return {
        "ok": result.returncode == 0,
        "status": "available" if result.returncode == 0 else "failed",
        "tool": tool_id,
        "exitCode": result.returncode,
        "stdout": compact_text(result.stdout),
        **({"stderr": compact_text(result.stderr)} if result.stderr else {}),
    }


def summarize_toolchain(value: dict[str, Any], detail: str) -> dict[str, Any]:
    if detail == "full":
        return value
    summary = value.get("summary")
    return summary if isinstance(summary, dict) else {
        "ok": value.get("ok"),
        "toolchain": value.get("toolchain"),
        "tools": value.get("tools"),
        "recommendations": value.get("recommendations"),
    }


def summarize_conda(value: dict[str, Any], detail: str) -> dict[str, Any]:
    if detail == "full":
        return value
    return {
        "ok": value.get("ok"),
        "count": value.get("count"),
        "summaryStats": value.get("summaryStats"),
        "systemRoots": value.get("systemRoots"),
        "userRoots": value.get("userRoots"),
        "userEnvironmentPolicy": value.get("userEnvironmentPolicy"),
        "recommendedByModel": value.get("recommendedByModel"),
    }


def summarize_mlip(value: dict[str, Any], detail: str) -> dict[str, Any]:
    if detail == "full":
        return value
    packages = value.get("packages") if isinstance(value.get("packages"), dict) else {}
    models = value.get("models") if isinstance(value.get("models"), list) else []
    return {
        "ok": value.get("ok"),
        "assetRoots": value.get("assetRoots"),
        "count": value.get("count"),
        "availableModels": [
            {
                "id": model.get("id"),
                "family": model.get("family"),
                "status": model.get("status"),
                "localPath": model.get("localPath"),
                "package": model.get("package"),
                "import": model.get("import"),
            }
            for model in models
            if isinstance(model, dict)
        ],
        "packages": packages,
        "note": value.get("note"),
    }


def summarize_qe_pseudo(value: dict[str, Any], detail: str) -> dict[str, Any]:
    if detail == "full":
        return value
    return {
        "ok": value.get("ok"),
        "root": value.get("root"),
        "family": value.get("family"),
        "functional": value.get("functional"),
        "version": value.get("version"),
        "families": value.get("families"),
        "elementCount": value.get("elementCount"),
        "error": value.get("error"),
    }


def recommendations(inventory: dict[str, Any]) -> list[str]:
    items: list[str] = []
    toolchain = inventory.get("toolchain")
    if isinstance(toolchain, dict):
        toolchain_recs = toolchain.get("recommendations")
        if isinstance(toolchain_recs, list):
            items.extend(str(item) for item in toolchain_recs if isinstance(item, str))
    conda = inventory.get("conda")
    if isinstance(conda, dict) and conda.get("count") == 0:
        items.append("No Conda environments were found; verify /opt/matos-tools and /workspace/caches mounts.")
    mlip = inventory.get("mlip")
    if isinstance(mlip, dict) and mlip.get("count") == 0:
        items.append("No mounted MLIP model assets were found; use mlip_model_catalog before relying on local models.")
    if not items:
        items.append("Materials runtime inventory completed; choose the specific catalog/preflight tool for the next action.")
    return sorted(set(items))


def main() -> int:
    payload = read_input()
    detail = detail_value(payload.get("detail"))
    timeout = float_value(payload.get("timeoutSeconds"), 20.0, 1.0, 60.0)
    inventory: dict[str, Any] = {}
    delegated: dict[str, str] = {}

    if bool_value(payload.get("includeToolchain"), True):
        value = run_tool("local-toolchain-preflight", {"detail": "summary"}, timeout)
        inventory["toolchain"] = summarize_toolchain(value, detail)
        delegated["toolchain"] = "mcp__matos_asset__local_toolchain_preflight"
    if bool_value(payload.get("includeConda"), True):
        value = run_tool(
            "conda-environment-catalog",
            {
                "probePackages": False,
                "includeSourceRouting": True,
                "includeGpu": False,
            },
            timeout,
        )
        inventory["conda"] = summarize_conda(value, detail)
        delegated["conda"] = "mcp__matos_asset__conda_environment_catalog"
    if bool_value(payload.get("includeMlip"), True):
        value = run_tool(
            "mlip-model-catalog",
            {"availableOnly": False, "includePackages": True},
            timeout,
        )
        inventory["mlip"] = summarize_mlip(value, detail)
        delegated["mlip"] = "mcp__matos_asset__mlip_model_catalog"
    if bool_value(payload.get("includeQePseudo"), True):
        value = run_tool(
            "qe-pseudopotential-catalog",
            {"elements": [], "includeAllElements": False, "validateFiles": False},
            timeout,
        )
        inventory["qePseudopotentials"] = summarize_qe_pseudo(value, detail)
        delegated["qePseudopotentials"] = "mcp__matos_asset__qe_pseudopotential_catalog"
    print_json(
        {
            "ok": True,
            "detail": detail,
            "inventory": inventory,
            "delegatedTools": delegated,
            "recommendations": recommendations(inventory),
        }
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print_json({"ok": False, "error": "interrupted"})
        raise SystemExit(130)
