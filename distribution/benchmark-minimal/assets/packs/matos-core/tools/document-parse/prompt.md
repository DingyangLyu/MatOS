Extract text from a LOCAL document file (PDF, DOCX, HTML, TXT/MD/CSV/JSON, etc.).

Use this when the user references a file in the workspace and you need its text
content (e.g. a PDF paper, a report, a dataset description).

Guidance:
- Pass `path` to a local file. For a document on the web (a URL or online PDF),
  use `web_read` instead — this tool is for local files only.
- Returns extracted `text`. If `truncated` is true, continue with
  `start_char=next_start_char` or request a larger `max_chars`; do not assume
  missing later text was absent from the document.
- PDF extraction prefers pdftotext and falls back to PyMuPDF/pypdf/PyPDF2 when
  available; DOCX uses python-docx; HTML uses BeautifulSoup; other office
  formats are converted via LibreOffice when available. If `ok` is false, read
  `notes` (a dependency may be unavailable in this runtime).
- Quote and cite only content you actually extracted.
- For formulas, equations, variables, units, LaTeX/MathML fragments, and table
  fragments, preserve the source text verbatim. Do not translate formulas. If
  PDF extraction makes a formula unreadable, say the formula extraction is
  noisy and omit or summarize the surrounding prose instead of inventing or
  "fixing" the equation.
