import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildEvolutionPanel } from '../src/routes/matos-evolution.js';

// Realistic shapes copied from `matos evolve monitor list --json` output
// (full, non-compact records). The bridge folds these into review cases.

const NOW = Date.parse('2026-07-09T12:00:00.000Z');

function record(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    recordId: 'monitor-a',
    sessionId: 'session-1',
    triggerKind: 'user-feedback',
    triggerKey: 'user-feedback:evt-1',
    status: 'detected',
    createdAt: '2026-07-09T11:58:00.000Z',
    updatedAt: '2026-07-09T11:58:00.000Z',
    summary: 'detected a trigger',
    ...overrides,
  };
}

test('empty ledger produces an empty panel', () => {
  const panel = buildEvolutionPanel([], { nowMs: NOW });
  assert.equal(panel.sessionId, null);
  assert.deepEqual(panel.cases, []);
});

test('groups records by trigger and reports an in-flight review', () => {
  const panel = buildEvolutionPanel(
    [
      record({ recordId: 'monitor-a', status: 'detected' }),
      record({
        recordId: 'monitor-b',
        status: 'analysis-complete',
        updatedAt: '2026-07-09T11:59:00.000Z',
        feedbackAnalysis: {
          shouldUseFeedback: true,
          summary: 'user corrected the tool call twice',
          signals: [{ kind: 'correction' }],
          decisions: [{ recommendedAction: 'update-skill' }],
        },
      }),
    ],
    { nowMs: NOW },
  );
  assert.equal(panel.sessionId, 'session-1');
  assert.equal(panel.cases.length, 1);
  const reviewCase = panel.cases[0]!;
  assert.equal(reviewCase.phase, 'reviewing');
  assert.equal(reviewCase.critic?.shouldUseFeedback, true);
  assert.equal(reviewCase.critic?.signalCount, 1);
  assert.equal(reviewCase.critic?.topAction, 'update-skill');
  const stages = Object.fromEntries(reviewCase.stages.map((s) => [s.role, s.state]));
  assert.equal(stages.scout, 'done');
  assert.equal(stages.critic, 'done');
  assert.equal(stages.editor, 'pending');
  assert.equal(stages.judge, 'pending');
});

test('direct-edit-complete with accepted editor run settles as accepted', () => {
  const panel = buildEvolutionPanel(
    [
      record({ recordId: 'monitor-a', status: 'detected' }),
      record({
        recordId: 'monitor-c',
        status: 'direct-edit-complete',
        updatedAt: '2026-07-09T11:59:30.000Z',
        directEditorRun: {
          runId: 'run-1',
          status: 'accepted',
          updatedAssets: ['skill:compute-runbook@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          semanticAcceptance: {
            verdict: 'accept',
            confidence: 0.86,
            reason: 'edit matches the observed failure and validation passed',
            overfitRisk: 'low',
            assetPollutionRisk: 'low',
          },
        },
      }),
    ],
    { nowMs: NOW },
  );
  const reviewCase = panel.cases[0]!;
  assert.equal(reviewCase.phase, 'accepted');
  assert.equal(reviewCase.editor?.status, 'accepted');
  assert.deepEqual(reviewCase.editor?.updatedAssets, ['skill:compute-runbook@0.1.0']);
  assert.equal(reviewCase.judge?.verdict, 'accept');
  assert.equal(reviewCase.judge?.confidence, 0.86);
  const stages = Object.fromEntries(reviewCase.stages.map((s) => [s.role, s.state]));
  assert.equal(stages.editor, 'done');
  assert.equal(stages.judge, 'done');
});

test('rollback verdict marks judge lane failed', () => {
  const panel = buildEvolutionPanel(
    [
      record({
        status: 'direct-edit-blocked',
        directEditorRun: {
          runId: 'run-2',
          status: 'rolled_back',
          updatedAssets: [],
          createdAssets: [],
          disabledAssets: [],
          semanticAcceptance: {
            verdict: 'rollback',
            confidence: 0.4,
            reason: 'edit looked overfit to one session',
            overfitRisk: 'high',
            assetPollutionRisk: 'medium',
          },
        },
      }),
    ],
    { nowMs: NOW },
  );
  const reviewCase = panel.cases[0]!;
  assert.equal(reviewCase.phase, 'blocked');
  const stages = Object.fromEntries(reviewCase.stages.map((s) => [s.role, s.state]));
  assert.equal(stages.judge, 'failed');
});

test('skipped-low-quality-trigger settles with skipped critic/editor lanes', () => {
  const panel = buildEvolutionPanel(
    [
      record({
        triggerKind: 'session-end',
        triggerKey: 'session-end:session-1',
        status: 'skipped-low-quality-trigger',
        summary: 'Skipped low-quality self-evolution trigger',
      }),
    ],
    { nowMs: NOW },
  );
  const reviewCase = panel.cases[0]!;
  assert.equal(reviewCase.phase, 'skipped');
  const stages = Object.fromEntries(reviewCase.stages.map((s) => [s.role, s.state]));
  assert.equal(stages.critic, 'skipped');
  assert.equal(stages.editor, 'skipped');
});

test('auto-selects the most recently active session and ignores older ones', () => {
  const panel = buildEvolutionPanel(
    [
      record({
        recordId: 'monitor-old',
        sessionId: 'session-old',
        triggerKey: 'session-end:session-old',
        status: 'noop',
        updatedAt: '2026-07-09T10:00:00.000Z',
      }),
      record({
        recordId: 'monitor-new',
        sessionId: 'session-new',
        triggerKey: 'user-feedback:evt-9',
        status: 'analysis-complete',
        updatedAt: '2026-07-09T11:59:00.000Z',
      }),
    ],
    { nowMs: NOW },
  );
  assert.equal(panel.sessionId, 'session-new');
  assert.equal(panel.cases.length, 1);
  assert.equal(panel.cases[0]!.caseId, 'user-feedback:evt-9');
});

test('auto-picked session drops stale cases outside the recent window', () => {
  const panel = buildEvolutionPanel(
    [
      record({
        sessionId: 'session-stale',
        triggerKey: 'session-end:session-stale',
        status: 'noop',
        updatedAt: '2026-07-09T08:00:00.000Z',
      }),
    ],
    { nowMs: NOW, recentMinutes: 30 },
  );
  assert.equal(panel.sessionId, 'session-stale');
  assert.deepEqual(panel.cases, []);
});

test('explicit session scope shows its cases regardless of age', () => {
  const panel = buildEvolutionPanel(
    [
      record({
        sessionId: 'session-stale',
        triggerKey: 'session-end:session-stale',
        status: 'noop',
        updatedAt: '2026-07-09T08:00:00.000Z',
      }),
    ],
    { nowMs: NOW, recentMinutes: 30, sessionId: 'session-stale' },
  );
  assert.equal(panel.cases.length, 1);
  assert.equal(panel.cases[0]!.phase, 'noop');
});

test('malformed rows are dropped instead of crashing the panel', () => {
  const panel = buildEvolutionPanel(
    [null, 42, 'nope', {}, { recordId: 'x' }, record({})],
    { nowMs: NOW },
  );
  assert.equal(panel.cases.length, 1);
});
