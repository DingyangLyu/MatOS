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

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  instantiateWorkflowNodeTemplate,
  listWorkflowNodeTemplates,
  workflowDefinitionFromTemplate,
  workflowNodeTemplateById,
} from './nodeTemplates.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import { startWorkflowRun } from './workflowRuntime.js'

describe('workflow node templates', () => {
  test('every template instantiates into a valid single-node workflow', () => {
    // The quality gate: a template that fails structural validation would
    // teach agents broken idioms — every entry must pass as-is.
    const templates = listWorkflowNodeTemplates()
    expect(templates.length).toBeGreaterThanOrEqual(8)
    for (const template of templates) {
      const definition = workflowDefinitionFromTemplate(template)
      const validation = validateWorkflowDefinition(definition)
      expect(
        { id: template.id, ok: validation.ok, errors: validation.errors },
      ).toEqual({ id: template.id, ok: true, errors: [] })
    }
  })

  test('template ids are unique and carry usage + parameter documentation', () => {
    const templates = listWorkflowNodeTemplates()
    const ids = templates.map(template => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of templates) {
      expect(template.usage.length).toBeGreaterThan(20)
      expect(template.description.length).toBeGreaterThan(20)
      for (const parameter of Object.values(template.parameters)) {
        expect(parameter.description?.length ?? 0).toBeGreaterThan(10)
      }
    }
  })

  test('filters by tag and node type', () => {
    const qe = listWorkflowNodeTemplates({ tag: 'qe' })
    expect(qe.map(template => template.id)).toContain('qe-pw-exec')
    expect(qe.map(template => template.id)).toContain('qe-convergence-guard')
    const guards = listWorkflowNodeTemplates({ nodeType: 'guard' })
    expect(guards.every(template => template.nodeType === 'guard')).toBe(true)
    expect(workflowNodeTemplateById('nope')).toBeUndefined()
  })

  test('instantiation wires dependsOn and keeps parameter references resolvable', () => {
    const guard = workflowNodeTemplateById('qe-convergence-guard')!
    const { node, parameters } = instantiateWorkflowNodeTemplate(guard, {
      id: 'gate',
      dependsOn: ['run_qe'],
    })
    expect(node.id).toBe('gate')
    expect(node.dependsOn).toEqual(['run_qe'])
    expect(Object.keys(parameters)).toEqual(['qe_output_file'])

    // A chained two-template workflow (exec producer + guard) stays valid.
    const exec = workflowNodeTemplateById('qe-pw-exec')!
    const producer = instantiateWorkflowNodeTemplate(exec, { id: 'run_qe' })
    const definition = {
      schemaVersion: 1,
      name: 'chained',
      version: '0.1.0',
      parameters: { ...producer.parameters, ...parameters },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [producer.node, node],
      outputs: {},
    }
    const validation = validateWorkflowDefinition(
      definition as Parameters<typeof validateWorkflowDefinition>[0],
    )
    expect(validation.errors).toEqual([])
    expect(validation.ok).toBe(true)
  })

  test('a template-built workflow actually runs end to end', async () => {
    // Real execution proof for the general-purpose pair: exec-script writes
    // its artifact-root result and results-guard passes over it.
    const root = await mkdtemp(join(tmpdir(), 'matos-node-template-run-'))
    const script = instantiateWorkflowNodeTemplate(
      workflowNodeTemplateById('exec-script')!,
      { id: 'work' },
    )
    const guard = instantiateWorkflowNodeTemplate(
      workflowNodeTemplateById('results-guard')!,
      { id: 'gate', dependsOn: ['work'] },
    )
    // Out-of-the-box pairing: exec-script writes result.txt into the run's
    // artifact root and results-guard gates that same location by default.
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:template-run@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'template-run',
        version: '0.1.0',
        parameters: {
          ...script.parameters,
          ...guard.parameters,
        },
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [script.node, guard.node],
        outputs: {},
      } as Parameters<typeof startWorkflowRun>[0]['definition'],
    })
    expect(run.status).toBe('completed')
  }, 30000)
})
