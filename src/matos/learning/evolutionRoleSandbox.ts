/** Headless sandbox args for hidden evolution roles that must only emit JSON. */
export const EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS = [
  '--permission-mode',
  'dontAsk',
  '--disallowed-tools',
  'Bash,PowerShell,Write,Edit,NotebookEdit,Task,Agent,SendMessage,TeamCreate,TeamDelete,WebFetch,WebSearch,Skill,mcp__matos_asset__evolution_context,mcp__matos_asset__evolution_request',
] as const
