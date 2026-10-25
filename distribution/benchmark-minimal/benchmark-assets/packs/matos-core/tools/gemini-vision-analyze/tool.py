#!/usr/bin/env python3
"""MatOS Gemini vision analyzer.

Contract (MatOS asset tool runner):
  stdin : {"input": {"imagePath": str, "context": str, ...}}
  stdout: one JSON object with ok/model/analysis fields.

The tool is stdlib-only so it can be hot-copied into existing workspaces. It
reads credentials from process env and, for live hotfixes, from
MATOS_GEMINI_ENV_FILE or /run/matos-gemini.env. Secrets are never printed.
"""
from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "gemini-3.1-pro-preview"
DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com"
DEFAULT_MAX_OUTPUT_TOKENS = 1200
DEFAULT_THINKING_BUDGET = 0
GOOGLE_NATIVE_THINKING_TOKEN_RESERVE = 1024
GOOGLE_NATIVE_MAX_REQUEST_TOKENS = 4096
HARD_MAX_IMAGE_BYTES = 20 * 1024 * 1024
TIMEOUT_SECONDS = 75
ENV_FILE_CANDIDATES = (
    "MATOS_GEMINI_ENV_FILE",
    "/home/workspace/.matos/gemini.env",
    "/run/matos-gemini.env",
)
GEMINI_ENV_KEYS = {
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "GEMINI_MODEL",
    "GEMINI_API_STYLE",
}


def emit(payload: dict[str, Any]) -> int:
    print(json.dumps(payload, ensure_ascii=False))
    return 0


def read_input() -> dict[str, Any]:
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        return payload["input"]
    return payload if isinstance(payload, dict) else {}


def parse_env_line(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[len("export ") :].strip()
    if "=" not in stripped:
        return None
    key, value = stripped.split("=", 1)
    key = key.strip()
    if key not in GEMINI_ENV_KEYS:
        return None
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return key, value


def load_env_files() -> None:
    paths: list[str] = []
    configured = os.environ.get("MATOS_GEMINI_ENV_FILE")
    if configured:
        paths.append(configured)
    paths.extend(candidate for candidate in ENV_FILE_CANDIDATES[1:] if candidate)

    for env_path in paths:
        try:
            path = Path(env_path)
            if not path.is_file():
                continue
            for line in path.read_text(encoding="utf8").splitlines():
                parsed = parse_env_line(line)
                if parsed is None:
                    continue
                key, value = parsed
                if value and not os.environ.get(key):
                    os.environ[key] = value
        except Exception:
            continue


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def clamp_float(value: Any, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def timeout_seconds() -> int:
    return clamp_int(
        os.environ.get("MATOS_GEMINI_TIMEOUT_SECONDS"),
        TIMEOUT_SECONDS,
        10,
        240,
    )


def retry_attempts() -> int:
    return clamp_int(
        os.environ.get("MATOS_GEMINI_RETRY_ATTEMPTS"),
        2,
        1,
        4,
    )


def default_thinking_budget() -> int:
    return clamp_int(
        os.environ.get("MATOS_GEMINI_THINKING_BUDGET"),
        DEFAULT_THINKING_BUDGET,
        0,
        8192,
    )


def build_google_generation_config(
    max_tokens: int,
    temperature: float,
    thinking_budget: int | None,
) -> dict[str, Any]:
    config: dict[str, Any] = {
        "temperature": temperature,
        "maxOutputTokens": max_tokens,
    }
    if thinking_budget is not None:
        config["thinkingConfig"] = {"thinkingBudget": thinking_budget}
    return config


def google_native_request_max_tokens(max_tokens: int, thinking_budget: int | None) -> int:
    reserve = max(GOOGLE_NATIVE_THINKING_TOKEN_RESERVE, thinking_budget or 0)
    return max(
        1024,
        min(GOOGLE_NATIVE_MAX_REQUEST_TOKENS, max_tokens + reserve),
    )


def usage_count(usage: dict[str, Any] | None, key: str) -> int:
    if not isinstance(usage, dict):
        return 0
    try:
        return int(usage.get(key) or 0)
    except (TypeError, ValueError):
        return 0


def google_response_diagnostics(
    payload: dict[str, Any],
    analysis: str,
    max_tokens: int,
    requested_max_tokens: int,
    thinking_budget: int | None,
) -> dict[str, Any]:
    usage = payload.get("usageMetadata") if isinstance(payload.get("usageMetadata"), dict) else {}
    thoughts = usage_count(usage, "thoughtsTokenCount")
    candidates = usage_count(usage, "candidatesTokenCount")
    finish_reason = google_finish_reason(payload)
    return {
        "thinkingBudget": thinking_budget,
        "finishReason": finish_reason,
        "thoughtsTokenCount": thoughts,
        "candidatesTokenCount": candidates,
        "visibleMaxOutputTokens": max_tokens,
        "requestedMaxOutputTokens": requested_max_tokens,
        "outputLooksTruncatedByThinking": finish_reason.upper() == "MAX_TOKENS"
        and thoughts > 0
        and candidates > 0
        and candidates < 128
        and len(analysis.split()) < 100,
    }


def resolve_image_path(raw: str) -> Path | None:
    image_path = raw.strip()
    if image_path.startswith("file://"):
        image_path = urllib.parse.unquote(urllib.parse.urlparse(image_path).path)
    if not image_path:
        return None

    path = Path(image_path).expanduser()
    if path.is_absolute() and path.is_file():
        return path
    if path.is_absolute():
        return None

    roots = [
        os.environ.get("MATOS_PROJECT_CWD"),
        os.environ.get("MATOS_WORKSPACE_DIR"),
        os.environ.get("MATOS_WORKSPACE_ROOT"),
        "/workspace/group/shared",
        "/workspace/group",
        os.getcwd(),
    ]
    for root in roots:
        if not root:
            continue
        candidate = Path(root).expanduser() / path
        if candidate.is_file():
            return candidate
    return None


def detect_mime(path: Path) -> str:
    mime, _encoding = mimetypes.guess_type(str(path))
    if mime and mime.startswith("image/"):
        return mime
    suffix = path.suffix.lower()
    if suffix == ".png":
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    if suffix == ".gif":
        return "image/gif"
    return mime or "application/octet-stream"


def ca_bundle_path() -> str | None:
    for candidate in (
        os.environ.get("SSL_CERT_FILE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        os.environ.get("CURL_CA_BUNDLE"),
        "/etc/ssl/certs/ca-certificates.crt",
        "/opt/matos-tools/conda/envs/matos-compute/ssl/cert.pem",
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    try:
        import certifi  # type: ignore

        bundle = certifi.where()
        if bundle and Path(bundle).is_file():
            return bundle
    except Exception:
        pass
    return None


def https_context() -> ssl.SSLContext:
    bundle = ca_bundle_path()
    if bundle:
        return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


def redact(text: str, api_key: str) -> str:
    redacted = text
    if api_key:
        redacted = redacted.replace(api_key, "<redacted>")
    redacted = re.sub(r"(GEMINI_API_KEY=)[^\s'\"&]+", r"\1<redacted>", redacted)
    return redacted[:2000]


def classify_request_error(status: int | None, error: str) -> dict[str, Any]:
    lowered = str(error or "").lower()
    if status in {408, 425, 429, 500, 502, 503, 504}:
        return {
            "errorKind": f"http_{status}",
            "retryable": True,
        }
    if status:
        return {
            "errorKind": f"http_{status}",
            "retryable": False,
        }
    if "timed out" in lowered or "timeout" in lowered:
        return {
            "errorKind": "timeout",
            "retryable": True,
        }
    if "empty vision response" in lowered:
        return {
            "errorKind": "empty_response",
            "retryable": True,
        }
    if "certificate" in lowered or "ssl" in lowered:
        return {
            "errorKind": "tls_or_certificate",
            "retryable": False,
        }
    if "cannot assign requested address" in lowered:
        return {
            "errorKind": "network_address_unavailable",
            "retryable": True,
        }
    if "temporary failure in name resolution" in lowered or "name or service not known" in lowered:
        return {
            "errorKind": "dns_resolution_failed",
            "retryable": True,
        }
    return {
        "errorKind": "network_or_provider_error",
        "retryable": True,
    }


def request_json(
    url: str,
    headers: dict[str, str],
    body: dict[str, Any],
    api_key: str,
) -> tuple[bool, int | None, dict[str, Any] | None, str]:
    data = json.dumps(body).encode("utf8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={**headers, "Content-Type": "application/json"},
        method="POST",
    )
    attempts = retry_attempts()
    last_status: int | None = None
    last_error = ""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(
                request,
                timeout=timeout_seconds(),
                context=https_context(),
            ) as response:
                text = response.read().decode("utf8", "ignore")
                return True, response.status, json.loads(text), ""
        except urllib.error.HTTPError as exc:
            text = exc.read().decode("utf8", "ignore")
            last_status = exc.code
            last_error = redact(text, api_key)
        except Exception as exc:
            last_status = None
            last_error = redact(str(exc), api_key)
        classification = classify_request_error(last_status, last_error)
        if not classification.get("retryable") or attempt >= attempts - 1:
            break
        time.sleep(min(2.0, 0.5 * (attempt + 1)))
    return False, last_status, None, last_error


def openai_chat_url(base_url: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/chat/completions"):
        return base
    if base.endswith("/v1"):
        return f"{base}/chat/completions"
    return f"{base}/v1/chat/completions"


def google_generate_url(base_url: str, model: str, api_key: str) -> str:
    base = base_url.rstrip("/")
    if base.endswith("/v1") or base.endswith("/v1beta"):
        root = base
    else:
        root = f"{base}/v1beta"
    quoted_model = urllib.parse.quote(model, safe="")
    return f"{root}/models/{quoted_model}:generateContent?key={urllib.parse.quote(api_key)}"


def base_url_prefers_openai(base_url: str) -> bool:
    return base_url.rstrip("/").endswith("/chat/completions")


def text_from_openai_response(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join(parts).strip()
    return ""


def text_from_google_response(payload: dict[str, Any]) -> str:
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    content = candidates[0].get("content") if isinstance(candidates[0], dict) else None
    parts = content.get("parts") if isinstance(content, dict) else None
    if not isinstance(parts, list):
        return ""
    text_parts = [
        part.get("text")
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    return "\n".join(text_parts).strip()


def google_finish_reason(payload: dict[str, Any] | None) -> str:
    if not isinstance(payload, dict):
        return ""
    candidates = payload.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0]
    if not isinstance(first, dict):
        return ""
    return str(first.get("finishReason") or "")


def build_prompt(context: str, question: str, detail: str) -> str:
    default_question = (
        "Describe the image, extract any important visible text, and answer the "
        "user's task-relevant visual question. Call out uncertainty."
    )
    detail_hint = (
        "Be concise and focus only on the main visual evidence."
        if detail == "brief"
        else "Inspect layout, labels, colors, plotted data, visible text, and possible issues in detail."
    )
    return "\n".join(
        [
            "You are a careful visual inspection model for MatOS agents.",
            f"Task context: {context.strip()}",
            f"Question: {(question or default_question).strip()}",
            detail_hint,
            "Do not infer secrets or hidden data. Report only visible evidence and task-relevant reasoning.",
        ]
    )


def call_openai_compatible(
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    mime_type: str,
    image_b64: str,
    max_tokens: int,
    temperature: float,
) -> tuple[bool, dict[str, Any]]:
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{mime_type};base64,{image_b64}",
                        },
                    },
                ],
            }
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    ok, status, payload, error = request_json(
        openai_chat_url(base_url),
        {"Authorization": f"Bearer {api_key}"},
        body,
        api_key,
    )
    if not ok or payload is None:
        return False, {
            "protocol": "openai-compatible",
            "status": status,
            "error": error,
            **classify_request_error(status, error),
        }
    analysis = text_from_openai_response(payload)
    if not analysis:
        return False, {
            "protocol": "openai-compatible",
            "status": status,
            "error": "empty vision response",
            **classify_request_error(status, "empty vision response"),
        }
    return True, {
        "protocol": "openai-compatible",
        "status": status,
        "analysis": analysis,
        "usage": payload.get("usage") if isinstance(payload.get("usage"), dict) else None,
    }


def call_google_native(
    base_url: str,
    api_key: str,
    model: str,
    prompt: str,
    mime_type: str,
    image_b64: str,
    max_tokens: int,
    temperature: float,
    thinking_budget: int | None,
) -> tuple[bool, dict[str, Any]]:
    requested_max_tokens = google_native_request_max_tokens(max_tokens, thinking_budget)
    body = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"text": prompt},
                    {"inlineData": {"mimeType": mime_type, "data": image_b64}},
                ],
            }
        ],
        "generationConfig": build_google_generation_config(
            requested_max_tokens,
            temperature,
            thinking_budget,
        ),
    }
    ok, status, payload, error = request_json(
        google_generate_url(base_url, model, api_key),
        {},
        body,
        api_key,
    )
    if not ok or payload is None:
        if (
            status == 400
            and thinking_budget is not None
            and "thinkingConfig" in str(error)
        ):
            body["generationConfig"] = build_google_generation_config(
                requested_max_tokens,
                temperature,
                None,
            )
            ok, status, payload, error = request_json(
                google_generate_url(base_url, model, api_key),
                {},
                body,
                api_key,
            )
        if ok and payload is not None:
            analysis = text_from_google_response(payload)
            if analysis:
                return True, {
                    "protocol": "google-native",
                    "status": status,
                    "analysis": analysis,
                    "usage": payload.get("usageMetadata")
                    if isinstance(payload.get("usageMetadata"), dict)
                    else None,
                    "diagnostics": google_response_diagnostics(
                        payload,
                        analysis,
                        max_tokens,
                        requested_max_tokens,
                        None,
                    ),
                }
        return False, {
            "protocol": "google-native",
            "status": status,
            "error": error,
            **classify_request_error(status, error),
        }
    analysis = text_from_google_response(payload)
    if not analysis:
        if (
            google_finish_reason(payload).upper() == "MAX_TOKENS"
            and requested_max_tokens < GOOGLE_NATIVE_MAX_REQUEST_TOKENS
        ):
            requested_max_tokens = GOOGLE_NATIVE_MAX_REQUEST_TOKENS
            body["generationConfig"] = build_google_generation_config(
                requested_max_tokens,
                temperature,
                thinking_budget,
            )
            ok, status, payload, error = request_json(
                google_generate_url(base_url, model, api_key),
                {},
                body,
                api_key,
            )
            if ok and payload is not None:
                analysis = text_from_google_response(payload)
        if analysis:
            return True, {
                "protocol": "google-native",
                "status": status,
                "analysis": analysis,
                "usage": payload.get("usageMetadata")
                if isinstance(payload.get("usageMetadata"), dict)
                else None,
                "diagnostics": google_response_diagnostics(
                    payload,
                    analysis,
                    max_tokens,
                    requested_max_tokens,
                    thinking_budget,
                ),
            }
        return False, {
            "protocol": "google-native",
            "status": status,
            "error": "empty vision response",
            **classify_request_error(status, "empty vision response"),
        }
    return True, {
        "protocol": "google-native",
        "status": status,
        "analysis": analysis,
        "usage": payload.get("usageMetadata")
        if isinstance(payload.get("usageMetadata"), dict)
        else None,
        "diagnostics": google_response_diagnostics(
            payload,
            analysis,
            max_tokens,
            requested_max_tokens,
            thinking_budget,
        ),
    }


def main() -> int:
    load_env_files()
    data = read_input()

    image_raw = str(data.get("imagePath") or data.get("image_path") or "").strip()
    context = str(data.get("context") or "").strip()
    question = str(data.get("question") or "").strip()
    detail = str(data.get("detail") or "full").strip().lower()
    if detail not in {"brief", "full"}:
        detail = "full"

    if not image_raw:
        return emit({"ok": False, "provider": "gemini", "notes": "imagePath is required"})
    if not context:
        return emit({"ok": False, "provider": "gemini", "notes": "context is required"})

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return emit(
            {
                "ok": False,
                "provider": "gemini",
                "notes": "GEMINI_API_KEY is required in env or MATOS_GEMINI_ENV_FILE",
            }
        )

    base_url = (
        os.environ.get("GEMINI_BASE_URL", "").strip() or DEFAULT_BASE_URL
    )
    model = str(data.get("model") or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL).strip()
    api_style = (
        os.environ.get("GEMINI_API_STYLE", "auto").strip().lower()
        or "auto"
    )
    max_tokens = clamp_int(
        data.get("maxOutputTokens") or data.get("max_output_tokens"),
        DEFAULT_MAX_OUTPUT_TOKENS,
        128,
        4096,
    )
    temperature = clamp_float(data.get("temperature"), 0.0, 0.0, 1.0)
    thinking_budget_raw = (
        data.get("thinkingBudget")
        if data.get("thinkingBudget") is not None
        else data.get("thinking_budget")
    )
    thinking_budget = clamp_int(
        thinking_budget_raw,
        default_thinking_budget(),
        0,
        8192,
    )

    image_path = resolve_image_path(image_raw)
    if image_path is None:
        return emit(
            {
                "ok": False,
                "provider": "gemini",
                "imagePath": image_raw,
                "notes": "image file not found",
            }
        )
    size = image_path.stat().st_size
    if size > HARD_MAX_IMAGE_BYTES:
        return emit(
            {
                "ok": False,
                "provider": "gemini",
                "imagePath": str(image_path),
                "imageBytes": size,
                "notes": "image is too large; limit is 20 MiB",
            }
        )

    mime_type = detect_mime(image_path)
    if not mime_type.startswith("image/"):
        return emit(
            {
                "ok": False,
                "provider": "gemini",
                "imagePath": str(image_path),
                "mimeType": mime_type,
                "notes": "file is not a supported image type",
            }
        )

    image_b64 = base64.b64encode(image_path.read_bytes()).decode("ascii")
    prompt = build_prompt(context, question, detail)
    attempts: list[dict[str, Any]] = []

    if api_style in {"openai", "openai-compatible", "chat"}:
        protocols = ["openai"]
    elif api_style in {"google", "google-native", "native"}:
        protocols = ["google"]
    elif base_url_prefers_openai(base_url):
        protocols = ["openai", "google"]
    else:
        protocols = ["google", "openai"]

    for protocol in protocols:
        if protocol == "google":
            ok, result = call_google_native(
                base_url,
                api_key,
                model,
                prompt,
                mime_type,
                image_b64,
                max_tokens,
                temperature,
                thinking_budget,
            )
        else:
            ok, result = call_openai_compatible(
                base_url,
                api_key,
                model,
                prompt,
                mime_type,
                image_b64,
                max_tokens,
                temperature,
            )
        attempts.append(
            {key: value for key, value in result.items() if key != "analysis"}
        )
        if ok:
            return emit(
                {
                    "ok": True,
                    "provider": "gemini",
                    "protocol": result["protocol"],
                    "model": model,
                    "imagePath": str(image_path),
                    "mimeType": mime_type,
                    "imageBytes": size,
                    "contextChars": len(context),
                    "question": question,
                    "analysis": result["analysis"],
                    "usage": result.get("usage"),
                    "diagnostics": result.get("diagnostics"),
                }
            )

    return emit(
        {
            "ok": False,
            "provider": "gemini",
            "model": model,
            "imagePath": str(image_path),
            "mimeType": mime_type,
            "attempts": attempts,
            "notes": "Gemini vision request failed",
            "retryable": any(bool(item.get("retryable")) for item in attempts),
            "nextActions": [
                "Retry once if the image is important and the failure was timeout/network related.",
                "Pass a shorter context/question and a compressed image if the request repeatedly times out.",
                "Check GEMINI_API_KEY/GEMINI_BASE_URL/GEMINI_MODEL only when the errorKind is auth, TLS, or provider HTTP failure.",
            ],
        }
    )


if __name__ == "__main__":
    raise SystemExit(main())
