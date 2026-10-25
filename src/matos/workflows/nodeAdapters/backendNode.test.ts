import { describe, expect, test } from 'bun:test'
import type { MatOSWorkflowNode } from '../types.js'
import {
  runWorkflowBackendNode,
  workflowBackendFailureDetail,
} from './backendNode.js'

describe('backend node dynamic tool allowlist', () => {
  test('rejects a resolved tool outside the immutable allowlist before asset loading', async () => {
    const node: MatOSWorkflowNode = {
      id: 'dynamic_backend',
      type: 'backend',
      dependsOn: [],
      backend: 'test',
      tool: 'tool:blocked@1.0.0',
      toolAllowlist: ['tool:allowed@1.0.0'],
      input: {},
    }

    await expect(
      runWorkflowBackendNode(node, { cwd: '/path/that/must/not/be-read' }),
    ).rejects.toThrow(
      'MatOS backend tool is outside node toolAllowlist: tool:blocked@1.0.0',
    )
  })

  test('uses a structured stdout error when a tool exits without stderr', () => {
    expect(
      workflowBackendFailureDetail({
        stderr: '',
        stdout: '{"ok":false,"error":"batch backend is unavailable"}',
        payload: { ok: false, error: 'batch backend is unavailable' },
      }),
    ).toBe('batch backend is unavailable')
  })

  test('preserves stderr precedence for failed tools', () => {
    expect(
      workflowBackendFailureDetail({
        stderr: 'solver exited unexpectedly',
        stdout: '{"ok":false,"error":"less specific"}',
        payload: { ok: false, error: 'less specific' },
      }),
    ).toBe('solver exited unexpectedly')
  })
})
