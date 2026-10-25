#!/usr/bin/env python3
"""Credential-safe MatOS literature access helper.

The tool intentionally does not accept passwords, cookies, or arbitrary auth
headers from model input. It helps agents use legal access channels that are
already configured for the user: local PDF/Zotero libraries, network-level
institution proxy/VPN, and open-access resolvers.
"""
from __future__ import annotations

import json
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

DEFAULT_MAX_RESULTS = 50
DEFAULT_MAX_DEPTH = 5
HARD_MAX_RESULTS = 200
DEFAULT_LIBRARY_ROOTS = [
    "/workspace/group/shared/literature",
    "/workspace/group/literature",
    "/workspace/literature",
    "/home/workspace/Zotero",
    "/home/workspace/Documents/Zotero",
]


def read_input() -> dict[str, Any]:
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        return payload["input"]
    return payload if isinstance(payload, dict) else {}


def clamp_int(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, number))


def split_roots(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [item.strip() for item in re.split(r"[:;\n]", raw) if item.strip()]


def normalize_roots(input_roots: Any) -> list[str]:
    roots: list[str] = []
    if isinstance(input_roots, list):
        roots.extend(str(item).strip() for item in input_roots if str(item).strip())
    roots.extend(split_roots(os.environ.get("MATOS_LITERATURE_LIBRARY_ROOTS")))
    roots.extend(DEFAULT_LIBRARY_ROOTS)

    seen: set[str] = set()
    normalized: list[str] = []
    for root in roots:
        path = str(Path(root).expanduser())
        if path not in seen:
            seen.add(path)
            normalized.append(path)
    return normalized


def redacted_presence(*names: str) -> bool:
    return any(bool(os.environ.get(name)) for name in names)


def access_status(roots: list[str]) -> dict[str, Any]:
    existing_roots = [root for root in roots if Path(root).is_dir()]
    proxy_names = [
        "MATOS_LITERATURE_HTTPS_PROXY",
        "MATOS_LITERATURE_HTTP_PROXY",
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "ALL_PROXY",
    ]
    return {
        "hasLibraryRoots": bool(existing_roots),
        "libraryRoots": existing_roots,
        "configuredLibraryRootCount": len(existing_roots),
        "hasProxy": any(bool(os.environ.get(name)) for name in proxy_names),
        "proxySources": [name for name in proxy_names if os.environ.get(name)],
        "hasEzproxy": bool(os.environ.get("MATOS_LITERATURE_EZPROXY_BASE_URL")),
        "hasBrowserProfile": redacted_presence(
            "MATOS_LITERATURE_BROWSER_PROFILE",
            "MATOS_LITERATURE_COOKIE_JAR",
        ),
        "credentialPolicy": {
            "acceptsPasswordsInPrompt": False,
            "acceptsCookiesInPrompt": False,
            "secretsRedacted": True,
            "allowedAccessChannels": [
                "local_pdf_or_zotero_library",
                "institution_proxy_or_vpn",
                "ezproxy_url_rewrite",
                "user_browser_login_handoff",
                "legal_open_access_resolvers",
            ],
        },
    }


def relative_depth(root: Path, path: Path) -> int:
    try:
        return len(path.relative_to(root).parts)
    except ValueError:
        return 0


def query_matches(path: Path, query: str) -> bool:
    if not query:
        return True
    haystack = " ".join(path.parts[-4:]).lower()
    return all(token in haystack for token in re.findall(r"[\w.-]+", query.lower())[:8])


def scan_local_library(
    roots: list[str],
    query: str,
    max_results: int,
    max_depth: int,
) -> dict[str, Any]:
    pdfs: list[dict[str, Any]] = []
    bibs: list[dict[str, Any]] = []
    scanned_roots: list[str] = []
    total_pdfs = 0
    total_bibs = 0

    for root_str in roots:
        root = Path(root_str)
        if not root.is_dir():
            continue
        scanned_roots.append(str(root))
        try:
            iterator = root.rglob("*")
            for path in iterator:
                if len(pdfs) + len(bibs) >= max_results:
                    break
                if not path.is_file() or relative_depth(root, path) > max_depth:
                    continue
                suffix = path.suffix.lower()
                if suffix not in {".pdf", ".bib", ".ris", ".enw"}:
                    continue
                is_pdf = suffix == ".pdf"
                if is_pdf:
                    total_pdfs += 1
                else:
                    total_bibs += 1
                stat = path.stat()
                record = {
                    "path": str(path),
                    "name": path.name,
                    "bytes": stat.st_size,
                    "modified": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ",
                        time.gmtime(stat.st_mtime),
                    ),
                }
                if not query_matches(path, query):
                    continue
                if is_pdf:
                    pdfs.append(record)
                else:
                    bibs.append(record)
        except OSError:
            continue

    return {
        "scannedRoots": scanned_roots,
        "pdfCount": total_pdfs,
        "bibCount": total_bibs,
        "matchedPdfCount": len(pdfs),
        "matchedBibCount": len(bibs),
        "pdfs": pdfs[:max_results],
        "bibliographies": bibs[:max_results],
    }


def normalize_doi(doi: str) -> str:
    value = doi.strip()
    value = re.sub(r"^https?://(dx\.)?doi\.org/", "", value, flags=re.I)
    return value.strip()


def unpaywall_email() -> str:
    return os.environ.get("MATOS_LITERATURE_UNPAYWALL_EMAIL", "matos@matos.local")


def _readable_file(path: str | None) -> str | None:
    if isinstance(path, str) and path and os.path.isfile(path):
        return path
    return None


def ca_bundle_path() -> str | None:
    """Container Python default CA paths drift; prefer explicit bundles."""
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
        path = _readable_file(candidate)
        if path:
            return path
    return None


def https_context() -> ssl.SSLContext:
    bundle = ca_bundle_path()
    if bundle:
        return ssl.create_default_context(cafile=bundle)
    return ssl.create_default_context()


def resolve_unpaywall(doi: str) -> dict[str, Any]:
    clean = normalize_doi(doi)
    url = (
        "https://api.unpaywall.org/v2/"
        + urllib.parse.quote(clean, safe="")
        + "?email="
        + urllib.parse.quote(unpaywall_email(), safe="")
    )
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "MatOS literature-access/0.1"},
    )
    try:
        with urllib.request.urlopen(
            request, timeout=20, context=https_context()
        ) as response:
            data = json.loads(response.read().decode("utf8", "ignore"))
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        return {
            "doi": clean,
            "ok": False,
            "provider": "unpaywall",
            "notes": f"resolver failed: {exc}",
        }

    best = data.get("best_oa_location") or {}
    locations = data.get("oa_locations") if isinstance(data.get("oa_locations"), list) else []
    pdf_url = best.get("url_for_pdf")
    if not pdf_url:
        for location in locations:
            if isinstance(location, dict) and location.get("url_for_pdf"):
                pdf_url = location.get("url_for_pdf")
                break
    landing_url = best.get("url_for_landing_page") or best.get("url")
    return {
        "doi": clean,
        "ok": True,
        "provider": "unpaywall",
        "title": data.get("title"),
        "isOpenAccess": bool(data.get("is_oa")),
        "pdfUrl": pdf_url,
        "landingUrl": landing_url,
        "hostType": best.get("host_type"),
        "version": best.get("version"),
        "oaLocationCount": len(locations),
    }


def build_next_actions(query: str, dois: list[str], status: dict[str, Any]) -> list[dict[str, Any]]:
    actions: list[dict[str, Any]] = []
    for root in status.get("libraryRoots", []):
        actions.append({
            "type": "read_local_library",
            "root": root,
            "query": query,
            "tool": "mcp__matos_asset__document_parse",
        })
    for doi in dois:
        actions.append({
            "type": "resolve_open_access",
            "doi": normalize_doi(doi),
            "tool": "mcp__matos_asset__literature_access",
            "action": "resolve",
        })
    if status.get("hasProxy") or status.get("hasEzproxy"):
        actions.append({
            "type": "use_authorized_network_access",
            "method": "institution_proxy_or_ezproxy",
            "notes": "Use normal WebFetch/direct browser access through configured network access. Do not ask for credentials.",
        })
    if status.get("hasBrowserProfile"):
        actions.append({
            "type": "browser_login_handoff",
            "method": "user_private_browser_session",
            "notes": "Use the user-owned browser session only through approved browser tooling; never print cookies.",
        })
    actions.append({
        "type": "user_retrieval_checklist",
        "notes": "For unresolved paywalled papers, produce DOI/title checklist and ask the user to retrieve them with their authorized account into a workspace library root.",
    })
    return actions


def main() -> int:
    data = read_input()
    action = str(data.get("action") or "status").strip().lower()
    if action not in {"status", "plan", "scan", "resolve"}:
        action = "status"
    query = str(data.get("query") or "").strip()
    max_results = clamp_int(data.get("maxResults"), DEFAULT_MAX_RESULTS, 1, HARD_MAX_RESULTS)
    max_depth = clamp_int(data.get("maxDepth"), DEFAULT_MAX_DEPTH, 0, 8)
    roots = normalize_roots(data.get("libraryRoots"))
    status = access_status(roots)

    dois_raw = data.get("dois")
    dois = [normalize_doi(str(item)) for item in dois_raw] if isinstance(dois_raw, list) else []
    dois = [doi for doi in dois if doi][:max_results]

    payload: dict[str, Any] = {
        "ok": True,
        "action": action,
        "access": status,
        "notes": "Credential-safe helper: do not send account passwords, cookies, or tokens through chat.",
    }

    if action in {"scan", "plan"}:
        payload["localLibrary"] = scan_local_library(roots, query, max_results, max_depth)
    else:
        payload["localLibrary"] = {
            "scannedRoots": status.get("libraryRoots", []),
            "pdfCount": 0,
            "bibCount": 0,
            "pdfs": [],
            "bibliographies": [],
        }

    if action == "resolve":
        payload["resolved"] = [resolve_unpaywall(doi) for doi in dois]
    elif action == "plan":
        payload["resolved"] = []
        payload["nextActions"] = build_next_actions(query, dois, status)
    elif action == "status":
        payload["nextActions"] = build_next_actions(query, dois, status)

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
