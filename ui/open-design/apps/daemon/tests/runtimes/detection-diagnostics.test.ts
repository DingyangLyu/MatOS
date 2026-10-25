import { expect,test } from 'vitest';
import {
detectAgentsStream,
selectAgentDefsForDetection,
} from '../../src/runtimes/detection.js';
import { buildAuthDiagnostic } from '../../src/runtimes/diagnostics.js';
import {
assert,
chmodSync,
detectAgents,
join,
minimalAgentDef,
mkdtempSync,
rmSync,
tmpdir,
withEnvSnapshot,
writeFileSync,
} from './helpers/test-helpers.js';

const posixTest = process.platform === 'win32' ? test.skip : test;

function writeMatOSAgent(dir: string, statusOutput: string): void {
  const bin = join(dir, 'matos');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "2026.05.07-test"; exit 0; fi\n` +
      `if [ "$1" = "models" ]; then echo "auto"; exit 0; fi\n` +
      `if [ "$1" = "status" ]; then echo "${statusOutput}"; exit 0; fi\n` +
      `exit 0\n`,
  );
  chmodSync(bin, 0o755);
}

function writeNonExecutableMatOSAgent(dir: string): string {
  const bin = join(dir, 'matos');
  writeFileSync(
    bin,
    `#!/bin/sh\n` +
      `if [ "$1" = "--version" ]; then echo "2026.05.07-test"; exit 0; fi\n` +
      `exit 0\n`,
  );
  chmodSync(bin, 0o644);
  return bin;
}


posixTest('detectAgents emits a not-executable diagnostic for a PATH match without execute permission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-diag-notexec-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      const bin = writeNonExecutableMatOSAgent(dir);
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const agents = await detectAgents();
      const matos = agents.find((agent) => agent.id === 'matos');

      assert.equal(matos?.available, false);
      const diagnostic = matos?.diagnostics?.[0];
      assert.ok(diagnostic, 'expected a diagnostic on the unavailable agent');
      assert.equal(diagnostic?.reason, 'not-executable');
      assert.equal(diagnostic?.severity, 'error');
      assert.equal(diagnostic?.detail, bin);
      assert.match(diagnostic?.message ?? '', /not executable/i);
      const intents = (diagnostic?.fixActions ?? []).map((a) => a.kind);
      assert.ok(intents.includes('rescan'), 'expected rescan fix intent');
      assert.equal(
        intents.includes('openDocs'),
        false,
        'permission diagnostics should not use shim repair advice',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('auth diagnostics do not offer daemon OAuth without an active producer', () => {
  const diagnostic = buildAuthDiagnostic(
    { id: 'matos', name: 'MatOS' },
    {
      status: 'missing',
      message: 'MatOS is installed but not authenticated.',
    },
  );

  const intents = (diagnostic?.fixActions ?? []).map((a) => a.kind);
  assert.deepEqual(intents, ['openDocs', 'rescan']);
});

test('agent id selection happens before detection probes are scheduled', () => {
  const defs = [
    minimalAgentDef({ id: 'matos', bin: 'matos' }),
    minimalAgentDef({ id: 'other-a', bin: 'other-a' }),
    minimalAgentDef({ id: 'other-b', bin: 'other-b' }),
  ];

  expect(selectAgentDefsForDetection(defs, { agentIds: ['matos'] }).map((def) => def.id)).toEqual([
    'matos',
  ]);
});

posixTest('detectAgentsStream yields the same agent set as detectAgents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'od-diag-stream-'));
  try {
    await withEnvSnapshot(['PATH', 'OD_AGENT_HOME'], async () => {
      writeMatOSAgent(dir, 'Authenticated');
      process.env.PATH = dir;
      process.env.OD_AGENT_HOME = dir;

      const batch = await detectAgents();
      const streamed: string[] = [];
      for await (const agent of detectAgentsStream()) {
        streamed.push(agent.id);
      }

      assert.equal(
        streamed.length,
        batch.length,
        'stream should yield one event per agent',
      );
      assert.deepEqual(
        [...streamed].sort(),
        batch.map((agent) => agent.id).sort(),
        'stream should cover exactly the same agent ids',
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
