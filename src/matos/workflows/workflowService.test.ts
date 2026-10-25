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

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { getMatOSConfigPath, getMatOSDir, readMatOSProjectConfig } from '../project.js'
import {
  awaitMatOSWorkflowReplayClosureIdle,
  createMatOSWorkflowService,
  matOSWorkflowService,
} from './workflowService.js'
import { readWorkflowDraftDefinition } from './workflowStore.js'

const execFileAsync = promisify(execFile)
const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 20 * 1024 * 1024,
  })
  return String(result.stdout ?? '').trim()
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '.'])
  await git(cwd, [
    '-c',
    'user.name=MatOS Test',
    '-c',
    'user.email=matos-test@localhost',
    'commit',
    '-m',
    message,
  ])
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-'))
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'service-flow')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'service-flow',
    type: 'workflow',
    name: 'Service Flow',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'service-flow',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {
      resultPath: { value: '{{ nodes.write_result.outputs.stdout }}' },
    },
    nodes: [
      {
        id: 'write_result',
        type: 'exec',
        dependsOn: [],
        command: 'printf service-ok > result.txt && printf result.txt',
        artifactContract: {
          result_file: {
            kind: 'file',
            path: 'result.txt',
            required: true,
          },
        },
      },
    ],
  })
  return root
}

describe('MatOS workflow service', () => {
  test('provides a shared json-shaped workflow runtime surface', async () => {
    const cwd = await fixture()
    const service = createMatOSWorkflowService()

    const listed = await service.list({ cwd })
    expect(listed.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          canonicalKey: 'workflow:service-flow@0.1.0',
          kind: 'executable',
          readiness: expect.objectContaining({
            status: 'experimental',
            userFacing: false,
          }),
        }),
      ]),
    )

    const shown = await service.show({ cwd, ref: 'workflow:service-flow' })
    expect(shown.validation.ok).toBe(true)
    expect(shown.nodeManifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'agent',
          runtimeType: 'agent',
          palette: true,
          requiredFields: expect.arrayContaining(['id', 'type', 'role']),
        }),
      ]),
    )

    const validated = await service.validate({ cwd, ref: 'workflow:service-flow' })
    expect(validated).toMatchObject({
      workflow: 'workflow:service-flow@0.1.0',
      ok: true,
      errors: [],
    })

    const compiled = await service.compile({ cwd, ref: 'workflow:service-flow' })
    expect(compiled).toMatchObject({
      ok: true,
      workflowRef: 'workflow:service-flow@0.1.0',
      metadata: {
        compilerVersion: 'matos-workflow-compile-v1',
        nodeCount: 1,
        contractNodeCount: 1,
      },
      contracts: {
        nodes: {
          write_result: {
            outputs: {
              stdout: { type: 'string' },
            },
          },
        },
      },
    })

    const started = await service.run({ cwd, ref: 'workflow:service-flow' })
    expect(started.run.status).toBe('completed')
    expect(started.run.outputs.resultPath).toBe('result.txt')
    const graphSnapshot = JSON.parse(
      await readFile(join(started.run.runDir, 'graph.snapshot.json'), 'utf8'),
    )
    expect(graphSnapshot.compiled).toEqual(
      expect.objectContaining({
        compilerVersion: 'matos-workflow-compile-v1',
        workflowRef: 'workflow:service-flow@0.1.0',
        contractNodeCount: 1,
        contracts: expect.objectContaining({
          nodes: expect.objectContaining({
            write_result: expect.objectContaining({
              outputs: expect.objectContaining({
                stdout: expect.objectContaining({ type: 'string' }),
              }),
            }),
          }),
        }),
      }),
    )
    const evidence = JSON.parse(
      await readFile(
        join(
          getMatOSDir(cwd),
          'learning',
          'workflow-evidence',
          `workflow-evidence-${started.run.runId}.json`,
        ),
        'utf8',
      ),
    )
    expect(evidence).toMatchObject({
      runId: started.run.runId,
      workflowRef: 'workflow:service-flow@0.1.0',
      status: 'completed',
    })
    expect(evidence.sourceRefs).toContain(`workflow-run:${started.run.runId}`)
    expect(evidence.eventTypes).toContain('workflow.run.completed')

    const inspected = await service.inspect({ cwd, runId: started.run.runId })
    expect(inspected.run.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'write_result',
          status: 'completed',
        }),
      ]),
    )

    const events = await service.events({ cwd, runId: started.run.runId })
    expect(events.events.map(event => event.type)).toContain(
      'workflow.run.completed',
    )

    const artifacts = await service.artifacts({ cwd, runId: started.run.runId })
    expect(artifacts.artifacts).toEqual([])

    const compileInspect = await service.compileInspect({
      cwd,
      runId: started.run.runId,
    })
    expect(compileInspect).toMatchObject({
      ok: true,
      workflowRef: 'workflow:service-flow@0.1.0',
      metadata: {
        compilerVersion: 'matos-workflow-compile-v1',
        nodeCount: 1,
      },
      contracts: {
        nodes: {
          write_result: {
            artifacts: {
              result_file: {
                path: 'result.txt',
                required: true,
              },
            },
          },
        },
      },
    })

    const contracts = await service.contracts({
      cwd,
      runId: started.run.runId,
    })
    expect(contracts).toMatchObject({
      source: 'run',
      workflowRef: 'workflow:service-flow@0.1.0',
      runId: started.run.runId,
      artifacts: [
        {
          nodeId: 'write_result',
          contractId: 'result_file',
          status: 'missing',
          required: true,
        },
      ],
    })

    const paused = await service.pause({ cwd, runId: started.run.runId }).catch(
      error => error,
    )
    expect(paused).toBeInstanceOf(Error)
  })

  test('supports deferred start (advance:false) resumed later from created state', async () => {
    const cwd = await fixture()
    const service = createMatOSWorkflowService()

    // advance:false persists the validated run without executing any node —
    // this is the tool-facing wait=false path where a detached worker
    // advances the run after the agent turn has already returned.
    const started = await service.run({
      cwd,
      ref: 'workflow:service-flow',
      recordSession: false,
      advance: false,
    })
    expect(started.run.status).toBe('created')
    expect(started.run.runId).toMatch(/^run_/)

    const status = await service.status({ cwd, runId: started.run.runId })
    expect(status.run.status).toBe('created')

    // resume must accept a created run (deferred start or a creator process
    // that died before the first advance) and execute it to completion.
    const resumed = await service.resume({ cwd, runId: started.run.runId })
    expect(resumed.run.status).toBe('completed')
    expect(resumed.run.outputs.resultPath).toBe('result.txt')
  })

  test('does not report persisted invalid compiled snapshots as ok', async () => {
    const cwd = await fixture()
    const service = createMatOSWorkflowService()
    const started = await service.run({ cwd, ref: 'workflow:service-flow' })
    await writeJson(join(started.run.runDir, 'graph.snapshot.json'), {
      schemaVersion: 1,
      name: 'invalid persisted snapshot',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'bad_node',
          type: 'domain_specific_runtime_type',
          dependsOn: [],
        },
      ],
      compiled: {
        schemaVersion: 1,
        compilerVersion: 'matos-workflow-compile-v1',
        compiledAt: '2026-06-06T00:00:00.000Z',
        sourceDigest: 'sha256:source',
        snapshotDigest: 'sha256:snapshot',
        nodeCount: 1,
        edgeCount: 0,
        contractNodeCount: 0,
        budgetEstimate: {
          agentCalls: 0,
          toolCalls: 0,
          backendJobs: 0,
          childRuns: 0,
          dynamicPatches: 0,
        },
        risk: 'low',
        ok: true,
        contracts: { nodes: {} },
      },
    })

    const inspected = await service.compileInspect({
      cwd,
      runId: started.run.runId,
    })

    expect(inspected.ok).toBe(false)
    expect(inspected.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'invalid_node_type',
          nodeId: 'bad_node',
        }),
      ]),
    )
  })

  test('matches relative artifact contract paths against absolute artifact paths', async () => {
    const cwd = await fixture()
    const service = createMatOSWorkflowService()
    const started = await service.run({ cwd, ref: 'workflow:service-flow' })
    await writeJson(join(started.run.runDir, 'artifacts.json'), [
      {
        id: 'absolute-result',
        nodeId: 'write_result',
        kind: 'file',
        path: join(started.run.runDir, 'result.txt'),
      },
    ])

    const contracts = await service.contracts({
      cwd,
      runId: started.run.runId,
    })

    expect(contracts.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'write_result',
          contractId: 'result_file',
          status: 'present',
          artifact: expect.objectContaining({
            id: 'absolute-result',
          }),
        }),
      ]),
    )
  })

  test('persists run trace provenance and supports structured run filters', async () => {
    const cwd = await fixture()
    const service = createMatOSWorkflowService()
    const firedAt = Date.parse('2026-06-16T00:00:00.000Z')
    const env = {
      ...process.env,
      MATOS_USER_ID: 'workflow-service-user',
      MATOS_RUNTIME_PROFILE_REF: 'runtime:workflow-service-test',
      MATOS_TRACE_ID: 'trace-workflow-service',
      MATOS_SESSION_ID: 'session-workflow-service',
      MATOS_SCOPE_REF: 'scope:workflow-service',
    }

    const triggered = await service.run({
      cwd,
      env,
      ref: 'workflow:service-flow',
      provenance: {
        source: 'trigger',
        triggerId: 'trg-nightly-service',
        triggerEventId: 'matos.schedule.cron',
        triggerAppId: 'matos-schedule',
        firedAt,
        payloadDigest: 'sha256:workflow-service-payload',
      },
    })
    const manual = await service.run({
      cwd,
      ref: 'workflow:service-flow',
      provenance: { source: 'manual', reason: 'service-test' },
    })

    const persisted = JSON.parse(
      await readFile(join(triggered.run.runDir, 'run.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(persisted).toMatchObject({
      trace: {
        traceId: 'trace-workflow-service',
        sessionId: 'session-workflow-service',
        userId: 'workflow-service-user',
        scopeRef: 'user:local',
        runtimeRef: 'runtime:workflow-service-test',
      },
      provenance: {
        source: 'trigger',
        triggerId: 'trg-nightly-service',
        triggerEventId: 'matos.schedule.cron',
        triggerAppId: 'matos-schedule',
        firedAt,
        payloadDigest: 'sha256:workflow-service-payload',
      },
    })

    const byTrigger = await service.listRuns({
      cwd,
      filter: { triggerId: 'trg-nightly-service' },
    })
    expect(byTrigger.runs.map(item => item.run.runId)).toEqual([
      triggered.run.runId,
    ])
    expect(byTrigger.summary.filters).toEqual({
      triggerId: 'trg-nightly-service',
    })
    expect(byTrigger.runs[0]?.run.trace).toMatchObject({
      traceId: 'trace-workflow-service',
      userId: 'workflow-service-user',
    })
    expect(byTrigger.runs[0]?.run.provenance).toMatchObject({
      source: 'trigger',
      triggerId: 'trg-nightly-service',
    })

    const byTrace = await service.listRuns({
      cwd,
      filter: {
        traceId: 'trace-workflow-service',
        sessionId: 'session-workflow-service',
        source: 'trigger',
      },
    })
    expect(byTrace.runs.map(item => item.run.runId)).toEqual([
      triggered.run.runId,
    ])

    const byManualSource = await service.listRuns({
      cwd,
      filter: { source: 'manual' },
    })
    expect(byManualSource.runs.map(item => item.run.runId)).toEqual([
      manual.run.runId,
    ])

    const byQuery = await service.listRuns({
      cwd,
      query: 'workflow-service-payload',
    })
    expect(byQuery.runs.map(item => item.run.runId)).toEqual([
      triggered.run.runId,
    ])
  })

  test('uses an ambient user scope for workflow storage and node trace context', async () => {
    const cwd = await fixture()
    const service = createMatOSWorkflowService()
    const run = await service.run({
      cwd,
      env: {
        MATOS_RUNTIME_DATA_DIR: join(cwd, 'ambient-scope-runtime'),
        MATOS_SCOPE_REF: 'user:alice',
      },
      ref: 'workflow:service-flow',
    })

    expect(run.run.runDir).toContain('/scopes/users/alice/')
    expect(run.run.trace?.scopeRef).toBe('user:alice')
  })

  test('failed workflow runs write self-evolution workflow evidence without proposals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-failure-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'failing-flow')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'failing-flow',
      type: 'workflow',
      name: 'Failing Flow',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'failing-flow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'fetch_sources',
          type: 'exec',
          dependsOn: [],
          command: 'printf failing-fetch >&2; exit 7',
        },
        {
          id: 'cross_verify_sources',
          type: 'exec',
          dependsOn: ['fetch_sources'],
          command: 'printf should-not-run',
        },
      ],
    })

    const service = createMatOSWorkflowService()
    const started = await service.run({ cwd: root, ref: 'workflow:failing-flow' })

    expect(started.run.status).toBe('failed')
    const evidence = JSON.parse(
      await readFile(
        join(
          getMatOSDir(root),
          'learning',
          'workflow-evidence',
          `workflow-evidence-${started.run.runId}.json`,
        ),
        'utf8',
      ),
    )
    expect(evidence).toMatchObject({
      runId: started.run.runId,
      workflowRef: 'workflow:failing-flow@0.1.0',
      status: 'failed',
      nodeSummary: expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'fetch_sources',
          status: 'failed',
          hasError: true,
        }),
      ]),
      suggestedAssetTypes: ['workflow', 'benchmark'],
    })
  })

  test('repeated failed runs close the replay loop: cluster, auto-verify, improvement candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-replay-loop-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'flaky-flow')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'flaky-flow',
      type: 'workflow',
      name: 'Flaky Flow',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'flaky-flow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'always_breaks',
          type: 'exec',
          dependsOn: [],
          policy: { replaySafe: true },
          command: 'printf broken >&2; exit 9',
        },
      ],
    })

    const service = createMatOSWorkflowService()
    const first = await service.run({ cwd: root, ref: 'workflow:flaky-flow' })
    const second = await service.run({ cwd: root, ref: 'workflow:flaky-flow' })
    expect(first.run.status).toBe('failed')
    expect(second.run.status).toBe('failed')

    const {
      listMatOSStableImprovementCandidates,
      listMatOSWorkflowReplayCandidates,
      listMatOSWorkflowReplayClusters,
    } = await import('../learning/replayCandidates.js')

    // Both failed runs generated replay candidates linked from evidence.
    const candidates = await listMatOSWorkflowReplayCandidates(root)
    const productCandidates = candidates.filter(
      candidate => candidate.workflowRef === 'workflow:flaky-flow@0.1.0',
    )
    expect(productCandidates.length).toBe(2)

    // Same signature across two runs forms one cluster.
    const clusters = await listMatOSWorkflowReplayClusters(root)
    expect(clusters).toHaveLength(1)
    expect(clusters[0]?.occurrences).toBe(2)

    // Background auto-verification may replay this exec-only fixture because
    // the node explicitly opts into replaySafe. Reproduced clusters materialize
    // one promotion-gated record. Poll briefly because closure runs as
    // fire-and-forget background maintenance.
    const deadline = Date.now() + 15_000
    let improvements = await listMatOSStableImprovementCandidates(root)
    while (improvements.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
      improvements = await listMatOSStableImprovementCandidates(root)
    }
    expect(improvements).toHaveLength(1)
    expect(improvements[0]?.status).toBe('awaiting-promotion')
    expect(improvements[0]?.gates.promotion.status).toBe('blocked')

    const verified = (await listMatOSWorkflowReplayCandidates(root)).filter(
      candidate => candidate.verification?.status === 'reproduced',
    )
    expect(verified.length).toBeGreaterThan(0)

    // Replay verification runs must not generate replay candidates of their
    // own: only the two original product runs may appear as candidates.
    const finalCandidates = (await listMatOSWorkflowReplayCandidates(root)).filter(
      candidate => candidate.workflowRef === 'workflow:flaky-flow@0.1.0',
    )
    expect(finalCandidates.length).toBe(2)
  })

  test('repeated unsafe exec failures do not auto-verify through the service replay loop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-unsafe-replay-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'unsafe-flow')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'unsafe-flow',
      type: 'workflow',
      name: 'Unsafe Flow',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'unsafe-flow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'unsafe_shell',
          type: 'exec',
          dependsOn: [],
          command: 'printf unsafe-broken >&2; exit 9',
        },
      ],
    })

    const service = createMatOSWorkflowService()
    const first = await service.run({ cwd: root, ref: 'workflow:unsafe-flow' })
    const second = await service.run({ cwd: root, ref: 'workflow:unsafe-flow' })
    expect(first.run.status).toBe('failed')
    expect(second.run.status).toBe('failed')
    await awaitMatOSWorkflowReplayClosureIdle()

    const {
      listMatOSStableImprovementCandidates,
      listMatOSWorkflowReplayCandidates,
      listMatOSWorkflowReplayClusters,
    } = await import('../learning/replayCandidates.js')
    const candidates = (await listMatOSWorkflowReplayCandidates(root)).filter(
      candidate => candidate.workflowRef === 'workflow:unsafe-flow@0.1.0',
    )
    expect(candidates).toHaveLength(2)
    expect(candidates.some(
      candidate => candidate.verification?.status === 'skipped-unsafe',
    )).toBe(true)
    expect(await listMatOSWorkflowReplayClusters(root)).toHaveLength(1)
    expect(await listMatOSStableImprovementCandidates(root)).toHaveLength(0)
  })

  test('marks replay candidates skipped-unsafe when the service cannot reload the workflow definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-missing-definition-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'missing-definition-flow')
    const workflowPath = join(workflowDir, 'workflow.json')
    const startedMarkerPath = join(root, 'delayed-failure-started')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'missing-definition-flow',
      type: 'workflow',
      name: 'Missing Definition Flow',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(workflowPath, {
      schemaVersion: 1,
      name: 'missing-definition-flow',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        {
          id: 'delayed_failure',
          type: 'exec',
          dependsOn: [],
          replaySafe: true,
          command: `printf started > '${startedMarkerPath}'; sleep 0.2; printf missing-definition >&2; exit 7`,
        },
      ],
    })

    const service = createMatOSWorkflowService()
    const running = service.run({ cwd: root, ref: 'workflow:missing-definition-flow' })
    // Remove the definition only after the exec node is actually running, so the
    // initial service-side workflow load cannot race against the deletion.
    const waitStart = Date.now()
    while (!(await pathExists(startedMarkerPath))) {
      if (Date.now() - waitStart > 20000) {
        throw new Error('missing-definition-flow exec node did not start in time')
      }
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    await rm(workflowPath)

    const result = await running
    expect(result.run.status).toBe('failed')
    await awaitMatOSWorkflowReplayClosureIdle()

    const { listMatOSWorkflowReplayCandidates } = await import(
      '../learning/replayCandidates.js'
    )
    const candidates = (await listMatOSWorkflowReplayCandidates(root)).filter(
      candidate => candidate.workflowRef === 'workflow:missing-definition-flow@0.1.0',
    )
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.verification?.status).toBe('skipped-unsafe')
    expect(candidates[0]?.verification?.reason).toContain('definition is missing')
  })

  test('workflow service mutates drafts through native draft store operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-draft-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: { runtimeDataDir: join(root, 'runtime-state') },
    })

    const created = await matOSWorkflowService.createDraft({
      cwd: root,
      id: 'builder',
      name: 'Builder Draft',
    })
    await matOSWorkflowService.addDraftNode({
      cwd: root,
      draftId: 'builder',
      node: { id: 'prepare', type: 'exec', command: 'printf ok', dependsOn: [] },
    })
    await matOSWorkflowService.addDraftNode({
      cwd: root,
      draftId: 'builder',
      node: {
        id: 'check',
        type: 'guard',
        dependsOn: [],
        checks: [{ type: 'expression', value: 'true' }],
      },
    })
    const connected = await matOSWorkflowService.connectDraftNodes({
      cwd: root,
      draftId: 'builder',
      from: 'prepare',
      to: 'check',
    })
    const updated = await matOSWorkflowService.updateDraftNode({
      cwd: root,
      draftId: 'builder',
      nodeId: 'check',
      patch: { id: 'review', type: 'human', prompt: 'Review' },
    })
    const outputs = await matOSWorkflowService.setDraftOutputs({
      cwd: root,
      draftId: 'builder',
      outputs: { summary: { value: '{{ nodes.prepare.outputs.stdout }}' } },
    })
    const compiled = await matOSWorkflowService.compileDraft({
      cwd: root,
      draftId: 'builder',
    })
    const disconnected = await matOSWorkflowService.disconnectDraftNodes({
      cwd: root,
      draftId: 'builder',
      from: 'prepare',
      to: 'review',
    })
    const deleted = await matOSWorkflowService.deleteDraftNode({
      cwd: root,
      draftId: 'builder',
      nodeId: 'review',
    })
    const listed = await matOSWorkflowService.drafts({ cwd: root })

    expect(created.draft.draftId).toBe('builder')
    expect(connected.definition.nodes.find(node => node.id === 'check')?.dependsOn).toEqual([
      'prepare',
    ])
    expect(updated.definition.nodes.find(node => node.id === 'review')?.dependsOn).toEqual([
      'prepare',
    ])
    expect(outputs.definition.outputs.summary?.value).toBe(
      '{{ nodes.prepare.outputs.stdout }}',
    )
    expect(compiled).toMatchObject({
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
    expect(
      disconnected.definition.nodes.find(node => node.id === 'review')?.dependsOn,
    ).toEqual([])
    expect(deleted.definition.nodes.map(node => node.id)).toEqual(['prepare'])
    expect(listed.drafts.map(draft => draft.draftId)).toEqual(['builder'])
    expect(connected.validation.ok).toBe(true)
    expect(updated.validation.ok).toBe(true)
    expect(outputs.validation.ok).toBe(true)
    expect(disconnected.validation.ok).toBe(true)
    expect(deleted.validation.ok).toBe(true)
  }, 30000)

  test('workflow service owns draft show import publish fork and trigger operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-boundary-'))
    const componentDir = join(root, '.matos', 'assets', 'workflows', 'component-flow')
    await mkdir(componentDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: { runtimeDataDir: join(root, 'runtime-state') },
    })
    await writeJson(join(componentDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'component-flow',
      type: 'workflow',
      name: 'Component Flow',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'component' } },
    })
    await writeJson(join(componentDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'component-flow',
      parameters: { message: { type: 'string' } },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        componentText: { value: '{{ nodes.component_echo.outputs.stdout }}' },
      },
      nodes: [
        {
          id: 'component_echo',
          type: 'exec',
          dependsOn: [],
          command: 'printf component',
        },
      ],
    })

    const created = await matOSWorkflowService.createDraft({
      cwd: root,
      id: 'boundary-builder',
      name: 'Boundary Builder',
    })
    const imported = await matOSWorkflowService.importComponent({
      cwd: root,
      draftId: created.draft.draftId,
      ref: 'workflow:component-flow',
    })
    expect(imported.component).toMatchObject({
      canonicalKey: 'workflow:component-flow@0.1.0',
      kind: 'component',
    })
    expect(imported.definition.nodes.map(node => node.id)).toContain(
      'component_echo',
    )
    expect(imported.validation.ok).toBe(true)

    const shown = await matOSWorkflowService.showDraft({
      cwd: root,
      draftId: created.draft.draftId,
    })
    expect(shown.definition.nodes.map(node => node.id)).toContain(
      'component_echo',
    )
    expect(shown.provenance.map(entry => entry.type)).toContain(
      'draft.component.imported',
    )

    const published = await matOSWorkflowService.publishDraft({
      cwd: root,
      draftId: created.draft.draftId,
      id: 'boundary-published',
      name: 'Boundary Published',
      version: '0.2.0',
    })
    expect(published.published).toMatchObject({
      assetKey: 'workflow:boundary-published@0.2.0',
    })
    expect(published.draft.status).toBe('published')
    expect(
      JSON.parse(await readFile(published.published.manifestPath, 'utf8')),
    ).toMatchObject({
      id: 'boundary-published',
      type: 'workflow',
      runtime: { workflow: { kind: 'executable' } },
    })

    const forkedWorkflow = await matOSWorkflowService.forkWorkflow({
      cwd: root,
      ref: 'workflow:boundary-published',
      id: 'boundary-template-fork',
      name: 'Boundary Template Fork',
      version: '0.3.0',
      description: 'Derived from an existing workflow asset',
    })
    expect(forkedWorkflow.draft).toMatchObject({
      draftId: 'boundary-template-fork',
      sourceWorkflowRef: 'workflow:boundary-published@0.2.0',
    })
    expect(forkedWorkflow.source).toMatchObject({
      canonicalKey: 'workflow:boundary-published@0.2.0',
    })
    expect(forkedWorkflow.definition).toMatchObject({
      name: 'Boundary Template Fork',
      version: '0.3.0',
      description: 'Derived from an existing workflow asset',
    })
    expect(forkedWorkflow.definition.nodes.map(node => node.id)).toContain(
      'component_echo',
    )
    expect(forkedWorkflow.validation.ok).toBe(true)

    const run = await matOSWorkflowService.run({
      cwd: root,
      ref: 'workflow:boundary-published',
      provenance: { source: 'manual', reason: 'fork-source' },
    })
    const forked = await matOSWorkflowService.forkRun({
      cwd: root,
      runId: run.run.runId,
      id: 'boundary-fork',
      name: 'Boundary Fork',
    })
    expect(forked.draft).toMatchObject({
      draftId: 'boundary-fork',
      sourceRunId: run.run.runId,
      sourceWorkflowRef: 'workflow:boundary-published@0.2.0',
    })
    expect(forked.validation.ok).toBe(true)

    const savedTrigger = await matOSWorkflowService.saveTrigger({
      cwd: root,
      workflowRef: 'workflow:boundary-published@0.2.0',
      request: {
        trigger_id: 'trg-boundary',
        event_id: 'matos.manual.run',
        name: 'Boundary manual trigger',
        config: {},
        payload: { parameters: { message: 'go' } },
        status: 1,
      },
    })
    expect(savedTrigger).toMatchObject({
      applied: true,
      trigger: {
        triggerId: 'trg-boundary',
        workflowRef: 'workflow:boundary-published@0.2.0',
        appId: 'matos-manual',
        eventId: 'matos.manual.run',
      },
    })
    const triggerList = await matOSWorkflowService.triggers({ cwd: root })
    expect(triggerList.triggers.map(trigger => trigger.triggerId)).toContain(
      'trg-boundary',
    )
    const triggerDetail = await matOSWorkflowService.trigger({
      cwd: root,
      triggerId: 'trg-boundary',
    })
    expect(triggerDetail.trigger?.workflowRef).toBe(
      'workflow:boundary-published@0.2.0',
    )
    const triggerEvents = matOSWorkflowService.triggerEvents({ cwd: root })
    expect(triggerEvents.triggerApps.map(app => app.appId)).toContain(
      'matos-schedule',
    )
    const deletedTrigger = await matOSWorkflowService.deleteTrigger({
      cwd: root,
      triggerId: 'trg-boundary',
    })
    expect(deletedTrigger.applied).toBe(true)
    expect((await matOSWorkflowService.triggers({ cwd: root })).total).toBe(0)
  }, 30000)

  test('publishes scoped workflow drafts through user Gitea accepted assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-gitea-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-workflow-service-gitea-repo-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice workflow assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await commitAll(repo, 'seed alice workflow assets')
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo,
          ref: 'main',
          runtimeRef: {
            mode: 'accepted-ref',
            ref: 'accepted/alice-assets/stable',
            commit: seedCommit,
          },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
      includeDefaultAssetRoots: false,
      execution: { runtimeDataDir: join(root, 'runtime-state') },
    })

    const created = await matOSWorkflowService.createDraft({
      cwd: root,
      scopeRef: 'user:alice',
      id: 'scoped-builder',
      name: 'Scoped Builder',
    })
    const replaced = await matOSWorkflowService.replaceDraftDefinition({
      cwd: root,
      scopeRef: 'user:alice',
      draftId: created.draft.draftId,
      definition: {
        schemaVersion: 1,
        name: 'scoped-published',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          text: { value: '{{ nodes.echo.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'echo',
            type: 'exec',
            dependsOn: [],
            command: 'printf scoped-ok',
          },
        ],
      },
    })
    expect(replaced.validation.ok).toBe(true)

    const published = await matOSWorkflowService.publishDraft({
      cwd: root,
      scopeRef: 'user:alice',
      env: { MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1' },
      draftId: created.draft.draftId,
      id: 'scoped-published',
      name: 'Scoped Published',
      version: '0.1.0',
    })

    expect(published.published.assetKey).toBe('workflow:scoped-published@0.1.0')
    expect(published.scopedGiteaSync).toMatchObject({
      ok: true,
      action: 'synced',
      scope: 'user',
      scopeRef: 'user:alice',
      localAssetRemoved: true,
    })
    expect(published.scopedGiteaSync?.activationRequired).toBeUndefined()
    expect(published.scopedGiteaSync?.nextAction).toBeUndefined()
    expect(await pathExists(published.scopedGiteaSync?.generatedDir ?? '')).toBe(false)
    expect(await pathExists(published.published.assetDir)).toBe(false)

    const acceptedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(acceptedCommit).not.toBe(seedCommit)
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:workflow/scoped-published/workflow.json',
      ]),
    ).toContain('scoped-ok')

    const benchmarkScopedCreated = await matOSWorkflowService.createDraft({
      cwd: root,
      scopeRef: 'user:alice',
      id: 'benchmark-scoped-builder',
      name: 'Benchmark Scoped Builder',
    })
    const benchmarkScopedReplaced = await matOSWorkflowService.replaceDraftDefinition({
      cwd: root,
      scopeRef: 'user:alice',
      draftId: benchmarkScopedCreated.draft.draftId,
      definition: {
        schemaVersion: 1,
        name: 'benchmark-scoped-published',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          text: { value: '{{ nodes.echo.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'echo',
            type: 'exec',
            dependsOn: [],
            command: 'printf benchmark-scoped-ok',
          },
        ],
      },
    })
    expect(benchmarkScopedReplaced.validation.ok).toBe(true)

    const benchmarkScopedPublished = await matOSWorkflowService.publishDraft({
      cwd: root,
      scopeRef: 'user:alice',
      env: {
        MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1',
        MATOS_WORKFLOW_SCOPED_GITEA_SYNC: '0',
      },
      draftId: benchmarkScopedCreated.draft.draftId,
      id: 'benchmark-scoped-published',
      name: 'Benchmark Scoped Published',
      version: '0.1.0',
    })
    expect(benchmarkScopedPublished.scopedGiteaSync).toBeUndefined()
    const benchmarkScopedManifest = JSON.parse(
      await readFile(benchmarkScopedPublished.published.manifestPath, 'utf8'),
    )
    expect(benchmarkScopedManifest).toMatchObject({
      id: 'benchmark-scoped-published',
    })
    expect(benchmarkScopedManifest.lifecycle?.status).not.toBe('disabled')

    const config = await readMatOSProjectConfig(root)
    expect(config.assetSources?.[0]).toMatchObject({
      type: 'git',
      id: 'alice-assets',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: acceptedCommit,
      },
    })

    const assets = await loadMatOSAssets(root)
    expect((await validateMatOSAssets(assets)).ok).toBe(true)
    const runtimeRegistry = buildMatOSAssetRegistry(assets)
    expect(runtimeRegistry.resolve('workflow:scoped-published')?.canonicalKey).toBe(
      'workflow:scoped-published@0.1.0',
    )
    const lookupRegistry = buildMatOSAssetRegistry(assets, {
      includeDisabled: true,
    })
    const workflow = lookupRegistry.resolve('workflow:scoped-published')
    expect(workflow?.canonicalKey).toBe('workflow:scoped-published@0.1.0')
    expect(workflow?.lifecycle.status).toBe('enabled')
    expect(workflow?.metadata.sourceProvenance).toMatchObject({
      scope: 'user',
      scopeRef: 'user:alice',
    })

    const autoScopedCreated = await matOSWorkflowService.createDraft({
      cwd: root,
      id: 'auto-scoped-builder',
      name: 'Auto Scoped Builder',
    })
    const autoScopedReplaced = await matOSWorkflowService.replaceDraftDefinition({
      cwd: root,
      draftId: autoScopedCreated.draft.draftId,
      definition: {
        schemaVersion: 1,
        name: 'auto-scoped-published',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          text: { value: '{{ nodes.echo.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'echo',
            type: 'exec',
            dependsOn: [],
            command: 'printf auto-scoped-ok',
          },
        ],
      },
    })
    expect(autoScopedReplaced.validation.ok).toBe(true)

    const autoScopedPublished = await matOSWorkflowService.publishDraft({
      cwd: root,
      env: { MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1' },
      draftId: autoScopedCreated.draft.draftId,
      id: 'auto-scoped-published',
      name: 'Auto Scoped Published',
      version: '0.1.0',
    })
    expect(autoScopedPublished.scopedGiteaSync).toMatchObject({
      ok: true,
      action: 'synced',
      scope: 'user',
      scopeRef: 'user:alice',
    })
    const autoAcceptedCommit = await git(repo, [
      'rev-parse',
      'accepted/alice-assets/stable',
    ])
    expect(autoAcceptedCommit).not.toBe(acceptedCommit)
    expect(
      await git(repo, [
        'show',
        'accepted/alice-assets/stable:workflow/auto-scoped-published/workflow.json',
      ]),
    ).toContain('auto-scoped-ok')

    const project = join(root, 'projects', 'scoped-workflow')
    await mkdir(join(project, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(project), {
      version: 1, assetRoots: ['assets'], assetSources: [], includeDefaultAssetRoots: false,
    })
    const context = {
      cwd: project,
      scopeRef: 'user:alice',
      env: { MATOS_ASSETS_CWD: root, MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1' },
    }
    const projectDraft = await matOSWorkflowService.createDraft({ ...context, id: 'project-scoped-builder' })
    await matOSWorkflowService.replaceDraftDefinition({
      ...context,
      draftId: projectDraft.draft.draftId,
      definition: {
        schemaVersion: 1, name: 'project-scoped-published', parameters: {}, outputs: {},
        policy: { approvalMode: 'bypass' },
        nodes: [{ id: 'echo', type: 'exec', command: 'printf project-scoped-ok', dependsOn: [] }],
      },
    })
    const projectPublished = await matOSWorkflowService.publishDraft({
      ...context, draftId: projectDraft.draft.draftId, id: 'project-scoped-published', version: '0.1.0',
    })
    expect(projectPublished.scopedGiteaSync).toMatchObject({ ok: true, action: 'synced', scopeRef: 'user:alice' })
    expect(projectPublished.scopedGiteaSync?.generatedDir?.startsWith(join(root, '.matos'))).toBe(true)
    expect(JSON.parse(await readFile(getMatOSConfigPath(project), 'utf8')).assetSources).toEqual([])
    const shown = await matOSWorkflowService.show({ ...context, ref: 'workflow:project-scoped-published@0.1.0' })
    expect(shown.validation.ok).toBe(true)
    expect((await matOSWorkflowService.list(context)).workflows.some(asset => asset.id === 'project-scoped-published')).toBe(true)
    const executed = await matOSWorkflowService.run({ ...context, ref: 'workflow:project-scoped-published@0.1.0', recordSession: false })
    expect(executed.run.status).toBe('completed')
    expect(await git(repo, ['show', 'accepted/alice-assets/stable:workflow/project-scoped-published/workflow.json'])).toContain('project-scoped-ok')

    const acceptedBeforeRejection = await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])
    const wrongScope = { ...context, scopeRef: 'user:bob' }
    const rejectedDraft = await matOSWorkflowService.createDraft({ ...wrongScope, id: 'wrong-scope-builder' })
    await matOSWorkflowService.replaceDraftDefinition({
      ...wrongScope, draftId: rejectedDraft.draft.draftId,
      definition: await readWorkflowDraftDefinition(projectDraft.draft.draftDir),
    })
    await expect(matOSWorkflowService.publishDraft({
      ...wrongScope, draftId: rejectedDraft.draft.draftId, id: 'wrong-scope-published',
    })).rejects.toThrow('No matching Gitea asset source for user:bob')
    expect(await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])).toBe(acceptedBeforeRejection)

    const workspaceConfig = await readFile(getMatOSConfigPath(root), 'utf8')
    await writeFile(getMatOSConfigPath(root), '{')
    try {
      await expect(matOSWorkflowService.publishDraft({
        ...context, draftId: projectDraft.draft.draftId, id: 'broken-source-published',
      })).rejects.toThrow()
      expect(await pathExists(join(project, '.matos/assets/workflows/broken-source-published'))).toBe(false)
    } finally {
      await writeFile(getMatOSConfigPath(root), workspaceConfig)
    }
  }, 120_000)

  test('cleans generated scoped workflow copy when Gitea sync fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-gitea-fail-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      assetSources: [],
      includeDefaultAssetRoots: false,
      execution: { runtimeDataDir: join(root, 'runtime-state') },
    })

    const created = await matOSWorkflowService.createDraft({
      cwd: root,
      scopeRef: 'user:alice',
      id: 'scoped-sync-failure',
      name: 'Scoped Sync Failure',
    })
    const replaced = await matOSWorkflowService.replaceDraftDefinition({
      cwd: root,
      scopeRef: 'user:alice',
      draftId: created.draft.draftId,
      definition: {
        schemaVersion: 1,
        name: 'scoped-sync-failure',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          text: { value: '{{ nodes.echo.outputs.stdout }}' },
        },
        nodes: [
          {
            id: 'echo',
            type: 'exec',
            dependsOn: [],
            command: 'printf scoped-sync-failure-ok',
          },
        ],
      },
    })
    expect(replaced.validation.ok).toBe(true)

    const publication = matOSWorkflowService.publishDraft({
      cwd: root,
      scopeRef: 'user:alice',
      draftId: created.draft.draftId,
      id: 'scoped-sync-failure',
      name: 'Scoped Sync Failure',
      version: '0.1.0',
    })

    await expect(publication).rejects.toThrow(/Workflow publication failed: .*No matching Gitea asset source/)
    expect(await pathExists(join(root, '.matos/assets/generated/scopes/users/alice/workflow/scoped-sync-failure'))).toBe(false)
    expect(
      JSON.parse(await readFile(join(root, '.matos/assets/workflows/scoped-sync-failure/asset.json'), 'utf8')),
    ).toMatchObject({
      lifecycle: {
        status: 'disabled',
        origin: 'workflow-scoped-gitea-sync',
      },
    })

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    expect(registry.resolve('workflow:scoped-sync-failure')).toBeUndefined()

    const validation = await validateMatOSAssets(assets)
    expect(validation.ok).toBe(true)
    expect(validation.errors.map(error => error.code)).not.toContain(
      'duplicate_asset',
    )
  }, 30000)

  test('workflow service rejects unsafe draft ids and invalid draft mutations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-service-invalid-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: { runtimeDataDir: join(root, 'runtime-state') },
    })

    const created = await matOSWorkflowService.createDraft({
      cwd: root,
      id: 'invalid-builder',
      name: 'Invalid Builder',
    })
    await matOSWorkflowService.addDraftNode({
      cwd: root,
      draftId: 'invalid-builder',
      node: { id: 'prepare', type: 'exec', command: 'printf ok', dependsOn: [] },
    })

    await expect(
      matOSWorkflowService.addDraftNode({
        cwd: root,
        draftId: '../escape',
        node: { id: 'bad', type: 'exec', command: 'printf bad', dependsOn: [] },
      }),
    ).rejects.toThrow('Workflow draft id must be a simple id')

    await expect(
      matOSWorkflowService.addDraftNode({
        cwd: root,
        draftId: 'invalid-builder',
        node: { id: 'bad', type: 'not-a-real-type', dependsOn: [] } as never,
      }),
    ).rejects.toThrow('Invalid workflow draft mutation')
    expect((await readWorkflowDraftDefinition(created.draft.draftDir)).nodes).toEqual([
      expect.objectContaining({ id: 'prepare', type: 'exec' }),
    ])

    await expect(
      matOSWorkflowService.updateDraftNode({
        cwd: root,
        draftId: 'invalid-builder',
        nodeId: 'prepare',
        patch: { type: 'not-a-real-type' } as never,
      }),
    ).rejects.toThrow('Invalid workflow draft mutation')
    expect((await readWorkflowDraftDefinition(created.draft.draftDir)).nodes).toEqual([
      expect.objectContaining({ id: 'prepare', type: 'exec' }),
    ])
  })
})
