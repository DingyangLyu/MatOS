import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderMatOSGlobalRules, writeMatOSGlobalRulesFile } from '../../src/runtimes/matos-global-rules.js';

let dataDir = '';

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'matos-global-rules-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('matos global rules', () => {
  it('renders the rules under a labelled heading', () => {
    const rendered = renderMatOSGlobalRules('  Always cite sources.\n');
    expect(rendered.startsWith('## User global rules\n')).toBe(true);
    expect(rendered.endsWith('Always cite sources.')).toBe(true);
  });

  it('writes a private per-attempt file only when rules are set', async () => {
    await expect(writeMatOSGlobalRulesFile(dataDir, 'run-1', '')).resolves.toBeNull();
    await expect(writeMatOSGlobalRulesFile(dataDir, 'run-1', '   ')).resolves.toBeNull();
    await expect(writeMatOSGlobalRulesFile(dataDir, 'run-1', null)).resolves.toBeNull();

    const first = await writeMatOSGlobalRulesFile(dataDir, 'run/1', 'Use SI units.');
    const second = await writeMatOSGlobalRulesFile(dataDir, 'run/1', 'Use SI units.');
    expect(first).not.toBeNull();
    expect(second).not.toBe(first);
    expect(path.dirname(first!)).toBe(path.join(dataDir, 'native-run-prompts'));
    expect(path.basename(first!)).toMatch(/^run_1-/);
    await expect(fsp.readFile(first!, 'utf8')).resolves.toBe(`${renderMatOSGlobalRules('Use SI units.')}\n`);
    expect((await fsp.stat(first!)).mode & 0o777).toBe(0o600);
  });

  it('keeps the rules within the saved length bound', () => {
    const rendered = renderMatOSGlobalRules('x'.repeat(6000));
    expect(rendered.split('\n').at(-1)).toHaveLength(5000);
  });
});
