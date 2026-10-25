#!/usr/bin/env python3
"""MatOS harness for the public SciAgentGym chemistry/materials subset.

This script prepares benchmark work directories without exposing hidden answers
to the agent-visible case files. It intentionally treats the official public
SciAgentGym repository as an external benchmark source instead of importing the
tasks into the MatOS asset registry.
"""

from __future__ import annotations

import argparse
import json
import os
import py_compile
import re
import shutil
import signal
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_SOURCE_ROOT = Path(os.environ.get("SCIAGENTGYM_SOURCE", Path(__file__).resolve().parents[1] / "benchmarks/external/sciagentgym"))
SUBSET_ID = "matos-chem-materials"
RUN_DIR_ID = "sciagentgym-chem-materials"
SUBSET_SUBJECTS = ("Chemistry", "Materials Science", "Materials")
PUBLIC_TASK_FILES = (
    ("single", "refine_merged_single_questions.json"),
    ("multi", "refine_merged_multi_questions.json"),
)
PRIVATE_KEYS = {
    "answer",
    "golden_answer",
    "tool_expected",
    "solution_steps",
    "refined_versions",
    "augmented_versions",
}


def benchmark_run_env() -> dict[str, str]:
    env = os.environ.copy()
    env["MATOS_BENCHMARK_MODE"] = "1"
    env["MATOS_DISABLE_ALWAYS_ON_LEARNING"] = "1"
    env["MATOS_DISABLE_SELF_EVOLUTION"] = "1"
    return env


PAPER_REPORTED_FULL = {
    "tasks": 259,
    "subQuestions": 1134,
    "chemistry_tasks": 81,
    "materials_science_tasks": 37,
}
OFFICIAL_TOOLKIT_RUNNER = r'''#!/usr/bin/env python3
"""Run public SciAgentGym toolkit functions from a prepared benchmark case."""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import sys
from pathlib import Path
from typing import Any


DEFAULT_REPO_ROOT = Path(__file__).resolve().parent / "sciagentgym-public"


def to_jsonable(value: Any) -> Any:
    try:
        import numpy as np

        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, np.ndarray):
            return value.tolist()
    except Exception:
        pass
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [to_jsonable(item) for item in value]
    try:
        json.dumps(value)
        return value
    except TypeError:
        return repr(value)


def resolve_tool_file(tool_file: str, repo_root: Path) -> Path:
    raw = Path(tool_file)
    candidates = []
    if raw.is_absolute():
        candidates.append(raw)
    else:
        candidates.extend([Path.cwd() / raw, repo_root / raw])
        if str(raw).startswith("toolkits/"):
            candidates.append(repo_root / raw)
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise FileNotFoundError(f"tool file not found: {tool_file}")


def load_module(tool_file: Path, repo_root: Path):
    for path in (repo_root, repo_root.parent, tool_file.parent):
        path_text = str(path)
        if path_text not in sys.path:
            sys.path.insert(0, path_text)
    spec = importlib.util.spec_from_file_location(tool_file.stem, tool_file)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load module spec for {tool_file}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def collect_functions(module) -> dict[str, Any]:
    functions: dict[str, Any] = {}
    for name in dir(module):
        if name.startswith("_"):
            continue
        obj = getattr(module, name)
        if inspect.isfunction(obj) and getattr(obj, "__module__", None) == module.__name__:
            functions[name] = obj
        elif inspect.isclass(obj) and getattr(obj, "__module__", None) == module.__name__:
            try:
                sig = inspect.signature(obj)
                required = [
                    p
                    for p in sig.parameters.values()
                    if p.default is inspect._empty
                    and p.kind in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
                    and p.name != "self"
                ]
                if required:
                    continue
                instance = obj()
                for method_name in dir(instance):
                    if method_name.startswith("_"):
                        continue
                    method = getattr(instance, method_name)
                    if inspect.ismethod(method):
                        functions[f"{name}.{method_name}"] = method
                        functions.setdefault(method_name, method)
            except Exception:
                continue
    return functions


def function_signature(fn: Any) -> str:
    try:
        return str(inspect.signature(fn))
    except Exception:
        return "(...)"


def command_list(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    tool_file = resolve_tool_file(args.tool_file, repo_root)
    module = load_module(tool_file, repo_root)
    functions = collect_functions(module)
    payload = {
        "ok": True,
        "toolFile": str(tool_file),
        "repoRoot": str(repo_root),
        "functions": sorted(functions),
        "signatures": {name: function_signature(fn) for name, fn in sorted(functions.items())},
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2 if args.json else None))
    return 0


def command_call(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    tool_file = resolve_tool_file(args.tool_file, repo_root)
    module = load_module(tool_file, repo_root)
    functions = collect_functions(module)
    if args.function not in functions:
        raise SystemExit(f"function not found: {args.function}; available={sorted(functions)}")
    call_args = json.loads(args.args_json or "{}")
    fn = functions[args.function]
    if isinstance(call_args, list):
        result = fn(*call_args)
    elif isinstance(call_args, dict):
        result = fn(**call_args)
    else:
        raise SystemExit("--args-json must decode to an object or array")
    payload = {
        "ok": True,
        "toolFile": str(tool_file),
        "function": args.function,
        "result": to_jsonable(result),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2 if args.json else None))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=str(DEFAULT_REPO_ROOT), help="Prepared SciAgentGym public repo root")
    parser.add_argument("--json", action="store_true", help="Pretty-print JSON")
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List callable functions in a toolkit file")
    p_list.add_argument("--tool-file", required=True)
    p_list.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    p_list.set_defaults(func=command_list)

    p_call = sub.add_parser("call", help="Call a function in a toolkit file")
    p_call.add_argument("--tool-file", required=True)
    p_call.add_argument("--function", required=True)
    p_call.add_argument("--args-json", default="{}")
    p_call.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    p_call.set_defaults(func=command_call)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
'''


@dataclass(frozen=True)
class BenchCase:
    case_id: str
    dataset_kind: str
    dataset_file: str
    index: int
    raw: dict[str, Any]

    @property
    def metadata(self) -> dict[str, Any]:
        value = self.raw.get("metadata")
        return value if isinstance(value, dict) else {}

    @property
    def subject(self) -> str:
        return str(self.metadata.get("subject") or "")

    @property
    def topic(self) -> str:
        return str(self.metadata.get("topic") or "")

    @property
    def question(self) -> str:
        return str(self.raw.get("question") or "")

    @property
    def tools(self) -> list[dict[str, Any]]:
        value = self.raw.get("usage_tool_protocol")
        return value if isinstance(value, list) else []


def eprint(*parts: Any) -> None:
    print(*parts, file=sys.stderr)


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def copytree_ignore(_directory: str, names: list[str]) -> set[str]:
    ignored = {"__pycache__", ".pytest_cache", ".DS_Store"}
    return {name for name in names if name in ignored or name.endswith((".pyc", ".pyo"))}


def materialize_official_toolkit(run_root: Path, repo: Path) -> dict[str, str]:
    """Copy the public SciAgentGym toolkit into the prepared run directory."""
    toolkit_root = run_root / "toolkit"
    public_root = toolkit_root / "sciagentgym-public"
    source_toolkits = repo / "toolkits"
    target_toolkits = public_root / "toolkits"
    if not source_toolkits.is_dir():
        raise SystemExit(f"SciAgentGym toolkits directory not found: {source_toolkits}")
    toolkit_root.mkdir(parents=True, exist_ok=True)
    if target_toolkits.exists():
        shutil.rmtree(target_toolkits)
    shutil.copytree(source_toolkits, target_toolkits, ignore=copytree_ignore)
    runner_path = toolkit_root / "run_official_tool.py"
    runner_path.write_text(OFFICIAL_TOOLKIT_RUNNER, encoding="utf-8")
    try:
        os.chmod(runner_path, 0o755)
    except OSError:
        pass
    return {
        "runner": str(runner_path),
        "runnerRunRelativePath": str(runner_path.relative_to(run_root)),
        "publicRoot": str(public_root),
        "toolkitRoot": str(target_toolkits),
        "sourceToolkitRoot": str(source_toolkits),
    }


def materialize_case_official_toolkit(
    case: BenchCase,
    repo: Path,
    case_dir: Path,
    tool_index: dict[str, list[Path]],
) -> dict[str, Path]:
    local_root = case_dir / "input" / "official_toolkit"
    source_toolkit_root = repo / "toolkits"
    copied_directories: set[Path] = set()
    localized: dict[str, Path] = {}
    for entry in case.tools:
        if not isinstance(entry, dict):
            continue
        source = resolve_tool_file(
            repo,
            extract_function_path(entry),
            case.subject,
            case.topic,
            tool_index,
        )
        if not source:
            continue
        try:
            relative = source.relative_to(source_toolkit_root)
            source_parent = source.parent
            target_parent = local_root / relative.parent
            if source_parent not in copied_directories:
                shutil.copytree(
                    source_parent,
                    target_parent,
                    dirs_exist_ok=True,
                    ignore=copytree_ignore,
                )
                copied_directories.add(source_parent)
            target = target_parent / source.name
        except ValueError:
            target = local_root / "standalone" / source.name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        localized[str(source)] = target

    runner = case_dir / "input" / "run_official_tool.py"
    runner.parent.mkdir(parents=True, exist_ok=True)
    runner.write_text(OFFICIAL_TOOLKIT_RUNNER, encoding="utf-8")
    try:
        os.chmod(runner, 0o755)
    except OSError:
        pass
    return localized


def slugify(value: Any, *, max_len: int = 80) -> str:
    text = str(value or "case").strip().lower()
    text = re.sub(r"\.[a-z0-9]+$", "", text)
    text = re.sub(r"[^a-z0-9]+", "-", text)
    text = text.strip("-")
    return (text or "case")[:max_len].strip("-") or "case"


def source_repo(source_root: Path) -> Path:
    repo = source_root / "repo"
    if not repo.is_dir():
        raise SystemExit(f"SciAgentGym repo not found: {repo}")
    return repo


def public_dataset_root(source_root: Path) -> Path:
    root = source_repo(source_root) / "dataset"
    if not root.is_dir():
        raise SystemExit(f"SciAgentGym dataset directory not found: {root}")
    return root


def build_case_id(kind: str, item: dict[str, Any], index: int) -> str:
    raw_id = item.get("id")
    if raw_id is None:
        raw_id = index + 1
    filename = item.get("filename") or f"case-{index + 1}"
    try:
        id_part = f"{int(raw_id):03d}"
    except Exception:
        id_part = slugify(raw_id, max_len=24)
    return f"{kind}-{id_part}-{slugify(filename, max_len=72)}"


def load_public_cases(source_root: Path) -> list[BenchCase]:
    cases: list[BenchCase] = []
    dataset_root = public_dataset_root(source_root)
    for kind, filename in PUBLIC_TASK_FILES:
        data = read_json(dataset_root / filename)
        if not isinstance(data, list):
            raise SystemExit(f"Expected list in {dataset_root / filename}")
        for index, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            metadata = item.get("metadata")
            if not isinstance(metadata, dict):
                continue
            if metadata.get("subject") not in SUBSET_SUBJECTS:
                continue
            cases.append(
                BenchCase(
                    case_id=build_case_id(kind, item, index),
                    dataset_kind=kind,
                    dataset_file=filename,
                    index=index,
                    raw=item,
                )
            )
    cases.sort(key=lambda case: (case.dataset_kind, case.index, case.case_id))
    return cases


def official_public_counts(source_root: Path) -> dict[str, Any]:
    dataset_root = public_dataset_root(source_root)
    counts: dict[str, int] = {}
    for kind, filename in PUBLIC_TASK_FILES:
        data = read_json(dataset_root / filename)
        counts[kind] = len(data) if isinstance(data, list) else 0
    return {
        "single": counts.get("single", 0),
        "multi": counts.get("multi", 0),
        "total": sum(counts.values()),
        "files": [filename for _, filename in PUBLIC_TASK_FILES],
    }


def question_preview(text: str, limit: int = 220) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 1].rstrip() + "..."


def case_summary(case: BenchCase) -> dict[str, Any]:
    image_path = case.metadata.get("image_path")
    images = image_path if isinstance(image_path, list) else ([] if not image_path else [image_path])
    return {
        "caseId": case.case_id,
        "datasetKind": case.dataset_kind,
        "datasetFile": case.dataset_file,
        "sourceIndex": case.index,
        "sourceId": case.raw.get("id"),
        "filename": case.raw.get("filename"),
        "subject": case.subject,
        "topic": case.topic,
        "imageCount": len(images),
        "toolCount": len(case.tools),
        "questionPreview": question_preview(case.question),
    }


def command_list(args: argparse.Namespace) -> int:
    source_root = Path(args.source_root).resolve()
    cases = load_public_cases(source_root)
    subject_counts = Counter(case.subject for case in cases)
    topic_counts = Counter(case.topic for case in cases)
    payload = {
        "subset": SUBSET_ID,
        "description": (
            "Public SciAgentGym chemistry/materials subset available from the "
            "official repository. This is a local diagnostic subset, not the "
            "full paper leaderboard."
        ),
        "sourceRoot": str(source_root),
        "repo": str(source_repo(source_root)),
        "total": len(cases),
        "subjectCounts": dict(subject_counts),
        "topicCounts": dict(topic_counts),
        "source": {
            "officialPublicTasks": official_public_counts(source_root),
            "paperReportedFullBenchmark": PAPER_REPORTED_FULL,
        },
        "items": [case_summary(case) for case in cases],
    }
    output_payload(payload, args.json)
    return 0


def strip_private_fields(obj: Any) -> Any:
    if isinstance(obj, dict):
        cleaned: dict[str, Any] = {}
        for key, value in obj.items():
            if key in PRIVATE_KEYS:
                continue
            cleaned[key] = strip_private_fields(value)
        return cleaned
    if isinstance(obj, list):
        return [strip_private_fields(item) for item in obj]
    return obj


def private_payload(case: BenchCase) -> dict[str, Any]:
    metadata = case.metadata
    return {
        "caseId": case.case_id,
        "datasetKind": case.dataset_kind,
        "datasetFile": case.dataset_file,
        "sourceIndex": case.index,
        "sourceId": case.raw.get("id"),
        "filename": case.raw.get("filename"),
        "subject": case.subject,
        "topic": case.topic,
        "question": case.question,
        "answer": case.raw.get("answer"),
        "metadataPrivate": {
            key: metadata.get(key)
            for key in ("golden_answer", "tool_expected", "solution_steps")
            if key in metadata
        },
        "refined_versions": case.raw.get("refined_versions"),
        "augmented_versions": case.raw.get("augmented_versions"),
    }


def public_case_payload(case: BenchCase, copied_images: list[dict[str, str]]) -> dict[str, Any]:
    raw_public = strip_private_fields(case.raw)
    metadata = raw_public.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
        raw_public["metadata"] = metadata
    metadata["benchmark_case_id"] = case.case_id
    metadata["benchmark_dataset_kind"] = case.dataset_kind
    metadata["benchmark_dataset_file"] = case.dataset_file
    metadata["image_path"] = [item["caseRelativePath"] for item in copied_images]
    raw_public["usage_tool_protocol"] = []
    return raw_public


def extract_function_path(tool_entry: dict[str, Any]) -> str | None:
    additional = tool_entry.get("additionalProperties")
    if isinstance(additional, dict):
        value = additional.get("function_path")
        if isinstance(value, str) and value.strip():
            return value.strip()
    function_block = tool_entry.get("function")
    if isinstance(function_block, dict):
        value = function_block.get("function_path")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def tool_name(tool_entry: dict[str, Any]) -> str | None:
    function_block = tool_entry.get("function")
    if isinstance(function_block, dict):
        value = function_block.get("name")
        if isinstance(value, str) and value.strip():
            return value.strip()
    value = tool_entry.get("name")
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def build_tool_index(repo: Path) -> dict[str, list[Path]]:
    roots = [repo / "toolkits", repo / "src", repo / "tools"]
    index: dict[str, list[Path]] = {}
    for root in roots:
        if not root.exists():
            continue
        for path in root.rglob("*.py"):
            index.setdefault(path.name, []).append(path)
    for values in index.values():
        values.sort(key=lambda p: str(p))
    return index


def normalize_path_part(value: str) -> set[str]:
    raw = value.lower().strip()
    variants = {
        raw,
        raw.replace(" ", "_"),
        raw.replace(" ", "-"),
        raw.replace("_", " "),
        raw.replace("_", "-"),
        raw.replace("-", "_"),
        raw.replace("-", " "),
    }
    if re.search(r"\bx[\s_-]ray\b", raw):
        xray = re.sub(r"\bx[\s_]ray\b", "x-ray", raw)
        variants.update({xray, xray.replace(" ", "_"), xray.replace(" ", "-"), xray.replace("-", "_")})
    return {item for item in variants if item}


def resolve_tool_file(
    repo: Path,
    function_path: str | None,
    subject: str,
    topic: str,
    tool_index: dict[str, list[Path]],
) -> Path | None:
    if not function_path:
        return None
    clean = function_path.strip()
    if clean.startswith("./"):
        clean = clean[2:]
    filename = clean.split("tools/")[-1] if "tools/" in clean else Path(clean).name
    subject_base = subject.lower().strip().replace(" ", "_")
    subject_variants = normalize_path_part(subject)
    if subject_base in {"materials", "material"}:
        subject_variants.add("materials_science")
    topic_variants = normalize_path_part(topic)
    candidates: list[Path] = []
    if subject and topic:
        for subject_part in sorted(subject_variants):
            for topic_part in sorted(topic_variants):
                candidates.append(repo / "toolkits" / subject_part / topic_part / filename)
    candidates.extend(
        [
            repo / clean,
            repo / "toolkits" / filename,
            repo / "src" / "tools" / filename,
            repo / "tools" / filename,
        ]
    )
    if "tools/" in clean:
        for discipline in ("physics", "chemistry", "materials_science", "astronomy", "statistics", "life_science"):
            candidates.append(repo / "toolkits" / discipline / filename)
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate)
        if key in seen:
            continue
        seen.add(key)
        if candidate.is_file():
            return candidate
    indexed = tool_index.get(filename, [])
    if indexed:
        return indexed[0]
    return None


def tool_manifest(
    case: BenchCase,
    repo: Path,
    case_dir: Path,
    localized_tools: dict[str, Path],
    tool_index: dict[str, list[Path]],
) -> dict[str, Any]:
    tools: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    resolved_paths: set[str] = set()
    for entry in case.tools:
        if not isinstance(entry, dict):
            continue
        fpath = extract_function_path(entry)
        resolved = resolve_tool_file(repo, fpath, case.subject, case.topic, tool_index)
        function_block = entry.get("function")
        schema = function_block if isinstance(function_block, dict) else {}
        local_resolved = localized_tools.get(str(resolved)) if resolved else None
        local_resolved = local_resolved if local_resolved and local_resolved.is_file() else None
        item = {
            "name": tool_name(entry),
            "description": schema.get("description"),
            "parameters": schema.get("parameters"),
            "originalFunctionPath": fpath,
            "resolvedPath": str(local_resolved.relative_to(case_dir)) if local_resolved else None,
            "resolvedPathRelativeToCase": str(local_resolved.relative_to(case_dir)) if local_resolved else None,
        }
        if local_resolved:
            resolved_paths.add(str(local_resolved.relative_to(case_dir)))
        else:
            missing.append(item)
        tools.append(item)
    return {
        "caseId": case.case_id,
        "subject": case.subject,
        "topic": case.topic,
        "toolCount": len(tools),
        "resolvedToolFiles": sorted(resolved_paths),
        "missingToolReferences": missing,
        "tools": tools,
    }


def official_toolkit_manifest(
    case: BenchCase,
    repo: Path,
    case_dir: Path,
    localized_tools: dict[str, Path],
    tool_index: dict[str, list[Path]],
) -> dict[str, Any]:
    tools: list[dict[str, Any]] = []
    for entry in case.tools:
        if not isinstance(entry, dict):
            continue
        fpath = extract_function_path(entry)
        source_resolved = resolve_tool_file(repo, fpath, case.subject, case.topic, tool_index)
        function_block = entry.get("function")
        schema = function_block if isinstance(function_block, dict) else {}
        local_resolved = localized_tools.get(str(source_resolved)) if source_resolved else None
        tool_item = {
            "name": tool_name(entry),
            "description": schema.get("description"),
            "parameters": schema.get("parameters"),
            "originalFunctionPath": fpath,
            "resolvedPath": str(local_resolved.relative_to(case_dir))
            if local_resolved and local_resolved.is_file()
            else None,
            "resolvedPathRelativeToCase": str(local_resolved.relative_to(case_dir))
            if local_resolved and local_resolved.is_file()
            else None,
            "callExample": (
                "python input/run_official_tool.py call "
                f"--tool-file {json.dumps(str(local_resolved.relative_to(case_dir)))} "
                f"--function {json.dumps(tool_name(entry) or '')} "
                "--args-json '{}' --json"
            )
            if local_resolved and local_resolved.is_file() and tool_name(entry)
            else None,
        }
        tools.append(tool_item)
    return {
        "enabled": True,
        "provenance": "SciAgentGym official public repository toolkit materialized for optional agent use",
        "repoRoot": "input/official_toolkit",
        "toolkitRoot": "input/official_toolkit",
        "runnerCaseRelativePath": "input/run_official_tool.py",
        "usage": {
            "list": "python input/run_official_tool.py list --tool-file <resolvedPath> --json",
            "call": "python input/run_official_tool.py call --tool-file <resolvedPath> --function <name> --args-json '<json object>' --json",
            "note": "The official toolkit is optional public support. Agents may also use the native tools provided by their runner.",
        },
        "tools": tools,
    }


def resolve_image_source(repo: Path, image_ref: Any) -> Path | None:
    if not isinstance(image_ref, str) or not image_ref.strip():
        return None
    raw = image_ref.strip()
    path = Path(raw)
    if path.is_absolute() and path.is_file():
        return path
    candidates = [repo / raw, repo / "gym" / "test_images" / Path(raw).name, repo / "gym" / "images" / Path(raw).name]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def copy_case_images(case: BenchCase, repo: Path, case_dir: Path) -> list[dict[str, str]]:
    image_value = case.metadata.get("image_path")
    image_refs = image_value if isinstance(image_value, list) else ([] if not image_value else [image_value])
    copied: list[dict[str, str]] = []
    image_dir = case_dir / "input" / "images"
    for idx, image_ref in enumerate(image_refs, start=1):
        source = resolve_image_source(repo, image_ref)
        if not source:
            copied.append({"source": str(image_ref), "caseRelativePath": "", "status": "missing"})
            continue
        target = image_dir / source.name
        if target.exists():
            target = image_dir / f"{idx:02d}-{source.name}"
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
        copied.append(
            {
                "source": str(image_ref),
                "sourceResolved": str(source),
                "caseRelativePath": str(target.relative_to(case_dir)),
                "status": "copied",
            }
        )
    return copied


def task_markdown(case: BenchCase, copied_images: list[dict[str, str]]) -> str:
    images = [item for item in copied_images if item.get("status") == "copied"]
    image_lines = "\n".join(f"- `{item['caseRelativePath']}`" for item in images) or "- None"
    return f"""# SciAgentGym Public Case

Case ID: `{case.case_id}`
Source: SciAgentGym public `{case.dataset_file}` (`{case.dataset_kind}` case index {case.index})
Subject: `{case.subject}`
Topic: `{case.topic}`

## Rules

- Work only inside this case directory.
- Do not inspect parent directories, `.private`, answer keys, hidden references, scorer files, or prior outputs.
- Never run filesystem-wide searches such as `find /`; if a resource is not in this case directory, treat it as unavailable.
- Use `input/case.json`, `input/tools.json`, `input/official_toolkit.json`, and the image files listed below as the participant-visible input.
- `input/official_toolkit.json` exposes optional public SciAgentGym toolkit files. You may call them with `input/run_official_tool.py`, or use the native tools provided by your runner.
- Put the final answer in `submission/final_answer.txt`.
- If you use tools, local scripts, or calculations, summarize the method in `submission/report.md`.
- Return a concise final answer. If possible, wrap the final answer in LaTeX `\\boxed{{...}}`.

## Images

{image_lines}

## Question

{case.question}
"""


def selected_cases(source_root: Path, limit: int | None, case_ids: list[str] | None = None) -> list[BenchCase]:
    cases = load_public_cases(source_root)
    if case_ids:
        wanted = set(case_ids)
        cases = [case for case in cases if case.case_id in wanted]
        missing = sorted(wanted - {case.case_id for case in cases})
        if missing:
            raise SystemExit(f"Unknown case id(s): {', '.join(missing)}")
    if limit is not None:
        cases = cases[:limit]
    return cases


def command_prepare(args: argparse.Namespace) -> int:
    source_root = Path(args.source_root).resolve()
    repo = source_repo(source_root)
    cases = selected_cases(source_root, args.limit, args.case_id)
    run_root = Path(args.work_root).resolve() / RUN_DIR_ID / "runs" / args.run_id
    if run_root.exists() and not args.force:
        raise SystemExit(f"Run root already exists; use --force to replace: {run_root}")
    if run_root.exists():
        shutil.rmtree(run_root)
    (run_root / "cases").mkdir(parents=True, exist_ok=True)
    (run_root / ".private").mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(run_root / ".private", 0o700)
    except OSError:
        pass

    tool_index = build_tool_index(repo)
    toolkit_info = materialize_official_toolkit(run_root, repo)
    manifest_cases: list[dict[str, Any]] = []
    for case in cases:
        case_dir = run_root / "cases" / case.case_id
        case_dir.mkdir(parents=True, exist_ok=True)
        (case_dir / "submission").mkdir(parents=True, exist_ok=True)
        (case_dir / "logs").mkdir(parents=True, exist_ok=True)
        copied_images = copy_case_images(case, repo, case_dir)
        localized_tools = materialize_case_official_toolkit(case, repo, case_dir, tool_index)
        write_json(case_dir / "input" / "case.json", public_case_payload(case, copied_images))
        write_json(
            case_dir / "input" / "tools.json",
            tool_manifest(case, repo, case_dir, localized_tools, tool_index),
        )
        write_json(
            case_dir / "input" / "official_toolkit.json",
            official_toolkit_manifest(case, repo, case_dir, localized_tools, tool_index),
        )
        (case_dir / "TASK.md").write_text(task_markdown(case, copied_images), encoding="utf-8")

        private_dir = run_root / ".private" / case.case_id
        write_json(private_dir / "case-private.json", private_payload(case))
        try:
            os.chmod(private_dir, 0o700)
            os.chmod(private_dir / "case-private.json", 0o600)
        except OSError:
            pass
        manifest_cases.append(
            {
                "caseId": case.case_id,
                "caseDirectory": str(case_dir.relative_to(run_root)),
                "datasetKind": case.dataset_kind,
                "datasetFile": case.dataset_file,
                "sourceIndex": case.index,
                "sourceId": case.raw.get("id"),
                "filename": case.raw.get("filename"),
                "subject": case.subject,
                "topic": case.topic,
                "toolCount": len(case.tools),
                "imageCount": len([item for item in copied_images if item.get("status") == "copied"]),
            }
        )

    manifest = {
        "subset": SUBSET_ID,
        "runId": args.run_id,
        "sourceRoot": str(source_root),
        "repo": str(repo),
        "createdBy": "scripts/matos-sciagentgym-bench.py prepare",
        "answerVisibility": "private answer files are stored under .private and must not be shown to agents",
        "officialToolkit": {
            "enabled": True,
            "runner": toolkit_info["runnerRunRelativePath"],
            "repoRoot": toolkit_info["publicRoot"],
            "toolkitRoot": toolkit_info["toolkitRoot"],
            "sourceToolkitRoot": toolkit_info["sourceToolkitRoot"],
            "policy": "optional public support; native agent tools remain allowed",
        },
        "cases": manifest_cases,
    }
    write_json(run_root / "run-manifest.json", manifest)
    write_json(run_root / ".private" / "answer-key.json", [private_payload(case) for case in cases])
    try:
        os.chmod(run_root / ".private" / "answer-key.json", 0o600)
    except OSError:
        pass
    payload = {
        "subset": SUBSET_ID,
        "runId": args.run_id,
        "runRoot": str(run_root),
        "prepared": len(cases),
        "cases": manifest_cases,
    }
    output_payload(payload, args.json)
    return 0


def command_tool_smoke(args: argparse.Namespace) -> int:
    source_root = Path(args.source_root).resolve()
    repo = source_repo(source_root)
    cases = selected_cases(source_root, args.limit, args.case_id)
    tool_index = build_tool_index(repo)
    missing: list[dict[str, Any]] = []
    parse_failures: list[dict[str, str]] = []
    resolved_files: set[Path] = set()
    tool_refs = 0
    for case in cases:
        for entry in case.tools:
            if not isinstance(entry, dict):
                continue
            tool_refs += 1
            fpath = extract_function_path(entry)
            resolved = resolve_tool_file(repo, fpath, case.subject, case.topic, tool_index)
            if not resolved:
                missing.append(
                    {
                        "caseId": case.case_id,
                        "tool": tool_name(entry),
                        "functionPath": fpath,
                        "subject": case.subject,
                        "topic": case.topic,
                    }
                )
                continue
            resolved_files.add(resolved)
    if args.compile:
        for path in sorted(resolved_files, key=lambda p: str(p)):
            try:
                py_compile.compile(str(path), doraise=True)
            except py_compile.PyCompileError as exc:
                parse_failures.append({"path": str(path), "error": str(exc)})
    payload = {
        "subset": SUBSET_ID,
        "sourceRoot": str(source_root),
        "totalCases": len(cases),
        "toolReferences": tool_refs,
        "resolvedToolFiles": len(resolved_files),
        "missingToolReferences": len(missing),
        "missing": missing,
        "parseFailures": parse_failures,
        "compiled": bool(args.compile),
    }
    output_payload(payload, args.json)
    return 1 if missing or parse_failures else 0


def normalize_answer(value: Any) -> str:
    text = canonical_protocol_text("" if value is None else str(value))
    text = re.sub(r"\s+", " ", text).strip()
    return text.lower()


def extract_numeric_values(text: str) -> list[float]:
    text = "" if text is None else str(text)
    if "\\boxed" in text:
        boxed = extract_boxed(text)
        if boxed:
            text = boxed
    text = text.strip().lower()
    text = text.replace("$", "")
    text = text.replace("\\%", "%")
    text = text.replace("\\times", " x ")
    text = text.replace("×", " x ")
    text = unwrap_latex_text_commands(text)
    text = replace_numeric_fractions(text)
    text = re.sub(r"\^\{([^{}]+)\}", r"^\1", text)
    text = re.sub(r"(?<=\d)(?=[a-df-z])", " ", text)
    text = text.replace(",", "")
    text = re.sub(
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(?:\\times|×|x|\*)\s*10\s*\^\s*\{?\s*([+-]?\d+)\s*\}?",
        r"\1e\2",
        text,
    )
    text = re.sub(r"(?<=\d)(?=[a-df-z])", " ", text)
    values: list[float] = []
    for match in re.finditer(r"(?<![a-z0-9_.])([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?![a-z0-9_.])", text):
        try:
            values.append(float(match.group(1)))
        except ValueError:
            continue
    return values


def numeric_answers_match(answer: str, expected: str) -> bool:
    answer_values = extract_numeric_values(answer)
    expected_values = extract_numeric_values(expected)
    if not answer_values or not expected_values:
        return False
    if len(expected_values) == 1:
        expected_value = expected_values[0]
        tolerance = max(0.01, abs(expected_value) * 1e-3)
        return any(abs(answer_value - expected_value) <= tolerance for answer_value in answer_values)
    if len(answer_values) < len(expected_values):
        return False
    for answer_value, expected_value in zip(answer_values[: len(expected_values)], expected_values):
        tolerance = max(0.01, abs(expected_value) * 1e-3)
        if abs(answer_value - expected_value) > tolerance:
            return False
    return True


def extract_boxed(text: str) -> str | None:
    matches = list(re.finditer(r"\\boxed\s*\{", text))
    if not matches:
        return None
    match = matches[-1]
    start = match.end()
    depth = 1
    chars: list[str] = []
    for ch in text[start:]:
        if ch == "{":
            depth += 1
            chars.append(ch)
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return "".join(chars).strip()
            chars.append(ch)
        else:
            chars.append(ch)
    return None


def extract_boxed_expression(text: str) -> str | None:
    matches = list(re.finditer(r"\\boxed\s*\{", text))
    if not matches:
        return None
    match = matches[-1]
    start = match.start()
    cursor = match.end()
    depth = 1
    for offset, ch in enumerate(text[cursor:], start=cursor):
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : offset + 1].strip()
    return None


def extract_submission_answer(text: str) -> str:
    boxed = extract_boxed(text)
    if boxed:
        return boxed
    patterns = [
        r"(?is)final\s+answer\s*[:：]\s*(.+)$",
        r"(?is)answer\s*[:：]\s*(.+)$",
        r"(?is)###\s*answer\s*###\s*(.+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return match.group(1).strip()
    return text.strip()


def unwrap_latex_text_commands(text: str) -> str:
    commands = ("text", "mathrm", "operatorname", "mathit", "textrm", "mathbf")
    previous = None
    while previous != text:
        previous = text
        for command in commands:
            text = re.sub(rf"\\{command}\{{([^{{}}]*)\}}", r"\1", text)
    return text


def replace_numeric_fractions(text: str) -> str:
    def repl(match: re.Match[str]) -> str:
        numerator = float(match.group(1))
        denominator = float(match.group(2))
        if denominator == 0:
            return match.group(0)
        value = numerator / denominator
        return f"{value:.6f}".rstrip("0").rstrip(".")

    return re.sub(
        r"\\frac\s*\{\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\}\s*\{\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\}",
        repl,
        text,
    )


def strip_parenthetical_approximation(text: str) -> str:
    return re.sub(r"\(\s*(?:≈|~|approx\b|approximately\b)\s*[^()]*\)", "", text, flags=re.IGNORECASE)


def compact_numbered_parts(text: str) -> str:
    matches = [
        (int(index), value.strip(" .,:;"))
        for index, value in re.findall(r"\((\d+)\)\s*(.*?)(?=(?:\(\d+\))|$)", text, flags=re.DOTALL)
    ]
    if len(matches) < 2:
        return text
    if any(not value or len(value) > 80 for _, value in matches):
        return text
    return " ".join(f"{index}.{value}" for index, value in matches)


def compact_assignment_series(text: str) -> str:
    parts = [part.strip() for part in re.split(r"\s*[;,]\s*", text) if part.strip()]
    if len(parts) < 2:
        return text
    values: list[str] = []
    for part in parts:
        match = re.match(r"^[A-Za-z0-9_().\- ]+[:=]\s*(.+?)$", part)
        if not match:
            return text
        value = match.group(1).strip()
        value = re.sub(r"\s+[A-Z]$", "", value)
        values.append(value)
    if not values:
        return text
    return ", ".join(values)


def simplify_latex_text(text: str) -> str:
    text = text.strip()
    if "\\boxed" in text:
        boxed = extract_boxed(text)
        if boxed:
            text = boxed
    text = re.sub(
        r"([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\\times\s*10\s*\^\s*\{?\s*([+-]?\d+)\s*\}?",
        r"\1e\2",
        text,
    )
    text = text.replace("$", "")
    text = text.replace("\\,", " ")
    text = text.replace("\\;", " ")
    text = text.replace("\\:", " ")
    text = text.replace("\\quad", " ")
    text = text.replace("\\qquad", " ")
    text = text.replace("\\(", " ")
    text = text.replace("\\)", " ")
    text = text.replace("\\[", " ")
    text = text.replace("\\]", " ")
    text = text.replace("\\%", "%")
    text = text.replace("\\approx", "approx ")
    text = unwrap_latex_text_commands(text)
    text = replace_numeric_fractions(text)
    text = re.sub(r"_\{([^{}]+)\}", r"\1", text)
    text = re.sub(r"\^\{([^{}]+)\}", r"\1", text)
    text = re.sub(r"\\[A-Za-z]+", " ", text)
    text = text.replace("\\", " ")
    text = text.replace("{", "")
    text = text.replace("}", "")
    return re.sub(r"\s+", " ", text).strip()


def maybe_extract_list_suffix(text: str) -> str:
    if ":" not in text:
        return text
    prefix, suffix = text.split(":", 1)
    prefix_clean = re.sub(r"\s+", " ", prefix.strip().lower())
    label_like = re.fullmatch(
        r"(?:final\s+answer|answer|result|results|selected\s+answer|choice|choices|ranked\s+list|list)",
        prefix_clean,
    )
    if not label_like:
        return text
    if "," in suffix or re.search(r"\band\b", suffix, flags=re.IGNORECASE):
        return suffix.strip()
    return text


def canonical_protocol_text(text: str) -> str:
    text = simplify_latex_text(text)
    text = strip_parenthetical_approximation(text)
    text = maybe_extract_list_suffix(text)
    text = compact_numbered_parts(text)
    text = compact_assignment_series(text)
    text = re.sub(r"\s+", " ", text).strip(" .")
    return text


def split_simple_answer_list(text: str) -> list[str]:
    text = maybe_extract_list_suffix(canonical_protocol_text(text))
    if "=" in text or re.search(r"\b(?:is|are|was|were|corresponds|highest|lowest)\b", text, flags=re.IGNORECASE):
        return []
    normalized = re.sub(r"\band\b", ",", text, flags=re.IGNORECASE)
    if "," not in normalized:
        return []
    items = []
    for item in normalized.split(","):
        clean = item.strip(" .")
        if not clean:
            continue
        if len(clean.split()) > 4:
            return []
        items.append(clean.lower())
    return items if len(items) >= 2 else []


def read_submission(case_dir: Path) -> tuple[Path | None, str | None]:
    candidates = [
        case_dir / "submission" / "final_answer.txt",
        case_dir / "submission" / "answer.txt",
        case_dir / "submission" / "result.txt",
        case_dir / "answer.txt",
    ]
    for path in candidates:
        if path.is_file():
            return path, path.read_text(encoding="utf-8", errors="replace")
    return None, None


def build_protocol_adapter_task(case_dir: Path, task_text: str, raw_submission: str) -> str:
    case_json = case_dir / "input" / "case.json"
    return f"""You are normalizing a completed SciAgentGym benchmark answer into the benchmark's final submission protocol.

Strict rules:
- Do not recompute the science.
- Do not browse the web.
- Do not call tools unless the runtime forces you to, and do not inspect any hidden files.
- Use only the public task and the raw answer below.
- Preserve the scientific conclusion exactly.
- Remove explanation, derivation, equations, hedging, prose, and duplicate alternatives.
- Output only the benchmark-ready final answer text, with no preamble.
- If a compact LaTeX boxed answer is natural, return exactly one `\\boxed{{...}}` expression.

Public task source: `{case_json}`

=== PUBLIC TASK ===
{task_text.strip()}

=== RAW SUBMISSION TO NORMALIZE ===
{raw_submission.strip()}
"""


def normalize_adapted_submission(text: str) -> str:
    compact = text.strip()
    if not compact:
        return ""
    answer = extract_submission_answer(compact).strip()
    normalized = canonical_protocol_text(answer)
    return normalized or answer


def deterministic_correct(submission: str, expected: Any) -> bool:
    expected_raw = "" if expected is None else str(expected)
    answer_raw = extract_submission_answer(submission)
    expected_norm = normalize_answer(expected_raw)
    answer_norm = normalize_answer(answer_raw)
    if not expected_norm or not answer_norm:
        return False
    if answer_norm == expected_norm:
        return True
    if len(expected_norm) >= 4 and expected_norm in answer_norm:
        return True
    if len(answer_norm) >= 4 and answer_norm in expected_norm:
        return True
    answer_items = split_simple_answer_list(answer_raw)
    expected_items = split_simple_answer_list(expected_raw)
    if answer_items and expected_items and sorted(answer_items) == sorted(expected_items):
        return True
    if numeric_answers_match(answer_raw, expected_raw):
        return True
    return False


def adapt_one_case(args: argparse.Namespace, case: dict[str, Any], run_root: Path) -> dict[str, Any]:
    case_id = str(case["caseId"])
    case_dir = run_root / "cases" / case_id
    submission_path, submission_text = read_submission(case_dir)
    if submission_path is None or submission_text is None:
        return {
            "caseId": case_id,
            "adapted": False,
            "skipped": True,
            "reason": "missing_submission",
            "submissionPath": None,
        }

    submission_dir = submission_path.parent
    raw_backup = submission_dir / "final_answer.raw.txt"
    if not raw_backup.exists():
        raw_backup.write_text(submission_text, encoding="utf-8")

    task_text = (case_dir / "TASK.md").read_text(encoding="utf-8")
    log_dir = case_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stdout_log = log_dir / "matos.protocol_adapt.stdout.log"
    stderr_log = log_dir / "matos.protocol_adapt.stderr.log"

    if args.adapter_command:
        proc = subprocess.run(
            args.adapter_command,
            cwd=case_dir,
            shell=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=args.timeout,
            check=False,
        )
    else:
        task = build_protocol_adapter_task(case_dir, task_text, submission_text)
        command = [
            str(Path(args.matos_bin).resolve()),
            "run",
            "--role",
            args.role,
            "--execution",
            args.execution,
        ]
        if args.model:
            command.extend(["--model", args.model])
        if args.max_turns:
            command.extend(["--max-turns", str(args.max_turns)])
        command.append(task)
        proc = subprocess.run(
            command,
            cwd=case_dir,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=args.timeout,
            check=False,
        )

    stdout_log.write_text(proc.stdout, encoding="utf-8")
    stderr_log.write_text(proc.stderr, encoding="utf-8")

    normalized = normalize_adapted_submission(proc.stdout)
    if proc.returncode == 0 and normalized:
        submission_path.write_text(normalized + "\n", encoding="utf-8")
        adapted = True
    else:
        adapted = False

    return {
        "caseId": case_id,
        "adapted": adapted,
        "exitCode": proc.returncode,
        "submissionPath": str(submission_path.relative_to(run_root)),
        "rawBackupPath": str(raw_backup.relative_to(run_root)),
        "stdoutLog": str(stdout_log.relative_to(run_root)),
        "stderrLog": str(stderr_log.relative_to(run_root)),
        "normalizedAnswer": normalized[:500],
        "reason": None if adapted else ("adapter_failed" if proc.returncode != 0 else "empty_output"),
    }


def command_adapt(args: argparse.Namespace) -> int:
    run_root = Path(args.run_root).resolve()
    manifest = read_json(run_root / "run-manifest.json")
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise SystemExit(f"Invalid run manifest: {run_root / 'run-manifest.json'}")
    selected = [case for case in cases if isinstance(case, dict)]
    if args.case_id:
        allowed = set(args.case_id)
        selected = [case for case in selected if str(case.get("caseId")) in allowed]
    if args.limit is not None:
        selected = selected[: args.limit]
    if args.jobs < 1:
        raise SystemExit("--jobs must be >= 1")

    if args.jobs == 1:
        results = [adapt_one_case(args, case, run_root) for case in selected]
    else:
        results_by_case: dict[str, dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=args.jobs) as executor:
            futures = {executor.submit(adapt_one_case, args, case, run_root): str(case["caseId"]) for case in selected}
            for future in as_completed(futures):
                case_id = futures[future]
                try:
                    results_by_case[case_id] = future.result()
                except Exception as exc:
                    results_by_case[case_id] = {
                        "caseId": case_id,
                        "adapted": False,
                        "exitCode": 1,
                        "error": repr(exc),
                        "reason": "exception",
                    }
        results = [results_by_case[str(case["caseId"])] for case in selected]

    payload = {
        "subset": manifest.get("subset", SUBSET_ID),
        "runId": manifest.get("runId"),
        "runRoot": str(run_root),
        "role": args.role,
        "execution": args.execution,
        "results": results,
    }
    write_json(run_root / "adapt-results.json", payload)
    output_payload(payload, args.json)
    return 1 if any(not item.get("adapted") and not item.get("skipped") for item in results) else 0


def command_score(args: argparse.Namespace) -> int:
    run_root = Path(args.run_root).resolve()
    manifest = read_json(run_root / "run-manifest.json")
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise SystemExit(f"Invalid run manifest: {run_root / 'run-manifest.json'}")
    details: list[dict[str, Any]] = []
    submitted = 0
    correct = 0
    for case in cases:
        if not isinstance(case, dict) or not case.get("caseId"):
            continue
        case_id = str(case["caseId"])
        case_dir = run_root / "cases" / case_id
        private_path = run_root / ".private" / case_id / "case-private.json"
        private = read_json(private_path)
        submission_path, submission_text = read_submission(case_dir)
        if submission_text is None:
            details.append({"caseId": case_id, "status": "missing_submission", "correct": False})
            continue
        submitted += 1
        is_correct = deterministic_correct(submission_text, private.get("answer"))
        correct += 1 if is_correct else 0
        details.append(
            {
                "caseId": case_id,
                "status": "scored",
                "correct": is_correct,
                "submissionPath": str(submission_path.relative_to(run_root)) if submission_path else None,
                "extractedAnswer": extract_submission_answer(submission_text)[:500],
            }
        )
    total = len(cases)
    payload = {
        "subset": manifest.get("subset", SUBSET_ID),
        "runId": manifest.get("runId"),
        "runRoot": str(run_root),
        "total": total,
        "submitted": submitted,
        "correct": correct,
        "accuracy": (correct / total) if total else 0.0,
        "details": details,
        "scoring": "deterministic public harness check; use official/LLM judge separately for leaderboard-like reporting",
    }
    output_payload(payload, args.json)
    return 0


def run_logged_process(command: list[str], cwd: Path, env: dict[str, str],
                       stdout_path: Path, stderr_path: Path, timeout: float) -> tuple[int, bool]:
    """Preserve live logs and record timeouts without promoting partial output."""
    with stdout_path.open("w", encoding="utf-8") as out, stderr_path.open("w", encoding="utf-8") as err:
        proc = subprocess.Popen(command, cwd=cwd, env=env, stdout=out, stderr=err,
                                start_new_session=True)
        try:
            return proc.wait(timeout=timeout), False
        except subprocess.TimeoutExpired:
            # Let the native CLI abort its active turn before force cleanup.
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            # Also stop children that kept the original process group alive.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
            return 124, True


def run_one_case(args: argparse.Namespace, case: dict[str, Any], run_root: Path) -> dict[str, Any]:
    case_id = str(case["caseId"])
    case_dir = run_root / "cases" / case_id
    submission = case_dir / "submission" / "final_answer.txt"
    if args.skip_existing and submission.is_file():
        return {
            "caseId": case_id,
            "exitCode": 0,
            "skipped": True,
            "reason": "submission_exists",
            "submissionWritten": True,
        }
    task_path = case_dir / "TASK.md"
    task_text = task_path.read_text(encoding="utf-8")
    command = [
        str(Path(args.matos_bin).resolve()),
        "run",
        "--role",
        args.role,
        "--execution",
        args.execution,
    ]
    if getattr(args, "context_profile", None):
        command.extend(["--context-profile", args.context_profile])
    if args.model:
        command.extend(["--model", args.model])
    if args.max_turns:
        command.extend(["--max-turns", str(args.max_turns)])
    command.append(task_text)
    log_dir = case_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = log_dir / "matos.stdout.log"
    stderr_path = log_dir / "matos.stderr.log"
    exit_code, timed_out = run_logged_process(command, case_dir, benchmark_run_env(),
                                             stdout_path, stderr_path, args.timeout)
    stdout_text = stdout_path.read_text(encoding="utf-8")
    if exit_code == 0 and stdout_text.strip() and not submission.exists():
        submission.write_text(stdout_text.strip() + "\n", encoding="utf-8")
    return {
        "caseId": case_id,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "stdoutLog": str((log_dir / "matos.stdout.log").relative_to(run_root)),
        "stderrLog": str((log_dir / "matos.stderr.log").relative_to(run_root)),
        "submissionWritten": submission.exists(),
    }


def command_run(args: argparse.Namespace) -> int:
    run_root = Path(args.run_root).resolve()
    manifest = read_json(run_root / "run-manifest.json")
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise SystemExit(f"Invalid run manifest: {run_root / 'run-manifest.json'}")
    selected = [case for case in cases if isinstance(case, dict)]
    if args.case_id:
        allowed = set(args.case_id)
        selected = [case for case in selected if str(case.get("caseId")) in allowed]
    if args.limit is not None:
        selected = selected[: args.limit]
    if args.jobs < 1:
        raise SystemExit("--jobs must be >= 1")
    if args.jobs == 1:
        results = [run_one_case(args, case, run_root) for case in selected]
    else:
        results_by_case: dict[str, dict[str, Any]] = {}
        with ThreadPoolExecutor(max_workers=args.jobs) as executor:
            futures = {executor.submit(run_one_case, args, case, run_root): str(case["caseId"]) for case in selected}
            for future in as_completed(futures):
                case_id = futures[future]
                try:
                    results_by_case[case_id] = future.result()
                except Exception as exc:
                    results_by_case[case_id] = {
                        "caseId": case_id,
                        "exitCode": 1,
                        "error": repr(exc),
                        "submissionWritten": False,
                    }
        results = [results_by_case[str(case["caseId"])] for case in selected]
    payload = {
        "subset": manifest.get("subset", SUBSET_ID),
        "runId": manifest.get("runId"),
        "runRoot": str(run_root),
        "role": args.role,
        "execution": args.execution,
        "results": results,
    }
    write_json(run_root / "run-results.json", payload)
    output_payload(payload, args.json)
    return 1 if any(item["exitCode"] != 0 for item in results) else 0


def output_payload(payload: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        if isinstance(payload, dict):
            for key, value in payload.items():
                if isinstance(value, (dict, list)):
                    print(f"{key}: {json.dumps(value, ensure_ascii=False)}")
                else:
                    print(f"{key}: {value}")
        else:
            print(payload)


def add_common_source_arg(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--source-root", default=str(DEFAULT_SOURCE_ROOT), help="SciAgentGym external source root")
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List the public chemistry/materials subset")
    add_common_source_arg(p_list)
    p_list.set_defaults(func=command_list)

    p_prepare = sub.add_parser("prepare", help="Prepare an agent-visible benchmark run directory")
    add_common_source_arg(p_prepare)
    p_prepare.add_argument("--work-root", required=True, help="Parent directory for benchmark runs")
    p_prepare.add_argument("--run-id", required=True, help="Run identifier")
    p_prepare.add_argument("--limit", type=int, help="Prepare only the first N selected cases")
    p_prepare.add_argument("--case-id", action="append", help="Prepare only a specific case id; repeatable")
    p_prepare.add_argument("--force", action="store_true", help="Replace an existing run directory")
    p_prepare.set_defaults(func=command_prepare)

    p_smoke = sub.add_parser("tool-smoke", help="Check that referenced official tool files can be resolved")
    add_common_source_arg(p_smoke)
    p_smoke.add_argument("--limit", type=int, help="Check only the first N selected cases")
    p_smoke.add_argument("--case-id", action="append", help="Check only a specific case id; repeatable")
    p_smoke.add_argument("--compile", action="store_true", help="Also py_compile resolved tool files")
    p_smoke.set_defaults(func=command_tool_smoke)

    p_score = sub.add_parser("score", help="Score submissions with hidden answers kept under .private")
    p_score.add_argument("--run-root", required=True, help="Prepared run root")
    p_score.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    p_score.set_defaults(func=command_score)

    p_run = sub.add_parser("run", help="Run prepared cases through the native MatOS CLI")
    p_run.add_argument("--run-root", required=True, help="Prepared run root")
    p_run.add_argument("--matos-bin", default=str(Path(__file__).resolve().parent / "matos-benchmark.sh"), help="MatOS benchmark wrapper")
    p_run.add_argument("--role", default="compute", help="MatOS role")
    p_run.add_argument("--execution", default="local", choices=["local"], help="MatOS execution backend")
    p_run.add_argument(
        "--context-profile",
        default=None,
        choices=["full", "lean"],
        help="MatOS runtime context profile. 'lean' drops asset/role builder tools and delegated role definitions for focused single-task runs.",
    )
    p_run.add_argument("--model", default="deepseek-flash", help="Solver model")
    p_run.add_argument("--max-turns", type=int, help="Optional max turns")
    p_run.add_argument("--timeout", type=int, default=43200, help="Per-case timeout in seconds (default: 12 hours)")
    p_run.add_argument("--limit", type=int, help="Run only first N prepared cases")
    p_run.add_argument("--case-id", action="append", help="Run only a specific prepared case id; repeatable")
    p_run.add_argument("--jobs", type=int, default=1, help="Number of MatOS cases to run concurrently")
    p_run.add_argument("--skip-existing", action="store_true", help="Skip cases with submission/final_answer.txt")
    p_run.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    p_run.set_defaults(func=command_run)

    p_adapt = sub.add_parser("adapt", help="Normalize prepared benchmark submissions into tighter protocol answers")
    p_adapt.add_argument("--run-root", required=True, help="Prepared run root")
    p_adapt.add_argument("--matos-bin", default=str(Path(__file__).resolve().parent / "matos-benchmark.sh"), help="MatOS benchmark wrapper")
    p_adapt.add_argument("--role", default="compute", help="MatOS role used for protocol adaptation")
    p_adapt.add_argument(
        "--execution",
        default="local",
        choices=["local"],
        help="MatOS execution backend for protocol adaptation",
    )
    p_adapt.add_argument("--model", default="deepseek-flash", help="Solver model")
    p_adapt.add_argument("--max-turns", type=int, help="Optional max turns")
    p_adapt.add_argument("--timeout", type=int, default=1800, help="Per-case timeout in seconds")
    p_adapt.add_argument("--limit", type=int, help="Adapt only first N prepared cases")
    p_adapt.add_argument("--case-id", action="append", help="Adapt only a specific prepared case id; repeatable")
    p_adapt.add_argument("--jobs", type=int, default=1, help="Number of adaptation jobs to run concurrently")
    p_adapt.add_argument(
        "--adapter-command",
        help="Advanced/debug override: shell command that emits the normalized answer on stdout",
    )
    p_adapt.add_argument("--json", action="store_true", help="Print machine-readable JSON")
    p_adapt.set_defaults(func=command_adapt)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
