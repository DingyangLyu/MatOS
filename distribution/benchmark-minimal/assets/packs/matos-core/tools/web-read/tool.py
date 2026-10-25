#!/usr/bin/env python3
"""MatOS web/PDF reader (Jina Reader with bounded direct fallback).

Reads any URL — HTML pages *and* PDFs — and returns clean Markdown, using the
Jina Reader service (https://r.jina.ai). Public HTML pages fall back to a
direct, SSRF-guarded reader when Jina or its network route is unavailable.

Keyless by default; set JINA_API_KEYS (or JINA_API_KEY) for higher rate limits.

Contract (MatOS asset tool runner):
  stdin : {"input": {"url": str, "max_chars"?: int}}
  stdout: one JSON object {"ok": bool, "url": str, "provider": str,
          "chars": int, "truncated": bool, "content": str, "notes"?: str}
"""
from __future__ import annotations

import hashlib
import html
import ipaddress
import json
import os
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from typing import Any

JINA_BASE = "https://r.jina.ai/"
DEFAULT_MAX_CHARS = 40000
HARD_MAX_CHARS = 120000
JINA_TIMEOUT_SECONDS = 12
DIRECT_TIMEOUT_SECONDS = 8
DIRECT_MAX_BYTES = 4 * 1024 * 1024
MIN_USEFUL_CONTENT_CHARS = 160
CACHE_TTL_SECONDS = 1800
CACHE_VERSION = "v2"
CACHE_DIR = os.path.join(
    os.environ.get("TMPDIR") or os.environ.get("TMP") or "/tmp",
    "matos-web-read-cache",
)
ARXIV_ID_PATTERN = re.compile(
    r"(?:^|/)(?:abs|pdf|html)/"
    r"(?P<id>(?:\d{4}\.\d{4,5}|[a-z][a-z.\-]+/\d{7})(?:v\d+)?)"
    r"(?:\.pdf)?(?:$|[/?#])",
    re.I,
)


def readable_file(path: object) -> str | None:
    if isinstance(path, str) and path and os.path.isfile(path):
        return path
    return None


def ca_bundle_path() -> str | None:
    candidates = [
        os.environ.get("SSL_CERT_FILE"),
        os.environ.get("REQUESTS_CA_BUNDLE"),
        os.environ.get("CURL_CA_BUNDLE"),
    ]
    try:
        import certifi  # type: ignore

        candidates.append(certifi.where())
    except Exception:
        pass
    candidates.extend(
        [
            "/etc/ssl/certs/ca-certificates.crt",
            "/opt/matos-tools/conda/envs/matos-compute/ssl/cert.pem",
        ]
    )
    for candidate in candidates:
        path = readable_file(candidate)
        if path:
            return path
    return None


def https_context() -> ssl.SSLContext:
    bundle = ca_bundle_path()
    if bundle:
        return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


class DirectReadRejected(ValueError):
    """The direct fallback URL is not a public HTTP(S) destination."""


class DirectContentUnsupported(ValueError):
    """The direct fallback cannot turn this response into useful text."""


class FetchRoutesError(RuntimeError):
    def __init__(
        self,
        attempts: list[dict[str, Any]],
        last_error: BaseException,
    ) -> None:
        super().__init__("all bounded web-read routes failed")
        self.attempts = attempts
        self.last_error = last_error


class ReadableHTMLParser(HTMLParser):
    """Small stdlib HTML-to-readable-text adapter for the network fallback."""

    SKIP_TAGS = {"script", "style", "noscript", "svg", "canvas", "template"}
    BLOCK_TAGS = {
        "article",
        "aside",
        "blockquote",
        "div",
        "footer",
        "header",
        "main",
        "nav",
        "p",
        "section",
        "table",
        "tr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(
        self,
        tag: str,
        attrs: list[tuple[str, str | None]],
    ) -> None:
        del attrs
        tag = tag.lower()
        if self.skip_depth:
            self.skip_depth += 1
            return
        if tag in self.SKIP_TAGS:
            self.skip_depth = 1
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append(f"\n\n{'#' * int(tag[1])} ")
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag == "br":
            self.parts.append("\n")
        elif tag == "pre":
            self.parts.append("\n\n```\n")
        elif tag == "code":
            self.parts.append("`")
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n\n")
        elif tag in {"td", "th"}:
            self.parts.append(" | ")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag == "pre":
            self.parts.append("\n```\n\n")
        elif tag == "code":
            self.parts.append("`")
        elif tag in self.BLOCK_TAGS or tag in {
            "h1",
            "h2",
            "h3",
            "h4",
            "h5",
            "h6",
            "li",
        }:
            self.parts.append("\n\n")

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.parts.append(data)

    def markdown(self) -> str:
        text = html.unescape("".join(self.parts))
        text = re.sub(r"[\t\f\v ]+", " ", text)
        text = re.sub(r" *\n *", "\n", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def html_to_markdown(value: str) -> str:
    parser = ReadableHTMLParser()
    parser.feed(value)
    parser.close()
    return parser.markdown()


def canonical_direct_url(url: str) -> str:
    """Use an arXiv abstract page when a PDF URL cannot be parsed directly."""

    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower().rstrip(".")
    if host not in {
        "arxiv.org",
        "www.arxiv.org",
        "export.arxiv.org",
        "ar5iv.labs.arxiv.org",
    }:
        return url
    match = ARXIV_ID_PATTERN.search(parsed.path + "/")
    if not match:
        return url
    arxiv_id = urllib.parse.quote(match.group("id"), safe="/.")
    if "/pdf/" in parsed.path.lower() or parsed.path.lower().endswith(".pdf"):
        return f"https://arxiv.org/abs/{arxiv_id}"
    return url


def validate_public_http_url(url: str) -> None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise DirectReadRejected("direct fallback requires a valid http(s) URL")
    if parsed.username or parsed.password:
        raise DirectReadRejected("direct fallback rejects URLs with embedded credentials")
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise DirectReadRejected("direct fallback URL has an invalid port") from exc
    if port not in {80, 443}:
        raise DirectReadRejected("direct fallback only permits public HTTP(S) ports")
    host = parsed.hostname.rstrip(".")
    try:
        literal = ipaddress.ip_address(host)
        addresses = [literal]
    except ValueError:
        try:
            addresses = [
                ipaddress.ip_address(item[4][0])
                for item in socket.getaddrinfo(
                    host,
                    port,
                    type=socket.SOCK_STREAM,
                )
            ]
        except (OSError, ValueError) as exc:
            raise DirectReadRejected("direct fallback could not resolve the public host") from exc
    if not addresses or any(not address.is_global for address in addresses):
        raise DirectReadRejected("direct fallback rejects non-public network addresses")


class PublicRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self,
        req: urllib.request.Request,
        fp: Any,
        code: int,
        msg: str,
        headers: Any,
        newurl: str,
    ) -> urllib.request.Request | None:
        validate_public_http_url(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def redacted_url(value: str) -> str:
    if not value:
        return ""
    parsed = urllib.parse.urlsplit(value)
    if not parsed.scheme or not parsed.netloc:
        return value
    host = parsed.hostname or ""
    if parsed.port:
        host = f"{host}:{parsed.port}"
    if parsed.username or parsed.password:
        host = f"<redacted>@{host}"
    return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, parsed.query, parsed.fragment))


def redacted_proxy_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    if not parsed.scheme or not parsed.hostname:
        return "<configured>"
    host = parsed.hostname
    if parsed.port:
        host = f"{host}:{parsed.port}"
    if parsed.username or parsed.password:
        host = f"<redacted>@{host}"
    return urllib.parse.urlunsplit((parsed.scheme, host, "", "", ""))


def first_env_value(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def web_read_proxy_env() -> dict[str, str]:
    http_proxy = first_env_value(
        "MATOS_WEB_READ_HTTP_PROXY",
        "MATOS_JINA_HTTP_PROXY",
        "MATOS_WEB_PROXY_URL",
        "MATOS_CONTAINER_PROXY_URL",
        "MATOS_PAPER_DB_HTTP_PROXY",
        "http_proxy",
        "HTTP_PROXY",
        "ALL_PROXY",
        "all_proxy",
    )
    https_proxy = first_env_value(
        "MATOS_WEB_READ_HTTPS_PROXY",
        "MATOS_JINA_HTTPS_PROXY",
        "MATOS_WEB_PROXY_URL",
        "MATOS_CONTAINER_PROXY_URL",
        "MATOS_PAPER_DB_HTTPS_PROXY",
        "https_proxy",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "all_proxy",
    )
    proxies: dict[str, str] = {}
    if http_proxy:
        proxies["http"] = http_proxy
        if not https_proxy:
            proxies["https"] = http_proxy
    if https_proxy:
        proxies["https"] = https_proxy
    return proxies


def web_read_opener() -> urllib.request.OpenerDirector | None:
    proxies = web_read_proxy_env()
    if not proxies:
        return None
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(proxies),
        urllib.request.HTTPSHandler(context=https_context()),
        PublicRedirectHandler(),
    )


def direct_web_opener() -> urllib.request.OpenerDirector:
    return urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=https_context()),
        PublicRedirectHandler(),
    )


def cache_path(url: str, max_chars: int) -> str:
    digest = hashlib.sha256(
        f"{CACHE_VERSION}|{url}|{max_chars}".encode("utf8")
    ).hexdigest()
    return os.path.join(CACHE_DIR, f"{digest}.json")


def read_cache(path: str) -> dict | None:
    try:
        if time.time() - os.path.getmtime(path) > CACHE_TTL_SECONDS:
            return None
        with open(path, "r", encoding="utf8") as handle:
            return json.load(handle)
    except Exception:  # noqa: BLE001 - cache is best-effort
        return None


def write_cache(path: str, payload: dict) -> None:
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with open(path, "w", encoding="utf8") as handle:
            json.dump(payload, handle, ensure_ascii=False)
    except Exception:  # noqa: BLE001 - cache is best-effort
        pass


def fetch_jina_once(
    url: str,
    headers: dict,
    opener: urllib.request.OpenerDirector | None,
) -> str:
    request = urllib.request.Request(JINA_BASE + url, headers=headers)
    if opener:
        with opener.open(request, timeout=JINA_TIMEOUT_SECONDS) as response:
            return response.read().decode("utf8", "ignore")
    with urllib.request.urlopen(
        request,
        timeout=JINA_TIMEOUT_SECONDS,
        context=https_context(),
    ) as response:
        return response.read().decode("utf8", "ignore")


def useful_jina_content(body: str) -> str:
    content = body.strip()
    lowered = content[:500].lower()
    if len(content) < MIN_USEFUL_CONTENT_CHARS:
        raise DirectContentUnsupported("Jina returned too little readable content")
    if (
        "target url returned error" in lowered
        or "securitycompromiseerror" in lowered
        or lowered.startswith("upstream error")
    ):
        raise DirectContentUnsupported("Jina returned an upstream error document")
    return content


def attempt_failure(
    route: str,
    error: BaseException,
    started: float,
) -> dict[str, Any]:
    return {
        "route": route,
        "elapsedMs": round((time.monotonic() - started) * 1000),
        "errorKind": classify_fetch_error(error)["errorKind"],
    }


def fetch_jina(
    url: str,
    headers: dict,
) -> tuple[str, list[dict[str, Any]], str]:
    proxy_opener = web_read_opener()
    candidates: list[tuple[str, urllib.request.OpenerDirector]] = []
    if proxy_opener:
        candidates.append(("jina-proxy", proxy_opener))
    candidates.append(("jina-direct", direct_web_opener()))
    attempts: list[dict[str, Any]] = []
    last_error: Exception | None = None
    for route, candidate in candidates:
        started = time.monotonic()
        try:
            return useful_jina_content(
                fetch_jina_once(url, headers, candidate)
            ), attempts, route
        except Exception as exc:  # noqa: BLE001 - continue to the next bounded route
            last_error = exc
            attempts.append(attempt_failure(route, exc, started))
    raise FetchRoutesError(
        attempts,
        last_error or RuntimeError("Jina read failed without a diagnostic"),
    )


def fetch_direct_once(
    url: str,
    headers: dict,
    opener: urllib.request.OpenerDirector,
) -> tuple[str, str]:
    direct_url = canonical_direct_url(url)
    validate_public_http_url(direct_url)
    request_headers = {
        **headers,
        "Accept": "text/html,application/xhtml+xml,text/plain,application/xml;q=0.9,*/*;q=0.1",
    }
    request = urllib.request.Request(direct_url, headers=request_headers)
    with opener.open(request, timeout=DIRECT_TIMEOUT_SECONDS) as response:
        final_url = response.geturl()
        validate_public_http_url(final_url)
        content_type = response.headers.get_content_type().lower()
        raw = response.read(DIRECT_MAX_BYTES + 1)
        if len(raw) > DIRECT_MAX_BYTES:
            raw = raw[:DIRECT_MAX_BYTES]
        charset = response.headers.get_content_charset() or "utf8"
    try:
        decoded = raw.decode(charset, "ignore")
    except LookupError:
        decoded = raw.decode("utf8", "ignore")
    if content_type in {"text/html", "application/xhtml+xml"}:
        content = html_to_markdown(decoded)
    elif (
        content_type.startswith("text/")
        or content_type.endswith("+xml")
        or content_type in {"application/json", "application/xml"}
    ):
        content = decoded.strip()
    else:
        raise DirectContentUnsupported(
            f"direct fallback cannot parse content type {content_type or 'unknown'}"
        )
    if len(content) < MIN_USEFUL_CONTENT_CHARS:
        raise DirectContentUnsupported("direct fallback returned too little readable content")
    return content, final_url


def fetch_direct(
    url: str,
    headers: dict,
    previous_attempts: list[dict[str, Any]],
) -> tuple[str, str, list[dict[str, Any]], str]:
    proxy_opener = web_read_opener()
    candidates: list[tuple[str, urllib.request.OpenerDirector]] = []
    if proxy_opener:
        candidates.append(("origin-proxy", proxy_opener))
    candidates.append(("origin-direct", direct_web_opener()))
    attempts = list(previous_attempts)
    last_error: Exception | None = None
    for route, candidate in candidates:
        started = time.monotonic()
        try:
            content, final_url = fetch_direct_once(url, headers, candidate)
            return content, final_url, attempts, route
        except Exception as exc:  # noqa: BLE001 - continue to the next bounded route
            last_error = exc
            attempts.append(attempt_failure(route, exc, started))
    raise FetchRoutesError(
        attempts,
        last_error or RuntimeError("direct read failed without a diagnostic"),
    )


def classify_fetch_error(error: BaseException) -> dict:
    message = str(error)
    if isinstance(error, DirectReadRejected):
        return {
            "errorKind": "direct_url_rejected",
            "retryable": False,
            "nextActions": [
                "Use a public HTTP(S) URL without embedded credentials or private-network addresses.",
                "Use the appropriate authenticated MCP connector for private resources.",
            ],
        }
    if isinstance(error, DirectContentUnsupported):
        return {
            "errorKind": "unsupported_or_empty_content",
            "retryable": False,
            "nextActions": [
                "For a paper with a DOI, call mcp__matos_asset__literature_access.",
                "For a PDF already in the workspace, call mcp__matos_asset__document_parse.",
            ],
        }
    if isinstance(error, urllib.error.HTTPError):
        retryable = error.code in {408, 425, 429, 500, 502, 503, 504}
        return {
            "errorKind": f"http_{error.code}",
            "retryable": retryable,
            "nextActions": (
                [
                    "Retry with the same URL after a short delay.",
                    "If this repeats, locate a canonical URL with WebSearch or mcp__matos_asset__deep_research_search.",
                ]
                if retryable
                else [
                    "Check whether the URL is public, stable, and not blocked by the upstream site.",
                    "Try a canonical DOI or call mcp__matos_asset__literature_access when this is a paper.",
                ]
            ),
        }
    lowered = message.lower()
    errno = getattr(error, "errno", None)
    if errno == 99 or "cannot assign requested address" in lowered:
        return {
            "errorKind": "network_address_unavailable",
            "retryable": True,
            "nextActions": [
                "Retry once after a short delay; this usually indicates a transient container or proxy networking issue.",
                "If repeated, check MATOS_WEB_READ_* proxy settings and the host proxy relay.",
            ],
        }
    if "timed out" in lowered or "timeout" in lowered:
        return {
            "errorKind": "timeout",
            "retryable": True,
            "nextActions": [
                "Do not immediately fan out repeated web_read calls; the tool already tried bounded proxy and direct routes.",
                "For papers with a DOI, use mcp__matos_asset__literature_access.",
            ],
        }
    if "certificate" in lowered or "ssl" in lowered:
        return {
            "errorKind": "tls_or_certificate",
            "retryable": False,
            "nextActions": [
                "Check SSL_CERT_FILE/REQUESTS_CA_BUNDLE or the managed container CA bundle.",
                "Do not disable certificate verification silently.",
            ],
        }
    if "name or service not known" in lowered or "temporary failure in name resolution" in lowered:
        return {
            "errorKind": "dns_resolution_failed",
            "retryable": True,
            "nextActions": [
                "Retry after a short delay.",
                "If repeated, check container DNS and proxy configuration.",
            ],
        }
    return {
        "errorKind": "network_or_provider_error",
        "retryable": True,
        "nextActions": [
            "Retry once if the page is important.",
            "If repeated, use WebSearch or mcp__matos_asset__deep_research_search to locate an alternate source.",
        ],
    }


def proxy_note() -> str | None:
    proxies = web_read_proxy_env()
    if not proxies:
        return None
    return "used web-read proxy " + ", ".join(
        f"{scheme}={redacted_proxy_url(value)}"
        for scheme, value in sorted(proxies.items())
    )


def read_input() -> dict:
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        return payload["input"]
    return payload if isinstance(payload, dict) else {}


def clamp_max_chars(value: object) -> int:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_MAX_CHARS
    return max(500, min(HARD_MAX_CHARS, n))


def jina_key() -> str:
    raw = os.environ.get("JINA_API_KEYS") or os.environ.get("JINA_API_KEY") or ""
    return raw.split(",")[0].strip()


def main() -> int:
    data = read_input()
    url = str(data.get("url") or "").strip()
    if not url or not url.startswith(("http://", "https://")):
        print(json.dumps({"ok": False, "url": url, "provider": "jina", "chars": 0,
                          "truncated": False, "content": "",
                          "notes": "a valid http(s) url is required"}))
        return 0

    max_chars = clamp_max_chars(data.get("max_chars"))
    cache_file = cache_path(url, max_chars)
    cached = read_cache(cache_file)
    if cached is not None:
        cached["cached"] = True
        print(json.dumps(cached, ensure_ascii=False))
        return 0

    common_headers = {
        "User-Agent": "MatOS web-read/0.2",
    }
    jina_headers = {
        **common_headers,
        "X-Return-Format": "markdown",
    }
    key = jina_key()
    if key:
        jina_headers["Authorization"] = f"Bearer {key}"

    provider = "jina"
    source_url = url
    attempts: list[dict[str, Any]] = []
    try:
        body, attempts, route = fetch_jina(url, jina_headers)
    except FetchRoutesError as jina_error:
        try:
            body, source_url, attempts, route = fetch_direct(
                url,
                common_headers,
                jina_error.attempts,
            )
            provider = "direct-html"
        except FetchRoutesError as all_error:
            diagnostic = classify_fetch_error(all_error.last_error)
            print(
                json.dumps(
                    {
                        "ok": False,
                        "url": url,
                        "provider": "jina+direct",
                        "chars": 0,
                        "truncated": False,
                        "content": "",
                        "notes": "all bounded Jina and direct-read routes failed",
                        "attempts": all_error.attempts,
                        **diagnostic,
                    }
                )
            )
            return 0

    truncated = len(body) > max_chars
    content = body[:max_chars]
    note = proxy_note()
    notes = []
    if truncated:
        notes.append(f"truncated to {max_chars} chars; request a larger max_chars or a more specific URL")
    if attempts:
        notes.append(f"fallback succeeded after {len(attempts)} failed route(s)")
    if note and route.endswith("-proxy"):
        notes.append(note)

    payload = {
        "ok": True,
        "url": url,
        "sourceUrl": source_url,
        "provider": provider,
        "route": route,
        "chars": len(content),
        "truncated": truncated,
        "content": content,
        **({"attempts": attempts} if attempts else {}),
        **({"notes": "; ".join(notes)} if notes else {}),
    }
    write_cache(cache_file, payload)
    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
