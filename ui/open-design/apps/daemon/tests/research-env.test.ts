import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  listConfiguredResearchApiEnvNames,
  resolveResearchApiAgentEnv,
} from '../src/integrations/provider-config.js';

// Env vars the research providers can read credentials from. Cleared per
// test so a developer machine with a real MP_API_KEY does not change results.
const RESEARCH_ENV_KEYS = [
  'OD_MP_API_KEY',
  'MP_API_KEY',
  'PMG_MAPI_KEY',
  'OD_OPENALEX_API_KEY',
  'OPENALEX_API_KEY',
  'OD_NOMAD_API_TOKEN',
  'NOMAD_API_TOKEN',
  'OD_S2_API_KEY',
  'S2_API_KEY',
  'SEMANTIC_SCHOLAR_API_KEY',
  'OD_SPRINGER_API_KEY',
  'SPRINGER_API_KEY',
  'OD_ELSEVIER_API_KEY',
  'ELSEVIER_API_KEY',
  'OD_MPDS_KEY',
  'MPDS_KEY',
];

describe('research API agent env injection', () => {
  let projectRoot: string;
  const originalEnv = Object.fromEntries(
    RESEARCH_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const originalMediaConfigDir = process.env.OD_MEDIA_CONFIG_DIR;
  const originalDataDir = process.env.OD_DATA_DIR;

  beforeEach(async () => {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'od-research-env-'));
    for (const key of RESEARCH_ENV_KEYS) {
      delete process.env[key];
    }
    delete process.env.OD_MEDIA_CONFIG_DIR;
    delete process.env.OD_DATA_DIR;
  });

  afterEach(async () => {
    for (const key of RESEARCH_ENV_KEYS) {
      if (originalEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    if (originalMediaConfigDir == null) {
      delete process.env.OD_MEDIA_CONFIG_DIR;
    } else {
      process.env.OD_MEDIA_CONFIG_DIR = originalMediaConfigDir;
    }
    if (originalDataDir == null) {
      delete process.env.OD_DATA_DIR;
    } else {
      process.env.OD_DATA_DIR = originalDataDir;
    }
    await rm(projectRoot, { recursive: true, force: true });
  });

  async function writeStoredMediaConfig(data: unknown) {
    const file = path.join(projectRoot, '.od', 'media-config.json');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data), 'utf8');
  }

  it('expands a stored Materials Project key into every agent env alias', async () => {
    await writeStoredMediaConfig({
      providers: {
        'materials-project': { apiKey: 'mp-stored-key' },
      },
    });

    const env = await resolveResearchApiAgentEnv(projectRoot);

    expect(env.MP_API_KEY).toBe('mp-stored-key');
    expect(env.PMG_MAPI_KEY).toBe('mp-stored-key');
  });

  it('collects every configured research provider and skips unconfigured ones', async () => {
    await writeStoredMediaConfig({
      providers: {
        'materials-project': { apiKey: 'mp-key' },
        openalex: { apiKey: 'openalex-key' },
        'semantic-scholar': { apiKey: 's2-key' },
      },
    });

    const env = await resolveResearchApiAgentEnv(projectRoot);

    expect(env).toEqual({
      MP_API_KEY: 'mp-key',
      PMG_MAPI_KEY: 'mp-key',
      OPENALEX_API_KEY: 'openalex-key',
      OPENALEX_MAILTO: 'openalex-key',
      S2_API_KEY: 's2-key',
      SEMANTIC_SCHOLAR_API_KEY: 's2-key',
    });
    // Unconfigured providers must not appear at all — exporting empty
    // strings would clobber inherited env in the agent child process.
    expect(Object.keys(env)).not.toContain('NOMAD_API_TOKEN');
    expect(Object.keys(env)).not.toContain('ELSEVIER_API_KEY');
  });

  it('does not leak media (image/video/audio) provider keys into the research env', async () => {
    await writeStoredMediaConfig({
      providers: {
        openai: { apiKey: 'sk-openai-media' },
        elevenlabs: { apiKey: 'el-media-key' },
        'materials-project': { apiKey: 'mp-key' },
      },
    });

    const env = await resolveResearchApiAgentEnv(projectRoot);

    expect(Object.values(env)).not.toContain('sk-openai-media');
    expect(Object.values(env)).not.toContain('el-media-key');
    expect(env.MP_API_KEY).toBe('mp-key');
  });

  it('lets a daemon-process env var win over the stored key (idempotent for shell exports)', async () => {
    process.env.MP_API_KEY = 'mp-env-key';
    await writeStoredMediaConfig({
      providers: {
        'materials-project': { apiKey: 'mp-stored-key' },
      },
    });

    const env = await resolveResearchApiAgentEnv(projectRoot);

    expect(env.MP_API_KEY).toBe('mp-env-key');
    expect(env.PMG_MAPI_KEY).toBe('mp-env-key');
  });

  it('lists configured env names (sorted, values never included)', async () => {
    await writeStoredMediaConfig({
      providers: {
        openalex: { apiKey: 'openalex-secret' },
        mpds: { apiKey: 'mpds-secret' },
      },
    });

    const names = await listConfiguredResearchApiEnvNames(projectRoot);

    expect(names).toEqual(['MPDS_KEY', 'OPENALEX_API_KEY', 'OPENALEX_MAILTO']);
    expect(names.join(' ')).not.toContain('secret');
  });

  it('returns an empty map when nothing is configured', async () => {
    await expect(resolveResearchApiAgentEnv(projectRoot)).resolves.toEqual({});
    await expect(listConfiguredResearchApiEnvNames(projectRoot)).resolves.toEqual([]);
  });
});
