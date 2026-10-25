#!/usr/bin/env python3
"""MatOS local document parser.

Extracts plain text from a local file so the deep-research agent can read
documents the user placed in the workspace. Handles the common research formats
with graceful degradation when an optional dependency is missing:

  .pdf            -> pdftotext (poppler) CLI
  .docx           -> python-docx
  .html/.htm      -> BeautifulSoup (bs4)
  .txt/.md/.csv/.tsv/.json/.log/.rst/.yaml/.yml -> plain UTF-8 read
  other office    -> libreoffice --headless --convert-to txt (best effort)

For remote documents (a URL/PDF on the web) use the web_read tool instead.

Contract (MatOS asset tool runner):
  stdin : {"input": {"path": str, "max_chars"?: int, "start_char"?: int}}
  stdout: one JSON object {"ok": bool, "path": str, "type": str, "chars": int,
          "truncated": bool, "text": str, "next_start_char"?: int,
          "notes"?: str}
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from shutil import which

DEFAULT_MAX_CHARS = 60000
HARD_MAX_CHARS = 200000
PLAIN_EXTS = {
    ".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".rst",
    ".yaml", ".yml", ".text",
}
OFFICE_EXTS = {".doc", ".ppt", ".pptx", ".odt", ".odp", ".rtf", ".xlsx", ".xls"}


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


def clamp_start_char(value: object) -> int:
    try:
        n = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
    return max(0, n)


def parse_pdf(path: str) -> str:
    if not _which("pdftotext"):
        errors: list[str] = ["pdftotext not available"]
        for parser_name, parser in (
            ("pymupdf", parse_pdf_with_pymupdf),
            ("pypdf", parse_pdf_with_pypdf),
            ("PyPDF2", parse_pdf_with_pypdf2),
        ):
            try:
                text = parser(path)
                if text.strip():
                    return text
                errors.append(f"{parser_name} returned no text")
            except Exception as exc:  # noqa: BLE001 - optional parser fallback
                errors.append(f"{parser_name}: {exc}")
        raise RuntimeError(
            "PDF extraction dependencies unavailable. Install poppler-utils "
            "for pdftotext, or install pymupdf/pypdf. Tried: "
            + "; ".join(errors)
        )
    result = subprocess.run(
        ["pdftotext", "-layout", "-nopgbrk", "-enc", "UTF-8", path, "-"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=90,
    )
    if result.returncode != 0:
        raise RuntimeError(
            result.stderr.decode("utf8", "ignore").strip() or "pdftotext failed"
        )
    return result.stdout.decode("utf8", "replace")


def parse_pdf_with_pymupdf(path: str) -> str:
    import fitz  # type: ignore

    with fitz.open(path) as document:
        return "\n".join(page.get_text("text") for page in document)


def parse_pdf_with_pypdf(path: str) -> str:
    from pypdf import PdfReader  # type: ignore

    reader = PdfReader(path)
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def parse_pdf_with_pypdf2(path: str) -> str:
    from PyPDF2 import PdfReader  # type: ignore

    reader = PdfReader(path)
    return "\n".join(page.extract_text() or "" for page in reader.pages)


def parse_docx(path: str) -> str:
    import docx  # type: ignore

    document = docx.Document(path)
    return "\n".join(p.text for p in document.paragraphs)


def parse_html(path: str) -> str:
    from bs4 import BeautifulSoup  # type: ignore

    with open(path, "r", encoding="utf8", errors="ignore") as handle:
        soup = BeautifulSoup(handle.read(), "html.parser")
    for tag in soup(["script", "style"]):
        tag.decompose()
    return soup.get_text("\n")


def parse_plain(path: str) -> str:
    with open(path, "r", encoding="utf8", errors="ignore") as handle:
        return handle.read()


def normalize_extracted_text(text: str) -> str:
    # Keep normal research text intact, but remove control bytes that can make
    # browser/chat renderers appear to drop surrounding content.
    return "".join(
        char
        if char in {"\n", "\r", "\t"} or ord(char) >= 32
        else " "
        for char in text
    ).replace("\r\n", "\n").replace("\r", "\n")


def boundary_clip(text: str, start_char: int, max_chars: int) -> tuple[str, bool, int | None]:
    if start_char >= len(text):
        return "", False, None
    hard_end = min(len(text), start_char + max_chars)
    if hard_end >= len(text):
        return text[start_char:], False, None

    window = text[start_char:hard_end]
    # Prefer a paragraph/line/sentence boundary near the end. This avoids
    # cutting formulas, citations, and CJK prose in the middle, which users read
    # as swallowed text. Do not shorten tiny chunks too aggressively.
    min_end = max(int(len(window) * 0.72), 500)
    candidates = [
        window.rfind("\n\n"),
        window.rfind("\n"),
        window.rfind(". "),
        window.rfind("。"),
        window.rfind("; "),
        window.rfind("；"),
    ]
    relative_end = max(candidates)
    if relative_end >= min_end:
        clipped_end = start_char + relative_end + 1
    else:
        clipped_end = hard_end
    return text[start_char:clipped_end], True, clipped_end


def parse_office_via_libreoffice(path: str) -> str:
    if not _which("libreoffice"):
        raise RuntimeError("libreoffice not available for this format")
    with tempfile.TemporaryDirectory() as tmp:
        result = subprocess.run(
            ["libreoffice", "--headless", "--convert-to", "txt:Text", "--outdir", tmp, path],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=120,
        )
        if result.returncode != 0:
            raise RuntimeError(
                result.stderr.decode("utf8", "ignore").strip() or "libreoffice convert failed"
            )
        base = os.path.splitext(os.path.basename(path))[0] + ".txt"
        out_path = os.path.join(tmp, base)
        if not os.path.exists(out_path):
            raise RuntimeError("libreoffice produced no output")
        return parse_plain(out_path)


def _which(cmd: str) -> bool:
    return which(cmd) is not None


def extract(path: str) -> tuple[str, str]:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        return "pdf", parse_pdf(path)
    if ext == ".docx":
        return "docx", parse_docx(path)
    if ext in {".html", ".htm"}:
        return "html", parse_html(path)
    if ext in PLAIN_EXTS:
        return "text", parse_plain(path)
    if ext in OFFICE_EXTS:
        return "office", parse_office_via_libreoffice(path)
    # Unknown extension: attempt a plain UTF-8 read as a last resort.
    return "text", parse_plain(path)


def main() -> int:
    data = read_input()
    path = str(data.get("path") or "").strip()
    if not path:
        print(json.dumps({"ok": False, "path": "", "type": "", "chars": 0,
                          "truncated": False, "text": "", "notes": "path is required"}))
        return 0
    if not os.path.isfile(path):
        print(json.dumps({"ok": False, "path": path, "type": "", "chars": 0,
                          "truncated": False, "text": "",
                          "notes": "file not found (use web_read for URLs)"}))
        return 0

    max_chars = clamp_max_chars(data.get("max_chars"))
    start_char = clamp_start_char(data.get("start_char"))
    try:
        kind, text = extract(path)
    except Exception as exc:  # noqa: BLE001 - report, never crash the agent
        print(json.dumps({"ok": False, "path": path, "type": "", "chars": 0,
                          "truncated": False, "text": "",
                          "notes": f"parse failed: {exc}"}))
        return 0

    text = normalize_extracted_text(text)
    clipped, truncated, next_start_char = boundary_clip(text, start_char, max_chars)
    notes: list[str] = []
    if truncated:
        notes.append(f"truncated to {len(clipped)} chars; continue with start_char={next_start_char}")
    if kind == "pdf":
        notes.append(
            "PDF text extraction may render formulas/tables noisily; preserve "
            "formula snippets verbatim or omit noisy formulas instead of translating them."
        )
    print(json.dumps({
        "ok": True,
        "path": path,
        "type": kind,
        "chars": len(clipped),
        "total_chars": len(text),
        "start_char": start_char,
        "truncated": truncated,
        "text": clipped,
        **({"next_start_char": next_start_char} if next_start_char is not None else {}),
        **({"notes": " ".join(notes)} if notes else {}),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
