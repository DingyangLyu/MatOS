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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  inspectWorkflowRun,
  startWorkflowRun,
} from './workflowRuntime.js'
import { readWorkflowRunEvents } from './workflowStore.js'

describe('MatOS workflow validation engine', () => {
  test('guard expression checks use the same node status templates as workflow conditions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-validation-status-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validation-status@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validation-status',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          guardOk: { value: '{{ nodes.check_status.outputs.ok }}' },
        },
        nodes: [
          {
            id: 'prepare',
            type: 'exec',
            dependsOn: [],
            command: 'printf prepared > prepared.txt',
          },
          {
            id: 'check_status',
            type: 'guard',
            dependsOn: ['prepare'],
            checks: [
              {
                type: 'expression',
                value: '{{ nodes.prepare.status }} == completed',
              },
            ],
          },
          {
            id: 'condition_branch',
            type: 'exec',
            dependsOn: [],
            command: 'printf branch > branch.txt',
          },
        ],
        edges: [
          {
            from: 'prepare',
            to: 'condition_branch',
            condition: '{{ nodes.prepare.status }} == completed',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.guardOk).toBe(true)
    expect(await readFile(join(root, 'branch.txt'), 'utf8')).toBe('branch')
  })

  test('guard expression checks can require exec stdout to contain a marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-validation-stdout-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validation-stdout@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validation-stdout',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          guardOk: { value: '{{ nodes.check_stdout.outputs.ok }}' },
        },
        nodes: [
          {
            id: 'emit',
            type: 'exec',
            dependsOn: [],
            command: 'printf workflow-ok',
          },
          {
            id: 'check_stdout',
            type: 'guard',
            dependsOn: ['emit'],
            checks: [
              {
                type: 'expression',
                value: '{{ nodes.emit.outputs.stdout }} contains "workflow-ok"',
              },
            ],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.guardOk).toBe(true)
  })

  test('validate nodes preserve observed expected evidence and recommendation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-validation-evidence-'))
    const evidencePath = join(root, 'result.json')
    await mkdir(root, { recursive: true })
    await writeFile(evidencePath, '{"energy": -5.1}\n', 'utf8')

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validation-evidence@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validation-evidence',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          recommendation: { value: '{{ nodes.validate_result.outputs.recommendation }}' },
        },
        nodes: [
          {
            id: 'validate_result',
            type: 'validate',
            dependsOn: [],
            checks: [
              {
                id: 'energy-window',
                type: 'numeric_range',
                value: -5.1,
                min: -5.2,
                max: -5.0,
                evidence: [
                  {
                    id: 'energy-json',
                    path: evidencePath,
                    kind: 'validation-evidence',
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.recommendation).toBe('continue')

    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.output).toEqual({
      ok: true,
      severity: 'info',
      recommendation: 'continue',
      checks: [
        {
          id: 'energy-window',
          type: 'numeric_range',
          ok: true,
          observed: -5.1,
          expected: { min: -5.2, max: -5.0 },
          evidence: [
            {
              id: 'energy-json',
              path: evidencePath,
              kind: 'validation-evidence',
            },
          ],
        },
      ],
    })
  })

  test('citation grep gates accept non-zero-padded MatOS source IDs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-validation-citations-'))
    await mkdir(root, { recursive: true })
    await writeFile(
      join(root, 'final_report.md'),
      'The convergence recommendation is source backed [S1].\n',
      'utf8',
    )

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validation-citations@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validation-citations',
        parameters: {},
        outputs: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [
          {
            id: 'validate_report',
            type: 'validate',
            dependsOn: [],
            checks: [
              {
                id: 'report-cites-sources',
                type: 'grep',
                path: join(root, 'final_report.md'),
                pattern: '[S',
              },
            ],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.output).toMatchObject({
      ok: true,
      recommendation: 'continue',
      checks: [
        {
          id: 'report-cites-sources',
          ok: true,
          expected: '[S',
        },
      ],
    })
  })

  test('validate nodes preserve explicit failure recommendations for adaptive routing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-validation-reroute-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validation-reroute@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validation-reroute',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          recommendation: {
            value: '{{ nodes.validate_result.outputs.recommendation }}',
          },
          recovery: { value: '{{ nodes.recover.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'validate_result',
            type: 'validate',
            dependsOn: [],
            recommendation: 'reroute',
            checks: [{ type: 'file_exists', path: 'missing.txt' }],
          },
          {
            id: 'recover',
            type: 'exec',
            dependsOn: [],
            command: 'printf rerouted',
          },
        ],
        edges: [
          {
            from: 'validate_result',
            to: 'recover',
            condition:
              '{{ nodes.validate_result.outputs.recommendation }} == reroute',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.recommendation).toBe('reroute')
    expect(run.outputs.recovery).toBe('rerouted')
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.validation.reroute_requested',
    )
  })

  test('validate nodes fail the run when validation output recommends fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-validation-output-fail-'))

    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validation-output-fail@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validation-output-fail',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          recommendation: {
            value: '{{ nodes.validate_result.outputs.recommendation }}',
          },
        },
        nodes: [
          {
            id: 'validate_result',
            type: 'validate',
            dependsOn: [],
            checks: [{ id: 'missing', type: 'file_exists', path: 'missing.txt' }],
          },
        ],
      },
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.status).toBe('failed')
    expect(inspected.nodes?.[0]?.output).toMatchObject({
      ok: false,
      severity: 'error',
      recommendation: 'fail',
    })
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.validation.decision',
    )
  })
})
