Search scholarly literature (OpenAlex) for source-backed deep research.

Use this tool to discover real, citable scholarly sources when you need current
or source-dependent evidence. Use it alongside WebSearch/WebFetch, not as a
replacement: this tool is for scholarly metadata, WebSearch is for the broader
public web, and WebFetch/`mcp__matos_asset__web_read` reads selected URLs.

Guidance:
- Call with a focused `query`. Run several narrower queries instead of one broad
  query; expand or refine based on what you find.
- Each result includes `title`, `authors`, `year`, `venue`, `doi`, `url`,
  `citedByCount`, and a reconstructed `abstract`. Assign each kept source a
  stable source ID (S001, S002, ...) and record it in your source ledger.
- To read a source's full text, pass its `url` (or DOI URL) to WebFetch or
  `mcp__matos_asset__web_read`. If a selected source has a DOI, use
  `mcp__matos_asset__literature_access` before falling back to open-web/OA
  access.
- Cite only sources whose IDs exist in your source index. Mark anything you
  cannot verify as inference.
- For current/recent topics, pass `from_year` (e.g. the last one or two years)
  to bias toward the newest papers, and check each result's `year`.
- If `ok` is false, read `notes`, then broaden/rephrase the query or fall back
  to WebFetch on a known URL.
