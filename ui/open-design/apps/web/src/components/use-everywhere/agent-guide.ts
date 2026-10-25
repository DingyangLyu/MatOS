// Pure builder for the "Copy guide for an agent" markdown payload.
//
// This handoff describes the native MatOS runtime. It deliberately avoids the
// retired Open Design `od` CLI, design-system registry, and install-info MCP
// sidecar so an external agent cannot accidentally create a parallel runtime.

import { GUIDE_SECTIONS, type CodeSnippet, type GuideSection } from './sections';

export interface AgentGuideOptions {
  /** Scoped daemon URL detected at modal-open time. */
  daemonUrl?: string;
  /** Optional MatOS version/channel; useful when handing a failure to support. */
  versionHint?: string;
}

export interface AgentGuideSnippetRenderOptions {
  daemonUrl?: string;
}

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:7456';

export function buildAgentGuideMarkdown(options: AgentGuideOptions = {}): string {
  const daemonUrl = normalizeDaemonUrl(options.daemonUrl);
  const lines: string[] = [];

  lines.push('# MatOS — native agent guide');
  lines.push('');
  lines.push(
    'Use the existing MatOS runtime in this scoped workspace. The native `matos` CLI is authoritative; ' +
      'the web workspace, scientific MCP servers, workflows, sessions, permissions, traces, and ' +
      'self-evolution all project from that same runtime.',
  );
  if (options.versionHint) {
    lines.push('');
    lines.push(`> Reported MatOS version/channel: \`${options.versionHint}\``);
  }
  lines.push('');

  lines.push('## Setup checklist');
  lines.push('');
  lines.push('1. Confirm the current login and runtime are healthy:');
  lines.push('');
  lines.push('   ```bash');
  lines.push('   matos login status --json');
  lines.push('   matos --version --json');
  lines.push('   ```');
  lines.push('');
  lines.push('2. Validate the scoped assets before composing a role:');
  lines.push('');
  lines.push('   ```bash');
  lines.push('   matos assets validate --json');
  lines.push('   matos assets doctor --json');
  lines.push('   matos roles list --json');
  lines.push('   ```');
  lines.push('');
  lines.push('3. Run work through an explicit native role; do not rebuild its prompt or tool list in the client:');
  lines.push('');
  lines.push('   ```bash');
  lines.push('   matos run --role role:compute "Inspect the project and report the next reproducible step."');
  lines.push('   ```');
  lines.push('');
  lines.push('4. Configure optional scientific MCP servers in Integrations. They are materialized into normal MatOS agent runs.');
  lines.push('');
  lines.push(
    `5. Use \`${daemonUrl}/api/matos/*\` only as the scoped web projection. ` +
      'Do not expose it as an unauthenticated public API.',
  );
  lines.push('');

  for (const section of GUIDE_SECTIONS) {
    lines.push(...renderSection(section, daemonUrl));
  }

  lines.push('## Scoped web references');
  lines.push('');
  lines.push(`- Health: \`${daemonUrl}/api/health\``);
  lines.push(`- Assets: \`${daemonUrl}/api/matos/assets\``);
  lines.push(`- Roles: \`${daemonUrl}/api/matos/roles\``);
  lines.push(`- Workflow start: \`${daemonUrl}/api/matos/workflow/run\``);
  lines.push('');
  lines.push(
    '> Preserve the current user/project scope. Never copy secrets, another user’s private assets, hidden ' +
      'evolution records, host-only paths, or raw session JSONL into prompts or responses.',
  );
  lines.push('');

  return lines.join('\n');
}

export function renderAgentGuideSnippetBody(
  snippet: CodeSnippet,
  options: AgentGuideSnippetRenderOptions = {},
): string {
  return substituteDaemonUrl(snippet.body, normalizeDaemonUrl(options.daemonUrl));
}

function renderSection(section: GuideSection, daemonUrl: string): string[] {
  const lines: string[] = [];
  lines.push(`## ${substituteDaemonUrl(section.heading, daemonUrl)}`);
  lines.push('');
  lines.push(substituteDaemonUrl(section.intro, daemonUrl));
  lines.push('');
  for (const bullet of section.bullets) {
    lines.push(`- ${substituteDaemonUrl(bullet, daemonUrl)}`);
  }
  lines.push('');
  for (const snippet of section.snippets) {
    lines.push(`### ${substituteDaemonUrl(snippet.label, daemonUrl)}`);
    lines.push('');
    lines.push(`\`\`\`${snippet.language}`);
    lines.push(renderAgentGuideSnippetBody(snippet, { daemonUrl }));
    lines.push('```');
    lines.push('');
  }
  if (section.footer) {
    lines.push(`> ${substituteDaemonUrl(section.footer, daemonUrl)}`);
    lines.push('');
  }
  return lines;
}

function normalizeDaemonUrl(daemonUrl: string | undefined): string {
  return (daemonUrl ?? DEFAULT_DAEMON_URL).replace(/\/$/, '');
}

function substituteDaemonUrl(body: string, daemonUrl: string): string {
  return body.replace(/http:\/\/127\.0\.0\.1:7456/g, daemonUrl);
}
