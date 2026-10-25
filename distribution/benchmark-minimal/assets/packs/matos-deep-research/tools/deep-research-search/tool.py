#!/usr/bin/env python3
"""MatOS deep-research scholarly search tool.

Provider-agnostic literature search for the deep-research agent. The built-in
WebSearch tool relies on the Anthropic server-side `web_search` tool and is
disabled for non-Anthropic providers (e.g. DeepSeek), so the agent needs a
real, model-provider-independent search path. This tool queries the OpenAlex
scholarly API (no key required) and returns clean, citable source records the
agent can archive and cite.

Contract (MatOS asset tool runner):
  stdin : {"input": {"query": str, "limit"?: int, "from_year"?: int,
                      "kind"?: "works"}}
  stdout: one JSON object {"ok": bool, "query": str, "count": int,
          "results": [{id,title,doi,url,year,venue,authors,
                       citedByCount,type,abstract}], "notes"?: str}

The tool never raises for network problems; it returns ok=false with an error
note so the agent can adapt (e.g. broaden the query or fall back to WebFetch).
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

OPENALEX_WORKS = "https://api.openalex.org/works"
DEFAULT_LIMIT = 6
MAX_LIMIT = 15
ABSTRACT_MAX_CHARS = 1200
DEFAULT_OPENALEX_ATTEMPTS = 3
MAX_OPENALEX_ATTEMPTS = 5
RETRYABLE_HTTP_STATUSES = {408, 425, 429, 500, 502, 503, 504}


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


def read_input() -> dict:
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        return payload["input"]
    return payload if isinstance(payload, dict) else {}


def clamp_limit(value: object) -> int:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    return max(1, min(MAX_LIMIT, n))


def openalex_attempts() -> int:
    try:
        attempts = int(os.environ.get(
            "MATOS_DEEP_RESEARCH_OPENALEX_ATTEMPTS",
            str(DEFAULT_OPENALEX_ATTEMPTS),
        ))
    except ValueError:
        return DEFAULT_OPENALEX_ATTEMPTS
    return max(1, min(MAX_OPENALEX_ATTEMPTS, attempts))


def retry_delay_seconds(attempt: int, error: Exception) -> float:
    if isinstance(error, urllib.error.HTTPError):
        retry_after = error.headers.get("Retry-After") if error.headers else None
        try:
            if retry_after is not None:
                return max(0.1, min(5.0, float(retry_after)))
        except ValueError:
            pass
    return min(2.0, 0.35 * (2 ** max(0, attempt - 1)))


def retryable_openalex_error(error: Exception) -> bool:
    if isinstance(error, urllib.error.HTTPError):
        return error.code in RETRYABLE_HTTP_STATUSES
    return isinstance(
        error,
        (urllib.error.URLError, TimeoutError, ssl.SSLError, ConnectionError),
    )


def reconstruct_abstract(inverted_index: object) -> str:
    if not isinstance(inverted_index, dict) or not inverted_index:
        return ""
    positions: list[tuple[int, str]] = []
    for word, idxs in inverted_index.items():
        if not isinstance(idxs, list):
            continue
        for idx in idxs:
            if isinstance(idx, int):
                positions.append((idx, str(word)))
    if not positions:
        return ""
    positions.sort(key=lambda item: item[0])
    text = " ".join(word for _pos, word in positions)
    return text[:ABSTRACT_MAX_CHARS]


def extract_authors(authorships: object, limit: int = 6) -> list[str]:
    authors: list[str] = []
    if isinstance(authorships, list):
        for entry in authorships:
            if not isinstance(entry, dict):
                continue
            author = entry.get("author")
            if isinstance(author, dict):
                name = author.get("display_name")
                if isinstance(name, str) and name.strip():
                    authors.append(name.strip())
            if len(authors) >= limit:
                break
    return authors


def extract_venue(primary_location: object) -> str:
    if isinstance(primary_location, dict):
        source = primary_location.get("source")
        if isinstance(source, dict):
            name = source.get("display_name")
            if isinstance(name, str):
                return name.strip()
    return ""


def best_url(item: dict, doi: str, openalex_id: str) -> str:
    primary = item.get("primary_location")
    if isinstance(primary, dict):
        landing = primary.get("landing_page_url")
        if isinstance(landing, str) and landing.startswith("http"):
            return landing
    if doi:
        return doi if doi.startswith("http") else f"https://doi.org/{doi}"
    return openalex_id


def fetch_works(query: str, limit: int, from_year: object) -> dict:
    params = {
        "search": query,
        "per-page": str(limit),
        "select": (
            "id,display_name,doi,publication_year,authorships,"
            "primary_location,cited_by_count,abstract_inverted_index,type"
        ),
        "sort": "relevance_score:desc",
    }
    try:
        year = int(from_year)  # type: ignore[arg-type]
        params["filter"] = f"from_publication_date:{year}-01-01"
    except (TypeError, ValueError):
        pass
    url = f"{OPENALEX_WORKS}?{urllib.parse.urlencode(params)}"
    mailto = os.environ.get("MATOS_DEEP_RESEARCH_MAILTO", "matos.local")
    request = urllib.request.Request(
        url,
        headers={"User-Agent": f"MatOS deep-research search/0.1 (mailto:{mailto})"},
    )
    attempts = openalex_attempts()
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(
                request,
                timeout=20,
                context=https_context(),
            ) as response:
                return json.loads(response.read().decode("utf8"))
        except Exception as exc:  # noqa: BLE001 - classify before retrying
            if attempt >= attempts or not retryable_openalex_error(exc):
                raise
            time.sleep(retry_delay_seconds(attempt, exc))
    raise RuntimeError("openalex retry loop exited unexpectedly")


def main() -> int:
    data = read_input()
    query = str(data.get("query") or "").strip()
    if not query:
        print(json.dumps({"ok": False, "query": "", "count": 0, "results": [],
                          "notes": "query is required"}))
        return 0

    limit = clamp_limit(data.get("limit"))

    if os.environ.get("MATOS_DEEP_RESEARCH_OFFLINE_SOURCES") == "1":
        print(json.dumps({"ok": False, "query": query, "count": 0, "results": [],
                          "notes": "offline mode (MATOS_DEEP_RESEARCH_OFFLINE_SOURCES=1)"}))
        return 0

    try:
        payload = fetch_works(query, limit, data.get("from_year"))
    except Exception as exc:  # noqa: BLE001 - report, never crash the agent
        print(json.dumps({"ok": False, "query": query, "count": 0, "results": [],
                          "notes": f"openalex request failed: {exc}"}))
        return 0

    raw_results = payload.get("results")
    if not isinstance(raw_results, list):
        print(json.dumps({"ok": False, "query": query, "count": 0, "results": [],
                          "notes": "openalex returned no results array"}))
        return 0

    results = []
    for item in raw_results:
        if not isinstance(item, dict):
            continue
        title = str(item.get("display_name") or "").strip()
        if not title:
            continue
        doi = str(item.get("doi") or "").strip()
        openalex_id = str(item.get("id") or "").strip()
        results.append({
            "id": openalex_id,
            "title": title,
            "doi": doi,
            "url": best_url(item, doi, openalex_id),
            "year": item.get("publication_year"),
            "venue": extract_venue(item.get("primary_location")),
            "authors": extract_authors(item.get("authorships")),
            "citedByCount": item.get("cited_by_count"),
            "type": item.get("type"),
            "abstract": reconstruct_abstract(item.get("abstract_inverted_index")),
        })

    print(json.dumps({
        "ok": True,
        "query": query,
        "count": len(results),
        "results": results,
        "notes": "source: OpenAlex (api.openalex.org). Fetch URLs with WebFetch for full text.",
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
