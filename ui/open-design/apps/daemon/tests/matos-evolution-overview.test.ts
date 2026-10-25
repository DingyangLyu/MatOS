import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  assetJsonChangesFromDiff,
  buildEvolutionOverview,
  loadEvolutionOverview,
  readEvolutionRunDiff,
} from '../src/routes/matos-evolution-overview.js';
import { buildEvolutionPanel } from '../src/routes/matos-evolution.js';

const PROJECT = { projectId: 'p1', projectName: 'Perovskites', cwd: '/projects/p1' };
const WORKSPACE = { projectId: null, projectName: null, cwd: '/workspace' };

const NEW_OVERLAY_DIFF = `diff --git a/.matos/assets/skills/answer-finalization/asset.json b/.matos/assets/skills/answer-finalization/asset.json
new file mode 100644
--- /dev/null
+++ b/.matos/assets/skills/answer-finalization/asset.json
@@ -0,0 +1,8 @@
+{
+  "schemaVersion": 1,
+  "id": "answer-finalization",
+  "type": "skill",
+  "version": "0.1.2",
+  "overlayOf": "skill:answer-finalization@0.1.1",
+  "entry": "SKILL.md"
+}
`;

const VERSION_BUMP_DIFF = `diff --git a/.matos/assets/skills/answer-finalization/asset.json b/.matos/assets/skills/answer-finalization/asset.json
--- a/.matos/assets/skills/answer-finalization/asset.json
+++ b/.matos/assets/skills/answer-finalization/asset.json
@@ -3,3 +3,3 @@
   "type": "skill",
-  "version": "0.1.2",
+  "version": "0.1.3",
   "overlayOf": "skill:answer-finalization@0.1.1",
`;

function run(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    runId: 'direct-editor-a',
    status: 'accepted',
    scope: 'project',
    createdAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:01:00.000Z',
    input: {
      scopeRef: 'project:p1',
      currentEvolutionContext: { trigger: { kind: 'user-feedback', summary: 'report pm too' } },
    },
    editorOutput: { summary: 'Report lattice constants in pm as well.' },
    createdAssets: ['skill:answer-finalization@0.1.2'],
    importedTouchedPaths: ['.matos/assets/skills/answer-finalization/asset.json'],
    semanticAcceptance: { verdict: 'accept', confidence: 0.8, reason: 'explicit preference' },
    ...overrides,
  };
}

test('reads version lineage from asset.json hunks', () => {
  assert.deepEqual(assetJsonChangesFromDiff(NEW_OVERLAY_DIFF), [
    {
      dirName: 'answer-finalization',
      key: 'skill:answer-finalization',
      beforeVersion: null,
      afterVersion: '0.1.2',
      overlayOfVersion: '0.1.1',
    },
  ]);
  assert.equal(assetJsonChangesFromDiff(VERSION_BUMP_DIFF)[0]?.beforeVersion, '0.1.2');
  assert.equal(assetJsonChangesFromDiff(VERSION_BUMP_DIFF)[0]?.afterVersion, '0.1.3');
});

test('builds proposals, history and a per-asset lineage chain', () => {
  const overview = buildEvolutionOverview([
    { location: PROJECT, record: run({}), diff: NEW_OVERLAY_DIFF },
    {
      location: PROJECT,
      record: run({
        runId: 'direct-editor-b',
        status: 'proposed',
        statusReason: 'awaiting_human_approval',
        createdAt: '2026-10-22T11:00:00.000Z',
        updatedAt: '2026-10-22T11:01:00.000Z',
        createdAssets: [],
        updatedAssets: ['skill:answer-finalization@0.1.3'],
        proposal: { proposedAt: '2026-10-22T11:01:00.000Z' },
      }),
      diff: VERSION_BUMP_DIFF,
    },
    // Not an asset change: stays out of the history.
    { location: WORKSPACE, record: run({ runId: 'direct-editor-c', status: 'noop' }), diff: null },
    {
      location: WORKSPACE,
      record: run({
        runId: 'direct-editor-d',
        status: 'rolled_back',
        updatedAt: '2026-10-22T09:00:00.000Z',
        input: { scopeRef: 'user:local' },
      }),
      diff: null,
    },
  ]);

  assert.deepEqual(overview.proposals.map((item) => item.runId), ['direct-editor-b']);
  assert.deepEqual(
    overview.history.map((item) => item.runId),
    ['direct-editor-b', 'direct-editor-a', 'direct-editor-d'],
  );
  const accepted = overview.history.find((item) => item.runId === 'direct-editor-a');
  assert.equal(accepted?.projectName, 'Perovskites');
  assert.equal(accepted?.triggerKind, 'user-feedback');
  assert.equal(accepted?.judge?.verdict, 'accept');

  assert.equal(overview.lineage.length, 1);
  const lineage = overview.lineage[0]!;
  assert.equal(lineage.assetKey, 'skill:answer-finalization');
  assert.equal(lineage.acceptedCount, 1);
  assert.equal(lineage.proposedCount, 1);
  assert.equal(lineage.branches.length, 1);
  assert.deepEqual(
    lineage.branches[0]!.nodes.map((node) => [node.status, node.version, node.parentVersion]),
    [
      ['base', '0.1.1', null],
      ['accepted', '0.1.2', '0.1.1'],
      ['proposed', '0.1.3', '0.1.2'],
    ],
  );
});

test('loads run records from every location and serves bounded diffs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'matos-evolution-overview-'));
  const project = path.join(root, 'project');
  const runDir = path.join(project, '.matos', 'evolution', 'direct-editor', 'runs', 'direct-editor-a');
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, 'run.json'), JSON.stringify(run({})));
  await writeFile(path.join(runDir, 'diff.patch'), NEW_OVERLAY_DIFF);

  const overview = await loadEvolutionOverview([
    { projectId: null, projectName: null, cwd: path.join(root, 'workspace-without-runs') },
    { projectId: 'p1', projectName: 'Perovskites', cwd: project },
    // The same directory listed twice is read once.
    { projectId: 'p1', projectName: 'Perovskites', cwd: project },
  ]);
  assert.deepEqual(overview.history.map((item) => item.runId), ['direct-editor-a']);
  assert.equal(overview.lineage[0]?.branches[0]?.nodes.length, 2);

  assert.equal((await readEvolutionRunDiff(project, 'direct-editor-a'))?.diff, NEW_OVERLAY_DIFF);
  assert.equal(await readEvolutionRunDiff(project, '../escape'), null);
});

test('the review panel reports a parked proposal as its own phase', () => {
  const panel = buildEvolutionPanel(
    [
      {
        recordId: 'monitor-p',
        sessionId: 'session-1',
        triggerKind: 'user-feedback',
        triggerKey: 'user-feedback:evt-p',
        status: 'direct-edit-proposed',
        createdAt: '2026-10-22T11:00:00.000Z',
        updatedAt: '2026-10-22T11:01:00.000Z',
        summary: 'waiting for approval',
        directEditorRun: { status: 'proposed', semanticAcceptance: { verdict: 'accept' } },
      },
    ],
    { nowMs: Date.parse('2026-10-22T11:05:00.000Z') },
  );
  assert.equal(panel.cases[0]?.phase, 'proposed');
  const stages = Object.fromEntries(panel.cases[0]!.stages.map((stage) => [stage.role, stage.state]));
  assert.equal(stages.editor, 'done');
  assert.equal(stages.judge, 'done');
});
