import { describe, expect, it } from 'vitest';
import {
  controlArgs,
  normalizeWorkflowEvents,
  normalizeWorkflowPublish,
  normalizeWorkflowRun,
  normalizeWorkflowValidation,
  parametersToArgs,
  pickWorkflowNodeDetail,
  sanitizeWorkflowId,
  workflowDraftIdFor,
  workflowValidationFromMutationRejection,
} from '../../src/routes/matos-workflow.js';

describe('matos workflow bridge helpers', () => {
  it('derives a stable, safe draft id per canvas', () => {
    const a = workflowDraftIdFor('/repo', 'demo.workflow.json');
    const b = workflowDraftIdFor('/repo', 'demo.workflow.json');
    const c = workflowDraftIdFor('/repo', 'other.workflow.json');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^od-canvas-[0-9a-f]{12}$/);
  });

  it('sanitizes workflow names into registry-safe ids', () => {
    expect(sanitizeWorkflowId('LiFePO4 Formation Energy')).toBe('lifepo4-formation-energy');
    expect(sanitizeWorkflowId('  --Weird__Name!!  ')).toBe('weird__name');
    // Leading digits are valid asset-id first chars, so they survive.
    expect(sanitizeWorkflowId('123abc')).toBe('123abc');
    // A leading dot is not a valid first char and is stripped.
    expect(sanitizeWorkflowId('.hidden')).toBe('hidden');
    expect(sanitizeWorkflowId('')).toBe('canvas-workflow');
    expect(sanitizeWorkflowId('***')).toBe('canvas-workflow');
  });

  it('normalizes replace-definition validation payloads', () => {
    const result = normalizeWorkflowValidation({
      validation: {
        ok: false,
        errors: [
          { code: 'missing_node', message: 'node b missing' },
          { message: 'no code field' },
          'ignored',
        ],
      },
      workflowRef: 'workflow:demo',
      metadata: { nodeCount: 3, risk: 'low' },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      { code: 'missing_node', message: 'node b missing' },
      { code: 'error', message: 'no code field' },
    ]);
    expect(result.workflowRef).toBe('workflow:demo');
    expect(result.nodeCount).toBe(3);
    expect(result.risk).toBe('low');
  });

  it('turns a replace-definition hard rejection into a structured verdict', () => {
    // The native draft store keeps drafts always-valid, so an incomplete
    // canvas graph makes `draft replace-definition` exit 1 with a joined
    // stderr message instead of a --json verdict. The bridge must render that
    // as a normal invalid validation, not a raw 502 (the reported bug showed
    // "matos workflow draft replace-definition failed: Invalid workflow draft
    // definition: Agent node requires role; ..." as a red error blob).
    const verdict = workflowValidationFromMutationRejection(
      'matos workflow draft failed: Invalid workflow draft definition: ' +
        'Agent node requires role; Agent node requires prompt or systemPrompt; Backend node requires backend\n',
    );
    expect(verdict).toEqual({
      ok: false,
      errors: [
        { code: 'invalid_definition', message: 'Agent node requires role' },
        { code: 'invalid_definition', message: 'Agent node requires prompt or systemPrompt' },
        { code: 'invalid_definition', message: 'Backend node requires backend' },
      ],
      diagnostics: [],
      workflowRef: null,
      nodeCount: null,
      risk: null,
    });

    // Empty tail still yields a non-empty errors list so the strip renders.
    expect(
      workflowValidationFromMutationRejection('x: Invalid workflow draft definition:  ')?.errors,
    ).toEqual([{ code: 'invalid_definition', message: 'workflow validation failed' }]);

    // Anything else is a real bridge failure and must keep throwing.
    expect(workflowValidationFromMutationRejection('matos: command not found')).toBeNull();
    expect(workflowValidationFromMutationRejection('EACCES: permission denied')).toBeNull();
  });

  it('normalizes compile-style diagnostics at the top level', () => {
    const result = normalizeWorkflowValidation({
      ok: true,
      diagnostics: [
        { severity: 'warning', code: 'unused', message: 'node c unused', nodeId: 'c' },
        { code: 'x' },
      ],
      metadata: { nodeCount: 2, risk: 'medium' },
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      { severity: 'warning', code: 'unused', message: 'node c unused', nodeId: 'c' },
    ]);
    expect(result.risk).toBe('medium');
  });

  it('normalizes run and status payloads with node lists', () => {
    const fromRun = normalizeWorkflowRun({
      run: {
        runId: 'run-123',
        status: 'running',
        nodes: [
          { nodeId: 'a', status: 'succeeded' },
          { id: 'b', status: 'running' },
          { status: 'pending' },
        ],
      },
    });
    expect(fromRun.runId).toBe('run-123');
    expect(fromRun.status).toBe('running');
    expect(fromRun.nodes.map((node) => [node.nodeId, node.status])).toEqual([
      ['a', 'succeeded'],
      ['b', 'running'],
    ]);
    // Without diagnostics, running nodes drive the active set.
    expect(fromRun.activeNodeIds).toEqual(['b']);

    const minimal = normalizeWorkflowRun({ id: 'r2', status: 'failed' });
    expect(minimal.runId).toBe('r2');
    expect(minimal.status).toBe('failed');
    expect(minimal.nodes).toEqual([]);
    expect(minimal.pendingApprovals).toEqual([]);
    expect(minimal.budget).toBeNull();
    expect(minimal.outputs).toBeNull();
  });

  it('includes unstarted graph nodes in progress without exposing executable node bodies', () => {
    const run = normalizeWorkflowRun({
      runId: 'graph-progress', status: 'running', workflowRef: 'workflow:pinned@1.0.0', workflowName: 'Pinned workflow',
      nodes: [{ nodeId: 'prepare', status: 'completed' }],
      graph: { nodes: [
        { id: 'prepare', label: 'Prepare sample', type: 'exec', dependsOn: [], command: 'private command' },
        { id: 'analyze', type: 'agent', dependsOn: ['prepare'], prompt: 'private prompt' },
      ], edges: [{ from: 'prepare', to: 'analyze' }] },
    });
    expect(run.workflowName).toBe('Pinned workflow');
    expect(run.workflowRef).toBe('workflow:pinned@1.0.0');
    expect(run.nodes.map((node) => [node.nodeId, node.status])).toEqual([['prepare', 'completed'], ['analyze', 'pending']]);
    expect(run.graph?.nodes[0]?.label).toBe('Prepare sample');
    expect(JSON.stringify(run.graph)).not.toContain('private');
  });

  it('normalizes rich inspect payloads (diagnostics, approvals, budget)', () => {
    const startedAt = '2026-07-09T11:30:54.613Z';
    const updatedAt = '2026-07-09T11:30:57.631Z';
    const view = normalizeWorkflowRun({
      run: {
        runId: 'run-777',
        status: 'running',
        waitingNodeId: 'gate',
        nodes: [
          {
            nodeId: 'first',
            status: 'completed',
            attempts: 1,
            startedAt,
            updatedAt,
            output: { exitCode: 0, stdout: 'huge payload dropped' },
          },
          {
            nodeId: 'boom',
            status: 'failed',
            attempts: 2,
            startedAt,
            updatedAt,
            error: { message: 'exit 3' },
          },
          { nodeId: 'later', status: 'running', startedAt: updatedAt },
        ],
        diagnostics: { activeNodeIds: ['later'] },
        pendingApprovals: [
          {
            nodeId: 'gate',
            status: 'pending',
            actionFingerprint: 'fp-1',
            requestedAt: updatedAt,
          },
        ],
        budget: {
          totals: {
            totalTokens: 1234,
            totalCostUsd: 0.05,
            wallTimeMs: 3022,
            elapsedWallTimeMs: 17063,
            agentCalls: 0,
            toolCalls: 2,
          },
        },
        outputs: { final: { value: 'ok' } },
      },
      detached: true,
    });
    expect(view.runId).toBe('run-777');
    expect(view.waitingNodeId).toBe('gate');
    expect(view.detached).toBe(true);
    expect(view.activeNodeIds).toEqual(['later']);

    const first = view.nodes.find((node) => node.nodeId === 'first');
    // Settled node duration comes from startedAt -> updatedAt, not now().
    expect(first?.durationMs).toBe(Date.parse(updatedAt) - Date.parse(startedAt));
    expect(first?.finishedAt).toBe(updatedAt);
    // Node output payloads are intentionally not part of the poll summary.
    expect(first && 'output' in first).toBe(false);

    const boom = view.nodes.find((node) => node.nodeId === 'boom');
    expect(boom?.error).toBe('exit 3');
    expect(boom?.attempts).toBe(2);

    const later = view.nodes.find((node) => node.nodeId === 'later');
    expect(later?.durationMs).toBeGreaterThanOrEqual(0);

    expect(view.pendingApprovals).toEqual([
      { nodeId: 'gate', status: 'pending', fingerprint: 'fp-1', requestedAt: updatedAt },
    ]);
    expect(view.budget).toEqual({
      totalTokens: 1234,
      totalCostUsd: 0.05,
      wallTimeMs: 3022,
      elapsedWallTimeMs: 17063,
      agentCalls: 0,
      toolCalls: 2,
    });
    expect(view.outputs).toEqual({ final: { value: 'ok' } });
  });

  it('normalizes event feeds and lifts nodeId out of data', () => {
    const events = normalizeWorkflowEvents({
      events: [
        {
          id: 'e1',
          timestamp: '2026-07-09T11:30:54.618Z',
          type: 'workflow.node.started',
          data: { nodeId: 'first', attempt: 1 },
        },
        { type: 'workflow.run.completed' },
        { data: { nodeId: 'missing-type' } },
        'garbage',
      ],
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: 'e1',
      type: 'workflow.node.started',
      nodeId: 'first',
    });
    expect(events[1]).toMatchObject({ type: 'workflow.run.completed', nodeId: null });
  });

  it('picks one node detail with output/error payloads intact', () => {
    const payload = {
      run: {
        nodes: [
          {
            nodeId: 'relax',
            status: 'completed',
            attempts: 1,
            startedAt: '2026-07-09T11:30:54.613Z',
            updatedAt: '2026-07-09T11:30:57.631Z',
            output: { exitCode: 0, stdout: 'first-done\n', stderr: '' },
          },
        ],
      },
    };
    const detail = pickWorkflowNodeDetail(payload, 'relax');
    expect(detail?.status).toBe('completed');
    expect(detail?.output).toEqual({ exitCode: 0, stdout: 'first-done\n', stderr: '' });
    expect(detail?.durationMs).toBe(3018);
    expect(pickWorkflowNodeDetail(payload, 'nope')).toBeNull();
  });

  it('maps whitelisted control actions onto CLI argv and rejects the rest', () => {
    expect(controlArgs('run-1', 'cancel', {})).toEqual(['workflow', 'cancel', 'run-1', '--json']);
    expect(controlArgs('run-1', 'retry-node', { nodeId: 'boom' })).toEqual([
      'workflow',
      'retry-node',
      'run-1',
      '--node',
      'boom',
      '--json',
    ]);
    expect(controlArgs('run-1', 'retry-node', {})).toBeNull();
    expect(controlArgs('run-1', 'approve', { nodeId: 'gate', fingerprint: 'fp' })).toEqual([
      'workflow',
      'approve',
      'run-1',
      '--node',
      'gate',
      '--fingerprint',
      'fp',
      '--json',
    ]);
    expect(controlArgs('run-1', 'respond', { nodeId: 'ask', message: 'yes' })).toEqual([
      'workflow',
      'respond',
      'run-1',
      '--node',
      'ask',
      '--message',
      'yes',
      '--json',
    ]);
    expect(controlArgs('run-1', 'rm -rf /', {})).toBeNull();
    expect(controlArgs('run-1', null, {})).toBeNull();
  });

  it('builds a workflow ref from the published asset key', () => {
    expect(normalizeWorkflowPublish({ published: { assetKey: 'workflow:demo@0.1.0' } })).toEqual({
      assetKey: 'workflow:demo@0.1.0',
      workflowRef: 'workflow:demo@0.1.0',
    });
    expect(normalizeWorkflowPublish({ published: { id: 'demo', version: '0.2.0' } })).toEqual({
      assetKey: null,
      workflowRef: 'workflow:demo@0.2.0',
    });
    expect(normalizeWorkflowPublish({ assetKey: 'demo' })).toEqual({
      assetKey: 'demo',
      workflowRef: 'workflow:demo',
    });
  });

  it('does not report a disabled or unaccepted scoped workflow as published', () => {
    for (const scopedGiteaSync of [
      { ok: false, action: 'failed', localAssetDisabled: true },
      { ok: true, action: 'synced', activationRequired: true },
    ]) {
      expect(() => normalizeWorkflowPublish({
        published: { assetKey: 'workflow:demo@0.1.0' }, scopedGiteaSync,
      })).toThrow(/accepted runtime asset/);
    }
    expect(normalizeWorkflowPublish({
      published: { assetKey: 'workflow:demo@0.1.0' },
      scopedGiteaSync: { ok: true, action: 'synced', localAssetRemoved: true },
    }).workflowRef).toBe('workflow:demo@0.1.0');
  });

  it('rejects a failed scoped publication even if the CLI returned an asset key', () => {
    expect(() => normalizeWorkflowPublish({
      published: { assetKey: 'workflow:demo@0.1.0' },
      scopedGiteaSync: { ok: false, action: 'failed', localAssetDisabled: true },
    })).toThrow(/publication failed/i);
  });

  it('encodes parameters as repeated --param key=value args', () => {
    expect(parametersToArgs({ temperature: '300', steps: 10, flag: true })).toEqual([
      '--param',
      'temperature=300',
      '--param',
      'steps=10',
      '--param',
      'flag=true',
    ]);
    expect(parametersToArgs(null)).toEqual([]);
    expect(parametersToArgs('nope')).toEqual([]);
  });
});
