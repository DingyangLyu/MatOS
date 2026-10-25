import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { compileWorkflowDefinition } from './workflowCompiler.js'
import { nodeApprovalRequired } from './nodeLifecycle.js'
import {
  approveWorkflowNode,
  inspectWorkflowRun,
  startWorkflowRun,
} from './workflowRuntime.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from './types.js'

/**
 * Physical-world interface: instrument semantic nodes.
 *
 * These tests exercise the generic kernel path (instrument -> backend), the
 * explicit adapter-tool validation contract, the non-bypassable physical
 * approval gate, and a real end-to-end run against the bundled simulated
 * XRD driver (`matos-assets/.../tools/instrument-xrd-simulator/tool.py`).
 */

const SIMULATOR_TOOL_SOURCE = join(
  import.meta.dir,
  '../../../matos-assets/packs/matos-core/tools/instrument-xrd-simulator/tool.py',
)

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** Installs the real simulator driver as a project-local tool asset. */
async function installSimulatorTool(root: string): Promise<void> {
  const toolDir = join(root, '.matos', 'assets', 'tools', 'instrument-xrd-simulator')
  await mkdir(toolDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(toolDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'instrument-xrd-simulator',
    type: 'tool',
    name: 'XRD Instrument Simulator',
    version: '0.1.0',
    entry: './tool.py',
    metadata: {
      executor: { runtime: 'python3', entry: './tool.py', timeoutMs: 30000 },
      instrument: {
        instrumentId: 'xrd-simulator-001',
        physical: false,
        adapterContract: 'matos-instrument-v1',
      },
    },
  })
  await copyFile(SIMULATOR_TOOL_SOURCE, join(toolDir, 'tool.py'))
}

function instrumentNode(overrides: Partial<MatOSWorkflowNode>): MatOSWorkflowNode {
  return {
    id: 'submit_scan',
    type: 'instrument',
    dependsOn: [],
    instrument: 'xrd-simulator-001',
    operation: 'submit',
    tool: 'tool:instrument-xrd-simulator',
    input: {
      action: 'submit',
      simulation: true,
      sample: { formula: 'Si' },
    },
    ...overrides,
  }
}

function sopDefinition(simulation: boolean | string): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'instrument-sop-test',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
    outputs: {
      instrumentId: {
        value: '{{ nodes.check_instrument.outputs.payload.instrumentId }}',
      },
      taskId: { value: '{{ nodes.submit_scan.outputs.payload.taskId }}' },
      status: { value: '{{ nodes.poll_status.outputs.payload.status }}' },
      measurementPath: {
        value: '{{ nodes.fetch_result.outputs.payload.measurementPath }}',
      },
      peakCount: { value: '{{ nodes.fetch_result.outputs.payload.peakCount }}' },
    },
    nodes: [
      {
        id: 'check_instrument',
        type: 'instrument',
        dependsOn: [],
        instrument: 'xrd-simulator-001',
        operation: 'describe',
        tool: 'tool:instrument-xrd-simulator',
        input: { action: 'describe', simulation },
      },
      {
        id: 'submit_scan',
        type: 'instrument',
        dependsOn: ['check_instrument'],
        instrument: 'xrd-simulator-001',
        operation: 'submit',
        tool: 'tool:instrument-xrd-simulator',
        input: {
          action: 'submit',
          simulation,
          sample: { formula: 'LiFePO4', label: 'e2e-test' },
          scan: { twoThetaStart: 15, twoThetaEnd: 60, stepDegrees: 0.2 },
        },
      },
      {
        id: 'wait_for_completion',
        type: 'exec',
        dependsOn: ['submit_scan'],
        command: 'sleep 2 && printf INSTRUMENT_WAIT_DONE',
      },
      {
        id: 'poll_status',
        type: 'instrument',
        dependsOn: ['wait_for_completion'],
        instrument: 'xrd-simulator-001',
        operation: 'status',
        tool: 'tool:instrument-xrd-simulator',
        input: {
          action: 'status',
          simulation,
          taskId: '{{ nodes.submit_scan.outputs.payload.taskId }}',
        },
      },
      {
        id: 'fetch_result',
        type: 'instrument',
        dependsOn: ['poll_status'],
        instrument: 'xrd-simulator-001',
        operation: 'result',
        tool: 'tool:instrument-xrd-simulator',
        input: {
          action: 'result',
          simulation,
          taskId: '{{ nodes.submit_scan.outputs.payload.taskId }}',
        },
      },
      {
        id: 'validate_measurement',
        type: 'validate',
        dependsOn: ['fetch_result'],
        checks: [
          {
            id: 'scan-completed',
            type: 'expression',
            value: '"{{ nodes.poll_status.outputs.payload.status }}" == "completed"',
          },
          {
            id: 'measurement-artifact-exists',
            type: 'file_exists',
            path: '{{ nodes.fetch_result.outputs.payload.measurementPath }}',
          },
          {
            id: 'peaks-detected',
            type: 'numeric_range',
            value: '{{ nodes.fetch_result.outputs.payload.peakCount }}',
            min: 1,
          },
        ],
      },
    ],
  }
}

describe('instrument semantic nodes', () => {
  test('compile: instrument nodes become generic backend runtime nodes', () => {
    const compiled = compileWorkflowDefinition(sopDefinition(true))
    const submit = compiled.nodes.find(node => node.id === 'submit_scan')
    expect(submit).toMatchObject({
      type: 'backend',
      targetType: 'instrument',
      runtimeType: 'backend',
      backend: 'instrument:xrd-simulator-001',
      tool: 'tool:instrument-xrd-simulator',
    })
    // No new runtime node type: every compiled node is a generic kernel type.
    const runtimeTypes = new Set(compiled.nodes.map(node => node.type))
    expect([...runtimeTypes].sort()).toEqual(['backend', 'exec', 'guard'])
  })

  test('validate: instrument nodes require instrument id and explicit adapter tool', () => {
    const missingInstrument = validateWorkflowDefinition(
      compileWorkflowDefinition({
        schemaVersion: 1,
        name: 'missing-instrument-id',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [instrumentNode({ instrument: undefined })],
      }),
    )
    expect(
      missingInstrument.errors.some(error =>
        error.message.includes('requires instrument id'),
      ),
    ).toBe(true)

    const missingTool = validateWorkflowDefinition(
      compileWorkflowDefinition({
        schemaVersion: 1,
        name: 'missing-adapter-tool',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [instrumentNode({ tool: undefined })],
      }),
    )
    expect(
      missingTool.errors.some(error =>
        error.message.includes('explicit adapter tool asset ref'),
      ),
    ).toBe(true)

    const valid = validateWorkflowDefinition(
      compileWorkflowDefinition(sopDefinition(true)),
    )
    expect(valid.errors).toEqual([])
  })

  test('approval matrix: physical operations cannot bypass approval, simulated ones can', () => {
    const bypassEverything = {
      schemaVersion: 1 as const,
      name: 'approval-matrix',
      parameters: {},
      policy: { approvalMode: 'bypass' as const, defaultRisk: 'low' as const },
      outputs: {},
      compiled: { reviewedHighRiskBypassTrusted: true },
    }
    const compiledWith = (input: Record<string, unknown>): MatOSWorkflowNode => {
      const definition = compileWorkflowDefinition({
        ...bypassEverything,
        nodes: [
          instrumentNode({
            input,
            policy: { approval: 'bypass', reviewedHighRiskBypass: true },
          }),
        ],
      })
      return definition.nodes[0]
    }
    const definitionFor = (node: MatOSWorkflowNode): MatOSWorkflowDefinition => ({
      ...bypassEverything,
      nodes: [node],
    })

    // Physical actuation (no simulation flag): approval required even with
    // node bypass policy, workflow bypass mode, and reviewed-high-risk trust.
    const physical = compiledWith({ action: 'submit', sample: { formula: 'Si' } })
    expect(nodeApprovalRequired(definitionFor(physical), physical)).toBe(true)

    // Simulated / dry-run tasks skip the physical gate (boolean or rendered
    // template string form).
    for (const input of [
      { action: 'submit', simulation: true },
      { action: 'submit', simulation: 'true' },
      { action: 'submit', dryRun: true },
    ]) {
      const node = compiledWith(input)
      expect(nodeApprovalRequired(definitionFor(node), node)).toBe(false)
    }

    // Simulated instrument submits must not fall into the generic HPC
    // submit/cancel protection either: without any node policy, workflow
    // bypass mode is enough for a simulated task (this is the SOP-run path).
    const plainSimulated = compileWorkflowDefinition({
      ...bypassEverything,
      compiled: {},
      nodes: [instrumentNode({ input: { action: 'submit', simulation: true } })],
    })
    expect(
      nodeApprovalRequired(plainSimulated, plainSimulated.nodes[0]),
    ).toBe(false)

    // Simulated instrument nodes still respect explicit ask policies: the
    // physical gate is an extra floor, not a replacement approval policy.
    const askDefinition = compileWorkflowDefinition({
      ...bypassEverything,
      nodes: [
        instrumentNode({
          input: { action: 'submit', simulation: true },
          policy: { approval: 'ask' },
        }),
      ],
    })
    expect(
      nodeApprovalRequired(askDefinition, askDefinition.nodes[0]),
    ).toBe(true)
  })
})
