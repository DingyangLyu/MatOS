/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, test } from 'bun:test'
import {
  computeJobReceiptFromBackendOutput,
  computeJobSpecForNode,
  computeToolRefForSpec,
} from './nodeAdapters/computeNode.js'
import type { MatOSWorkflowNode } from './types.js'

describe('MatOS workflow compute node contract', () => {
  test('normalizes explicitly configured compute node fields into a compute job spec', () => {
    const input = {
      workdir: '/workspace/group/shared/qe-si/attempt-01',
      remoteMountCodePath: '/srv/matos-test-fixtures/qe-si/attempt-01',
      resourceQueueName: 'research-queue',
      flavor: 'configured-flavor',
      entrypoint: './run-qe.sh',
    }
    const node: MatOSWorkflowNode = {
      id: 'generate_yaml',
      type: 'compute',
      dependsOn: [],
      backend: 'configured-compute',
      operation: 'generate_yaml',
      input,
    }

    const spec = computeJobSpecForNode(node)

    expect(spec).toEqual({
      backend: 'configured-compute',
      operation: 'generate-yaml',
      workdir: '/workspace/group/shared/qe-si/attempt-01',
      remoteWorkdir: '/srv/matos-test-fixtures/qe-si/attempt-01',
      queue: 'research-queue',
      flavor: 'configured-flavor',
      command: './run-qe.sh',
      inputs: input,
      metadata: {},
    })
    expect(computeToolRefForSpec(spec)).toBeUndefined()
  })

  test('accepts inputs as a backend-compatible alias for compute node input', () => {
    const inputs = {
      workdir: '/workspace/group/shared/qe-si/attempt-02',
      remoteMountCodePath: '/srv/matos-test-fixtures/qe-si/attempt-02',
      resourceQueueName: 'research-queue',
    }
    const node: MatOSWorkflowNode = {
      id: 'generate_yaml',
      type: 'compute',
      dependsOn: [],
      backend: 'configured-compute',
      operation: 'generate_yaml',
      inputs,
    }

    const spec = computeJobSpecForNode(node)

    expect(spec.workdir).toBe('/workspace/group/shared/qe-si/attempt-02')
    expect(spec.remoteWorkdir).toBe(
      '/srv/matos-test-fixtures/qe-si/attempt-02',
    )
    expect(spec.queue).toBe('research-queue')
    expect(spec.inputs).toBe(inputs)
  })

  test('wraps backend tool output as a stable compute job receipt', () => {
    const spec = computeJobSpecForNode({
      id: 'submit',
      type: 'compute',
      dependsOn: [],
      backend: 'configured-compute',
      operation: 'submit',
      input: {
        workdir: '/workspace/group/shared/qe-si/attempt-01',
        yamlPath: '/workspace/group/shared/qe-si/attempt-01/task.yaml',
        dryRun: true,
      },
    })

    const receipt = computeJobReceiptFromBackendOutput(spec, {
      ok: true,
      backend: 'configured-compute',
      toolRef: 'tool:configured-compute-submit',
      toolId: 'configured-compute-submit',
      exitCode: 0,
      payload: {
        dryRun: true,
        command: ['configured-scheduler', 'task', 'submit', '--conf', '/workspace/task.yaml'],
        visibleWorkdir: '/workspace/group/shared/qe-si/attempt-01',
        remoteWorkdir: '/srv/matos-test-fixtures/qe-si/attempt-01',
        status: 'dry-run',
      },
    })

    expect(receipt).toMatchObject({
      ok: true,
      backend: 'configured-compute',
      operation: 'submit',
      toolRef: 'tool:configured-compute-submit',
      toolId: 'configured-compute-submit',
      exitCode: 0,
      workdir: '/workspace/group/shared/qe-si/attempt-01',
      remoteWorkdir: '/srv/matos-test-fixtures/qe-si/attempt-01',
      status: 'dry-run',
      artifacts: [],
      diagnostics: {},
      payload: {
        dryRun: true,
        command: ['configured-scheduler', 'task', 'submit', '--conf', '/workspace/task.yaml'],
        visibleWorkdir: '/workspace/group/shared/qe-si/attempt-01',
        remoteWorkdir: '/srv/matos-test-fixtures/qe-si/attempt-01',
        status: 'dry-run',
      },
    })
    expect(receipt.cancelState).toBe('not_requested')
    expect(receipt.reconcileState).toBe('not_needed')
    expect(receipt.statusTimeline?.[0]).toMatchObject({
      source: 'submit',
      status: 'dry-run',
    })
  })

  test('extracts long-running job identifiers logs artifacts and diagnostics from backend output', () => {
    const spec = computeJobSpecForNode({
      id: 'status',
      type: 'compute',
      dependsOn: [],
      backend: 'configured-compute',
      operation: 'status',
      input: {
        taskId: 'task-input',
        workdir: '/workspace/group/shared/job',
      },
    })

    const receipt = computeJobReceiptFromBackendOutput(spec, {
      ok: true,
      backend: 'configured-compute',
      toolRef: 'tool:configured-compute-status',
      toolId: 'configured-compute-status',
      exitCode: 0,
      diagnostics: { source: 'hpc-cli' },
      payload: {
        jobId: 'job-123',
        taskId: 'task-456',
        state: 'Running',
        logs: { stdout: 'started' },
        artifacts: [
          {
            id: 'stdout-log',
            path: '/workspace/group/shared/job/stdout.log',
            kind: 'log',
          },
        ],
      },
    })

    expect(receipt).toMatchObject({
      ok: true,
      backend: 'configured-compute',
      operation: 'status',
      toolRef: 'tool:configured-compute-status',
      toolId: 'configured-compute-status',
      exitCode: 0,
      jobId: 'job-123',
      taskId: 'task-456',
      workdir: '/workspace/group/shared/job',
      status: 'Running',
      logs: { stdout: 'started' },
      artifacts: [
        {
          id: 'stdout-log',
          path: '/workspace/group/shared/job/stdout.log',
          kind: 'log',
        },
      ],
      diagnostics: { source: 'hpc-cli' },
      payload: {
        jobId: 'job-123',
        taskId: 'task-456',
        state: 'Running',
        logs: { stdout: 'started' },
        artifacts: [
          {
            id: 'stdout-log',
            path: '/workspace/group/shared/job/stdout.log',
            kind: 'log',
          },
        ],
      },
    })
    expect(receipt.cancelState).toBe('not_requested')
    expect(receipt.reconcileState).toBe('not_needed')
    expect(receipt.statusTimeline?.[0]).toMatchObject({
      source: 'status',
      status: 'Running',
    })
  })
})
