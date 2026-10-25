import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MCP_TEMPLATES,
  buildClaudeMcpJson,
  isManagedProjectCwd,
  readMcpConfig,
  sanitizeMcpServer,
  writeMcpConfig,
} from '../src/mcp-config.js';

describe('mcp-config storage', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-mcpconfig-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('returns empty servers when no config file exists', async () => {
    const cfg = await readMcpConfig(dataDir);
    expect(cfg).toEqual({ servers: [] });
  });

  it('returns empty config for a corrupt JSON file', async () => {
    await writeFile(path.join(dataDir, 'mcp-config.json'), '{not valid');
    const cfg = await readMcpConfig(dataDir);
    expect(cfg).toEqual({ servers: [] });
  });

  it('persists and re-reads a valid stdio server', async () => {
    const written = await writeMcpConfig(dataDir, {
      servers: [
        {
          id: 'github',
          label: 'GitHub',
          transport: 'stdio',
          enabled: true,
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_xxx' },
        },
      ],
    });
    expect(written.servers).toHaveLength(1);
    expect(written.servers[0]?.id).toBe('github');

    const reread = await readMcpConfig(dataDir);
    expect(reread.servers[0]?.command).toBe('npx');
    expect(reread.servers[0]?.env?.GITHUB_PERSONAL_ACCESS_TOKEN).toBe('ghp_xxx');
  });

  it('persists and re-reads a valid SSE server with headers', async () => {
    const written = await writeMcpConfig(dataDir, {
      servers: [
        {
          id: 'higgsfield',
          transport: 'sse',
          enabled: true,
          url: 'https://mcp.higgsfield.ai',
          headers: { Authorization: 'Bearer abc' },
        },
      ],
    });
    expect(written.servers[0]?.url).toBe('https://mcp.higgsfield.ai/');
    expect(written.servers[0]?.headers?.Authorization).toBe('Bearer abc');
  });

  it('defaults loopback HTTP servers to no managed OAuth', () => {
    const out = sanitizeMcpServer({
      id: 'figma-use',
      transport: 'http',
      enabled: true,
      url: 'http://localhost:38451/mcp',
    });
    expect(out?.authMode).toBe('none');
  });

  it('defaults remote HTTP servers to managed OAuth for backward compatibility', () => {
    const out = sanitizeMcpServer({
      id: 'higgsfield',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.higgsfield.ai/mcp',
    });
    expect(out?.authMode).toBe('oauth');
  });

  it('drops invalid entries silently', async () => {
    const written = await writeMcpConfig(dataDir, {
      servers: [
        { id: 'bad' /* missing transport-required fields */ },
        { id: 'NOT VALID id', transport: 'stdio', command: 'x' },
        { id: 'good', transport: 'stdio', command: 'echo' },
        // Duplicate id is dropped on second occurrence.
        { id: 'good', transport: 'stdio', command: 'other' },
      ],
    });
    expect(written.servers.map((s) => s.id)).toEqual(['good']);
  });

  it('rejects non-http(s) URLs', () => {
    const out = sanitizeMcpServer({
      id: 'sneaky',
      transport: 'http',
      url: 'file:///etc/passwd',
    });
    expect(out).toBeNull();
  });

  it('drops disabled flag default to enabled when explicit', () => {
    const out = sanitizeMcpServer({
      id: 'a',
      transport: 'stdio',
      command: 'echo',
      enabled: false,
    });
    expect(out?.enabled).toBe(false);
  });

  it('writes JSON in a deterministic shape', async () => {
    await writeMcpConfig(dataDir, {
      servers: [
        { id: 'a', transport: 'stdio', enabled: true, command: 'echo' },
      ],
    });
    const raw = await readFile(path.join(dataDir, 'mcp-config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      servers: [
        { id: 'a', transport: 'stdio', enabled: true, command: 'echo' },
      ],
    });
  });
});

describe('buildClaudeMcpJson', () => {
  it('returns null when no enabled servers', () => {
    expect(buildClaudeMcpJson([])).toBeNull();
    expect(
      buildClaudeMcpJson([
        {
          id: 'x',
          transport: 'stdio',
          enabled: false,
          command: 'echo',
        },
      ]),
    ).toBeNull();
  });

  it('emits a stdio entry with command/args/env', () => {
    const out = buildClaudeMcpJson([
      {
        id: 'github',
        transport: 'stdio',
        enabled: true,
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp' },
      },
    ]);
    expect(out).toEqual({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp' },
        },
      },
    });
  });

  it('emits an sse / http entry with url + headers + transport type', () => {
    const out = buildClaudeMcpJson([
      {
        id: 'higgsfield',
        transport: 'sse',
        enabled: true,
        url: 'https://mcp.higgsfield.ai',
        headers: { Authorization: 'Bearer abc' },
      },
    ]) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(out.mcpServers.higgsfield).toEqual({
      type: 'sse',
      url: 'https://mcp.higgsfield.ai',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('skips disabled servers', () => {
    const out = buildClaudeMcpJson([
      {
        id: 'a',
        transport: 'stdio',
        enabled: true,
        command: 'echo',
      },
      {
        id: 'b',
        transport: 'stdio',
        enabled: false,
        command: 'rm',
      },
    ]) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(out.mcpServers)).toEqual(['a']);
  });

  it('injects an Authorization Bearer header when a stored OAuth token is supplied', () => {
    const out = buildClaudeMcpJson(
      [
        {
          id: 'higgsfield',
          transport: 'http',
          enabled: true,
          url: 'https://mcp.higgsfield.ai/mcp',
        },
      ],
      { higgsfield: 'access-tok-xyz' },
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(out.mcpServers.higgsfield?.headers).toEqual({
      Authorization: 'Bearer access-tok-xyz',
    });
  });

  it('does not inject a stored OAuth token into no-auth HTTP servers', () => {
    const out = buildClaudeMcpJson(
      [
        {
          id: 'figma-use',
          transport: 'http',
          enabled: true,
          authMode: 'none',
          url: 'http://localhost:38451/mcp',
        },
      ],
      { 'figma-use': 'stale-token' },
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(out.mcpServers['figma-use']?.headers).toBeUndefined();
  });

  it("does NOT overwrite a user-pinned Authorization header even when a token exists", () => {
    const out = buildClaudeMcpJson(
      [
        {
          id: 'higgsfield',
          transport: 'http',
          enabled: true,
          url: 'https://mcp.higgsfield.ai/mcp',
          headers: { authorization: 'Bearer manual-token' },
        },
      ],
      { higgsfield: 'access-tok-xyz' },
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(out.mcpServers.higgsfield?.headers).toEqual({
      authorization: 'Bearer manual-token',
    });
  });

  it('overwrites a blank/whitespace Authorization header with the OAuth Bearer (template-default-not-filled bug)', () => {
    const out = buildClaudeMcpJson(
      [
        {
          id: 'higgsfield',
          transport: 'http',
          enabled: true,
          url: 'https://mcp.higgsfield.ai/mcp',
          headers: { Authorization: '   ' },
        },
      ],
      { higgsfield: 'access-tok-xyz' },
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(out.mcpServers.higgsfield?.headers).toEqual({
      Authorization: 'Bearer access-tok-xyz',
    });
  });

  it('drops a blank Authorization header when no token is available either', () => {
    const out = buildClaudeMcpJson([
      {
        id: 'higgsfield',
        transport: 'http',
        enabled: true,
        url: 'https://mcp.higgsfield.ai/mcp',
        headers: { Authorization: '' },
      },
    ]) as { mcpServers: Record<string, Record<string, unknown>> };
    // Empty Authorization is worse than missing — should be omitted.
    expect(out.mcpServers.higgsfield?.headers).toBeUndefined();
  });
});

describe('sanitizeMcpServer headers', () => {
  it('strips empty / whitespace-only header values at persist time', () => {
    const sanitized = sanitizeMcpServer({
      id: 'higgsfield',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.higgsfield.ai/mcp',
      headers: {
        Authorization: '',
        'X-Real-Header': 'kept',
        ' ': 'invalid-key',
        Whitespace: '   ',
      },
    });
    expect(sanitized?.headers).toEqual({ 'X-Real-Header': 'kept' });
  });

  it('omits the headers field entirely when every value is blank', () => {
    const sanitized = sanitizeMcpServer({
      id: 'higgsfield',
      transport: 'http',
      enabled: true,
      url: 'https://mcp.higgsfield.ai/mcp',
      headers: { Authorization: '' },
    });
    expect(sanitized?.headers).toBeUndefined();
  });

  it('only injects the Bearer for the matching server id', () => {
    const out = buildClaudeMcpJson(
      [
        {
          id: 'higgsfield',
          transport: 'http',
          enabled: true,
          url: 'https://mcp.higgsfield.ai/mcp',
        },
        {
          id: 'untouched',
          transport: 'http',
          enabled: true,
          url: 'https://mcp.example.com/mcp',
        },
      ],
      { higgsfield: 'tok' },
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(out.mcpServers.higgsfield?.headers).toEqual({
      Authorization: 'Bearer tok',
    });
    expect(out.mcpServers.untouched?.headers).toBeUndefined();
  });
});

describe('isManagedProjectCwd', () => {
  const projectsDir = '/abs/.od/projects';

  it('accepts a real per-project subdir', () => {
    expect(isManagedProjectCwd('/abs/.od/projects/abc', projectsDir)).toBe(true);
    expect(
      isManagedProjectCwd('/abs/.od/projects/abc/sub', projectsDir),
    ).toBe(true);
  });

  it('rejects the projects-dir root itself (no per-project id)', () => {
    expect(isManagedProjectCwd(projectsDir, projectsDir)).toBe(false);
  });

  it('rejects a git-linked baseDir outside of projects-dir', () => {
    expect(isManagedProjectCwd('/home/me/code/repo', projectsDir)).toBe(false);
  });

  it('rejects PROJECT_ROOT-shaped fallback', () => {
    expect(isManagedProjectCwd('/abs', projectsDir)).toBe(false);
  });

  it('rejects null / undefined cwd', () => {
    expect(isManagedProjectCwd(null, projectsDir)).toBe(false);
    expect(isManagedProjectCwd(undefined, projectsDir)).toBe(false);
    expect(isManagedProjectCwd('', projectsDir)).toBe(false);
  });

  it('rejects path-prefix collisions (different sibling dir)', () => {
    // `/abs/.od/projects-other` starts with `/abs/.od/projects` as a string,
    // but is NOT a child of `/abs/.od/projects/`. Strict-separator check
    // makes sure we don't accidentally write to an unrelated tree.
    expect(
      isManagedProjectCwd('/abs/.od/projects-other/x', projectsDir),
    ).toBe(false);
  });
});

describe('MatOS MCP_TEMPLATES', () => {
  it('contains the five reviewed MatOS integration categories', () => {
    expect([...new Set(MCP_TEMPLATES.map((template) => template.category))])
      .toEqual([
        'materials-science',
        'research-literature',
        'data-viz',
        'publishing',
        'utilities',
      ]);
  });

  it('uses stable unique ids and executable transport definitions', () => {
    const ids = MCP_TEMPLATES.map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(MCP_TEMPLATES.length).toBeGreaterThanOrEqual(10);
    for (const template of MCP_TEMPLATES) {
      if (template.transport === 'stdio') {
        expect(template.command?.trim()).toBeTruthy();
        expect(template.args?.length).toBeGreaterThan(0);
      } else {
        expect(['http', 'sse']).toContain(template.transport);
        expect(template.url).toMatch(/^https:\/\//);
      }
      expect(template.homepage).toMatch(/^https:\/\//);
    }
  });

  it('ships materials, literature, visualization, publishing and utility presets', () => {
    const byId = new Map(MCP_TEMPLATES.map((template) => [template.id, template]));
    expect(byId.get('materials-project')).toMatchObject({
      category: 'materials-science',
      command: 'uvx',
      args: ['mcp-science', 'materials-project'],
    });
    expect(byId.get('materials-project')?.envFields).toContainEqual(
      expect.objectContaining({ key: 'MP_API_KEY', required: true, secret: true }),
    );
    expect(byId.get('optimade')?.args).toEqual(['optimade-mcp-server']);
    expect(byId.get('pubchem')?.args).toEqual(['pubchem-mcp-server']);
    expect(byId.get('arxiv')?.args).toEqual(['arxiv-mcp-server']);
    expect(byId.get('paper-search')?.args).toEqual(['paper-search-mcp']);
    expect(byId.get('antv-chart')?.category).toBe('data-viz');
    expect(byId.get('edgeone-pages')?.category).toBe('publishing');
    expect(byId.get('deckrun')).toMatchObject({
      category: 'publishing',
      transport: 'http',
      authMode: 'none',
      url: 'https://deckrun-mcp-free.agenticdecks.com/mcp/',
    });
    expect(byId.get('filesystem')?.category).toBe('utilities');
    expect(byId.get('fetch')?.args).toEqual(['-y', '@modelcontextprotocol/server-fetch']);
    expect(byId.get('a11y')?.category).toBe('utilities');
  });

  it('does not surface unreviewed image or design-generation presets', () => {
    const ids = MCP_TEMPLATES.map((template) => template.id);
    expect(ids).not.toContain('higgsfield-openclaw');
    expect(ids).not.toContain('photopea');
    expect(ids).not.toContain('figma-official');
  });
});

describe('managed project directory aliases', () => {
  it('accepts a project through an alias and rejects a symlink escaping the managed root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mcp-root-alias-'));
    try {
      const projects = path.join(root, 'projects');
      const project = path.join(projects, 'one');
      const external = path.join(root, 'external');
      await mkdir(project, { recursive: true });
      await mkdir(external);
      const alias = path.join(root, 'alias');
      await symlink(projects, alias, 'dir');
      await symlink(external, path.join(projects, 'escape'), 'dir');
      expect(isManagedProjectCwd(project, alias)).toBe(true);
      expect(isManagedProjectCwd(path.join(alias, 'one'), projects)).toBe(true);
      expect(isManagedProjectCwd(path.join(projects, 'escape'), projects)).toBe(false);
      expect(isManagedProjectCwd(alias, projects)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
