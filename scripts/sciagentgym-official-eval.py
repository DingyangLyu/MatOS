#!/usr/bin/env python3
"""Convert existing MatOS/Codex/Claude SciAgentGym runs to official-evaluator traces.

The public MatOS harness stores final answers in a lightweight answer-key layout.
The upstream SciAgentGym evaluator expects trace JSON files with
``model_structured_answer`` and ``golden_standard`` fields.  This script builds
those converted traces and then calls the upstream ``EvaluationService`` without
modifying the upstream repository.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]

SUBMISSION_ANSWER_PATHS = (
    Path("submission/final_answer.txt"),
    Path("submission/answer.txt"),
    Path("submission/result.txt"),
    Path("answer.txt"),
)

PUBLIC_BACKUP_ANSWER_PATHS = (
    Path("submission/final_answer.raw.txt"),
    Path("logs/matos.protocol_adapt.stdout.log"),
    Path("logs/matos.stdout.log"),
)


@dataclass(frozen=True)
class AnswerCandidate:
    path: Path
    raw: str
    extracted: str
    source_kind: str
    score: tuple[int, int, int]


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def parse_env_file(path: Path | None) -> dict[str, str]:
    if path is None or not path.is_file():
        return {}
    env: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        if key:
            env[key] = value
    return env


def output_payload(payload: Any, json_output: bool) -> None:
    if json_output:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        if isinstance(payload, dict):
            for key, value in payload.items():
                print(f"{key}: {value}")
        else:
            print(payload)


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


def extract_final_answer(text: str) -> str:
    boxed = extract_boxed(text)
    if boxed:
        return normalize_extracted_answer(boxed)
    patterns = [
        r"(?is)final\s+answer\s*[:：]\s*(.+)$",
        r"(?is)answer\s*[:：]\s*(.+)$",
        r"(?is)###\s*answer\s*###\s*(.+)$",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return normalize_extracted_answer(match.group(1))
    return normalize_extracted_answer(text)


def normalize_extracted_answer(text: str) -> str:
    text = text.strip()
    if not text:
        return ""
    text = re.sub(r"\\text\s*\{([^{}]*)\}", r"\1", text)
    text = re.sub(r"\\mathrm\s*\{([^{}]*)\}", r"\1", text)
    replacements = {
        r"\bar": "",
        r"\;": " ",
        r"\,": " ",
        r"\ ": " ",
        r"\times": "x",
        r"\cdot": "*",
        r"\degree": "degree",
        r"\circ": "degree",
        r"\alpha": "alpha",
        r"\beta": "beta",
        r"\gamma": "gamma",
        r"\AA": "A",
        r"\%": "%",
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r"_\{([^{}]+)\}", r"\1", text)
    text = re.sub(r"\^\{([^{}]+)\}", r"\1", text)
    text = re.sub(r"_([A-Za-z0-9])", r"\1", text)
    text = text.replace("{", "").replace("}", "")
    text = text.replace("\\", "")
    return re.sub(r"\s+", " ", text).strip(" `\n\t")


def iter_answer_candidates(case_dir: Path, source_policy: str) -> list[tuple[str, Path]]:
    if source_policy == "submission":
        return [("submission", case_dir / rel) for rel in SUBMISSION_ANSWER_PATHS]
    if source_policy == "public-richest":
        return (
            [("public-backup", case_dir / rel) for rel in PUBLIC_BACKUP_ANSWER_PATHS]
            + [("submission", case_dir / rel) for rel in SUBMISSION_ANSWER_PATHS]
        )
    raise ValueError(f"unsupported answer source policy: {source_policy}")


def looks_like_over_normalized_submission(text: str) -> bool:
    compact = re.sub(r"\s+", " ", text).strip()
    if not compact:
        return False
    if re.match(r"^[,;:'\]\)\-]", compact):
        return True
    if re.match(r"^\d+\s*,\s*\d+[-'a-zA-Z]", compact):
        return True
    if re.match(r"^\d+(?:\.\d+)?\s*(?:eV|ev|kJ|J|mol|g|%)?\s*,\s*[^,]+:", compact):
        return True
    if len(re.findall(r"\b\d{2,3}\.\d{2,3}\.\d{2,}", compact)) >= 2:
        return True
    if compact.count("^") >= 3 and re.search(r"\blattice\s+parameters\b", compact, flags=re.IGNORECASE):
        return True
    if compact.count(",") >= 4 and len(compact) < 140 and not re.search(
        r"\b(?:phase|single|structure|space|group|corresponds|answer|result)\b",
        compact,
        flags=re.IGNORECASE,
    ):
        return True
    return False


def score_answer_candidate(candidate: AnswerCandidate, baseline: AnswerCandidate | None) -> tuple[int, int, int]:
    extracted = candidate.extracted
    if not extracted:
        return (-10_000, 0, 0)
    score = 0
    if candidate.source_kind == "submission":
        score += 20
    if candidate.path.name == "final_answer.raw.txt":
        score += 12
    if candidate.path.name == "matos.protocol_adapt.stdout.log":
        score += 8
    if "\\boxed" in candidate.raw or "boxed" in candidate.raw.lower():
        score += 4
    if baseline and looks_like_over_normalized_submission(baseline.extracted):
        if len(extracted) > len(baseline.extracted) + 8:
            score += 80
        if baseline.extracted and baseline.extracted in extracted:
            score += 25
    elif candidate.source_kind != "submission":
        # Keep the historical submitted answer unless the backup is clearly
        # much richer. This avoids turning concise correct submissions into
        # long reports during comparative reruns.
        if baseline and len(extracted) > max(160, len(baseline.extracted) * 2):
            score -= 20
    if len(extracted) < 3:
        score -= 50
    return (score, min(len(extracted), 5000), -len(candidate.raw))


def select_public_answer_candidate(case_dir: Path, source_policy: str = "submission") -> AnswerCandidate:
    baseline: AnswerCandidate | None = None
    candidates: list[AnswerCandidate] = []
    for source_kind, path in iter_answer_candidates(case_dir, source_policy):
        if not path.is_file():
            continue
        raw = path.read_text(encoding="utf-8", errors="replace")
        extracted = extract_final_answer(raw)
        candidate = AnswerCandidate(
            path=path,
            raw=raw,
            extracted=extracted,
            source_kind=source_kind,
            score=(0, 0, 0),
        )
        if baseline is None and source_kind == "submission":
            baseline = candidate
        candidates.append(candidate)
        if source_policy == "submission":
            return candidate
    if not candidates:
        return AnswerCandidate(
            path=case_dir / "submission/final_answer.txt",
            raw="",
            extracted="",
            source_kind="missing",
            score=(-10_000, 0, 0),
        )
    scored = [
        AnswerCandidate(
            path=candidate.path,
            raw=candidate.raw,
            extracted=candidate.extracted,
            source_kind=candidate.source_kind,
            score=score_answer_candidate(candidate, baseline),
        )
        for candidate in candidates
    ]
    return max(scored, key=lambda candidate: candidate.score)


def read_submission(case_dir: Path) -> tuple[Path | None, str | None]:
    candidate = select_public_answer_candidate(case_dir, "submission")
    if candidate.raw:
        return candidate.path, candidate.raw
    return None, None


def discover_runs(args: argparse.Namespace) -> dict[str, Path]:
    runs: dict[str, Path] = {}
    for item in args.run or []:
        if "=" not in item:
            raise SystemExit(f"--run must use name=/path form: {item}")
        name, path = item.split("=", 1)
        runs[name.strip()] = Path(path).resolve()
    if args.only:
        allowed = set(args.only)
        runs = {name: path for name, path in runs.items() if name in allowed}
    if not runs:
        raise SystemExit("Pass at least one --run name=/path/to/run-root.")
    return runs


def build_inventory(runs: dict[str, Path], source_repo: Path) -> dict[str, Any]:
    dataset_counts: dict[str, int] = {}
    for dataset in ("refine_merged_single_questions.json", "refine_merged_multi_questions.json"):
        path = source_repo / "dataset" / dataset
        if path.is_file():
            dataset_counts[dataset] = len(read_json(path))
    run_summaries = {}
    case_ids_by_run: dict[str, list[str]] = {}
    for name, root in runs.items():
        manifest_path = root / "run-manifest.json"
        manifest = read_json(manifest_path) if manifest_path.is_file() else {}
        cases = [case for case in manifest.get("cases", []) if isinstance(case, dict)]
        case_ids = [str(case.get("caseId")) for case in cases if case.get("caseId")]
        case_ids_by_run[name] = case_ids
        submitted = 0
        missing = 0
        for case_id in case_ids:
            submission_path, _ = read_submission(root / "cases" / case_id)
            if submission_path is None:
                missing += 1
            else:
                submitted += 1
        run_summaries[name] = {
            "root": str(root),
            "exists": root.exists(),
            "manifest": str(manifest_path),
            "caseCount": len(case_ids),
            "submitted": submitted,
            "missingSubmission": missing,
        }
    common_case_ids = sorted(set.intersection(*(set(v) for v in case_ids_by_run.values()))) if case_ids_by_run else []
    return {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceRepo": str(source_repo),
        "datasetCounts": dataset_counts,
        "runs": run_summaries,
        "commonCaseCount": len(common_case_ids),
        "commonCaseIds": common_case_ids,
        "paperMetricNote": "SciAgentGym paper reports task-level SR and SPL; this inventory covers the local public chemistry/materials 42-case slice.",
    }


def convert_run(system: str, run_root: Path, output_root: Path, answer_source: str) -> dict[str, Any]:
    manifest = read_json(run_root / "run-manifest.json")
    cases = [case for case in manifest.get("cases", []) if isinstance(case, dict) and case.get("caseId")]
    trace_dir = output_root / "traces" / system
    converted = 0
    missing_submission = 0
    missing_private = 0
    details: list[dict[str, Any]] = []
    for case in cases:
        case_id = str(case["caseId"])
        case_dir = run_root / "cases" / case_id
        private_path = run_root / ".private" / case_id / "case-private.json"
        answer_candidate = select_public_answer_candidate(case_dir, answer_source)
        submission_path = answer_candidate.path
        raw_submission = answer_candidate.raw
        if not private_path.is_file():
            missing_private += 1
            details.append({"caseId": case_id, "status": "missing_private"})
            continue
        if not raw_submission:
            missing_submission += 1
            details.append({"caseId": case_id, "status": "missing_submission"})
            continue
        private = read_json(private_path)
        expected_answer = private.get("answer")
        extracted_answer = answer_candidate.extracted
        trace = {
            "trace_id": f"{system}:{case_id}",
            "model_name": system,
            "case_id": case_id,
            "question": private.get("question"),
            "metadata": {
                "subject": private.get("subject"),
                "topic": private.get("topic"),
                "datasetKind": private.get("datasetKind"),
                "datasetFile": private.get("datasetFile"),
                "sourceIndex": private.get("sourceIndex"),
                "sourceId": private.get("sourceId"),
                "filename": private.get("filename"),
            },
            "messages": [
                {"role": "user", "content": private.get("question") or ""},
                {"role": "assistant", "content": raw_submission},
            ],
            "model_raw_answer": raw_submission,
            "model_structured_answer": {"answer": extracted_answer},
            "answer_template": {"answer": "[final answer]"},
            "golden_standard": {"answer": expected_answer},
            "expected_format": "official_compatible_final_answer_field",
            "conversion": {
                "sourceRunRoot": str(run_root),
                "sourceSubmissionPath": str(submission_path),
                "sourceAnswerPolicy": answer_source,
                "sourceAnswerKind": answer_candidate.source_kind,
                "sourceAnswerScore": list(answer_candidate.score),
                "sourcePrivatePath": str(private_path),
                "privateGoldenAnswerShape": type((private.get("metadataPrivate") or {}).get("golden_answer")).__name__,
                "compatibilityScope": "final-answer-only; official evaluator core, not full official SR/SPL trace replay",
            },
        }
        trace_path = trace_dir / f"{case_id}_trace.json"
        write_json(trace_path, trace)
        converted += 1
        details.append(
            {
                "caseId": case_id,
                "status": "converted",
                "tracePath": str(trace_path),
                "submissionPath": str(submission_path),
                "answerSourcePolicy": answer_source,
                "answerSourceKind": answer_candidate.source_kind,
                "answerSourceScore": list(answer_candidate.score),
                "expectedAnswer": expected_answer,
                "extractedAnswer": extracted_answer[:500],
            }
        )
    payload = {
        "system": system,
        "runRoot": str(run_root),
        "traceDir": str(trace_dir),
        "total": len(cases),
        "converted": converted,
        "missingSubmission": missing_submission,
        "missingPrivate": missing_private,
        "details": details,
    }
    write_json(output_root / "conversion" / f"{system}.conversion.json", payload)
    return payload


def configure_official_imports(source_repo: Path) -> None:
    if not source_repo.is_dir():
        raise SystemExit(f"SciAgentGym source repo not found: {source_repo}")
    sys.path.insert(0, str(source_repo))


def configure_judge(args: argparse.Namespace) -> dict[str, Any]:
    env_file_values = parse_env_file(args.env_file)
    api_key = (
        args.judge_api_key
        or os.environ.get("SCIAGENTGYM_JUDGE_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
        or env_file_values.get("SCIAGENTGYM_JUDGE_API_KEY")
        or env_file_values.get("OPENAI_API_KEY")
    )
    base_url = (
        args.judge_base_url
        or os.environ.get("SCIAGENTGYM_JUDGE_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or env_file_values.get("SCIAGENTGYM_JUDGE_BASE_URL")
        or env_file_values.get("OPENAI_BASE_URL")
    )
    model = args.judge_model or os.environ.get("SCIAGENTGYM_JUDGE_MODEL") or "gpt-4.1"

    if args.disable_llm_fallback:
        from gym.core import evaluator

        evaluator.secondary_verification_with_llm = lambda actual, expected, path="": False
        return {
            "mode": "official-core-no-llm-fallback",
            "model": None,
            "baseUrlConfigured": False,
            "apiKeyConfigured": False,
        }

    if not api_key or not base_url:
        raise SystemExit(
            "Missing judge credentials. Set SCIAGENTGYM_JUDGE_API_KEY and "
            "SCIAGENTGYM_JUDGE_BASE_URL, or pass --disable-llm-fallback for a no-network diagnostic."
        )

    import gym.config.config as config

    config.JUDGE_MODEL = model
    config.SUPPORTED_MODELS[model] = {
        "provider": "openai",
        "model_name": model,
        "api_base_url": base_url,
        "api_key": api_key,
        "evaluation_only": True,
    }
    return {
        "mode": "official-evaluator-with-llm-fallback",
        "model": model,
        "baseUrlConfigured": bool(base_url),
        "apiKeyConfigured": bool(api_key),
    }


def evaluate_trace_dir(system: str, trace_dir: Path) -> dict[str, Any]:
    from gym.core.evaluation_service import EvaluationService

    service = EvaluationService(lenient_mode=True)
    trace_files = sorted(trace_dir.glob("*_trace.json"))
    details: list[dict[str, Any]] = []
    scores: list[float] = []
    correct = 0
    failures = 0
    match_types: dict[str, int] = {}
    for trace_file in trace_files:
        result = service.evaluate_single_trace(str(trace_file), force_reextract=False)
        trace_data = read_json(trace_file)
        score = float(result.get("score", 0.0)) if result.get("success") else 0.0
        scores.append(score)
        if score >= 1.0:
            correct += 1
        if not result.get("success"):
            failures += 1
        eval_details = trace_data.get("evaluation_details") or {}
        for item in eval_details.values():
            if isinstance(item, dict):
                match_type = str(item.get("match_type") or item.get("status") or "unknown")
                match_types[match_type] = match_types.get(match_type, 0) + 1
        details.append(
            {
                "caseId": trace_data.get("case_id"),
                "traceFile": str(trace_file),
                "score": score,
                "success": bool(result.get("success")),
                "summary": result.get("summary"),
                "details": result.get("details"),
            }
        )
    total = len(trace_files)
    return {
        "system": system,
        "traceDir": str(trace_dir),
        "total": total,
        "evaluated": total - failures,
        "correct": correct,
        "successRate": (correct / total) if total else 0.0,
        "meanFieldScore": (sum(scores) / total) if total else 0.0,
        "splAvailable": False,
        "spl": None,
        "matchTypes": match_types,
        "details": details,
    }


def write_markdown_report(output_root: Path, inventory: dict[str, Any], aggregate: dict[str, Any]) -> Path:
    lines = [
        "# SciAgentGym Official Evaluator Converted Results",
        "",
        f"Created: `{aggregate['createdAt']}`",
        "",
        "## Scope",
        "",
        "- Dataset: local public SciAgentGym chemistry/materials slice.",
        f"- Common cases: `{inventory.get('commonCaseCount')}`.",
        f"- Answer source policy: `{aggregate.get('answerSourcePolicy', 'submission')}`.",
        "- Evaluation path: converted final answers -> upstream `EvaluationService` -> upstream `calculate_answer_score`.",
        "- This is not a full paper SR/SPL replay because existing MatOS/Codex/Claude runs do not store upstream SciAgentGym tool-step traces or expert path lengths.",
        "",
        "## Scores",
        "",
        "| System | Official-compatible SR | Mean field score | Evaluated | SPL |",
        "| --- | ---: | ---: | ---: | --- |",
    ]
    for system, result in aggregate["systems"].items():
        lines.append(
            f"| {system} | `{result['correct']} / {result['total']} = {result['successRate']:.1%}` "
            f"| `{result['meanFieldScore']:.1%}` | `{result['evaluated']} / {result['total']}` | unavailable |"
        )
    lines.extend(
        [
            "",
            "## Judge Configuration",
            "",
            f"- Mode: `{aggregate['judge'].get('mode')}`",
            f"- Model: `{aggregate['judge'].get('model')}`",
            f"- API key configured: `{aggregate['judge'].get('apiKeyConfigured')}`",
            f"- Base URL configured: `{aggregate['judge'].get('baseUrlConfigured')}`",
            "",
            "## Output Files",
            "",
            f"- Inventory: `{output_root / 'inventory.json'}`",
            f"- Aggregate JSON: `{output_root / 'official-evaluation-summary.json'}`",
            f"- Converted traces: `{output_root / 'traces'}`",
            "",
            "## Caveat",
            "",
            "The upstream paper's reported SR requires all sub-questions in a task to be correct. "
            "The current public local run has already been flattened to 42 case-level final answers, "
            "so this report measures case-level final-answer success through the official evaluator core. "
            "The upstream SPL metric requires expert reference path length and actual SciAgentGym tool path length, "
            "which are not recoverable from these existing external-agent runs.",
            "",
        ]
    )
    report_path = output_root / "official-evaluation-report.md"
    report_path.write_text("\n".join(lines), encoding="utf-8")
    return report_path


def command_all(args: argparse.Namespace) -> int:
    runs = discover_runs(args)
    if args.source_repo is None:
        raise SystemExit("Pass --source-repo or set SCIAGENTGYM_SOURCE_REPO to the public SciAgentGym checkout.")
    if args.output_root is None:
        raise SystemExit("Pass --output-root for the evaluation output directory.")
    source_repo = args.source_repo.resolve()
    output_root = args.output_root.resolve()
    output_root.mkdir(parents=True, exist_ok=True)

    inventory = build_inventory(runs, source_repo)
    write_json(output_root / "inventory.json", inventory)

    conversions = {}
    for system, run_root in runs.items():
        conversions[system] = convert_run(system, run_root.resolve(), output_root, args.answer_source)
    write_json(output_root / "conversion/conversions.json", conversions)

    configure_official_imports(source_repo)
    judge = configure_judge(args)

    systems = {}
    for system in runs:
        result = evaluate_trace_dir(system, output_root / "traces" / system)
        systems[system] = result
        write_json(output_root / "evaluation" / f"{system}.official-evaluation.json", result)

    aggregate = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "outputRoot": str(output_root),
        "answerSourcePolicy": args.answer_source,
        "judge": judge,
        "inventoryPath": str(output_root / "inventory.json"),
        "systems": systems,
        "paperMetricCompatibility": {
            "sr": "case-level final-answer SR on converted public subset",
            "spl": "unavailable from existing external-agent runs",
            "fullPaperLeaderboardComparable": False,
        },
    }
    write_json(output_root / "official-evaluation-summary.json", aggregate)
    report_path = write_markdown_report(output_root, inventory, aggregate)

    payload = {
        "outputRoot": str(output_root),
        "inventoryPath": str(output_root / "inventory.json"),
        "summaryPath": str(output_root / "official-evaluation-summary.json"),
        "reportPath": str(report_path),
        "systems": {
            system: {
                "correct": result["correct"],
                "total": result["total"],
                "successRate": result["successRate"],
                "meanFieldScore": result["meanFieldScore"],
            }
            for system, result in systems.items()
        },
    }
    output_payload(payload, args.json)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-repo",
        type=Path,
        default=Path(os.environ["SCIAGENTGYM_SOURCE_REPO"]) if os.environ.get("SCIAGENTGYM_SOURCE_REPO") else None,
    )
    parser.add_argument("--output-root", type=Path)
    parser.add_argument("--run", action="append", help="Additional or replacement run in name=/path form.")
    parser.add_argument("--only", action="append", help="Limit to selected system name. Can be repeated.")
    parser.add_argument(
        "--answer-source",
        choices=("submission", "public-richest"),
        default="submission",
        help=(
            "Answer source policy for converted traces. 'submission' preserves the existing "
            "final_answer.txt behavior; 'public-richest' may use public raw/protocol artifacts "
            "when the submitted answer appears over-normalized."
        ),
    )
    parser.add_argument("--env-file", type=Path, help="Optional KEY=VALUE file with judge credentials.")
    parser.add_argument("--judge-model")
    parser.add_argument("--judge-base-url")
    parser.add_argument("--judge-api-key")
    parser.add_argument("--disable-llm-fallback", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.set_defaults(func=command_all)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
