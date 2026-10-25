import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import {
  createWorkflowRun,
  readWorkflowRun,
  writeWorkflowRun,
} from '../workflows/workflowStore.js'
import { runMatOSWorkflowCommand } from './workflow.js'
import { parseArgs as parseWorkflowArgs } from './workflowCliShared.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

// Bun applies explicit per-test timeouts over the CLI --timeout default, so
// honor a raised MATOS_TEST_TIMEOUT_MS (the matos-test.sh retry knob) for the
// approval-gate flow instead of silently pinning it to 15s.
function approvalGateTestTimeoutMs(): number {
  const runnerTimeout = Number.parseInt(process.env.MATOS_TEST_TIMEOUT_MS ?? '', 10)
  if (Number.isFinite(runnerTimeout) && runnerTimeout > 15_000) {
    return runnerTimeout
  }
  return 15_000
}

async function fixture(): Promise<string> {
  delete process.env.MATOS_WORKFLOW_RUNS_DIR
  const root = await mkdtemp(join(tmpdir(), 'matos-workflow-cli-'))
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'relax')
  const componentWorkflowDir = join(
    root,
    '.matos',
    'assets',
    'workflows',
    'relax-component',
  )
  const interactiveWorkflowDir = join(
    root,
    '.matos',
    'assets',
    'workflows',
    'interactive',
  )
  const stateMachineWorkflowDir = join(
    root,
    '.matos',
    'assets',
    'workflows',
    'state-machine',
  )
  await mkdir(workflowDir, { recursive: true })
  await mkdir(componentWorkflowDir, { recursive: true })
  await mkdir(interactiveWorkflowDir, { recursive: true })
  await mkdir(stateMachineWorkflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
    execution: {
      runtimeDataDir: join(root, 'runtime-state'),
    },
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'relax',
    type: 'workflow',
    name: 'Relax',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeFile(
    join(workflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: relax',
      'parameters:',
      '  steps:',
      '    type: number',
      '    default: 1',
      'nodes:',
      '  prepare:',
      '    type: exec',
      '    command: "printf ready"',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(componentWorkflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'relax-component',
    type: 'workflow',
    name: 'Relax Component',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'component' } },
  })
  await writeFile(
    join(componentWorkflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: relax component',
      'nodes:',
      '  prepare:',
      '    type: exec',
      '    command: "printf ready"',
      '  review:',
      '    type: human',
      '    dependsOn: [prepare]',
      '    prompt: Review generated plan',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(interactiveWorkflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'interactive',
    type: 'workflow',
    name: 'Interactive',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeFile(
    join(interactiveWorkflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: interactive',
      'nodes:',
      '  make_file:',
      '    type: exec',
      '    command: "printf ok > result.txt"',
      '  check_file:',
      '    type: guard',
      '    dependsOn: [make_file]',
      '    checks:',
      '      - type: file_exists',
      '        path: result.txt',
      '  review:',
      '    type: human',
      '    dependsOn: [check_file]',
      '    prompt: Review result',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(stateMachineWorkflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'state-machine',
    type: 'workflow',
    name: 'State Machine',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(stateMachineWorkflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'state-machine',
    parameters: {},
    policy: {
      approvalMode: 'bypass',
      defaultRisk: 'low',
      executionModel: 'state_machine',
      stateMachine: { initialNodeId: 'draft', maxTransitions: 2 },
    },
    outputs: { finalNodeId: { value: '{{ workflow.finalNodeId }}' } },
    nodes: [
      { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
      { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
    ],
    transitions: [
      { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
    ],
  })
  return root
}

async function backendFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-workflow-cli-backend-'))
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'backend')
  const backendWorkdir = join(root, 'workspace', 'attempt-01')
  await mkdir(workflowDir, { recursive: true })
  await mkdir(backendWorkdir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: true,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'backend',
    type: 'workflow',
    name: 'Backend',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'backend',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {},
    nodes: [
      {
        id: 'prepare_marker',
        type: 'exec',
        dependsOn: [],
        command: 'printf ready > prepared.txt && printf ready',
      },
      {
        id: 'generate_yaml',
        type: 'backend',
        dependsOn: ['prepare_marker'],
        backend: 'hpc-queue',
        tool: 'tool:hpc-generate-yaml',
        policy: { approval: 'ask' },
        input: {
          taskName: 'workflow-cli-backend',
          workdir: backendWorkdir,
          entrypoint: 'echo ok',
          benchmarkCaseId: 'case-cli',
          attemptId: 'attempt-01',
          approvalDigest: 'workflow-cli-approval',
        },
      },
    ],
  })
  return root
}

async function dynamicWorkflowFixture(
  options: { id?: string; risk?: 'low' | 'medium' | 'high' } = {},
): Promise<string> {
  const workflowId = options.id ?? 'dynamic-auto'
  const risk = options.risk ?? 'low'
  const root = await mkdtemp(join(tmpdir(), 'matos-workflow-cli-dynamic-'))
  const workflowDir = join(root, '.matos', 'assets', 'workflows', workflowId)
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
    execution: {
      runtimeDataDir: join(root, 'runtime-state'),
    },
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: workflowId,
    type: 'workflow',
    name: 'Dynamic Auto',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'dynamic auto',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: risk },
    outputs: {},
    nodes: [
      {
        id: 'plan',
        type: 'dynamic',
        dependsOn: [],
        candidate: {
          schemaVersion: 1,
          sourceNodeId: 'plan',
          reason: 'add bounded review node',
          operations: [
            {
              op: 'add_node',
              node: {
                id: 'review',
                type: 'exec',
                dependsOn: [],
                command: 'printf dynamic-review',
              },
            },
            { op: 'add_edge', from: 'plan', to: 'review' },
          ],
          budgetImpact: {
            addedNodes: 1,
            estimatedAgentCalls: 0,
            estimatedWallMinutes: 1,
          },
          risk,
        },
      },
    ],
  })
  return root
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('matos workflow CLI', () => {
  test('prints workflow help instead of treating --help as an unknown command', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-workflow-help-'))
    const stdout: string[] = []
    const stderr: string[] = []

    const code = await runMatOSWorkflowCommand(['--help'], {
      cwd,
      stdout: text => stdout.push(text),
      stderr: text => stderr.push(text),
    })

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toContain('Usage:')
    expect(stdout.join('')).toContain('matos workflow run <workflow-ref>')
  })

  test('prints nested draft help without mutating draft state', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'create', '--id', 'must-not-be-created', '--help'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toContain('matos workflow draft create')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'list', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(
      (JSON.parse(stdout.join('')) as { drafts: Array<{ draftId: string }> })
        .drafts,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: 'must-not-be-created' }),
      ]),
    )
  })

  test('documents exact replace-definition and publish draft contracts', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'replace-definition', 'builder', '--help'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toContain('--definition-json <json>')
    expect(stdout.join('')).toContain('--definition-file <path|->')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'publish', 'builder', '--help'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(stdout.join('')).toContain('--id <workflow-id>')

    stdout.length = 0
    stderr.length = 0
    let stdinReads = 0
    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'replace-definition', 'builder'],
        {
          cwd,
          stdin: async () => {
            stdinReads += 1
            return '{}'
          },
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(1)
    expect(stdinReads).toBe(0)
    expect(stderr.join('')).toContain('--definition-json <json>')
    expect(stderr.join('')).toContain('--definition-file <path|->')
  })

  test('replaces a draft definition from explicitly requested stdin', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'create', '--id', 'stdin-builder', '--json'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)

    const replacement = {
      schemaVersion: 1,
      name: 'stdin-workflow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'prepare',
          type: 'exec',
          command: 'printf stdin',
          dependsOn: [],
        },
      ],
      outputs: {},
    }
    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'replace-definition',
          'stdin-builder',
          '--definition-file',
          '-',
          '--json',
        ],
        {
          cwd,
          stdin: async () => JSON.stringify(replacement),
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(
      (JSON.parse(stdout.join('')) as { definition: { name: string } })
        .definition.name,
    ).toBe('stdin-workflow')
  })

  test('lists workflow assets as json', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    const code = await runMatOSWorkflowCommand(['list', '--json'], {
      cwd,
      stdout: text => stdout.push(text),
      stderr: text => stderr.push(text),
    })

    expect(code).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(JSON.parse(stdout.join('')).workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalKey: 'workflow:relax@0.1.0',
          kind: 'executable',
        }),
      ]),
    )
  })

  test('shows and validates a workflow', async () => {
    const cwd = await fixture()
    const stdout: string[] = []

    expect(
      await runMatOSWorkflowCommand(['show', 'workflow:relax', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: () => undefined,
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).definition.nodes[0].id).toBe('prepare')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['validate', 'workflow:relax', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: () => undefined,
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).ok).toBe(true)
  })

  test('preflights a workflow without starting a run', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['preflight', 'workflow:relax', '--param', 'steps=3', '--json'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const result = JSON.parse(stdout.join('')) as {
      runnable: boolean
      workflowRef: string
      summary: { errorCount: number }
    }
    expect(result.runnable).toBe(true)
    expect(result.workflowRef).toBe('workflow:relax@0.1.0')
    expect(result.summary.errorCount).toBe(0)
    expect(stderr.join('')).toBe('')
    expect(await exists(join(cwd, '.matos', 'workflows', 'runs'))).toBe(false)
  })

  test('preflight rejects unknown workflow parameters with the accepted contract', async () => {
    const cwd = await fixture()
    const stdout: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['preflight', 'workflow:relax', '--param', 'stepCount=3', '--json'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: () => undefined,
        },
      ),
    ).toBe(1)
    const result = JSON.parse(stdout.join('')) as {
      runnable: boolean
      issues: Array<{ code: string; message: string }>
    }
    expect(result.runnable).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unknown_workflow_parameter',
          message: expect.stringContaining('Accepted parameters: steps.'),
        }),
      ]),
    )
    expect(await exists(join(cwd, '.matos', 'workflows', 'runs'))).toBe(false)
  })

  test('parses indexed array workflow parameters used by tracked launchers', () => {
    const parsed = parseWorkflowArgs([
      '--param',
      'inputFiles[0]=artifacts/input-a.in',
      '--param',
      'inputFiles[1]=artifacts/input-b.in',
    ])

    expect(parsed.params).toEqual({
      inputFiles: ['artifacts/input-a.in', 'artifacts/input-b.in'],
    })
  })

  test('routes workflow preflight through the workspace daemon', async () => {
    const cwd = await fixture()
    let daemonInput:
      | { scopeReference?: string; argv: string[]; cwd: string }
      | undefined

    const code = await runMatOSWorkflowCommand(
      [
        'preflight',
        'workflow:relax',
        '--execution',
        'container',
        '--scope',
        'user:alice',
        '--param',
        'steps=3',
        '--json',
      ],
      {
        cwd,
        stdout: () => undefined,
        stderr: () => undefined,
        workflowContainer: {
          run: async input => {
            daemonInput = input
            return 0
          },
        },
      },
    )

    expect(code).toBe(0)
    expect(daemonInput).toMatchObject({
      scopeReference: 'user:alice',
      argv: [
        '/app/bin/matos',
        'workflow',
        'preflight',
        'workflow:relax',
        '--scope',
        'user:alice',
        '--param',
        'steps=3',
        '--json',
      ],
    })
  })

  test('inspect exposes workflow budget accounting', async () => {
    const cwd = await fixture()
    const runStdout: string[] = []
    const inspectStdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:relax', '--execution', 'local', '--json'],
        {
          cwd,
          stdout: text => runStdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    const runPayload = JSON.parse(runStdout.join('')) as {
      run: { runId: string; budget?: { totals: { nodeAttempts: number } } }
    }

    expect(
      await runMatOSWorkflowCommand(
        ['inspect', runPayload.run.runId, '--execution', 'local', '--json'],
        {
          cwd,
          stdout: text => inspectStdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    const inspected = JSON.parse(inspectStdout.join('')) as {
      run: { budget?: { totals: { nodeAttempts: number; toolCalls: number } } }
    }
    expect(inspected.run.budget?.totals.nodeAttempts).toBe(1)
    expect(inspected.run.budget?.totals.toolCalls).toBe(1)
  })

  test('inspect exposes state-machine workflow frames', async () => {
    const cwd = await fixture()
    const runStdout: string[] = []
    const inspectStdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:state-machine', '--execution', 'local', '--json'],
        {
          cwd,
          stdout: text => runStdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(stderr.join('')).toBe('')
    const runPayload = JSON.parse(runStdout.join('')) as {
      run: {
        runId: string
        stateMachine?: {
          frames: Array<{ frameId: string; index: number; activeNodeId: string; status: string }>
        }
      }
    }
    expect(runPayload.run.stateMachine?.frames).toEqual([
      expect.objectContaining({
        frameId: 'frame-000001',
        index: 1,
        activeNodeId: 'draft',
        status: 'completed',
      }),
      expect.objectContaining({
        frameId: 'frame-000002',
        index: 2,
        activeNodeId: 'review',
        status: 'completed',
      }),
    ])

    expect(
      await runMatOSWorkflowCommand(
        ['inspect', runPayload.run.runId, '--execution', 'local', '--json'],
        {
          cwd,
          stdout: text => inspectStdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(inspectStdout.join('')).run.stateMachine.frames).toEqual([
      expect.objectContaining({ activeNodeId: 'draft' }),
      expect.objectContaining({ activeNodeId: 'review' }),
    ])
  })

  test('runs, inspects, responds to, and cancels workflow runs', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:interactive', '--json'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; runDir: string; status: string; waitingNodeId: string }
    }
    expect(started.run.status).toBe('waiting_input')
    expect(started.run.waitingNodeId).toBe('review')
    expect(await exists(started.run.runDir)).toBe(true)

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['status', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('waiting_input')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['inspect', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.waitingNodeId).toBe('review')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['events', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(
      JSON.parse(stdout.join('')).events.map((event: { type: string }) => event.type),
    ).toContain('workflow.human.prompted')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'respond',
          started.run.runId,
          '--node',
          'review',
          '--message',
          '{"approved":true}',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('completed')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:interactive', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const cancellable = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string }
    }
    expect(cancellable.run.status).toBe('waiting_input')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['cancel', cancellable.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('cancelled')
    expect(stderr.join('')).toBe('')
  })

  test('reports workflow recovery recommendations from CLI', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:interactive', '--json'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string; waitingNodeId: string }
    }
    expect(started.run.status).toBe('waiting_input')
    expect(started.run.waitingNodeId).toBe('review')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['recover', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    expect(JSON.parse(stdout.join('')).recovery).toMatchObject({
      runId: started.run.runId,
      classification: 'human_wait',
      recommendedAction: 'request_human_review',
      nodeId: 'review',
    })
    expect(stderr.join('')).toBe('')
  })

  test('applies workflow recovery recommendations from CLI', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:interactive', '--json'],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string; waitingNodeId: string }
    }
    expect(started.run.status).toBe('waiting_input')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['recover-apply', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    expect(JSON.parse(stdout.join(''))).toMatchObject({
      recovery: {
        runId: started.run.runId,
        classification: 'human_wait',
        recommendedAction: 'request_human_review',
        nodeId: 'review',
      },
      appliedAction: 'none',
      run: {
        runId: started.run.runId,
        status: 'waiting_input',
      },
    })
    expect(stderr.join('')).toBe('')
  })

  test('reconciles workflow compute jobs from CLI', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:relax', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string }
    }
    expect(started.run.status).toBe('completed')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['reconcile', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    const reconciled = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string }
      reconciled: unknown[]
    }
    expect(reconciled.run).toMatchObject({
      runId: started.run.runId,
      status: 'completed',
    })
    expect(reconciled.reconciled).toEqual([])
    expect(stderr.join('')).toBe('')
  })

  test('refreshes workflow remote recovery queue from CLI', async () => {
    const cwd = await fixture()
    const workflowsDir = join(cwd, 'workflow-state')
    const workflowRunsDir = join(workflowsDir, 'runs')
    process.env.MATOS_WORKFLOW_RUNS_DIR = workflowRunsDir
    const handle = await createWorkflowRun({
      workflowsDir,
      workflowRunsDir,
      workflowRef: 'workflow:remote-recovery-cli@0.1.0',
      parameters: {},
      workspaceDir: cwd,
      graphSnapshot: {
        schemaVersion: 1,
        name: 'remote-recovery-cli',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'medium' },
        outputs: {},
        nodes: [
          {
            id: 'submit',
            type: 'compute',
            dependsOn: [],
            backend: 'hpc-queue',
            operation: 'submit',
          },
        ],
      },
    })
    await mkdir(join(handle.dir, 'node-runs', 'submit'), { recursive: true })
    await writeJson(join(handle.dir, 'node-runs', 'submit', 'node-run.json'), {
      nodeId: 'submit',
      status: 'completed',
      attempts: 1,
      updatedAt: new Date().toISOString(),
      output: {
        ok: true,
        backend: 'hpc-queue',
        operation: 'submit',
        taskId: 't-cli-recover-queue',
        status: 'Submitted',
        artifacts: [],
        diagnostics: {
          lifecycle: {
            reconcileFailures: [
              {
                source: 'manual_reconcile',
                taskId: 't-cli-recover-queue',
                error: 'temporary status outage',
              },
            ],
          },
        },
      },
    })
    await writeWorkflowRun(handle.dir, {
      ...(await readWorkflowRun(handle.dir)),
      status: 'waiting_input',
      waitingNodeId: 'review',
    })

    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        ['recover-queue', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    const payload = JSON.parse(stdout.join('')) as {
      jobs: Array<{
        runId: string
        status: string
        recommendedAction: string
        remoteRecovery: { taskId?: string }
      }>
    }
    expect(payload.jobs).toEqual([
      expect.objectContaining({
        runId: handle.runId,
        status: 'queued',
        recommendedAction: 'reconcile_compute',
        remoteRecovery: expect.objectContaining({
          taskId: 't-cli-recover-queue',
        }),
      }),
    ])
    expect(stderr.join('')).toBe('')
  })

  test('lists and inspects dynamic workflow patch ledgers from CLI', async () => {
    const cwd = await dynamicWorkflowFixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:dynamic-auto', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string; outputs: Record<string, unknown> }
    }
    expect(started.run.status).toBe('completed')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['patches', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const listed = JSON.parse(stdout.join('')) as {
      patches: Array<{ patchId: string; decision?: { status?: string } }>
    }
    expect(listed.patches).toEqual([
      expect.objectContaining({
        patchId: 'plan-add-bounded-review-node',
        decision: expect.objectContaining({ status: 'applied' }),
      }),
    ])

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-inspect',
          started.run.runId,
          '--patch',
          'plan-add-bounded-review-node',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).patch).toMatchObject({
      patchId: 'plan-add-bounded-review-node',
      candidate: {
        schemaVersion: 1,
        operations: [{ op: 'add_node' }, { op: 'add_edge' }],
      },
      decision: { status: 'applied' },
    })

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-inspect',
          started.run.runId,
          '--patch',
          'missing-patch',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)
    expect(stderr.join('')).toContain('Workflow graph patch not found: missing-patch')
    expect(stdout.join('')).toBe('')
  })

  test('approves and applies proposed dynamic workflow patches from CLI', async () => {
    const cwd = await dynamicWorkflowFixture({
      id: 'dynamic-high-risk',
      risk: 'high',
    })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:dynamic-high-risk', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string; waitingNodeId: string }
    }
    expect(started.run.status).toBe('waiting_input')
    expect(started.run.waitingNodeId).toBe('plan')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-approve',
          started.run.runId,
          '--patch',
          'plan-add-bounded-review-node',
          '--reason',
          'manual approval for bounded test patch',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).patch).toMatchObject({
      patchId: 'plan-add-bounded-review-node',
      decision: { status: 'approved' },
    })

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-apply',
          started.run.runId,
          '--patch',
          'plan-add-bounded-review-node',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const applied = JSON.parse(stdout.join('')) as {
      run: { status: string; nodes: Array<{ nodeId: string; status: string }> }
      patch: { decision?: { status?: string; graphSnapshotPath?: string } }
    }
    expect(applied.run.status).toBe('completed')
    expect(applied.run.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'plan', status: 'completed' }),
        expect.objectContaining({ nodeId: 'review', status: 'completed' }),
      ]),
    )
    expect(applied.patch.decision).toMatchObject({
      status: 'applied',
      graphSnapshotPath: 'graph.snapshot.v2.json',
    })
    expect(stderr.join('')).toBe('')
  })

  test('does not mutate dynamic patch decisions when the run is no longer waiting', async () => {
    const cwd = await dynamicWorkflowFixture({
      id: 'dynamic-high-risk-cancel',
      risk: 'high',
    })
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:dynamic-high-risk-cancel', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; status: string; waitingNodeId: string }
    }
    expect(started.run.status).toBe('waiting_input')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['cancel', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-approve',
          started.run.runId,
          '--patch',
          'plan-add-bounded-review-node',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)
    expect(stderr.join('')).toContain(
      'Workflow run is not waiting for dynamic patch',
    )

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-inspect',
          started.run.runId,
          '--patch',
          'plan-add-bounded-review-node',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).patch.decision.status).toBe('proposed')
    expect(stderr.join('')).toBe('')
  })

  test('routes workflow runs through the workspace daemon when container execution is requested', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []
    let daemonInput:
      | {
          scopeReference?: string
          argv: string[]
          cwd: string
          env?: Record<string, string>
        }
      | undefined
    process.env.MATOS_INTERNAL_STATE_DIR = '/home/workspace/.matos/internal'
    process.env.MATOS_WORKSPACE_DIR = '/workspace/group/shared'
    process.env.MATOS_SESSION_DIR = '/workspace/sessions'
    process.env.MATOS_WORKFLOW_RUNS_DIR = '/workspace/workflows/runs'
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR =
      '/home/workspace/.cache/tmp/matos-runtime/asset-runtime'
    process.env.MATOS_ASSET_ROOTS = '/workspace/assets/project:/app/matos-assets'

    const code = await runMatOSWorkflowCommand(
      [
        'run',
        'workflow:relax',
        '--execution',
        'container',
        '--scope',
        'user:alice',
        '--param',
        'steps=3',
        '--json',
      ],
      {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        workflowContainer: {
          run: async input => {
            daemonInput = input
            return 0
          },
        },
      },
    )

    expect(code).toBe(0)
    expect(stdout.join('')).toBe('')
    expect(stderr.join('')).toBe('')
    expect(daemonInput).toMatchObject({
      scopeReference: 'user:alice',
      cwd: '/workspace/group/shared',
      argv: [
        '/app/bin/matos',
        'workflow',
        'run',
        'workflow:relax',
        '--scope',
        'user:alice',
        '--param',
        'steps=3',
        '--json',
      ],
    })
    expect(daemonInput?.env).toMatchObject({
      MATOS_INTERNAL_STATE_DIR: '/home/workspace/.matos/internal',
      MATOS_WORKSPACE_DIR: '/workspace/group/shared',
      MATOS_SESSION_DIR: '/workspace/sessions',
      MATOS_WORKFLOW_RUNS_DIR: '/workspace/workflows/runs',
      MATOS_RUNTIME_MATERIALIZATION_DIR:
        '/home/workspace/.cache/tmp/matos-runtime/asset-runtime',
      MATOS_ASSET_ROOTS: '/workspace/assets/project:/app/matos-assets',
      MATOS_EXECUTION: 'container',
    })
  })

  test('routes workflow lifecycle commands through the workspace daemon when container execution is requested', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []
    let daemonInput:
      | {
          scopeReference?: string
          argv: string[]
          cwd: string
        }
      | undefined

    const code = await runMatOSWorkflowCommand(
      [
        'respond',
        'run_container_waiting',
        '--execution',
        'container',
        '--scope',
        'user:alice',
        '--node',
        'review',
        '--message',
        '{"approved":true}',
        '--json',
      ],
      {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
        workflowContainer: {
          run: async input => {
            daemonInput = input
            input.stdout('{"run":{"runId":"run_container_waiting","status":"completed"}}\n')
            return 0
          },
        },
      },
    )

    expect(code).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('completed')
    expect(stderr.join('')).toBe('')
    expect(daemonInput).toMatchObject({
      scopeReference: 'user:alice',
      cwd: '/workspace/group/shared',
      argv: [
        '/app/bin/matos',
        'workflow',
        'respond',
        'run_container_waiting',
        '--scope',
        'user:alice',
        '--node',
        'review',
        '--message',
        '{"approved":true}',
        '--json',
      ],
    })
  })

  test('routes workflow compile inspection commands through the workspace daemon when container execution is requested', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []
    const daemonArgv: string[][] = []

    const workflowContainer: NonNullable<
      Parameters<typeof runMatOSWorkflowCommand>[1]
    >['workflowContainer'] = {
      run: async input => {
        daemonArgv.push(input.argv)
        input.stdout('{"ok":true}\n')
        return 0
      },
    }

    expect(
      await runMatOSWorkflowCommand(
        [
          'compile-inspect',
          'run_container_compiled',
          '--execution',
          'container',
          '--scope',
          'user:alice',
          '--json',
        ],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          workflowContainer,
        },
      ),
    ).toBe(0)
    expect(
      await runMatOSWorkflowCommand(
        [
          'contract',
          'run_container_compiled',
          '--execution',
          'container',
          '--scope',
          'user:alice',
          '--json',
        ],
        {
          cwd,
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
          workflowContainer,
        },
      ),
    ).toBe(0)

    expect(stderr.join('')).toBe('')
    expect(daemonArgv).toEqual([
      [
        '/app/bin/matos',
        'workflow',
        'compile-inspect',
        'run_container_compiled',
        '--scope',
        'user:alice',
        '--json',
      ],
      [
        '/app/bin/matos',
        'workflow',
        'contract',
        'run_container_compiled',
        '--scope',
        'user:alice',
        '--json',
      ],
    ])
  })

  test('uses MATOS_WORKFLOW_RUNS_DIR for container-visible workflow run state', async () => {
    const cwd = await fixture()
    const runsDir = join(cwd, 'container-visible-workflows', 'runs')
    process.env.MATOS_WORKFLOW_RUNS_DIR = runsDir
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:interactive', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; runDir: string; status: string }
    }

    expect(started.run.runDir.startsWith(runsDir)).toBe(true)
    expect(await exists(join(runsDir, started.run.runId, 'run.json'))).toBe(true)

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['status', started.run.runId, '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('waiting_input')
    expect(stderr.join('')).toBe('')
  })

  test('uses explicit workflow env without reading MATOS_WORKFLOW_RUNS_DIR from process env', async () => {
    const cwd = await fixture()
    const runsDir = join(cwd, 'explicit-env-workflows', 'runs')
    const stdout: string[] = []
    const stderr: string[] = []

    expect(process.env.MATOS_WORKFLOW_RUNS_DIR).toBeUndefined()
    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:interactive', '--json'], {
        cwd,
        env: { MATOS_WORKFLOW_RUNS_DIR: runsDir },
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; runDir: string; status: string }
    }

    expect(started.run.runDir.startsWith(runsDir)).toBe(true)
    expect(await exists(join(runsDir, started.run.runId, 'run.json'))).toBe(true)

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['status', started.run.runId, '--json'],
        {
          cwd,
          env: { MATOS_WORKFLOW_RUNS_DIR: runsDir },
          stdout: text => stdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('waiting_input')
    expect(stderr.join('')).toBe('')
  })

  test('records workflow run session lifecycle under the active trace', async () => {
    const cwd = await fixture()
    process.env.MATOS_TRACE_ID = 'trace-workflow-cli-1'
    process.env.MATOS_SESSION_ID = 'session-workflow-cli-1'
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:relax', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; runDir: string; status: string }
    }
    expect(started.run.status).toBe('completed')

    const sessionJsonl = await readFile(
      join(cwd, '.matos', 'sessions', 'session-workflow-cli-1.jsonl'),
      'utf8',
    )
    const sessionEvents = sessionJsonl
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as { type: string; traceId?: string })
    expect(sessionEvents.map(event => event.type)).toContain(
      'matos.session.started',
    )
    expect(sessionEvents.map(event => event.type)).toContain(
      'matos.session.completed',
    )
    expect(sessionEvents[0]?.type).toBe('matos.session.started')
    expect(new Set(sessionEvents.map(event => event.traceId))).toEqual(
      new Set(['trace-workflow-cli-1']),
    )

    const workflowEvents = JSON.parse(
      await readFile(join(started.run.runDir, 'events.jsonl'), 'utf8').then(text =>
        `[${text
          .trim()
          .split('\n')
          .join(',')}]`,
      ),
    ) as Array<{ trace?: { traceId?: string } }>
    expect(new Set(workflowEvents.map(event => event.trace?.traceId))).toEqual(
      new Set(['trace-workflow-cli-1']),
    )
    expect(stderr.join('')).toBe('')
  })

  test('pauses, resumes, retries, and skips workflow runs from CLI', async () => {
    const cwd = await fixture()
    const workflowDir = join(cwd, '.matos', 'assets', 'workflows', 'ops')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'ops',
      type: 'workflow',
      name: 'Ops',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'ops',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        result: { value: '{{ nodes.flaky.outputs.stdout }}' },
      },
      nodes: [
        {
          id: 'review',
          type: 'human',
          dependsOn: [],
          prompt: 'Continue?',
        },
        {
          id: 'flaky',
          type: 'exec',
          dependsOn: ['review'],
          command:
            'if [ ! -f retry-marker ]; then touch retry-marker; exit 7; fi; printf cli-retry-ok',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:ops', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const started = (JSON.parse(stdout.join('')) as {
      run: { runId: string; runDir: string }
    }).run
    const runId = started.runId

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['pause', runId, '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('paused')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['resume', runId, '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('waiting_input')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['respond', runId, '--node', 'review', '--message', '{"approved":true}', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)
    expect(JSON.parse(stdout.join('')).run.status).toBe('failed')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['retry-node', runId, '--node', 'flaky', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.outputs.result).toBe('cli-retry-ok')
    const runSnapshot = JSON.parse(
      await readFile(join(started.runDir, 'run.json'), 'utf8'),
    ) as { workspaceDir?: string }
    expect(runSnapshot.workspaceDir).toBeTruthy()
    await rm(join(runSnapshot.workspaceDir!, 'retry-marker'), { force: true })

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:ops', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const skipRunId = (JSON.parse(stdout.join('')) as { run: { runId: string } })
      .run.runId

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'respond',
          skipRunId,
          '--node',
          'review',
          '--message',
          '{"approved":true}',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'skip-node',
          skipRunId,
          '--node',
          'flaky',
          '--reason',
          'optional failure',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).run.status).toBe('completed')
    expect(stderr.join('')).toBe('')
  })

  test('retries failed aggregate map children from CLI without rerunning successful children', async () => {
    const cwd = await fixture()
    const childDir = join(cwd, '.matos', 'assets', 'workflows', 'retryable-map-child')
    const parentDir = join(cwd, '.matos', 'assets', 'workflows', 'map-selective-cli')
    await mkdir(childDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeJson(join(childDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'retryable-map-child',
      type: 'workflow',
      name: 'Retryable Map Child',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(childDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'retryable-map-child',
      parameters: {
        item: { type: 'string', default: 'none' },
        failItems: { type: 'string', default: 'bad' },
      },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        item: { value: '{{ parameters.item }}' },
        done: { value: '{{ nodes.mark.outputs.stdout }}' },
      },
      nodes: [
        {
          id: 'mark',
          type: 'exec',
          dependsOn: [],
          command:
            'case ",{{ parameters.failItems }}," in *,"{{ parameters.item }}",*) if [ ! -f "retry-{{ parameters.item }}.marker" ]; then touch "retry-{{ parameters.item }}.marker"; echo "first failure {{ parameters.item }}" >&2; exit 7; fi;; esac; printf "{{ parameters.item }}," >> successful-items.log && printf "{{ parameters.item }}"',
        },
      ],
    })
    await writeJson(join(parentDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'map-selective-cli',
      type: 'workflow',
      name: 'Map Selective CLI',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(parentDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'map-selective-cli',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        final: { value: '{{ nodes.report.outputs.stdout }}' },
        completed: { value: '{{ nodes.scan.outputs.completedCount }}' },
        failed: { value: '{{ nodes.scan.outputs.failedCount }}' },
      },
      nodes: [
        {
          id: 'scan',
          type: 'map',
          dependsOn: [],
          workflow: 'workflow:retryable-map-child',
          items: ['si', 'bad', 'ge'],
          itemParameter: 'item',
          parameters: { failItems: 'bad' },
          outputKeys: ['item', 'done'],
          failureMode: 'aggregate',
        },
        {
          id: 'report',
          type: 'exec',
          dependsOn: ['scan'],
          command:
            'printf "{{ nodes.scan.outputs.completedCount }}/{{ nodes.scan.outputs.failedCount }}" > final-report.txt && cat final-report.txt',
        },
      ],
    })

    const stdout: string[] = []
    const stderr: string[] = []
    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:map-selective-cli', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    const started = JSON.parse(stdout.join('')) as {
      run: { runId: string; runDir: string; status: string }
    }
    expect(started.run.status).toBe('failed')
    const runSnapshot = JSON.parse(
      await readFile(join(started.run.runDir, 'run.json'), 'utf8'),
    ) as { workspaceDir: string }
    expect(await readFile(join(runSnapshot.workspaceDir, 'successful-items.log'), 'utf8')).toBe(
      'si,ge,',
    )

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'retry-node',
          started.run.runId,
          '--node',
          'scan',
          '--failed-children-only',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const retried = JSON.parse(stdout.join('')) as {
      run: { status: string; outputs: { final: string; completed: number; failed: number } }
    }
    expect(retried.run.status).toBe('completed')
    expect(retried.run.outputs).toMatchObject({
      final: '3/0',
      completed: 3,
      failed: 0,
    })
    expect(await readFile(join(runSnapshot.workspaceDir, 'successful-items.log'), 'utf8')).toBe(
      'si,ge,bad,',
    )
    expect(
      await stat(
        join(started.run.runDir, 'rounds', 'scan', '0002', 'retry-02', 'summary.md'),
      ),
    ).toBeTruthy()
    expect(stderr.join('')).toBe('')
  })

  test('creates workflow drafts, imports components, publishes assets, and forks runs', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'create',
          '--id',
          'draft-relax',
          '--name',
          'Draft Relax',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).draft.draftId).toBe('draft-relax')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'import-component',
          'draft-relax',
          'workflow:relax-component',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).definition.nodes.map((node: { id: string }) => node.id)).toEqual([
      'prepare',
      'review',
    ])

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'publish',
          'draft-relax',
          '--id',
          'generated-relax',
          '--version',
          '0.1.0',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).published.assetKey).toBe(
      'workflow:generated-relax@0.1.0',
    )

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['show', 'workflow:generated-relax', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).definition.nodes[1].id).toBe('review')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['run', 'workflow:generated-relax', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const runId = JSON.parse(stdout.join('')).run.runId as string

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['fork', runId, '--id', 'draft-from-run', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).draft.draftId).toBe('draft-from-run')
    expect(stderr.join('')).toBe('')

    // `wait` long-polls the run: this run parked on its human `review` node,
    // so wait returns immediately with the waiting pulse and the respond path
    // instead of forcing a status-poll loop.
    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['wait', runId, '--timeout-seconds', '5', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const waited = JSON.parse(stdout.join('')) as {
      timedOut: boolean
      pulse: {
        status: string
        waiting: { nodeId: string; kind: string } | null
        guidance: string[]
      }
      newEvents: Array<{ type: string }>
    }
    expect(waited.timedOut).toBe(false)
    expect(waited.pulse.status).toBe('waiting_input')
    expect(waited.pulse.waiting).toEqual({ nodeId: 'review', kind: 'input' })
    expect(waited.pulse.guidance.join(' ')).toContain('respond')

    // `draft validate` aliases compile: agents guess it first (the tool action
    // is validate_draft) and previously burned a turn on
    // "Unknown matos workflow draft command: validate".
    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'validate', 'draft-relax', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).ok).toBe(true)

    // `author` publishes a definition file in one call (create+validate+publish).
    stdout.length = 0
    stderr.length = 0
    const authoredDefinition = {
      schemaVersion: 1,
      name: 'cli-authored',
      version: '0.1.0',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'hello', type: 'exec', dependsOn: [], command: 'printf cli-authored' },
      ],
    }
    await writeFile(
      join(cwd, 'cli-authored.workflow.json'),
      JSON.stringify(authoredDefinition),
      'utf8',
    )
    expect(
      await runMatOSWorkflowCommand(
        [
          'author',
          '--id',
          'cli-authored',
          '--definition-file',
          'cli-authored.workflow.json',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const authored = JSON.parse(stdout.join('')) as {
      validation: { ok: boolean }
      workflowRef: string | null
    }
    expect(authored.validation.ok).toBe(true)
    expect(authored.workflowRef).toBe('workflow:cli-authored@0.1.0')

    // `templates` exposes the curated node templates on the CLI surface too.
    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(['templates', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const templates = JSON.parse(stdout.join('')) as {
      templates: Array<{ id: string }>
    }
    expect(templates.templates.map(item => item.id)).toContain('qe-pw-exec')

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['templates', 'results-guard', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(
      (JSON.parse(stdout.join('')) as { template: { id: string } }).template.id,
    ).toBe('results-guard')

    // Unknown subcommands list the available surface instead of dead-ending.
    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'compile-all'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    expect(stderr.join('')).toContain('Unknown matos workflow draft command: compile-all')
    expect(stderr.join('')).toContain('Available: from-task, list, create, show, validate, compile')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(['node-types'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    expect(stderr.join('')).toContain('Unknown matos workflow command: node-types')
    expect(stderr.join('')).toContain('Available: list, show, validate, compile')
  })

  test('mutates workflow drafts from CLI builder commands', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(['draft', 'create', '--id', 'builder', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'add-node',
          'builder',
          '--node-json',
          '{"id":"prepare","type":"exec","command":"printf ok","dependsOn":[]}',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'add-node',
          'builder',
          '--node-json',
          '{"id":"bad","type":"not-a-real-type","dependsOn":[]}',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)
    expect(stderr.join('')).toContain('Invalid workflow draft mutation')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'show', 'builder', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(
      JSON.parse(stdout.join('')).definition.nodes.map(
        (node: { id: string }) => node.id,
      ),
    ).toEqual(['prepare'])

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'show', '../escape', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(1)
    expect(stderr.join('')).toContain('Workflow draft id must be a simple id')

    const reviewNodePath = join(cwd, 'review-node.json')
    await writeFile(
      reviewNodePath,
      '{"id":"review","type":"human","prompt":"Review","dependsOn":[]}',
      'utf8',
    )
    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'add-node',
          'builder',
          '--node-file',
          reviewNodePath,
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'connect', 'builder', '--from', 'prepare', '--to', 'review', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    const connected = JSON.parse(stdout.join('')) as {
      definition: { nodes: Array<{ id: string; dependsOn: string[] }> }
      validation: { ok: boolean }
    }
    expect(connected.definition.nodes.find(node => node.id === 'review')?.dependsOn).toEqual([
      'prepare',
    ])
    expect(connected.validation.ok).toBe(true)

    const patchPath = join(cwd, 'review-patch.json')
    await writeFile(patchPath, '{"id":"final_review","prompt":"Final review"}', 'utf8')
    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'update-node',
          'builder',
          '--node',
          'review',
          '--patch-file',
          patchPath,
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const updated = JSON.parse(stdout.join('')) as {
      definition: { nodes: Array<{ id: string; dependsOn: string[]; prompt?: string }> }
    }
    expect(
      updated.definition.nodes.find(node => node.id === 'final_review'),
    ).toMatchObject({
      dependsOn: ['prepare'],
      prompt: 'Final review',
    })

    const outputsPath = join(cwd, 'outputs.json')
    await writeFile(
      outputsPath,
      '{"summary":{"value":"{{ nodes.prepare.outputs.stdout }}"}}',
      'utf8',
    )
    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'set-outputs',
          'builder',
          '--outputs-file',
          outputsPath,
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).definition.outputs.summary.value).toBe(
      '{{ nodes.prepare.outputs.stdout }}',
    )

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'compile', 'builder', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join(''))).toMatchObject({
      ok: true,
      workflowRef: 'draft:builder',
      metadata: {
        compilerVersion: 'matos-workflow-compile-v1',
        nodeCount: 2,
        contractNodeCount: 2,
      },
      contracts: {
        nodes: {
          prepare: {
            outputs: {
              stdout: { type: 'string' },
            },
          },
        },
      },
    })

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'list', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).drafts.map((draft: { draftId: string }) => draft.draftId)).toEqual([
      'builder',
    ])

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'disconnect',
          'builder',
          '--from',
          'prepare',
          '--to',
          'final_review',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(
      JSON.parse(stdout.join('')).definition.nodes.find(
        (node: { id: string }) => node.id === 'final_review',
      ).dependsOn,
    ).toEqual([])

    stdout.length = 0
    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'delete-node', 'builder', '--node', 'final_review', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    expect(
      JSON.parse(stdout.join('')).definition.nodes.map(
        (node: { id: string }) => node.id,
      ),
    ).toEqual(['prepare'])
    expect(stderr.join('')).toBe('')
  })

  test('builds, publishes, and runs a state-machine workflow from draft transition commands', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []
    const run = async (args: string[]): Promise<number> => {
      stdout.length = 0
      stderr.length = 0
      return runMatOSWorkflowCommand(args, {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      })
    }

    expect(await run(['draft', 'create', '--id', 'sm-builder', '--json'])).toBe(0)
    for (const node of ['draft_step', 'review_step', 'done_step']) {
      expect(
        await run([
          'draft',
          'add-node',
          'sm-builder',
          '--node-json',
          `{"id":"${node}","type":"exec","command":"printf ${node}","dependsOn":[]}`,
          '--json',
        ]),
      ).toBe(0)
    }

    expect(
      await run([
        'draft',
        'connect-transition',
        'sm-builder',
        '--from',
        'draft_step',
        '--to',
        'review_step',
        '--route',
        'success',
        '--transition-id',
        'd2r',
        '--json',
      ]),
    ).toBe(0)
    expect(
      await run([
        'draft',
        'connect-transition',
        'sm-builder',
        '--from',
        'review_step',
        '--to',
        'draft_step',
        '--route',
        'success',
        '--guard',
        '{{ parameters.revision }} == 1',
        '--reducer-json',
        '{"revision":2}',
        '--max-traversals',
        '1',
        '--transition-id',
        'r2d',
        '--json',
      ]),
    ).toBe(0)
    expect(
      await run([
        'draft',
        'connect-transition',
        'sm-builder',
        '--from',
        'review_step',
        '--to',
        'done_step',
        '--route',
        'success',
        '--guard',
        '{{ parameters.revision }} == 2',
        '--transition-id',
        'r2done',
        '--json',
      ]),
    ).toBe(0)

    expect(
      await run([
        'draft',
        'set-state-machine',
        'sm-builder',
        '--initial-node',
        'draft_step',
        '--max-transitions',
        '6',
        '--json',
      ]),
    ).toBe(0)
    const stateMachineResult = JSON.parse(stdout.join('')) as {
      definition: {
        policy: {
          executionModel?: string
          stateMachine?: { initialNodeId: string; maxTransitions: number }
        }
        transitions: Array<{ id?: string; from: string; to: string }>
      }
      validation: { ok: boolean }
    }
    expect(stateMachineResult.validation.ok).toBe(true)
    expect(stateMachineResult.definition.policy.executionModel).toBe('state_machine')
    expect(stateMachineResult.definition.policy.stateMachine).toMatchObject({
      initialNodeId: 'draft_step',
      maxTransitions: 6,
    })
    expect(stateMachineResult.definition.transitions.map(item => item.id)).toEqual([
      'd2r',
      'r2d',
      'r2done',
    ])

    expect(
      await run([
        'draft',
        'disconnect-transition',
        'sm-builder',
        '--transition-id',
        'r2done',
        '--json',
      ]),
    ).toBe(0)
    expect(
      (JSON.parse(stdout.join('')) as {
        definition: { transitions: Array<{ id?: string }> }
      }).definition.transitions.map(item => item.id),
    ).toEqual(['d2r', 'r2d'])
    expect(
      await run([
        'draft',
        'connect-transition',
        'sm-builder',
        '--from',
        'review_step',
        '--to',
        'done_step',
        '--route',
        'success',
        '--guard',
        '{{ parameters.revision }} == 2',
        '--transition-id',
        'r2done',
        '--json',
      ]),
    ).toBe(0)

    expect(
      await run([
        'draft',
        'publish',
        'sm-builder',
        '--id',
        'sm-cycle',
        '--version',
        '0.1.0',
        '--json',
      ]),
    ).toBe(0)

    expect(
      await run([
        'run',
        'workflow:sm-cycle',
        '--param',
        'revision=1',
        '--execution',
        'local',
        '--json',
      ]),
    ).toBe(0)
    const finished = JSON.parse(stdout.join('')) as {
      run: {
        status: string
        outputs?: { finalNodeId?: string }
        stateMachine?: { frames?: Array<{ activeNodeId: string }> }
        budget?: { totals: { nodeAttempts: number } }
      }
    }
    expect(finished.run.status).toBe('completed')
    expect(finished.run.outputs?.finalNodeId).toBe('done_step')
    expect(
      finished.run.stateMachine?.frames?.map(frame => frame.activeNodeId),
    ).toEqual(['draft_step', 'review_step', 'draft_step', 'review_step', 'done_step'])
    expect(finished.run.budget?.totals.nodeAttempts).toBe(5)
  })

  test('replaces workflow draft definitions through native draft command', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    const stderr: string[] = []

    expect(
      await runMatOSWorkflowCommand(['draft', 'create', '--id', 'builder', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)

    const replacement = {
      schemaVersion: 1,
      name: 'json-edited-workflow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'prepare',
          type: 'exec',
          command: 'printf ok',
          dependsOn: [],
        },
        {
          id: 'review',
          type: 'human',
          prompt: 'Review JSON edit',
          dependsOn: ['prepare'],
        },
      ],
      outputs: {
        summary: { value: '{{ nodes.prepare.outputs.stdout }}' },
      },
    }

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'replace-definition',
          'builder',
          '--definition-json',
          JSON.stringify(replacement),
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const replaced = JSON.parse(stdout.join('')) as {
      definition: { name: string; nodes: Array<{ id: string }>; outputs: Record<string, unknown> }
      validation: { ok: boolean }
    }
    expect(replaced.validation.ok).toBe(true)
    expect(replaced.definition.name).toBe('json-edited-workflow')
    expect(replaced.definition.nodes.map(node => node.id)).toEqual([
      'prepare',
      'review',
    ])

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(
        [
          'draft',
          'replace-definition',
          'builder',
          '--definition-json',
          '{"schemaVersion":1,"name":"bad","parameters":{},"policy":{"approvalMode":"bypass","defaultRisk":"low"},"nodes":[{"id":"bad","type":"research_search","dependsOn":[]}],"outputs":{}}',
          '--json',
        ],
        { cwd, stdout: text => stdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)
    expect(stderr.join('')).toContain('Invalid workflow draft definition')

    stdout.length = 0
    stderr.length = 0
    expect(
      await runMatOSWorkflowCommand(['draft', 'show', 'builder', '--json'], {
        cwd,
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    expect(JSON.parse(stdout.join('')).definition.name).toBe('json-edited-workflow')
  })

  test('patch-propose records a proposed graph patch for a run', async () => {
    const cwd = await fixture()
    const runStdout: string[] = []
    const stderr: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:relax', '--execution', 'local', '--json'],
        { cwd, stdout: text => runStdout.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(0)
    const runId = (JSON.parse(runStdout.join('')) as { run: { runId: string } })
      .run.runId

    const proposeStdout: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-propose',
          runId,
          '--operations',
          JSON.stringify([
            {
              op: 'add_node',
              node: {
                id: 'notify',
                type: 'exec',
                dependsOn: ['prepare'],
                command: 'printf done',
              },
            },
          ]),
          '--reason',
          'add completion notice',
          '--json',
        ],
        {
          cwd,
          stdout: text => proposeStdout.push(text),
          stderr: text => stderr.push(text),
        },
      ),
    ).toBe(0)
    const proposed = JSON.parse(proposeStdout.join('')) as {
      ok: boolean
      patch?: { patchId: string; decision?: { status?: string } }
    }
    expect(proposed.ok).toBe(true)
    expect(proposed.patch?.decision?.status).toBe('proposed')

    // A second, distinct proposal must not overwrite the first (content-addressed
    // ledger ids), even with the same default reason/source node.
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-propose',
          runId,
          '--operations',
          JSON.stringify([
            {
              op: 'add_node',
              node: {
                id: 'archive',
                type: 'exec',
                dependsOn: ['prepare'],
                command: 'printf archived',
              },
            },
          ]),
          '--json',
        ],
        { cwd, stdout: () => undefined, stderr: text => stderr.push(text) },
      ),
    ).toBe(0)

    const patchesStdout: string[] = []
    expect(
      await runMatOSWorkflowCommand(['patches', runId, '--json'], {
        cwd,
        stdout: text => patchesStdout.push(text),
        stderr: text => stderr.push(text),
      }),
    ).toBe(0)
    const listed = JSON.parse(patchesStdout.join('')) as {
      patches: { decision?: { status?: string } }[]
    }
    expect(listed.patches.length).toBe(2)
    expect(
      listed.patches.every(patch => patch.decision?.status === 'proposed'),
    ).toBe(true)
    expect(stderr.join('')).toBe('')
  })

  test('patch-propose rejects an invalid patch and writes no ledger', async () => {
    const cwd = await fixture()
    const runStdout: string[] = []
    const stderr: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        ['run', 'workflow:relax', '--execution', 'local', '--json'],
        { cwd, stdout: text => runStdout.push(text), stderr: () => undefined },
      ),
    ).toBe(0)
    const runId = (JSON.parse(runStdout.join('')) as { run: { runId: string } })
      .run.runId

    const out: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        [
          'patch-propose',
          runId,
          '--operations',
          JSON.stringify([{ op: 'delete_node', nodeId: 'prepare' }]),
          '--json',
        ],
        { cwd, stdout: text => out.push(text), stderr: text => stderr.push(text) },
      ),
    ).toBe(1)
    const result = JSON.parse(out.join('')) as { ok: boolean; errors: unknown[] }
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)

    const patchesStdout: string[] = []
    await runMatOSWorkflowCommand(['patches', runId, '--json'], {
      cwd,
      stdout: text => patchesStdout.push(text),
      stderr: () => undefined,
    })
    expect(
      (JSON.parse(patchesStdout.join('')) as { patches: unknown[] }).patches
        .length,
    ).toBe(0)
  })

  test('repair --plan emits the repair role and directive', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        ['repair', 'run-missing', '--plan', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: () => undefined },
      ),
    ).toBe(0)
    const plan = JSON.parse(stdout.join('')) as {
      command: string
      runId: string
      role: string
      directive: string
    }
    expect(plan.command).toBe('workflow repair')
    expect(plan.role).toBe('role:workflow-repair')
    expect(plan.directive).toContain('workflow_patch_propose')
  })

  test('repair launches the workflow-repair role via injected runTask', async () => {
    const cwd = await fixture()
    const calls: string[][] = []
    expect(
      await runMatOSWorkflowCommand(['repair', 'run-missing'], {
        cwd,
        stdout: () => undefined,
        stderr: () => undefined,
        runTask: async args => {
          calls.push(args)
          return 0
        },
      }),
    ).toBe(0)
    expect(calls.length).toBe(1)
    expect(calls[0]?.[0]).toBe('--role')
    expect(calls[0]?.[1]).toBe('role:workflow-repair')
    expect(calls[0]?.[2]).toContain('Repair MatOS workflow run run-missing')
  })

  test('draft from-task --plan and injected runTask use the planner role', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'from-task', 'Relax a structure with MACE', '--plan', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: () => undefined },
      ),
    ).toBe(0)
    const plan = JSON.parse(stdout.join('')) as {
      command: string
      role: string
      task: string
      directive: string
    }
    expect(plan.command).toBe('workflow draft from-task')
    expect(plan.role).toBe('role:workflow-planner')
    expect(plan.task).toBe('Relax a structure with MACE')

    const calls: string[][] = []
    expect(
      await runMatOSWorkflowCommand(
        ['draft', 'from-task', 'Relax a structure with MACE'],
        {
          cwd,
          stdout: () => undefined,
          stderr: () => undefined,
          runTask: async args => {
            calls.push(args)
            return 0
          },
        },
      ),
    ).toBe(0)
    expect(calls[0]?.slice(0, 2)).toEqual(['--role', 'role:workflow-planner'])
  })

  test('optimize --plan and injected runTask use the optimizer role', async () => {
    const cwd = await fixture()
    const stdout: string[] = []
    expect(
      await runMatOSWorkflowCommand(
        ['optimize', 'workflow:relax', '--evidence', 'slow runs', '--plan', '--json'],
        { cwd, stdout: text => stdout.push(text), stderr: () => undefined },
      ),
    ).toBe(0)
    const plan = JSON.parse(stdout.join('')) as {
      command: string
      role: string
      workflowRef: string
    }
    expect(plan.command).toBe('workflow optimize')
    expect(plan.role).toBe('role:workflow-optimizer')
    expect(plan.workflowRef).toBe('workflow:relax')

    const calls: string[][] = []
    expect(
      await runMatOSWorkflowCommand(['optimize', 'workflow:relax'], {
        cwd,
        stdout: () => undefined,
        stderr: () => undefined,
        runTask: async args => {
          calls.push(args)
          return 0
        },
      }),
    ).toBe(0)
    expect(calls[0]?.slice(0, 2)).toEqual(['--role', 'role:workflow-optimizer'])
  })
})
