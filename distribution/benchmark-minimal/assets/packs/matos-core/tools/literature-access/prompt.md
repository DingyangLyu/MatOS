Use this tool before or during literature work when a paper may require access.

This is an access-planning and fallback tool, not a public search engine. Keep
WebSearch/WebFetch available for public web discovery and reading, and use
`mcp__matos_asset__literature_access` for exact DOI/PDF resolution.

This tool is credential-safe:
- It never asks for, prints, or stores account passwords, cookies, tokens, or raw proxy credentials.
- It reports whether per-user access channels exist: local PDF/Zotero roots, institution proxy/VPN/EZproxy hints, and browser-login handoff paths.
- It can scan local PDF/BibTeX libraries and resolve DOIs through legal open-access providers.

Recommended flow:
1. Use WebSearch, WebFetch, `mcp__matos_asset__web_read`, or
   `mcp__matos_asset__deep_research_search` to discover public metadata, URLs,
   DOIs, and abstracts.
2. For exact DOI/PDF access, use this tool. If the DOI is unavailable or the
   paper is paywalled, continue with the fallbacks below.
3. Call `literature_access` with `action="status"` or `action="plan"` at the
   start of a paywalled literature task.
4. Use local PDFs/BibTeX first when `localLibrary.pdfCount` or `bibCount` is
   nonzero.
5. For DOI lists, call `action="resolve"` to find Unpaywall/open-access copies
   before asking the user to upload or download papers through their account.
6. If institutional access is available only through login, ask the user to log
   in through the MatOS browser or library portal and place PDFs under a
   workspace library root. Do not request credentials in chat.
7. Do not use piracy mirrors or bypass mechanisms. If full text is unavailable,
   create a DOI/title checklist for the user to retrieve with their authorized
   account.
