import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { callMatOSTool, type MatOSToolDefinition } from '../tools/matosToolRunner.js'
import { runWorkflowBackendNode } from '../workflows/nodeAdapters/backendNode.js'
import {
  withMatOSWorkflowExecutionContext,
  type MatOSAlgorithmComponentPin,
} from '../workflows/executionContext.js'
import type { MatOSWorkflowDefinition, MatOSWorkflowNode } from '../workflows/types.js'
import {
  assertSafeMatOSAlgorithmComponentInput,
  matOSAlgorithmComponentAssetIssues,
  parseMatOSAlgorithmDecisionReceipt,
  resolveMatOSAlgorithmComponentPins,
  verifyMatOSAlgorithmComponentPin,
} from './componentTool.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function componentNode(id = 'decide'): MatOSWorkflowNode {
  return {
    id,
    type: 'backend',
    dependsOn: [],
    backend: 'algorithm-component',
    tool: 'tool:test-component@0.1.0',
    input: { operation: 'decide' },
    algorithmDecision: {
      protocol: 'json-v1',
      componentRef: 'tool:test-component@0.1.0',
      plane: 'controller',
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      config: { policy: 'test' },
    },
  }
}

async function writeComponentProject(input: {
  source?: string
  permissions?: Record<string, unknown>
  metadata?: Record<string, unknown>
} = {}): Promise<{ root: string; entry: string; definition: MatOSWorkflowDefinition }> {
  const root = await mkdtemp(join(tmpdir(), 'matos-component-tool-'))
  const dir = join(root, '.matos/assets/tools/test-component')
  await mkdir(dir, { recursive: true })
  const entry = join(dir, 'tool.py')
  await writeFile(
    entry,
    input.source ??
      [
        '#!/usr/bin/env python3',
        'import json, os, sys',
        'json.load(sys.stdin)',
        'receipt = {',
        '  "schemaVersion": 1,',
        '  "protocol": os.environ["MATOS_ALGORITHM_DECISION_PROTOCOL"],',
        '  "decisionId": "provider-decision:stable",',
        '  "runId": os.environ["MATOS_WORKFLOW_RUN_ID"],',
        '  "nodeId": os.environ["MATOS_WORKFLOW_NODE_ID"],',
        '  "attempt": int(os.environ["MATOS_WORKFLOW_ATTEMPT"]),',
        '  "plane": os.environ["MATOS_ALGORITHM_PLANE"],',
        '  "providerId": os.environ["MATOS_ALGORITHM_PROVIDER_ID"],',
        '  "providerVersion": os.environ["MATOS_ALGORITHM_PROVIDER_VERSION"],',
        '  "assetRef": os.environ["MATOS_ALGORITHM_ASSET_REF"],',
        '  "configDigest": os.environ["MATOS_ALGORITHM_CONFIG_DIGEST"],',
        '  "implementationDigest": os.environ["MATOS_ALGORITHM_IMPLEMENTATION_DIGEST"],',
        '  "manifestDigest": os.environ["MATOS_ALGORITHM_RUN_MANIFEST_DIGEST"],',
        '  "evaluationRefs": ["evaluation:test:trajectory-1"],',
        '  "validationRefs": ["validation:test"],',
        '  "metricRefs": ["metric:test:score"],',
        '}',
        'print(json.dumps({"ok": True, "algorithmDecision": receipt}))',
      ].join('\n') + '\n',
    'utf8',
  )
  await writeJson(join(dir, 'asset.json'), {
    schemaVersion: 1,
    id: 'test-component',
    type: 'tool',
    name: 'Test component',
    version: '0.1.0',
    entry: './tool.py',
    permissions: input.permissions ?? {
      shell: 'disabled',
      network: 'disabled',
      workspace: 'read-only',
      secrets: [],
    },
    metadata: {
      kind: 'external-tool',
      isReadOnly: true,
      isDestructive: false,
      executor: {
        runtime: 'python3',
        entry: './tool.py',
        timeoutMs: 5_000,
      },
      algorithmDecision: {
        protocol: 'json-v1',
        plane: 'controller',
        providerId: 'test-provider',
        providerVersion: '0.1.0',
      },
      ...input.metadata,
    },
  })
  return {
    root,
    entry,
    definition: {
      schemaVersion: 1,
      name: 'component-test',
      parameters: {},
      policy: {},
      nodes: [componentNode()],
      outputs: {},
    },
  }
}

function executionPin(
  pin: Omit<MatOSAlgorithmComponentPin, 'manifestDigest'>,
  manifestDigest = 'f'.repeat(64),
): MatOSAlgorithmComponentPin {
  return { ...pin, manifestDigest }
}

describe('ordinary algorithm component tools', () => {
  test('pins real manifest and entry bytes and rejects same-size replacement', async () => {
    const project = await writeComponentProject()
    const [resolved] = await resolveMatOSAlgorithmComponentPins({
      cwd: project.root,
      definition: project.definition,
    })
    expect(resolved.assetRef).toBe('tool:test-component@0.1.0')
    expect(resolved.assetManifestDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(resolved.entryDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(resolved.implementationDigest).toMatch(/^[a-f0-9]{64}$/)

    const original = await readFile(project.entry, 'utf8')
    const replacement = `${original.slice(0, -2)}x\n`
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original))
    await writeFile(project.entry, replacement, 'utf8')
    await expect(
      verifyMatOSAlgorithmComponentPin({
        cwd: project.root,
        node: componentNode(),
        pin: executionPin(resolved),
      }),
    ).rejects.toThrow('changed after run creation')
  })

  test('validates read-only/no-secret asset permissions', async () => {
    const project = await writeComponentProject({
      permissions: {
        shell: 'enabled',
        network: 'enabled',
        workspace: 'read-write',
        secrets: ['API_KEY'],
      },
      metadata: { isReadOnly: false, isDestructive: true },
    })
    const asset = (await loadMatOSAssets(project.root)).find(
      item => item.id === 'test-component',
    )!
    expect(matOSAlgorithmComponentAssetIssues(asset)).toEqual([
      expect.stringContaining('isReadOnly=true'),
      expect.stringContaining('disable shell/network'),
    ])
  })

  test('rejects secret-like input, credential values, and host paths', () => {
    expect(() =>
      assertSafeMatOSAlgorithmComponentInput({ apiKey: 'not-even-needed' }),
    ).toThrow('secret-like')
    expect(() =>
      assertSafeMatOSAlgorithmComponentInput({ note: 'Bearer abcdefghijklmnop' }),
    ).toThrow('credential-like')
    expect(() =>
      assertSafeMatOSAlgorithmComponentInput({ dataRef: '/host/private/data.json' }),
    ).toThrow('host-absolute path')
  })

  test('derives collision-resistant decision ids from run and attempt pins', () => {
    const pin: MatOSAlgorithmComponentPin = {
      nodeId: 'decide',
      protocol: 'json-v1',
      plane: 'controller',
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      assetRef: 'tool:test-component@0.1.0',
      configDigest: '1'.repeat(64),
      assetManifestDigest: '2'.repeat(64),
      entryDigest: '3'.repeat(64),
      implementationDigest: '4'.repeat(64),
      runtimeRefs: [],
      manifestDigest: '5'.repeat(64),
    }
    const payloadFor = (runId: string, attempt: number) => ({
      algorithmDecision: {
        schemaVersion: 1,
        protocol: 'json-v1',
        decisionId: 'provider-reused-id',
        runId,
        nodeId: 'decide',
        attempt,
        plane: 'controller',
        providerId: 'test-provider',
        providerVersion: '0.1.0',
        assetRef: 'tool:test-component@0.1.0',
        configDigest: pin.configDigest,
        implementationDigest: pin.implementationDigest,
        manifestDigest: pin.manifestDigest,
      },
    })
    const first = parseMatOSAlgorithmDecisionReceipt({
      payload: payloadFor('run-1', 1),
      payloadBytes: 1,
      pin,
      runId: 'run-1',
      nodeId: 'decide',
      attempt: 1,
      inputDigest: '7'.repeat(64),
    })
    const secondPin = { ...pin, manifestDigest: '6'.repeat(64) }
    const secondPayload = payloadFor('run-2', 2)
    secondPayload.algorithmDecision.manifestDigest = secondPin.manifestDigest
    const second = parseMatOSAlgorithmDecisionReceipt({
      payload: secondPayload,
      payloadBytes: 1,
      pin: secondPin,
      runId: 'run-2',
      nodeId: 'decide',
      attempt: 2,
      inputDigest: '8'.repeat(64),
    })
    expect(first.providerDecisionId).toBe('provider-reused-id')
    expect(first.decisionId).toMatch(/^algorithm-component-decision:[a-f0-9]{64}$/)
    expect(second.decisionId).not.toBe(first.decisionId)

    expect(() =>
      parseMatOSAlgorithmDecisionReceipt({
          payload: {
            ...payloadFor('run-1', 1),
            domainDecision: { decisionId: 'different-domain-id' },
          },
          payloadBytes: 1,
          pin,
          runId: 'run-1',
          nodeId: 'decide',
          attempt: 1,
          inputDigest: '7'.repeat(64),
        }),
    ).toThrow('does not match the provider domain decision')
  })

  test('component subprocesses cannot see ambient secrets or host run directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-component-env-'))
    const entry = join(root, 'probe.py')
    await writeFile(
      entry,
      [
        'import json, os',
        'print(json.dumps({',
        '  "ambient": os.environ.get("MATOS_COMPONENT_TEST_API_KEY"),',
        '  "runDir": os.environ.get("MATOS_WORKFLOW_RUN_DIR"),',
        '  "runsDir": os.environ.get("MATOS_WORKFLOW_RUNS_DIR"),',
        '  "projectCwd": os.environ.get("MATOS_PROJECT_CWD"),',
        '  "runId": os.environ.get("MATOS_WORKFLOW_RUN_ID"),',
        '}))',
      ].join('\n'),
      'utf8',
    )
    const tool: MatOSToolDefinition = {
      id: 'probe',
      label: 'probe',
      description: 'probe',
      dir: root,
      entry,
      runtime: 'python3',
      timeoutMs: 2_000,
      mcpName: 'probe',
      inputSchema: { type: 'object' },
      prompt: undefined,
      isReadOnly: true,
      isDestructive: false,
    }
    const pin = executionPin({
      nodeId: 'decide',
      protocol: 'json-v1',
      plane: 'controller',
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      assetRef: 'tool:test-component@0.1.0',
      configDigest: '1'.repeat(64),
      assetManifestDigest: '2'.repeat(64),
      entryDigest: '3'.repeat(64),
      implementationDigest: '4'.repeat(64),
      runtimeRefs: [],
    })
    const previous = process.env.MATOS_COMPONENT_TEST_API_KEY
    process.env.MATOS_COMPONENT_TEST_API_KEY = 'should-not-cross-boundary'
    try {
      const result = await withMatOSWorkflowExecutionContext(
        {
          runId: 'run-env',
          runDir: join(root, 'runs/run-env'),
          workflowNodeId: 'decide',
          attempt: 1,
          projectCwd: root,
          algorithmComponentPins: new Map([['decide', pin]]),
        },
        () => callMatOSTool(tool, {}),
      )
      expect(JSON.parse(result.stdout)).toEqual({
        ambient: null,
        runDir: null,
        runsDir: null,
        projectCwd: null,
        runId: 'run-env',
      })
    } finally {
      if (previous === undefined) delete process.env.MATOS_COMPONENT_TEST_API_KEY
      else process.env.MATOS_COMPONENT_TEST_API_KEY = previous
    }
  })

  test('python component subprocesses cannot open files after source loading', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-component-filesystem-'))
    const entry = join(root, 'probe.py')
    await writeFile(
      entry,
      [
        'import json',
        'try:',
        '  open("/etc/passwd", "rb").read(1)',
        '  denied = False',
        'except PermissionError:',
        '  denied = True',
        'print(json.dumps({"filesystemOpenDenied": denied}))',
      ].join('\n'),
      'utf8',
    )
    const pin = executionPin({
      nodeId: 'decide',
      protocol: 'json-v1',
      plane: 'controller',
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      assetRef: 'tool:test-component@0.1.0',
      configDigest: '1'.repeat(64),
      assetManifestDigest: '2'.repeat(64),
      entryDigest: '3'.repeat(64),
      implementationDigest: '4'.repeat(64),
      runtimeRefs: [],
    })
    const result = await withMatOSWorkflowExecutionContext(
      {
        runId: 'run-filesystem',
        runDir: root,
        workflowNodeId: 'decide',
        attempt: 1,
        projectCwd: root,
        algorithmComponentPins: new Map([['decide', pin]]),
      },
      () => callMatOSTool({
        id: 'filesystem-probe',
        label: 'filesystem-probe',
        description: 'filesystem-probe',
        dir: root,
        entry,
        runtime: 'python3',
        timeoutMs: 2_000,
        mcpName: 'filesystem_probe',
        inputSchema: { type: 'object' },
        prompt: undefined,
        isReadOnly: true,
        isDestructive: false,
      }, {}),
    )
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ filesystemOpenDenied: true })
  })

  test('bounds output and force-kills a component that ignores SIGTERM', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-component-bounds-'))
    const pin = executionPin({
      nodeId: 'decide',
      protocol: 'json-v1',
      plane: 'controller',
      providerId: 'test-provider',
      providerVersion: '0.1.0',
      assetRef: 'tool:test-component@0.1.0',
      configDigest: '1'.repeat(64),
      assetManifestDigest: '2'.repeat(64),
      entryDigest: '3'.repeat(64),
      implementationDigest: '4'.repeat(64),
      runtimeRefs: [],
    })
    const run = async (source: string, timeoutMs: number) => {
      const entry = join(root, `tool-${timeoutMs}.py`)
      await writeFile(entry, source, 'utf8')
      return await withMatOSWorkflowExecutionContext(
        {
          runId: 'run-bounds',
          runDir: root,
          workflowNodeId: 'decide',
          attempt: 1,
          projectCwd: root,
          algorithmComponentPins: new Map([['decide', pin]]),
        },
        () =>
          callMatOSTool(
            {
              id: 'bounded',
              label: 'bounded',
              description: 'bounded',
              dir: root,
              entry,
              runtime: 'python3',
              timeoutMs,
              mcpName: 'bounded',
              inputSchema: { type: 'object' },
              prompt: undefined,
              isReadOnly: true,
              isDestructive: false,
            },
            {},
          ),
      )
    }
    const flooded = await run('print("x" * 400000)\n', 2_000)
    expect(flooded.exitCode).toBeNull()
    expect(flooded.stderr).toContain('256 KiB')
    expect(Buffer.byteLength(flooded.stdout)).toBeLessThanOrEqual(256 * 1024)

    const started = Date.now()
    const timedOut = await run(
      'import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(10)\n',
      50,
    )
    expect(timedOut.exitCode).toBeNull()
    expect(timedOut.stderr).toContain('Timed out')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test('decision evidence append failure does not fail a valid read-only controller', async () => {
    const project = await writeComponentProject()
    const runDir = join(project.root, 'run')
    await mkdir(runDir)
    await writeFile(join(runDir, 'events.jsonl'), '', 'utf8')
    const external = join(project.root, 'external-decisions')
    await writeFile(external, '', 'utf8')
    await symlink(external, join(runDir, 'algorithm-decisions.jsonl'))
    const [resolved] = await resolveMatOSAlgorithmComponentPins({
      cwd: project.root,
      definition: project.definition,
    })
    const pin = executionPin(resolved)
    const result = await withMatOSWorkflowExecutionContext(
      {
        runId: 'run-capture-failure',
        runDir,
        workflowNodeId: 'decide',
        attempt: 1,
        projectCwd: project.root,
        algorithmComponentPins: new Map([['decide', pin]]),
      },
      () => runWorkflowBackendNode(componentNode(), { cwd: project.root }),
    )
    expect(result.output.ok).toBeTrue()
    expect(await readFile(external, 'utf8')).toBe('')
    expect(await readFile(join(runDir, 'events.jsonl'), 'utf8')).toContain(
      'workflow.algorithm.decision_capture_failed',
    )
  })
})
