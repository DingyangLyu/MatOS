// Native MatOS surfaces shown by the “Use everywhere” panel.
//
// These examples intentionally use the stable `matos` CLI and the thin
// `/api/matos/*` web projections. Runtime authority remains in MatOS assets,
// roles, workflows, sessions and permissions; this guide must never teach a
// parallel Open Design runtime model.

export interface CodeSnippet {
  label: string;
  language: 'bash' | 'json' | 'http' | 'yaml' | 'ts' | 'tsx' | 'text';
  body: string;
}

export interface GuideSection {
  id: 'overview' | 'cli' | 'mcp' | 'http' | 'skills';
  tabLabel: string;
  heading: string;
  intro: string;
  bullets: string[];
  snippets: CodeSnippet[];
  footer?: string;
}

export const GUIDE_SECTIONS: GuideSection[] = [
  {
    id: 'overview',
    tabLabel: 'Overview',
    heading: 'One MatOS runtime, several safe entry points',
    intro:
      'The native MatOS CLI is authoritative. The web workspace, scientific MCP tools and HTTP projections all reuse the same scoped roles, assets, sessions, permissions and traces.',
    bullets: [
      'CLI — interactive `matos` and machine-readable `matos ... --json` commands.',
      'Assets — versioned roles, skills, workflows, tools, MCP configs, knowledge and data resolved by one registry.',
      'Web — `/api/matos/*` routes are thin adapters over the native CLI and services, not a second backend.',
      'Trace and evolution — normal runs preserve provenance and feed the bounded, hidden self-evolution pipeline.',
    ],
    snippets: [
      {
        label: 'Check authentication and runtime readiness',
        language: 'bash',
        body: 'matos login status --json\nmatos --version --json',
      },
      {
        label: 'Validate the scoped asset registry',
        language: 'bash',
        body: 'matos assets validate --json\nmatos assets doctor --json',
      },
      {
        label: 'Run a scientific task with an explicit role',
        language: 'bash',
        body:
          'matos run --role role:compute \\\n' +
          '  "Relax this CIF, validate convergence, and summarize the final structure."',
      },
    ],
    footer:
      'Scope is part of runtime identity. Do not copy another user’s paths, credentials, sessions or private assets into commands or configuration.',
  },
  {
    id: 'cli',
    tabLabel: 'Native CLI',
    heading: 'Use MatOS directly from a terminal or automation',
    intro:
      'The `matos` command is the stable human and agent API. Interactive and headless runs share role composition, tools, MCP, permissions, trace context and session storage.',
    bullets: [
      '`matos` opens the native interactive REPL in the current scoped workspace.',
      '`matos run --role ...` uses the same headless runtime and emits normal session/trace records.',
      'Registry, workflow, trace and evolution commands support `--json` for reliable automation.',
      'Use role refs such as `role:compute` or `role:research-scientist` instead of rebuilding prompts in scripts.',
    ],
    snippets: [
      {
        label: 'Initialize a project and inspect available roles',
        language: 'bash',
        body: 'matos init\nmatos roles list --json',
      },
      {
        label: 'Run a research task headlessly',
        language: 'bash',
        body:
          'matos run --role role:research-scientist \\\n' +
          '  "Compare recent MLIP benchmarks and preserve citations for every conclusion."',
      },
      {
        label: 'Inspect assets and their role dependency graph',
        language: 'bash',
        body:
          'matos assets list --json\n' +
          'matos assets graph --role role:compute --json',
      },
      {
        label: 'Inspect trace and self-evolution health',
        language: 'bash',
        body: 'matos trace list --json\nmatos evolve status --json',
      },
    ],
    footer:
      'Prefer the native command shown here over direct edits to runtime JSONL, hidden evolution records or daemon state.',
  },
  {
    id: 'mcp',
    tabLabel: 'Scientific MCP',
    heading: 'Attach scientific tool services to MatOS roles',
    intro:
      'The MCP picker in Integrations now focuses on materials data, scholarly literature and scientific visualization. Saved servers are materialized into normal agent runs through the existing MatOS tool path.',
    bullets: [
      'Materials Project, OPTIMADE, PubChem and GPAW cover common materials and chemistry workflows.',
      'arXiv and scholarly search provide literature evidence; retrieved paper text must be treated as untrusted input.',
      'AntV and Mermaid turn benchmark, provenance and workflow data into inspectable visual artifacts.',
      'Secrets stay in server-side MCP configuration and are never copied into chat or trace output.',
    ],
    snippets: [
      {
        label: 'List native MCP assets',
        language: 'bash',
        body: 'matos assets list --type mcp --json',
      },
      {
        label: 'See which tools and MCP assets a role composes',
        language: 'bash',
        body: 'matos assets graph --role role:compute --json',
      },
      {
        label: 'Validate configuration before a scientific run',
        language: 'bash',
        body: 'matos assets validate --json\nmatos assets doctor --json',
      },
    ],
    footer:
      'Configure external servers in this page; use native asset commands for inspection and governance. Do not hand-edit per-agent fallback configs.',
  },
  {
    id: 'http',
    tabLabel: 'Scoped web API',
    heading: 'Use the same scoped projections as the MatOS web workspace',
    intro:
      'The workspace daemon exposes small `/api/matos/*` adapters for the browser. They invoke native MatOS services and stay behind the workspace scope boundary.',
    bullets: [
      '`GET /api/matos/assets` projects the released asset catalog with redaction and scope filtering.',
      '`GET /api/matos/roles` returns selectable native roles and their runtime overrides.',
      '`POST /api/matos/workflow/run` starts a published native workflow; follow its run and events endpoints for progress.',
    ],
    snippets: [
      {
        label: 'List roles, skills, workflows and MCP assets',
        language: 'bash',
        body:
          'curl -s "http://127.0.0.1:7456/api/matos/assets?types=role,skill,workflow,mcp"',
      },
      {
        label: 'Read the selectable role catalog',
        language: 'bash',
        body: 'curl -s http://127.0.0.1:7456/api/matos/roles',
      },
      {
        label: 'Start a published workflow through the thin web adapter',
        language: 'bash',
        body:
          'curl -s -X POST http://127.0.0.1:7456/api/matos/workflow/run \\\n' +
          "  -H 'content-type: application/json' \\\n" +
          "  -d '{\"ref\":\"workflow:my-workflow\",\"parameters\":{}}'",
      },
    ],
    footer:
      'These are local product adapters, not an unauthenticated public API. The service listens on loopback; reach it from another machine through an SSH tunnel.',
  },
  {
    id: 'skills',
    tabLabel: 'Assets & workflows',
    heading: 'Compose reusable scientific capability as native assets',
    intro:
      'MatOS assets are versioned, dependency-aware and scope-aware. Roles compose skills, tools, MCP, knowledge and data; workflows orchestrate generic nodes without hard-coding one scientific domain into the engine.',
    bullets: [
      'Use canonical refs such as `skill:materials-compute`, `role:compute` and `workflow:public-local-calculation`.',
      'Inspect dependencies with registry graph commands instead of copying asset text into prompts.',
      'Validate workflow definitions before running and preserve run IDs for status, events and artifacts.',
      'Self-evolution edits stay bounded by editable roots, validation, semantic acceptance, snapshots and rollback.',
    ],
    snippets: [
      {
        label: 'Inspect one asset and its neighborhood',
        language: 'bash',
        body:
          'matos assets show skill:materials-compute --json\n' +
          'matos assets neighborhood skill:materials-compute --json',
      },
      {
        label: 'Validate and run a workflow asset',
        language: 'bash',
        body:
          'matos workflow validate workflow:my-workflow --json\n' +
          'matos workflow run workflow:my-workflow --param structure=sample.cif --json',
      },
      {
        label: 'Inspect a workflow run and its event provenance',
        language: 'bash',
        body:
          'matos workflow inspect <run-id> --json\n' +
          'matos workflow events <run-id> --json',
      },
    ],
    footer:
      'Asset manifests and small entry files belong in Git; large datasets, checkpoints and calculation payloads stay in mounted storage as provenance-preserving references.',
  },
];
