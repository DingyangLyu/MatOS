Read a public URL (web page or PDF) as clean Markdown. The tool uses Jina
Reader first and automatically falls back to bounded public-HTML reads when
Jina or its configured proxy route is unavailable.

Use this to read the full content of a source you found with search, especially
for JavaScript-heavy pages or PDFs where a raw fetch is unreliable. It returns
readable Markdown you can quote and cite.

Guidance:
- Pass the source `url` (the same URL you got from a search result or a DOI).
- Returns `content` (Markdown). If `truncated` is true, either request a larger
  `max_chars` or target a more specific URL/section.
- `provider` and `route` identify the successful path. `attempts` contains only
  redacted route/error classifications when an earlier route failed.
- Do not fan out repeated calls after a timeout. One call already tries bounded
  proxy/direct routes within the MCP timeout.
- arXiv PDF URLs automatically fall back to their canonical abstract page when
  direct PDF parsing is unavailable.
- Prefer this over WebFetch when a page is JS-rendered or is a PDF.
- Cite only sources you have actually read; record each kept source's ID and URL.
- Keyless by default; works on any model provider.
