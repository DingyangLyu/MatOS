import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import {
  inspectWorkflowRun,
  respondToWorkflowNode,
  startWorkflowRun,
} from './workflowRuntime.js'
import { compileWorkflowDefinition } from './workflowCompiler.js'
import { readWorkflowRunEvents } from './workflowStore.js'
import type { MatOSWorkflowDefinition } from './types.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function installWriteArtifactTool(root: string): Promise<void> {
  const toolDir = join(root, '.matos', 'assets', 'tools', 'write-artifact')
  await mkdir(toolDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(toolDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'write-artifact',
    type: 'tool',
    name: 'Write Artifact',
    version: '0.1.0',
    entry: './tool.mjs',
    metadata: {
      executor: {
        runtime: process.execPath,
        entry: './tool.mjs',
        timeoutMs: 5000,
      },
    },
  })
  await writeFile(
    join(toolDir, 'tool.mjs'),
    [
      "import { readFileSync, writeFileSync } from 'node:fs'",
      "const payload = JSON.parse(readFileSync(0, 'utf8'))",
      'const input = payload.input ?? {}',
      "const path = String(input.path ?? '')",
      "const message = String(input.message ?? 'done')",
      'writeFileSync(path, message)',
      'process.stdout.write(JSON.stringify({ artifactPath: path, message }))',
    ].join('\n'),
    'utf8',
  )
}

function targetWorkflow(outputPath: string): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'target-runtime-compile',
    parameters: {
      outputPath: { type: 'string', default: outputPath },
    },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {
      artifactPath: { value: '{{ nodes.compute_relax.outputs.payload.artifactPath }}' },
      validationOk: { value: '{{ nodes.validate_result.outputs.ok }}' },
    },
    nodes: [
      {
        id: 'prepare_spec',
        type: 'exec',
        dependsOn: [],
        command: 'printf spec > spec.txt',
      },
      {
        id: 'approve_compute',
        type: 'approval_gate',
        dependsOn: ['prepare_spec'],
        prompt: 'Approve compute submission',
      },
      {
        id: 'compute_relax',
        type: 'compute',
        dependsOn: ['approve_compute'],
        runtime: {
          type: 'backend',
          backend: 'local-test',
          tool: 'tool:write-artifact',
          input: {
            path: '{{ parameters.outputPath }}',
            message: 'computed-ok',
          },
        },
      },
      {
        id: 'validate_result',
        type: 'validate',
        dependsOn: ['compute_relax'],
        runtime: {
          type: 'guard',
          checks: [{ type: 'file_exists', path: '{{ parameters.outputPath }}' }],
        },
      },
      {
        id: 'delegate_child',
        type: 'supernode',
        dependsOn: ['validate_result'],
        workflow: 'workflow:child',
      },
    ],
  }
}

describe('MatOS workflow compiler', () => {
  test('compiles target semantic nodes into existing runtime node types', () => {
    const compiled = compileWorkflowDefinition(targetWorkflow('/tmp/out.txt'))

    expect(
      compiled.nodes.map(node => ({
        id: node.id,
        type: node.type,
        targetType: node.targetType,
        runtimeType: node.runtimeType,
      })),
    ).toEqual([
      { id: 'prepare_spec', type: 'exec', targetType: undefined, runtimeType: undefined },
      {
        id: 'approve_compute',
        type: 'human',
        targetType: 'approval_gate',
        runtimeType: 'human',
      },
      {
        id: 'compute_relax',
        type: 'backend',
        targetType: 'compute',
        runtimeType: 'backend',
      },
      {
        id: 'validate_result',
        type: 'guard',
        targetType: 'validate',
        runtimeType: 'guard',
      },
      {
        id: 'delegate_child',
        type: 'subworkflow',
        targetType: 'supernode',
        runtimeType: 'subworkflow',
      },
    ])
    expect(compiled.nodes.find(node => node.id === 'compute_relax')).toMatchObject({
      backend: 'local-test',
      tool: 'tool:write-artifact',
    })
    expect(compiled.nodes.find(node => node.id === 'validate_result')).toMatchObject({
      checks: [{ type: 'file_exists', path: '{{ parameters.outputPath }}' }],
    })
  })

  test('compiles conditional edges into explicit runtime dependencies', () => {
    const compiled = compileWorkflowDefinition({
      schemaVersion: 1,
      name: 'conditional-edges',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'decide',
          type: 'exec',
          dependsOn: [],
          command: 'printf pass',
        },
        {
          id: 'pass_branch',
          type: 'exec',
          dependsOn: [],
          command: 'printf pass > pass.txt',
        },
      ],
      edges: [
        {
          from: 'decide',
          to: 'pass_branch',
          condition: '{{ nodes.decide.outputs.stdout }} == pass',
        },
      ],
      outputs: {},
    })

    expect(compiled.edges).toEqual([
      {
        from: 'decide',
        to: 'pass_branch',
        condition: '{{ nodes.decide.outputs.stdout }} == pass',
      },
    ])
    expect(compiled.nodes.find(node => node.id === 'pass_branch')).toMatchObject({
      dependsOn: ['decide'],
      incomingEdges: [
        {
          from: 'decide',
          to: 'pass_branch',
          condition: '{{ nodes.decide.outputs.stdout }} == pass',
        },
      ],
    })
  })

  test('materializes dependsOn-only dependencies into compiled graph edges', () => {
    const compiled = compileWorkflowDefinition({
      schemaVersion: 1,
      name: 'depends-on-only',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'prepare',
          type: 'exec',
          dependsOn: [],
          command: 'printf prepare',
        },
        {
          id: 'run',
          type: 'exec',
          dependsOn: ['prepare'],
          command: 'printf run',
        },
      ],
      outputs: {},
    })

    expect(compiled.edges).toEqual([{ from: 'prepare', to: 'run' }])
    expect(compiled.nodes.find(node => node.id === 'run')).toMatchObject({
      dependsOn: ['prepare'],
      incomingEdges: [{ from: 'prepare', to: 'run' }],
    })
  })

  test('runs target approval, compute, and validate nodes through existing adapters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-compiler-run-'))
    const outputPath = join(root, 'computed.txt')
    await installWriteArtifactTool(root)

    const started = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:target-runtime-compile@0.1.0',
      parameters: {},
      definition: {
        ...targetWorkflow(outputPath),
        nodes: targetWorkflow(outputPath).nodes.filter(
          node => node.id !== 'delegate_child',
        ),
      },
      workspaceDir: root,
    })

    expect(started.status).toBe('waiting_input')
    expect(started.waitingNodeId).toBe('approve_compute')

    const completed = await respondToWorkflowNode({
      runDir: started.runDir,
      nodeId: 'approve_compute',
      response: { approved: true },
    })

    expect(completed.status).toBe('completed')
    expect(completed.outputs.artifactPath).toBe(outputPath)
    expect(completed.outputs.validationOk).toBe(true)
    expect(await readFile(outputPath, 'utf8')).toBe('computed-ok')
    const inspected = await inspectWorkflowRun(started.runDir)
    expect(inspected.nodes?.find(node => node.nodeId === 'compute_relax')).toMatchObject({
      status: 'completed',
      output: expect.objectContaining({
        backend: 'local-test',
        toolRef: 'tool:write-artifact',
      }),
    })
  })

  test('runs direct compute nodes as receipt-shaped outputs through existing tool assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-direct-compute-'))
    const outputPath = join(root, 'direct-compute.txt')
    await installWriteArtifactTool(root)

    const compiled = compileWorkflowDefinition({
      schemaVersion: 1,
      name: 'direct-compute',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        artifactPath: {
          value: '{{ nodes.write_result.outputs.payload.artifactPath }}',
        },
        operation: { value: '{{ nodes.write_result.outputs.operation }}' },
      },
      nodes: [
        {
          id: 'write_result',
          type: 'compute',
          dependsOn: [],
          backend: 'local-test',
          operation: 'write_artifact',
          tool: 'tool:write-artifact',
          input: {
            path: outputPath,
            message: 'direct-compute-ok',
          },
        },
      ],
    })

    expect(compiled.nodes[0]).toMatchObject({
      id: 'write_result',
      type: 'backend',
      targetType: 'compute',
      runtimeType: 'backend',
      backend: 'local-test',
      operation: 'write_artifact',
      tool: 'tool:write-artifact',
    })

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:direct-compute@0.1.0',
      parameters: {},
      definition: compiled,
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.artifactPath).toBe(outputPath)
    expect(run.outputs.operation).toBe('write-artifact')
    expect(await readFile(outputPath, 'utf8')).toBe('direct-compute-ok')

    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.find(node => node.nodeId === 'write_result')).toMatchObject({
      status: 'completed',
      output: {
        ok: true,
        backend: 'local-test',
        operation: 'write-artifact',
        toolRef: 'tool:write-artifact',
        toolId: 'write-artifact',
        exitCode: 0,
        artifacts: [],
        diagnostics: {},
        payload: {
          artifactPath: outputPath,
          message: 'direct-compute-ok',
        },
      },
    })
    expect(inspected.artifacts).toEqual([
      expect.objectContaining({
        id: 'write_result:payload.artifactPath',
        nodeId: 'write_result',
        path: outputPath,
        kind: 'artifactPath',
      }),
    ])
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.artifact.created',
    )
    expect((await readWorkflowRunEvents(run.runDir)).map(event => event.type)).toContain(
      'workflow.compute.completed',
    )
  })

  test('runs validate nodes as structured results that can route recovery branches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-validate-routing-'))
    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:validate-routing@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'validate-routing',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [
          {
            id: 'validate_missing_file',
            type: 'validate',
            dependsOn: [],
            checks: [{ type: 'file_exists', path: 'missing.txt' }],
          },
          {
            id: 'success_branch',
            type: 'exec',
            dependsOn: [],
            command: 'printf success > success.txt',
          },
          {
            id: 'recovery_branch',
            type: 'exec',
            dependsOn: [],
            command: 'printf recovery > recovery.txt',
          },
        ],
        edges: [
          {
            from: 'validate_missing_file',
            to: 'success_branch',
            condition: '{{ nodes.validate_missing_file.outputs.ok }} == true',
          },
          {
            from: 'validate_missing_file',
            to: 'recovery_branch',
            condition: '{{ nodes.validate_missing_file.outputs.ok }} == false',
          },
        ],
        outputs: {
          validationOk: {
            value: '{{ nodes.validate_missing_file.outputs.ok }}',
          },
          recommendation: {
            value: '{{ nodes.validate_missing_file.outputs.recommendation }}',
          },
        },
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.validationOk).toBe(false)
    expect(run.outputs.recommendation).toBe('fail')
    expect(await readFile(join(root, 'recovery.txt'), 'utf8')).toBe('recovery')

    const inspected = await inspectWorkflowRun(run.runDir)
    expect(
      inspected.nodes?.find(node => node.nodeId === 'validate_missing_file'),
    ).toMatchObject({
      status: 'completed',
      output: {
        ok: false,
        severity: 'error',
        recommendation: 'fail',
        checks: [{ id: 'file_exists_1', type: 'file_exists', ok: false }],
      },
    })
    expect(inspected.nodes?.find(node => node.nodeId === 'success_branch')).toMatchObject({
      status: 'skipped',
    })
    expect(inspected.nodes?.find(node => node.nodeId === 'recovery_branch')).toMatchObject({
      status: 'completed',
    })
  })

  test('runs only the branch whose edge condition matches and skips the other branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-branches-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:branches@0.1.0',
      parameters: {},
      definition: {
        schemaVersion: 1,
        name: 'branches',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [
          {
            id: 'decide',
            type: 'exec',
            dependsOn: [],
            command: 'printf pass',
          },
          {
            id: 'pass_branch',
            type: 'exec',
            dependsOn: [],
            command: 'printf pass > pass.txt',
          },
          {
            id: 'fail_branch',
            type: 'exec',
            dependsOn: [],
            command: 'printf fail > fail.txt',
          },
        ],
        edges: [
          {
            from: 'decide',
            to: 'pass_branch',
            condition: '{{ nodes.decide.outputs.stdout }} == pass',
          },
          {
            from: 'decide',
            to: 'fail_branch',
            condition: '{{ nodes.decide.outputs.stdout }} == fail',
          },
        ],
        outputs: {
          selected: { value: '{{ nodes.pass_branch.outputs.stdout }}' },
        },
      },
      workspaceDir: root,
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.selected).toBe('')
    expect(await readFile(join(root, 'pass.txt'), 'utf8')).toBe('pass')
    await expect(readFile(join(root, 'fail.txt'), 'utf8')).rejects.toThrow()

    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.map(node => [node.nodeId, node.status])).toEqual([
      ['decide', 'completed'],
      ['pass_branch', 'completed'],
      ['fail_branch', 'skipped'],
    ])
  })
})
