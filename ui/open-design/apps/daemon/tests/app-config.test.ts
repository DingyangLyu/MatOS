import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { agentCliEnvForAgent, readAppConfig, writeAppConfig } from '../src/app-config.js';
import { isLocalSameOrigin } from '../src/origin-validation.js';

describe('app-config', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-appconfig-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('readAppConfig', () => {
    it('returns an empty config when the config file does not exist', async () => {
      expect(await readAppConfig(dataDir)).toEqual({});
    });

    it('returns parsed config from an existing file', async () => {
      await writeFile(
        path.join(dataDir, 'app-config.json'),
        JSON.stringify({ onboardingCompleted: true }),
      );
      const cfg = await readAppConfig(dataDir);
      expect(cfg.onboardingCompleted).toBe(true);
    });

    it('returns an empty config for corrupted JSON without crashing', async () => {
      await writeFile(path.join(dataDir, 'app-config.json'), '{not valid');
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({});
    });

    it('returns an empty config when file contains a JSON array', async () => {
      await writeFile(path.join(dataDir, 'app-config.json'), '[1,2,3]');
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({});
    });

    it('returns an empty config when file contains a JSON primitive', async () => {
      await writeFile(path.join(dataDir, 'app-config.json'), '"hello"');
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({});
    });

    it('filters out unknown keys from stored file', async () => {
      await writeFile(
        path.join(dataDir, 'app-config.json'),
        JSON.stringify({ agentId: 'matos', rogue: 'value', __proto: 'x' }),
      );
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({ agentId: 'matos' });
      expect(cfg).not.toHaveProperty('rogue');
      expect(cfg).not.toHaveProperty('__proto');
    });

    it('filters out invalid scalar values from stored file', async () => {
      await writeFile(
        path.join(dataDir, 'app-config.json'),
        JSON.stringify({
          onboardingCompleted: 'yes',
          agentId: 123,
          skillId: { id: 'bad' },
          designSystemId: ['bad'],
        }),
      );
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({});
    });

  });

  describe('writeAppConfig', () => {
    it('creates data directory if missing', async () => {
      const nested = path.join(dataDir, 'sub', 'dir');
      await writeAppConfig(nested, { onboardingCompleted: true });
      const cfg = await readAppConfig(nested);
      expect(cfg.onboardingCompleted).toBe(true);
    });

    it('only persists ALLOWED_KEYS, filtering unknown keys', async () => {
      await writeAppConfig(dataDir, {
        onboardingCompleted: true,
        unknownKey: 'should be dropped',
        agentId: 'matos',
      });
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({
        onboardingCompleted: true,
        agentId: 'matos',
      });
      expect(cfg).not.toHaveProperty('unknownKey');
    });

    it('does not persist invalid scalar values', async () => {
      await writeAppConfig(dataDir, {
        onboardingCompleted: 'yes',
        agentId: 123,
        skillId: false,
        designSystemId: { id: 'bad' },
      });
      const cfg = await readAppConfig(dataDir);
      expect(cfg).toEqual({});
    });

    it('merges with existing config', async () => {
      await writeAppConfig(dataDir, { agentId: 'matos' });
      await writeAppConfig(dataDir, { skillId: 'coder' });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.agentId).toBe('matos');
      expect(cfg.skillId).toBe('coder');
    });

    it('clears a key when null is sent', async () => {
      await writeAppConfig(dataDir, { agentId: 'matos', skillId: 'coder' });
      await writeAppConfig(dataDir, { agentId: null });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.agentId).toBeNull();
      expect(cfg.skillId).toBe('coder');
    });

    it('clears agentModels when null is sent', async () => {
      await writeAppConfig(dataDir, {
        agentModels: { a: { model: 'gpt-4' } },
        onboardingCompleted: true,
      });
      expect((await readAppConfig(dataDir)).agentModels).toBeDefined();
      await writeAppConfig(dataDir, { agentModels: null });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.agentModels).toBeUndefined();
      expect(cfg.onboardingCompleted).toBe(true);
    });

    it('clears agentModels when empty object is sent', async () => {
      await writeAppConfig(dataDir, {
        agentModels: { a: { model: 'gpt-4' } },
      });
      await writeAppConfig(dataDir, { agentModels: {} });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.agentModels).toBeUndefined();
    });

    it('validates agentModels entries, dropping invalid shapes', async () => {
      await writeAppConfig(dataDir, {
        agentModels: {
          validAgent: { model: 'gpt-4', reasoning: 'fast' },
          invalidAgent: 'not-an-object',
          arrayAgent: [1, 2, 3],
          badKeys: { model: 'ok', extra: 42 },
        },
      });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.agentModels).toEqual({
        validAgent: { model: 'gpt-4', reasoning: 'fast' },
      });
    });

    it('drops agentModels entirely when no entries are valid', async () => {
      await writeAppConfig(dataDir, {
        onboardingCompleted: true,
        agentModels: { bad: 'string-value' },
      });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.onboardingCompleted).toBe(true);
      expect(cfg.agentModels).toBeUndefined();
    });

    it('clears retired Gemini agent preferences from stored config', async () => {
      await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify({
        agentId: 'gemini',
        agentModels: {
          gemini: { model: 'gemini-2.5-pro' },
          matos: { model: 'deepseek-flash' },
        },
        agentCliEnv: {
          gemini: { GEMINI_BIN: '~/bin/gemini' },
        },
      }));

      const cfg = await readAppConfig(dataDir);

      expect(cfg.agentId).toBeUndefined();
      expect(cfg.agentModels).toEqual({
        matos: { model: 'deepseek-flash' },
      });
      expect(cfg.agentCliEnv).toBeUndefined();
    });

    it('persists supported MatOS CLI env keys and drops everything else', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: {
          matos: {
            MATOS_BIN: '  ~/bin/matos  ',
            DEEPSEEK_BASE_URL: '  https://models.example/anthropic  ',
            DEEPSEEK_API_KEY: '  test-provider-key  ',
            MATOS_DSH_MODEL: '  deepseek-flash  ',
            MATOS_GITEA_TOKEN: 'must-not-pass',
            ANTHROPIC_AUTH_TOKEN: 'obsolete-must-not-pass',
            PATH: '/evil',
          },
          claude: {
            CLAUDE_CONFIG_DIR: '~/.claude-2',
            ANTHROPIC_BASE_URL: 'https://proxy.example/anthropic',
          },
          codex: { CODEX_HOME: '~/.codex-alt', CODEX_BIN: '~/bin/codex-next' },
          amr: { VELA_BIN: '~/bin/vela' },
          opencode: { OPENCODE_BIN: '~/bin/opencode' },
          __proto__: { MATOS_BIN: 'bad' },
        },
      });

      const cfg = await readAppConfig(dataDir);

      expect(cfg.agentCliEnv).toEqual({
        matos: {
          MATOS_BIN: '~/bin/matos',
          DEEPSEEK_BASE_URL: 'https://models.example/anthropic',
          DEEPSEEK_API_KEY: 'test-provider-key',
          MATOS_DSH_MODEL: 'deepseek-flash',
        },
      });
      expect(agentCliEnvForAgent(cfg.agentCliEnv, 'claude')).toEqual({});
    });

    it('persists native DeepSeek configuration and a MatOS executable override', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: { matos: {
          MATOS_BIN: '/srv/test-tools/matos',
          DEEPSEEK_BASE_URL: 'https://models.example/anthropic',
          DEEPSEEK_API_KEY: 'test-provider-key',
          MATOS_DSH_MODEL: 'deepseek-flash',
          MATOS_GITEA_TOKEN: 'must-not-pass',
          ANTHROPIC_AUTH_TOKEN: 'obsolete-must-not-pass',
          PATH: '/evil',
        } },
      });
      const cfg = await readAppConfig(dataDir);
      expect(agentCliEnvForAgent(cfg.agentCliEnv, 'matos')).toEqual({
        MATOS_BIN: '/srv/test-tools/matos',
        DEEPSEEK_BASE_URL: 'https://models.example/anthropic',
        DEEPSEEK_API_KEY: 'test-provider-key',
        MATOS_DSH_MODEL: 'deepseek-flash',
      });
    });

    it('keeps an explicitly configured DeepSeek key on the default endpoint', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: { matos: { DEEPSEEK_API_KEY: 'test-default-endpoint-key' } },
        agentCliEnvIntent: { matos: { apiKeyOverride: true } },
      });
      const cfg = await readAppConfig(dataDir);
      expect(agentCliEnvForAgent(cfg.agentCliEnv, 'matos')).toEqual({
        DEEPSEEK_API_KEY: 'test-default-endpoint-key',
      });
    });

    it('infers API key override intent for explicit MatOS env writes', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: {
          matos: { DEEPSEEK_API_KEY: 'test-provider-key' },
        },
      });

      const cfg = await readAppConfig(dataDir);

      expect(cfg.agentCliEnv).toEqual({
        matos: { DEEPSEEK_API_KEY: 'test-provider-key' },
      });
      expect(cfg.agentCliEnvIntent).toEqual({
        matos: { apiKeyOverride: true },
      });
    });

    it('does not infer API key override intent when reading legacy disk config', async () => {
      await writeFile(path.join(dataDir, 'app-config.json'), JSON.stringify({
        agentCliEnv: {
          matos: { DEEPSEEK_API_KEY: 'test-legacy-key' },
        },
      }));

      const cfg = await readAppConfig(dataDir);

      expect(cfg.agentCliEnv).toBeUndefined();
      expect(cfg.agentCliEnvIntent).toBeUndefined();
    });

    it('drops orphan CLI env intent entries when the agent env is empty', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: {
          matos: { MATOS_DSH_MODEL: 'deepseek-flash' },
        },
        agentCliEnvIntent: {
          codex: { apiKeyOverride: true },
        },
      });

      const cfg = await readAppConfig(dataDir);

      expect(cfg.agentCliEnv).toEqual({
        matos: { MATOS_DSH_MODEL: 'deepseek-flash' },
      });
      expect(cfg.agentCliEnvIntent).toBeUndefined();
    });

    it('drops agentCliEnv entries that collide with Object.prototype keys', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: {
          toString: {
            MATOS_BIN: '~/.matos-prototype',
          },
          hasOwnProperty: {
            MATOS_BIN: '~/.matos-other-prototype',
          },
          matos: {
            MATOS_BIN: '~/bin/matos',
          },
        },
      });

      const cfg = await readAppConfig(dataDir);

      expect(cfg.agentCliEnv).toEqual({
        matos: { MATOS_BIN: '~/bin/matos' },
      });
    });

    it('clears agentCliEnv when null or an empty object is sent', async () => {
      await writeAppConfig(dataDir, {
        agentCliEnv: {
          matos: { MATOS_BIN: '~/bin/matos' },
        },
        onboardingCompleted: true,
      });
      expect((await readAppConfig(dataDir)).agentCliEnv).toBeDefined();

      await writeAppConfig(dataDir, { agentCliEnv: null });
      let cfg = await readAppConfig(dataDir);
      expect(cfg.agentCliEnv).toBeUndefined();
      expect(cfg.onboardingCompleted).toBe(true);

      await writeAppConfig(dataDir, {
        agentCliEnv: {
          matos: { MATOS_DSH_MODEL: 'deepseek-flash' },
        },
      });
      await writeAppConfig(dataDir, { agentCliEnv: {} });
      cfg = await readAppConfig(dataDir);
      expect(cfg.agentCliEnv).toBeUndefined();
    });

    it('handles corrupted existing file gracefully on write', async () => {
      await writeFile(path.join(dataDir, 'app-config.json'), 'CORRUPT');
      await writeAppConfig(dataDir, { agentId: 'test' });
      const cfg = await readAppConfig(dataDir);
      expect(cfg.agentId).toBe('test');
    });
  });
});

describe('app-config customInstructions', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-instructions-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists customInstructions and reads them back', async () => {
    await writeAppConfig(dataDir, { customInstructions: 'Always cite sources.' });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.customInstructions).toBe('Always cite sources.');
  });

  it('keeps customInstructions across later config saves', async () => {
    await writeAppConfig(dataDir, { customInstructions: 'Always cite sources.' });
    await writeAppConfig(dataDir, { onboardingCompleted: true });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.customInstructions).toBe('Always cite sources.');
    expect(cfg.onboardingCompleted).toBe(true);
  });

  it('caps customInstructions at 5000 characters', async () => {
    await writeAppConfig(dataDir, { customInstructions: 'x'.repeat(5001) });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.customInstructions).toBe('x'.repeat(5000));
  });

  it('clears customInstructions when null is sent', async () => {
    await writeAppConfig(dataDir, { customInstructions: 'Always cite sources.' });
    await writeAppConfig(dataDir, { customInstructions: null });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.customInstructions).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP-layer origin guard
// ---------------------------------------------------------------------------

function httpRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode!, body: data }));
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('app-config disabled lists', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-disabled-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists disabledSkills as string array', async () => {
    await writeAppConfig(dataDir, { disabledSkills: ['skill-a', 'skill-b'] });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.disabledSkills).toEqual(['skill-a', 'skill-b']);
  });

  it('drops disabledSkills when not a string array', async () => {
    await writeAppConfig(dataDir, { disabledSkills: 'not-array' } as any);
    const cfg = await readAppConfig(dataDir);
    expect(cfg.disabledSkills).toBeUndefined();
  });

  it('drops disabledSkills with non-string elements', async () => {
    await writeAppConfig(dataDir, { disabledSkills: [1, 2, 3] } as any);
    const cfg = await readAppConfig(dataDir);
    expect(cfg.disabledSkills).toBeUndefined();
  });

  it('clears disabledSkills when empty array is sent', async () => {
    await writeAppConfig(dataDir, { disabledSkills: ['a'] });
    await writeAppConfig(dataDir, { disabledSkills: [] });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.disabledSkills).toEqual([]);
  });
});

describe('app-config projectLocations', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-projectLocations-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists valid projectLocations and reads them back', async () => {
    const locs = [
      { id: 'ext-one', name: 'One', path: '/tmp/od-loc-one' },
      { id: 'ext-two', name: 'Two', path: '/tmp/od-loc-two' },
    ];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toEqual(locs);
  });

  it('normalizes ~/ paths via expandHomePrefix', async () => {
    const home = homedir();
    const locs = [{ id: 'home-loc', name: 'Home', path: '~/od-projects' }];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(1);
    const first = cfg.projectLocations![0]!;
    expect(first.path).toBe(path.join(home, 'od-projects'));
    expect(path.isAbsolute(first.path)).toBe(true);
  });

  it('drops relative paths that cannot be resolved to absolute', async () => {
    const locs = [
      { id: 'good', name: 'Good', path: '/tmp/od-good' },
      { id: 'bad-relative', name: 'Bad Rel', path: './relative/path' },
    ];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(1);
    const first = cfg.projectLocations![0]!;
    expect(first.id).toBe('good');
  });

  it('drops entries without a string path', async () => {
    const locs = [
      { id: 'good', name: 'Good', path: '/tmp/od-good' },
      { id: 'no-path', name: 'No Path' },
    ];
    await writeAppConfig(dataDir, { projectLocations: locs as any });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(1);
    const first = cfg.projectLocations![0]!;
    expect(first.id).toBe('good');
  });

  it('deduplicates paths (case-sensitive on unix)', async () => {
    const locs = [
      { id: 'first', name: 'First', path: '/tmp/od-same' },
      { id: 'second', name: 'Second', path: '/tmp/od-same' },
    ];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    // Single canonical entry, second deduplicated
    expect(cfg.projectLocations).toHaveLength(1);
    const first = cfg.projectLocations![0]!;
    expect(first.path).toBe(path.normalize('/tmp/od-same'));
  });

  it('deduplicates by resolved path after normalization', async () => {
    const locs = [
      { id: 'first', name: 'First', path: '/tmp/od-dup/../od-dup' },
      { id: 'second', name: 'Second', path: '/tmp/od-dup' },
    ];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(1);
    const first = cfg.projectLocations![0]!;
    expect(first.path).toBe(path.normalize('/tmp/od-dup'));
  });

  it('rejects reserved id "default" and falls back to auto-generated id', async () => {
    const locs = [{ id: 'default', name: 'Hijack', path: '/tmp/od-hijack' }];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(1);
    // The stored id must NOT be 'default'
    const first = cfg.projectLocations![0]!;
    expect(first.id).not.toBe('default');
    // The auto-generated id follows the hash-backed base64url pattern
    expect(first.id).toMatch(/^loc_[A-Za-z0-9_-]{1,16}$/);
    expect(first.path).toBe(path.normalize('/tmp/od-hijack'));
  });

  it('generates distinct ids for sibling paths with long shared prefixes', async () => {
    const locs = [
      { path: '/tmp/open-design-project-locations/shared-prefix-one' },
      { path: '/tmp/open-design-project-locations/shared-prefix-two' },
    ];
    await writeAppConfig(dataDir, { projectLocations: locs });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(2);
    const ids = cfg.projectLocations!.map((location) => location.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => /^loc_[A-Za-z0-9_-]{1,16}$/.test(id))).toBe(true);
  });

  it('persists a defaultProjectLocationId preference', async () => {
    await writeAppConfig(dataDir, {
      projectLocations: [{ id: 'external-default', name: 'External', path: '/tmp/od-default-location' }],
      defaultProjectLocationId: 'external-default',
    });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.defaultProjectLocationId).toBe('external-default');
  });

  it('normalizes invalid defaultProjectLocationId values', async () => {
    await writeAppConfig(dataDir, { defaultProjectLocationId: '../bad' });
    let cfg = await readAppConfig(dataDir);
    expect(cfg.defaultProjectLocationId).toBe('default');

    await writeAppConfig(dataDir, { defaultProjectLocationId: null });
    cfg = await readAppConfig(dataDir);
    expect(cfg.defaultProjectLocationId).toBeNull();
  });

  it('drops invalid scalar projectLocations (not an array)', async () => {
    await writeAppConfig(dataDir, { projectLocations: 'not-array' } as any);
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toBeUndefined();
  });

  it('clears projectLocations when empty array is sent', async () => {
    await writeAppConfig(dataDir, {
      projectLocations: [{ id: 'ext', name: 'ext', path: '/tmp/od-ext' }],
      onboardingCompleted: true,
    });
    expect((await readAppConfig(dataDir)).projectLocations).toHaveLength(1);
    await writeAppConfig(dataDir, { projectLocations: [] });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toEqual([]);
    expect(cfg.onboardingCompleted).toBe(true);
  });

  it('clears projectLocations when null is sent', async () => {
    await writeAppConfig(dataDir, {
      projectLocations: [{ id: 'ext', name: 'ext', path: '/tmp/od-ext' }],
      onboardingCompleted: true,
    });
    expect((await readAppConfig(dataDir)).projectLocations).toHaveLength(1);
    await writeAppConfig(dataDir, { projectLocations: null as any });
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toBeUndefined();
    expect(cfg.onboardingCompleted).toBe(true);
  });

  it('validates projectLocations on read (filters corrupted stored data)', async () => {
    // Write raw JSON with invalid entries
    await writeFile(
      path.join(dataDir, 'app-config.json'),
      JSON.stringify({
        projectLocations: [
          { id: 'good', name: 'Good', path: '/tmp/od-good' },
          { id: 'bad-relative', name: 'Bad', path: 'relative' },
          { id: 'no-path', name: 'No Path' },
          'not-an-object',
          null,
          { id: 'good2', name: 'Dup Path', path: '/tmp/od-good' },
          { id: 'default', name: 'Reserved', path: '/tmp/od-reserved' },
        ],
      }),
    );
    const cfg = await readAppConfig(dataDir);
    expect(cfg.projectLocations).toHaveLength(2);
    const ids = cfg.projectLocations!.map((l) => l.id);
    expect(ids).not.toContain('default');
    expect(ids).not.toContain('bad-relative');
    expect(ids).not.toContain('no-path');
  });
});

describe('app-config recentLinkedDirs', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-recentdirs-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('persists a clean list of working directories', async () => {
    const cfg = await writeAppConfig(dataDir, {
      recentLinkedDirs: ['/home/a/project', '/home/b/site'],
    });
    expect(cfg.recentLinkedDirs).toEqual(['/home/a/project', '/home/b/site']);
    expect((await readAppConfig(dataDir)).recentLinkedDirs).toEqual([
      '/home/a/project',
      '/home/b/site',
    ]);
  });

  it('trims, drops empty entries, and de-dupes preserving order', async () => {
    const cfg = await writeAppConfig(dataDir, {
      recentLinkedDirs: ['  /home/a  ', '', '/home/a', '   ', '/home/b'],
    });
    expect(cfg.recentLinkedDirs).toEqual(['/home/a', '/home/b']);
  });

  it('caps the list at RECENT_LINKED_DIRS_MAX entries', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `/home/dir${i}`);
    const cfg = await writeAppConfig(dataDir, { recentLinkedDirs: many });
    expect(cfg.recentLinkedDirs).toEqual(many.slice(0, 5));
  });

  it('ignores a non-array value without touching other prefs', async () => {
    await writeAppConfig(dataDir, { onboardingCompleted: true });
    const cfg = await writeAppConfig(dataDir, {
      recentLinkedDirs: 'not-an-array' as unknown as string[],
    });
    expect(cfg.recentLinkedDirs).toBeUndefined();
    expect(cfg.onboardingCompleted).toBe(true);
  });

  it('updates recentLinkedDirs without clobbering unrelated prefs', async () => {
    await writeAppConfig(dataDir, { skillId: 'keep-me' });
    const cfg = await writeAppConfig(dataDir, {
      recentLinkedDirs: ['/home/a'],
    });
    expect(cfg.recentLinkedDirs).toEqual(['/home/a']);
    expect(cfg.skillId).toBe('keep-me');
  });
});

describe('app-config origin guard', () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;

  beforeAll(
    () =>
      new Promise<void>((resolve) => {
        const app = express();
        app.use(express.json());
        app.get('/api/app-config', (req, res) => {
          if (!isLocalSameOrigin(req, port)) {
            return res
              .status(403)
              .json({ error: 'cross-origin request rejected' });
          }
          res.json({ config: {} });
        });
        app.put('/api/app-config', (req, res) => {
          if (!isLocalSameOrigin(req, port)) {
            return res
              .status(403)
              .json({ error: 'cross-origin request rejected' });
          }
          res.json({ config: req.body });
        });
        server = app.listen(0, '127.0.0.1', () => {
          port = (server.address() as { port: number }).port;
          baseUrl = `http://127.0.0.1:${port}`;
          resolve();
        });
      }),
  );

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('allows GET from same-origin (no Origin header)', async () => {
    const res = await httpRequest(`${baseUrl}/api/app-config`, {
      headers: { Host: `127.0.0.1:${port}` },
    });
    expect(res.status).toBe(200);
  });

  it('allows PUT from same-origin', async () => {
    const res = await httpRequest(`${baseUrl}/api/app-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Host: `127.0.0.1:${port}`,
        Origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({ onboardingCompleted: true }),
    });
    expect(res.status).toBe(200);
  });

  it('rejects GET with cross-origin Origin header', async () => {
    const res = await httpRequest(`${baseUrl}/api/app-config`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'https://evil.com',
      },
    });
    expect(res.status).toBe(403);
  });

  it('rejects PUT with cross-origin Origin header', async () => {
    const res = await httpRequest(`${baseUrl}/api/app-config`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Host: `127.0.0.1:${port}`,
        Origin: 'https://evil.com',
      },
      body: JSON.stringify({ agentId: 'hacked' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects request with wrong Host header', async () => {
    const res = await httpRequest(`${baseUrl}/api/app-config`, {
      headers: { Host: 'evil.com:9999' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects no-Origin requests that only match configured deployment hosts', async () => {
    process.env.OD_ALLOWED_ORIGINS = 'https://od.example.com';
    try {
      const res = await httpRequest(`${baseUrl}/api/app-config`, {
        headers: { Host: 'od.example.com' },
      });
      expect(res.status).toBe(403);
    } finally {
      delete process.env.OD_ALLOWED_ORIGINS;
    }
  });

  it('still rejects non-loopback Origin', async () => {
    const res = await httpRequest(`${baseUrl}/api/app-config`, {
      headers: {
        Host: `127.0.0.1:${port}`,
        Origin: 'https://evil.com',
      },
    });
    expect(res.status).toBe(403);
  });
});
