export type BuiltinToolAssetDefinition = {
  id: string
  label: string
  description: string
  builtinTools: string[]
  mcpServers: string[]
}

export const BUILTIN_TOOL_ASSETS: BuiltinToolAssetDefinition[] = [
  {
    id: 'default-tools',
    label: 'Default Tool Pack',
    description:
      'Baseline capability pack for roles that rely on the standard MatOS tool pool.',
    builtinTools: [
      'Agent',
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'NotebookEdit',
      'Read',
      'SendMessage',
      'Skill',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'TodoWrite',
      'ToolSearch',
      'WebFetch',
      'WebSearch',
      'Write',
    ],
    mcpServers: [],
  },
  {
    id: 'files-core',
    label: 'Files Core',
    description: 'Read, search, and edit local workspace files.',
    builtinTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'],
    mcpServers: [],
  },
  {
    id: 'files-readonly',
    label: 'Files Readonly',
    description: 'Read and search local workspace files without edit access.',
    builtinTools: ['Read', 'Glob', 'Grep'],
    mcpServers: [],
  },
  {
    id: 'shell-core',
    label: 'Shell Core',
    description: 'Execute shell commands inside the current runtime.',
    builtinTools: ['Bash', 'PowerShell'],
    mcpServers: [],
  },
  {
    id: 'web-research',
    label: 'Web Research',
    description: 'Builtin web search and fetch tools.',
    builtinTools: ['WebSearch', 'WebFetch'],
    mcpServers: [],
  },
  {
    id: 'agent-orchestration',
    label: 'Agent Orchestration',
    description:
      'Sub-agent, task, and coordination tools used for multi-step workflows.',
    builtinTools: [
      'Agent',
      'SendMessage',
      'Skill',
      'Task',
      'TaskOutput',
      'TaskStop',
      'TeamCreate',
      'TeamDelete',
      'TodoWrite',
      'ToolSearch',
    ],
    mcpServers: [],
  },
  {
    id: 'mcp-matos',
    label: 'MatOS MCP (reserved)',
    description:
      'Reserved tool pack. No MCP server is wired for this in the current deployment, so it grants no tools. The native MatOS asset MCP server (matos_asset) is added automatically and is unrelated to this pack.',
    builtinTools: [],
    mcpServers: [],
  },
  {
    id: 'mcp-gmail',
    label: 'Gmail MCP (reserved)',
    description:
      'Reserved tool pack. No Gmail MCP server is wired in the current deployment, so it grants no tools.',
    builtinTools: [],
    mcpServers: [],
  },
  {
    id: 'mcp-workflow-tools',
    label: 'Workflow Tools MCP',
    description:
      'Workflow-builder helper MCP server used by workflow design roles.',
    builtinTools: [],
    mcpServers: ['workflow-tools'],
  },
]
