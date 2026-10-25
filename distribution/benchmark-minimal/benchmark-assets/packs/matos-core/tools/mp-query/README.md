# MP Query — MatOS bundled external tool

A reference implementation of a MatOS tool asset: bundled under
`container/tools/`, loaded by the engine bridge at session start,
callable by the LLM as a first-class tool alongside Bash / Read /
Grep.

## Anatomy

```
mp-query/
  matos.tool.json     manifest (id, impl, permissions, UI hints)
  prompt.md           description fed to the LLM
  input.schema.json   JSON schema the LLM sees for argument shape
  tool.py             python impl: read JSON stdin, write stdout
  README.md           you are here
```

## Flow

1. LLM decides to query Materials Project for a formula.
2. Engine dispatches the call via `_matos_external/dispatch.ts`.
3. Dispatcher spawns `python3 tool.py`, feeds
   `{ "input": { "formula": "Si" } }` on stdin.
4. `tool.py` reads `MP_API_KEY` from env (whitelisted via
   `permissions.secrets` in the manifest), calls MP REST API.
5. Formatted text on stdout → bridge hands verbatim to the LLM.

## Forking

```
/tools fork mp-query my-mp-query
```

Creates `data/tools/my-mp-query/draft/`. Tweak the prompt, swap
`tool.py` to use `mp_api`/`pymatgen` for rich structures, add
more fields, or change the impl runtime. Publish when ready; the
engine picks up the fork on the next turn.

## Environment

- `MP_API_KEY` must be present in the host environment. The bridge
  scrubs the tool subprocess env down to `PATH`, `HOME`, `LANG`,
  and the explicit `permissions.secrets` whitelist.
- Network access is enabled via `permissions.network: "enabled"`.
- Workspace is read-only (this tool never writes files).
