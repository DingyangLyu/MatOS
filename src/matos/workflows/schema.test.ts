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

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { getMatOSConfigPath } from '../project.js'
import { loadWorkflowAsset } from './loadWorkflow.js'
import {
  MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES,
  MATOS_WORKFLOW_RUNTIME_NODE_TYPES,
  MATOS_WORKFLOW_TARGET_RUNTIME_TYPES,
  sampleWorkflowDefinitionForManifest,
  validateMatOSWorkflowNodeManifests,
  workflowNodeManifestCoverageReport,
} from './nodeManifests.js'
import { parseWorkflowDefinition } from './schema.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import { compileMatOSWorkflowDefinition } from './workflowCompile.js'
import {
  extractWorkflowTemplateExpressions,
  parseWorkflowReferenceExpression,
} from './workflowReferences.js'
import { compileWorkflowDefinition } from './workflowCompiler.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('MatOS workflow schema', () => {
  test('loads a workflow asset and validates a deterministic DAG', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-schema-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'relax')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'relax',
      type: 'workflow',
      name: 'Relax',
      version: '0.1.0',
      entry: 'workflow.yaml',
      runtime: { workflow: { kind: 'executable', approvalMode: 'bypass' } },
    })
    await writeFile(
      join(workflowDir, 'workflow.yaml'),
      [
        'schemaVersion: 1',
        'name: relax',
        'version: "0.1.0"',
        'parameters:',
        '  structure_path:',
        '    type: string',
        '    required: true',
        'nodes:',
        '  prepare:',
        '    type: exec',
        '    command: "printf ready"',
        '  check:',
        '    type: guard',
        '    dependsOn: [prepare]',
        '    checks:',
        '      - type: expression',
        '        value: "{{ nodes.prepare.status }} == completed"',
        'outputs:',
        '  status:',
        '    value: "{{ nodes.check.outputs.ok }}"',
        '  input_path:',
        '    value: "{{ parameters.structure_path }}"',
      ].join('\n'),
      'utf8',
    )

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const loaded = await loadWorkflowAsset(registry, 'workflow:relax')
    const validation = validateWorkflowDefinition(loaded.definition)

    expect(loaded.asset.canonicalKey).toBe('workflow:relax@0.1.0')
    expect(loaded.kind).toBe('executable')
    expect(loaded.definition.nodes.map(node => node.id)).toEqual([
      'prepare',
      'check',
    ])
    expect(validation.ok).toBe(true)
  })

  test('keeps supported workflow node types covered by native builder manifests', () => {
    const manifestTypes = new Set(
      MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES.map(manifest => manifest.type),
    )
    const buildableTypes = new Set<string>([
      ...MATOS_WORKFLOW_RUNTIME_NODE_TYPES,
      ...Object.keys(MATOS_WORKFLOW_TARGET_RUNTIME_TYPES),
    ])

    expect([...buildableTypes].sort()).toEqual([...manifestTypes].sort())
  })

  test('validates every native node manifest and sample definition', () => {
    const manifestValidation = validateMatOSWorkflowNodeManifests()
    expect(manifestValidation).toMatchObject({
      ok: true,
      manifestCount: 14,
      paletteCount: 11,
    })
    expect(manifestValidation.issues).toEqual([])

    const report = workflowNodeManifestCoverageReport()
    expect(report.samples.map(sample => sample.type).sort()).toEqual(
      MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES.map(manifest => manifest.type).sort(),
    )

    for (const manifest of MATOS_WORKFLOW_NODE_MANIFEST_SUMMARIES) {
      expect(manifest.schemaVersion).toBe(1)
      expect(manifest.id).toBe(`workflow-node:${manifest.type}@1.0.0`)
      expect(manifest.version).toBe('1.0.0')
      expect(manifest.display?.title).toBe(manifest.title)
      expect(manifest.semanticType).toBe(manifest.targetType)
      expect(manifest.cozeAdapter?.nativeProductField).toBe('matosProduct')
      expect(manifest.compile?.nativeProductField).toBe('matosProduct')
      expect(manifest.form?.requiredFields).toEqual(manifest.requiredFields)
      expect(manifest.variables?.inputs).toEqual(manifest.ports?.inputs)
      expect(manifest.contracts?.inputContractPath).toBe('inputContract')
      expect(manifest.matosProduct?.manifestType).toBe(manifest.type)
      const definition = sampleWorkflowDefinitionForManifest(manifest)
      const validation = validateWorkflowDefinition(definition)
      expect(validation.ok, `${manifest.type}: ${JSON.stringify(validation.errors)}`).toBe(true)
    }
  })

  test('rejects extension nodes until a native runtime adapter exists', () => {
    const validation = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'reserved-extension-node',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'future_extension',
          type: 'extension',
          dependsOn: [],
        },
      ],
    })

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_node_type',
          nodeId: 'future_extension',
          path: 'nodes.future_extension.type',
        }),
      ]),
    )
  })

  test('warns when worst-case attempts exceed the declared budget', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'budget-estimate',
        version: '0.1.0',
        policy: { budget: { maxNodeAttempts: 2 } },
        nodes: {
          flaky: {
            type: 'exec',
            dependsOn: [],
            command: 'true',
            policy: { retry: { maxAttempts: 3 } },
          },
          fan: {
            type: 'loop',
            dependsOn: ['flaky'],
            workflow: 'workflow:child@0.1.0',
            maxIterations: 4,
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    // worst case: flaky retries 3 + loop 4 iterations = 7 > 2
    expect(validation.warnings?.map(warning => warning.code)).toContain(
      'budget_worst_case_attempts',
    )
  })

  test('rejects exec args that are not a string array', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'bad-exec-args',
        version: '0.1.0',
        nodes: {
          bad: {
            type: 'exec',
            dependsOn: [],
            command: 'python3',
            args: ['-c', 42],
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(false)
    expect(validation.errors).toContainEqual(
      expect.objectContaining({
        code: 'invalid_node_config',
        nodeId: 'bad',
        path: 'nodes.bad.args',
      }),
    )
  })

  test('warns when a node budget cannot cover its own retry policy', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'node-budget-estimate',
        version: '0.1.0',
        nodes: {
          flaky: {
            type: 'exec',
            dependsOn: [],
            command: 'true',
            budget: { maxNodeAttempts: 1 },
            policy: { retry: { maxAttempts: 3 } },
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(true)
    expect(validation.warnings).toEqual([
      expect.objectContaining({
        code: 'node_budget_below_retry',
        nodeId: 'flaky',
      }),
    ])
  })

  test('rejects invalid node budget limits', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'bad-node-budget',
        version: '0.1.0',
        nodes: {
          only: {
            type: 'exec',
            dependsOn: [],
            command: 'true',
            budget: { maxTotalTokens: -5 },
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual([
      expect.objectContaining({
        code: 'invalid_policy',
        nodeId: 'only',
        path: 'nodes.only.budget.maxTotalTokens',
      }),
    ])
  })

  test('reports missing dependencies and cycles', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'bad',
        version: '0.1.0',
        nodes: {
          a: { type: 'exec', dependsOn: ['b'], command: 'true' },
          b: { type: 'exec', dependsOn: ['a'], command: 'true' },
          c: { type: 'guard', dependsOn: ['missing'], checks: [] },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(false)
    expect(validation.errors.map(error => error.code)).toContain(
      'workflow_cycle',
    )
    expect(validation.errors.map(error => error.code)).toContain(
      'missing_node_dependency',
    )
  })

  test('rejects conditional edge cycles in the default DAG execution model', () => {
    const validation = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'edge-cycle',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'a', type: 'exec', dependsOn: [], command: 'printf a' },
        { id: 'b', type: 'exec', dependsOn: [], command: 'printf b' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'a' },
      ],
    })

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'workflow_cycle',
          message: 'Workflow dependency cycle: a -> b -> a',
        }),
      ]),
    )

    const templateBound = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'template bounded map',
      parameters: {
        parallel: { type: 'number', default: 2 },
      },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'scan',
          type: 'map',
          dependsOn: [],
          workflow: 'workflow:child',
          items: ['a', 'b'],
          maxParallel: '{{ parameters.parallel }}',
        },
      ],
    })
    expect(templateBound.ok).toBe(true)
  })

  test('reports missing conditional edge endpoints', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'bad edges',
        version: '0.1.0',
        nodes: {
          a: { type: 'exec', command: 'true' },
        },
        edges: [
          { from: 'missing_source', to: 'a' },
          { from: 'a', to: 'missing_target' },
        ],
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_node_dependency',
          path: 'edges.missing_source->a.from',
        }),
        expect.objectContaining({
          code: 'missing_node_dependency',
          path: 'edges.a->missing_target.to',
        }),
      ]),
    )
  })

  test('rejects unsupported workflow edge routes', () => {
    const result = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'bad-route',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'a', type: 'exec', dependsOn: [], command: 'printf a' },
        { id: 'b', type: 'exec', dependsOn: ['a'], command: 'printf b' },
      ],
      edges: [{ from: 'a', to: 'b', route: 'sometimes' as never }],
    })

    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_policy',
          path: 'edges.a->b.route',
        }),
      ]),
    )
  })

  test('allows outputs to reference node status attempts and error metadata', () => {
    const result = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'node-metadata-outputs',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        status: { value: '{{ nodes.a.status }}' },
        attempts: { value: '{{ nodes.a.attempts }}' },
        error: { value: '{{ nodes.a.error.message }}' },
      },
      nodes: [
        { id: 'a', type: 'exec', dependsOn: [], command: 'printf a' },
      ],
    })

    expect(result).toEqual({ ok: true, errors: [] })
  })

  test('allows outputs to reference workflow artifact metadata', () => {
    const result = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'workflow-metadata-outputs',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        artifactRoot: { value: '{{ workflow.artifactRoot }}' },
        report: { value: '{{ workflow.artifactRoot }}/report.md' },
      },
      nodes: [
        { id: 'write', type: 'exec', dependsOn: [], command: 'printf report' },
      ],
    })

    expect(result).toEqual({ ok: true, errors: [] })
  })

  test('validates agent outputSchema contracts before execution', () => {
    const valid = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'agent-contract',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'plan',
          type: 'agent',
          dependsOn: [],
          role: 'role:deep-research',
          prompt: 'Return JSON.',
          outputSchema: {
            type: 'object',
            required: ['stage'],
            properties: { stage: { type: 'string' } },
          },
        },
      ],
    })
    expect(valid).toEqual({ ok: true, errors: [] })

    const invalid = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'bad-agent-contract',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'plan',
          type: 'agent',
          dependsOn: [],
          role: 'role:deep-research',
          prompt: 'Return JSON.',
          outputSchema: { type: 'object', properties: [] },
        },
      ],
    })
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_output_schema',
          path: 'nodes.plan.outputSchema',
        }),
      ]),
    )

    const wrongNodeType = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'wrong-node-contract',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'prepare',
          type: 'exec',
          dependsOn: [],
          command: 'printf ok',
          outputSchema: { type: 'object' },
        },
      ],
    })
    expect(wrongNodeType.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_output_schema',
          path: 'nodes.prepare.outputSchema',
        }),
      ]),
    )
  })

  test('extracts workflow template references through the shared reference parser', () => {
    const expressions = extractWorkflowTemplateExpressions({
      output: '{{ nodes.prepare.outputs.stdout }}',
      nested: ['{{ parameters.structure_path }}', '{{ workflow.artifactRoot }}'],
    })

    expect(expressions.map(item => item.expression)).toEqual([
      'nodes.prepare.outputs.stdout',
      'parameters.structure_path',
      'workflow.artifactRoot',
    ])
    expect(parseWorkflowReferenceExpression(expressions[0]!.expression)).toEqual({
      kind: 'nodeOutput',
      nodeId: 'prepare',
      outputPath: 'stdout',
      expression: 'nodes.prepare.outputs.stdout',
    })
  })

  test('validates node field template references before execution', () => {
    const invalid = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'invalid-node-field-references',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'first',
          type: 'exec',
          dependsOn: [],
          command: 'printf "{{ nodes.second.outputs.stdout }}"',
        },
        {
          id: 'second',
          type: 'exec',
          dependsOn: ['first'],
          command: 'printf "{{ parameters.missing }}"',
        },
      ],
    })

    expect(invalid.ok).toBe(false)
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_reference',
          nodeId: 'first',
          path: 'nodes.first.command',
        }),
        expect.objectContaining({
          code: 'invalid_reference',
          nodeId: 'second',
          path: 'nodes.second.command',
        }),
      ]),
    )

    const loopCurrent = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'loop-current-reference',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'relax',
          type: 'loop',
          dependsOn: [],
          workflow: 'workflow:child',
          maxIterations: 2,
          until: '{{ nodes.current.outputs.done }} == true',
        },
      ],
    })
    expect(loopCurrent.ok).toBe(true)

    const loopState = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'loop-state-reference',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'relax',
          type: 'loop',
          dependsOn: [],
          workflow: 'workflow:child',
          maxIterations: 2,
          initialState: { energy: 0 },
          nextParameters: {
            energy: '{{ nodes.current.outputs.energy }}',
          },
          nextState: {
            previousEnergy: '{{ loop.state.energy }}',
            energy: '{{ nodes.current.outputs.energy }}',
          },
          until: '{{ loop.state.energy }} < 0.01',
        },
      ],
    })
    expect(loopState.ok).toBe(true)
  })

  test('validates extended node field template references before execution', () => {
    const invalid = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'extended-node-field-references',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'prepare',
          type: 'exec',
          dependsOn: [],
          command: 'printf ok',
          args: ['{{ parameters.missing_arg }}'],
          cwd: '{{ parameters.missing_cwd }}',
          env: { CASE_ID: '{{ parameters.missing_env }}' },
        },
        {
          id: 'review',
          type: 'human',
          dependsOn: ['prepare'],
          prompt: 'Review.',
          responseSchema: {
            type: 'object',
            properties: {
              value: { const: '{{ parameters.missing_schema_value }}' },
            },
          },
        },
      ],
    })

    expect(invalid.ok).toBe(false)
    expect(invalid.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_reference',
          nodeId: 'prepare',
          path: 'nodes.prepare.args[0]',
        }),
        expect.objectContaining({
          code: 'invalid_reference',
          nodeId: 'prepare',
          path: 'nodes.prepare.cwd',
        }),
        expect.objectContaining({
          code: 'invalid_reference',
          nodeId: 'prepare',
          path: 'nodes.prepare.env.CASE_ID',
        }),
        expect.objectContaining({
          code: 'invalid_reference',
          nodeId: 'review',
          path: 'nodes.review.responseSchema.properties.value.const',
        }),
      ]),
    )
  })

  test('rejects incomplete node-specific payloads before execution', () => {
    const validation = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'bad-node-payloads',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'agent_without_prompt',
          type: 'agent',
          dependsOn: [],
          role: 'role:compute',
        },
        {
          id: 'bad_guard',
          type: 'guard',
          dependsOn: [],
          checks: [
            { type: 'grep', path: 'output.txt' },
            { type: 'numeric_range', value: 1, min: 5, max: 2 },
          ],
        },
        {
          id: 'bad_human',
          type: 'human',
          dependsOn: [],
          prompt: 'Respond.',
          responseSchema: { type: 42 },
        },
        {
          id: 'bad_map',
          type: 'map',
          dependsOn: [],
          workflow: 'workflow:child',
          items: 'not-an-array',
        },
      ],
    })

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_field',
          nodeId: 'agent_without_prompt',
          path: 'nodes.agent_without_prompt.prompt',
        }),
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'bad_guard',
          path: 'nodes.bad_guard.checks[0].pattern',
        }),
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'bad_guard',
          path: 'nodes.bad_guard.checks[1].max',
        }),
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'bad_human',
          path: 'nodes.bad_human.responseSchema',
        }),
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'bad_map',
          path: 'nodes.bad_map.items',
        }),
      ]),
    )
  })

  test('validates static workflow role and tool references when an asset resolver is supplied', () => {
    const missing = validateWorkflowDefinition(
      {
        schemaVersion: 1,
        name: 'asset-aware-preflight',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'plan',
            type: 'agent',
            dependsOn: [],
            role: 'role:missing',
            prompt: 'Plan.',
          },
          {
            id: 'run',
            type: 'backend',
            dependsOn: [],
            backend: 'unknown-backend',
            tool: 'tool:missing',
            input: {},
          },
          {
            id: 'child',
            type: 'subworkflow',
            dependsOn: [],
            workflow: 'workflow:missing',
          },
        ],
      },
      {
        assetResolver: () => undefined,
      },
    )

    expect(missing.ok).toBe(false)
    expect(missing.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'plan',
          path: 'nodes.plan.role',
        }),
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'run',
          path: 'nodes.run.tool',
        }),
        expect.objectContaining({
          code: 'invalid_node_config',
          nodeId: 'child',
          path: 'nodes.child.workflow',
        }),
      ]),
    )

    const ok = validateWorkflowDefinition(
      {
        schemaVersion: 1,
        name: 'asset-aware-ok',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'plan',
            type: 'agent',
            dependsOn: [],
            role: 'role:compute',
            prompt: 'Plan.',
          },
          {
            id: 'run',
            type: 'backend',
            dependsOn: ['plan'],
            backend: 'local',
            tool: 'tool:conda-environment-catalog',
            operation: 'profile',
            input: {},
          },
          {
            id: 'child',
            type: 'subworkflow',
            dependsOn: ['run'],
            workflow: 'workflow:child',
          },
        ],
      },
      {
        assetResolver: reference => {
          if (reference.startsWith('role:')) return { type: 'role' }
          if (reference.startsWith('tool:')) return { type: 'tool' }
          if (reference.startsWith('workflow:')) return { type: 'workflow' }
          return undefined
        },
      },
    )

    expect(ok.ok).toBe(true)
  })

  test('validates exact cross-node input references against declared contracts', () => {
    const mismatch = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'typed-reference-mismatch',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'produce',
          type: 'exec',
          dependsOn: [],
          command: 'printf 1',
          outputContract: {
            value: { type: 'number' },
          },
        },
        {
          id: 'consume',
          type: 'exec',
          dependsOn: ['produce'],
          command: 'printf consume',
          inputContract: {
            value: { type: 'string' },
          },
          input: {
            value: '{{ nodes.produce.outputs.value }}',
          },
        },
      ],
    })

    expect(mismatch.ok).toBe(false)
    expect(mismatch.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'contract_type_mismatch',
          nodeId: 'consume',
          path: 'nodes.consume.input.value',
        }),
      ]),
    )

    const interpolated = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'typed-reference-interpolated',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'produce',
          type: 'exec',
          dependsOn: [],
          command: 'printf 1',
          outputContract: {
            value: { type: 'number' },
          },
        },
        {
          id: 'consume',
          type: 'exec',
          dependsOn: ['produce'],
          command: 'printf consume',
          inputContract: {
            value: { type: 'string' },
          },
          input: {
            value: 'value={{ nodes.produce.outputs.value }}',
          },
        },
      ],
    })

    expect(interpolated.ok).toBe(true)
  })

  test('compiles workflow snapshots with normalized generic node contracts', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'compiled-contracts',
        nodes: {
          prepare: {
            type: 'exec',
            command: 'printf ok',
            outputContract: {
              outputs: {
                reportPath: { type: 'string', required: true },
              },
            },
          },
          plan: {
            type: 'agent',
            dependsOn: ['prepare'],
            role: 'role:workflow-builder',
            prompt: 'Return JSON',
            outputSchema: {
              type: 'object',
              required: ['next'],
              properties: { next: { type: 'string' } },
            },
          },
        },
        outputs: {
          stdout: { value: '{{ nodes.prepare.outputs.stdout }}' },
          reportPath: { value: '{{ nodes.prepare.outputs.reportPath }}' },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const compiled = compileMatOSWorkflowDefinition(definition, {
      workflowRef: 'workflow:compiled-contracts@0.1.0',
      compiledAt: '2026-06-05T00:00:00.000Z',
    })

    expect(compiled.ok).toBe(true)
    expect(compiled.metadata).toEqual(
      expect.objectContaining({
        compilerVersion: 'matos-workflow-compile-v1',
        workflowRef: 'workflow:compiled-contracts@0.1.0',
        nodeCount: 2,
        contractNodeCount: 2,
      }),
    )
    expect(compiled.contracts.nodes.prepare?.outputs).toEqual(
      expect.objectContaining({
        stdout: expect.objectContaining({ type: 'string' }),
        reportPath: expect.objectContaining({ type: 'string', required: true }),
      }),
    )
    expect(compiled.contracts.nodes.plan?.outputs?.structured).toEqual(
      expect.objectContaining({
        type: 'object',
        required: true,
        schema: expect.objectContaining({ type: 'object' }),
      }),
    )
    expect(compiled.definition.compiled?.contracts).toEqual(compiled.contracts)
  })

  test('validates dynamic nodes as bounded graph patch proposal nodes', () => {
    const missingCandidate = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'dynamic-missing-candidate',
        nodes: {
          expand_graph: { type: 'dynamic' },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const missingValidation = validateWorkflowDefinition(missingCandidate)

    expect(missingValidation.ok).toBe(false)
    expect(missingValidation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_field',
          nodeId: 'expand_graph',
          path: 'nodes.expand_graph.candidate',
        }),
      ]),
    )

    const validDynamic = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'dynamic-valid',
        nodes: {
          expand_graph: {
            type: 'dynamic',
            candidate: {
              schemaVersion: 1,
              sourceNodeId: 'expand_graph',
              reason: 'add bounded node',
              operations: [],
              budgetImpact: { addedNodes: 0, estimatedAgentCalls: 0 },
              risk: 'low',
            },
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    expect(validateWorkflowDefinition(validDynamic).ok).toBe(true)

    const validDynamicPlanner = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'dynamic-planner-valid',
        nodes: {
          expand_graph: {
            type: 'dynamic',
            role: 'role:planner',
            prompt: 'Propose the next bounded workflow graph patch.',
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    expect(validateWorkflowDefinition(validDynamicPlanner).ok).toBe(true)
  })

  test('rejects domain-specific node types from the generic workflow core', () => {
    const validation = validateWorkflowDefinition({
      schemaVersion: 1,
      name: 'domain-node-types',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'research_search',
          type: 'research_search' as never,
          dependsOn: [],
        },
        {
          id: 'source_fetch',
          type: 'source_fetch' as never,
          dependsOn: [],
        },
      ],
    })

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_node_type',
          nodeId: 'research_search',
          path: 'nodes.research_search.type',
        }),
        expect.objectContaining({
          code: 'invalid_node_type',
          nodeId: 'source_fetch',
          path: 'nodes.source_fetch.type',
        }),
      ]),
    )
  })

  test('all bundled workflow assets pass asset-aware validation', async () => {
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(process.cwd()), {
      includeDisabled: true,
    })
    const workflows = registry.assets
      .filter(asset => asset.type === 'workflow' && asset.entryAbsolutePath)
      .sort((left, right) => left.canonicalKey.localeCompare(right.canonicalKey))

    expect(workflows.length).toBeGreaterThan(0)

    const failures: Array<{ ref: string; errors: string[] }> = []
    for (const workflow of workflows) {
      const loaded = await loadWorkflowAsset(registry, workflow.canonicalKey)
      const validation = validateWorkflowDefinition(loaded.definition, {
        assetResolver: reference => registry.resolve(reference),
      })
      if (!validation.ok) {
        failures.push({
          ref: workflow.canonicalKey,
          errors: validation.errors.map(
            error => `${error.path ?? error.nodeId ?? 'workflow'}: ${error.message}`,
          ),
        })
      }
    }

    expect(failures).toEqual([])
  }, 30000)

  test('rejects invalid retry policy fields', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'bad retry',
        nodes: {
          flaky: {
            type: 'exec',
            command: 'exit 7',
            policy: {
              retry: {
                maxAttempts: 0,
                backoffMs: -1,
                retryableExitCodes: ['7'],
                retryableErrorPatterns: [7],
              },
            },
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_policy',
          path: 'nodes.flaky.policy.retry.maxAttempts',
        }),
        expect.objectContaining({
          code: 'invalid_policy',
          path: 'nodes.flaky.policy.retry.backoffMs',
        }),
        expect.objectContaining({
          code: 'invalid_policy',
          path: 'nodes.flaky.policy.retry.retryableExitCodes',
        }),
        expect.objectContaining({
          code: 'invalid_policy',
          path: 'nodes.flaky.policy.retry.retryableErrorPatterns',
        }),
      ]),
    )
  })

  test('validates bounded iteration node payloads', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'bad iteration',
        nodes: {
          scan: {
            type: 'map',
            workflow: 'workflow:child',
            maxParallel: 0,
          },
          relax: {
            type: 'loop',
            workflow: 'workflow:child',
            maxIterations: 0,
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    const validation = validateWorkflowDefinition(definition)

    expect(validation.ok).toBe(false)
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'missing_field',
          path: 'nodes.scan.items',
        }),
        expect.objectContaining({
          code: 'invalid_policy',
          path: 'nodes.scan.maxParallel',
        }),
        expect.objectContaining({
          code: 'missing_field',
          path: 'nodes.relax.maxIterations',
        }),
      ]),
    )
  })


  test('round-trips Coze builder canvas positions through parse without loss', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'canvas-round-trip',
        version: '0.1.0',
        nodes: {
          a: { type: 'exec', command: 'printf a' },
          b: { type: 'exec', dependsOn: ['a'], command: 'printf b' },
        },
        canvas: {
          nodes: {
            a: { x: 120, y: 80 },
            b: { x: 480, y: 240 },
            // Non-numeric coordinates are UI noise, not real layout; drop them
            // instead of poisoning the native definition.
            ghost: { x: 'not-a-number', y: 10 },
          },
        },
      }),
      { sourcePath: 'workflow.json' },
    )

    expect(definition.canvas?.nodes?.a).toEqual({ x: 120, y: 80 })
    expect(definition.canvas?.nodes?.b).toEqual({ x: 480, y: 240 })
    expect(definition.canvas?.nodes?.ghost).toBeUndefined()

    // Canvas layout is pure UI metadata; it must never affect validation.
    expect(validateWorkflowDefinition(definition).ok).toBe(true)

    // Serializing and re-parsing (the save/reload path) keeps the layout.
    const reparsed = parseWorkflowDefinition(JSON.stringify(definition), {
      sourcePath: 'workflow.json',
    })
    expect(reparsed.canvas?.nodes?.a).toEqual({ x: 120, y: 80 })
    expect(reparsed.canvas?.nodes?.b).toEqual({ x: 480, y: 240 })
  })

  test('omits canvas metadata when no node positions are declared', () => {
    const definition = parseWorkflowDefinition(
      JSON.stringify({
        schemaVersion: 1,
        name: 'no-canvas',
        nodes: { a: { type: 'exec', command: 'true' } },
      }),
      { sourcePath: 'workflow.json' },
    )
    expect(definition.canvas).toBeUndefined()
  })

})
