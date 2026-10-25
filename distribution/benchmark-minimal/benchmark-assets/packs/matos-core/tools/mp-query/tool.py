#!/usr/bin/env python3
"""MatOS external tool: Materials Project query.

Contract with the engine bridge (see
`engine/src/tools/_matos_external/dispatch.ts:runSubprocess`):

  stdin:  JSON `{ "input": <user arg object>, ... }`
  stdout: plain text that the bridge hands to the LLM verbatim
  exit 0: success
  exit != 0: treated as error; stderr message surfaces to the LLM

This keeps the dependency surface minimal — only `urllib` + stdlib JSON.
When `mp_api` / `pymatgen` are available we'd layer in the official
SDK, but pinning a heavy dep in the baseline tool would bloat every
container. Users who need rich pymatgen Structure objects can fork
this tool and swap in the SDK.
"""
from __future__ import annotations

import json
import os
import ssl
import sys
from typing import Any, Iterable
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode

MP_API_BASE = "https://api.materialsproject.org"
MP_SUMMARY_PATH = "/materials/summary/"
DEFAULT_FIELDS = [
    "material_id",
    "formula_pretty",
    "band_gap",
    "formation_energy_per_atom",
    "energy_above_hull",
    "volume",
    "density",
    "nsites",
    "symmetry",
]


def fail(msg: str, code: int = 1) -> None:
    sys.stderr.write(msg + "\n")
    sys.exit(code)


def read_input() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        fail("empty stdin — expected JSON payload")
    try:
        blob = json.loads(raw)
    except json.JSONDecodeError as err:
        fail(f"stdin is not valid JSON: {err}")
    inp = blob.get("input") if isinstance(blob, dict) else None
    if not isinstance(inp, dict):
        fail("stdin missing `input` object")
    return inp


def _https_context() -> ssl.SSLContext:
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
    candidates.append("/etc/ssl/certs/ca-certificates.crt")
    for candidate in candidates:
        if isinstance(candidate, str) and candidate and os.path.isfile(candidate):
            return ssl.create_default_context(cafile=candidate)
    return ssl.create_default_context()


def request_mp(
    path: str,
    params: dict[str, Any],
    api_key: str,
    fields: Iterable[str],
    limit: int,
) -> Any:
    # Materials Project REST v2 expects `_fields` + `_limit` plus
    # tag-value filters as plain strings. Lists go as CSV.
    query: dict[str, str] = {
        "_fields": ",".join(fields),
        "_limit": str(limit),
    }
    for key, value in params.items():
        if isinstance(value, (list, tuple)):
            query[key] = ",".join(str(v) for v in value)
        else:
            query[key] = str(value)
    url = f"{MP_API_BASE}{path}?{urlencode(query)}"
    req = urlrequest.Request(
        url,
        headers={
            "X-API-KEY": api_key,
            "User-Agent": "MatOS/mp-query-tool",
            "Accept": "application/json",
        },
    )
    with urlrequest.urlopen(req, timeout=25, context=_https_context()) as resp:
        return json.loads(resp.read().decode("utf-8"))


def format_entry(entry: dict[str, Any]) -> str:
    mid = entry.get("material_id") or "?"
    formula = entry.get("formula_pretty") or "?"
    lines = [f"{mid}  {formula}"]
    for key in ("band_gap", "formation_energy_per_atom", "energy_above_hull"):
        if key in entry and entry[key] is not None:
            lines.append(f"  {key}: {entry[key]:.4f}")
    if "symmetry" in entry and isinstance(entry["symmetry"], dict):
        sym = entry["symmetry"]
        sg = sym.get("symbol") or sym.get("crystal_system") or ""
        if sg:
            lines.append(f"  symmetry: {sg}")
    if "volume" in entry and entry["volume"] is not None:
        lines.append(f"  volume: {entry['volume']:.2f} Å³")
    if "density" in entry and entry["density"] is not None:
        lines.append(f"  density: {entry['density']:.3f} g/cm³")
    return "\n".join(lines)


def main() -> int:
    api_key = os.environ.get("MP_API_KEY")
    if not api_key:
        fail(
            "MP_API_KEY not set. Get a key from https://materialsproject.org/"
            " and add it to the session secrets."
        )

    inp = read_input()
    fields = inp.get("fields") or DEFAULT_FIELDS
    if not isinstance(fields, list) or not all(isinstance(f, str) for f in fields):
        fail("`fields` must be a list of strings")
    limit = int(inp.get("limit") or 20)
    if "material_id" in inp and inp["material_id"]:
        params = {"material_ids": str(inp["material_id"])}
        try:
            payload = request_mp(MP_SUMMARY_PATH, params, api_key, fields, 1)
        except HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")[:200]
            fail(f"Materials Project HTTP {err.code}: {err.reason} — {body}")
        except URLError as err:
            fail(f"Materials Project unreachable: {err.reason}")
        except TimeoutError:
            fail("Materials Project request timed out")
    elif "formula" in inp and inp["formula"]:
        params = {"formula": str(inp["formula"])}
        try:
            payload = request_mp(MP_SUMMARY_PATH, params, api_key, fields, limit)
        except HTTPError as err:
            body = err.read().decode("utf-8", errors="replace")[:200]
            fail(f"Materials Project HTTP {err.code}: {err.reason} — {body}")
        except URLError as err:
            fail(f"Materials Project unreachable: {err.reason}")
        except TimeoutError:
            fail("Materials Project request timed out")
    else:
        fail("input must include either `formula` or `material_id`")

    entries = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        fail("unexpected MP API response shape")

    if not entries:
        print("No matching entries.")
        return 0

    print(f"Found {len(entries)} entr{'y' if len(entries) == 1 else 'ies'}:")
    for entry in entries:
        print()
        print(format_entry(entry))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        fail("interrupted")
