import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { runMatOSBenchmarkCase } from './benchmarkRunner.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('MatOS benchmark runner', () => {
  test('runs a deterministic local command benchmark', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-benchmark-runner-'))
    const casePath = join(root, 'case.json')
    await writeFile(
      casePath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'echo-policy',
          kind: 'command',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("project cluster queue")'],
          expect: {
            stdoutContains: 'project cluster queue',
            exitCode: 0,
          },
        },
        null,
        2,
      ),
    )

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:echo-policy@0.1.0',
      casePath,
    })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.evidence.stdoutPreview).toContain('project cluster queue')

    const saved = JSON.parse(await readFile(result.resultPath, 'utf8')) as {
      benchmarkRef: string
      ok: boolean
    }
    expect(saved.benchmarkRef).toBe('benchmark:echo-policy@0.1.0')
    expect(saved.ok).toBe(true)
  })

  test('command timeout kills the whole process tree with SIGKILL escalation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-benchmark-treekill-'))
    process.env.MATOS_BENCHMARK_KILL_GRACE_MS = '200'
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 1,
      id: 'tree-kill',
      kind: 'command',
      command: 'sh',
      args: [
        '-c',
        // The background sleep keeps the default TERM disposition (started
        // before the trap), so the group SIGTERM must reach it; the leader
        // ignores TERM, so only the escalation group SIGKILL can reap it.
        'sleep 30 & echo $! > child-pid.txt; trap "" TERM; echo $$ > leader-pid.txt; while :; do sleep 1; done',
      ],
      expect: { exitCode: 0 },
    })

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:tree-kill@0.1.0',
      casePath,
      timeoutMs: 500,
    })

    expect(result.ok).toBe(false)
    expect(result.status).toBe('failed')
    expect(result.exitCode).toBe(124)
    expect(result.evidence.message).toContain('timed out')

    const readPid = async (name: string): Promise<number> =>
      Number((await readFile(join(root, name), 'utf8')).trim())
    const leaderPid = await readPid('leader-pid.txt')
    const childPid = await readPid('child-pid.txt')
    expect(Number.isInteger(leaderPid) && leaderPid > 0).toBe(true)
    expect(Number.isInteger(childPid) && childPid > 0).toBe(true)
    const dead = (pid: number): boolean => {
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    }
    // Group SIGTERM reaches the subtree immediately; the TERM-ignoring leader
    // falls to the SIGKILL escalation after the (shortened) grace.
    const deadline = Date.now() + 5000
    while ((!dead(leaderPid) || !dead(childPid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(dead(childPid)).toBe(true)
    expect(dead(leaderPid)).toBe(true)
  }, 20_000)

  test('blocks V2 matos-run benchmarks when real execution is not explicitly enabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-benchmark-runner-'))
    const casePath = join(root, 'case.json')
    await writeFile(
      casePath,
      JSON.stringify(
        {
          schemaVersion: 2,
          id: 'matos-run-blocked',
          kind: 'matos-run',
          task: {
            role: 'compute',
            prompt: 'Return benchmark-ok.',
            maxTurns: 1,
          },
          checks: [{ type: 'stdout-contains', value: 'benchmark-ok' }],
          costRisk: 'cheap',
          approvalPolicy: 'bypass-safe',
        },
        null,
        2,
      ),
    )

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:matos-run-blocked@0.1.0',
      casePath,
    })

    expect(result.status).toBe('blocked')
    expect(result.evidence.message).toContain('MATOS_RUN_REAL_BENCHMARKS')
  })

  test('runs matos-workflow benchmark cases through the real workflow service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-benchmark-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'benchmark-smoke')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'benchmark-smoke',
      type: 'workflow',
      name: 'Benchmark Smoke',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'benchmark-smoke',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [{ id: 'say_ok', type: 'exec', dependsOn: [], command: 'printf ok' }],
      outputs: { ok: { value: '{{ nodes.say_ok.outputs.stdout }}' } },
    })
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 1,
      id: 'workflow-benchmark-smoke',
      kind: 'matos-workflow',
      workflowRef: 'workflow:benchmark-smoke@0.1.0',
      expect: { status: 'completed', outputs: { ok: 'ok' } },
    })

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:workflow-benchmark-smoke@0.1.0',
      casePath,
    })

    expect(result.status).toBe('succeeded')
    expect(result.ok).toBe(true)
    expect(result.evidence.stdoutPreview).toContain('"status":"completed"')
  })

  test('runs V2 workflow-run benchmarks through the real workflow service', async () => {
    process.env.MATOS_RUN_REAL_BENCHMARKS = '1'
    const root = await mkdtemp(join(tmpdir(), 'matos-v2-workflow-benchmark-'))
    const workflowDir = join(root, '.matos', 'assets', 'workflows', 'v2-smoke')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'v2-smoke',
      type: 'workflow',
      name: 'V2 Smoke',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'v2-smoke',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [{ id: 'say_ok', type: 'exec', dependsOn: [], command: 'printf v2-ok' }],
      outputs: { ok: { value: '{{ nodes.say_ok.outputs.stdout }}' } },
    })
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'workflow-run-v2',
      kind: 'workflow-run',
      task: {
        workflowRef: 'workflow:v2-smoke@0.1.0',
      },
      checks: [
        { type: 'stdout-contains', value: '"status":"completed"' },
        { type: 'artifact-json-path', path: '$.outputs.ok', equals: 'v2-ok' },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'free',
      approvalPolicy: 'bypass-safe',
    })

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:workflow-run-v2@0.1.0',
      casePath,
    })

    expect(result.status).toBe('succeeded')
    expect(result.ok).toBe(true)
    expect(result.evidence.stdoutPreview).toContain('"outputs":{"ok":"v2-ok"}')
  })

  test('runs V2 tool-call benchmarks through native MatOS tool assets', async () => {
    process.env.MATOS_RUN_REAL_BENCHMARKS = '1'
    const root = await mkdtemp(join(tmpdir(), 'matos-v2-tool-benchmark-'))
    const toolDir = join(root, '.matos', 'assets', 'tools', 'native-echo')
    await mkdir(toolDir, { recursive: true })
    await writeJson(getMatOSConfigPath(root), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
    })
    await writeJson(join(toolDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'native-echo',
      type: 'tool',
      name: 'Native Echo',
      version: '0.1.0',
      entry: 'tool.py',
      metadata: {
        executor: {
          runtime: 'python3',
          entry: 'tool.py',
          timeoutMs: 5000,
        },
      },
    })
    await writeFile(
      join(toolDir, 'tool.py'),
      [
        'import json',
        'import sys',
        'payload = json.load(sys.stdin).get("input", {})',
        'print(json.dumps({"ok": True, "message": payload.get("message")}))',
      ].join('\n'),
      'utf8',
    )
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'tool-call-v2',
      kind: 'tool-call',
      task: {
        toolRef: 'tool:native-echo@0.1.0',
        input: { message: 'tool-v2-ok' },
      },
      checks: [
        { type: 'tool-call', toolRef: 'tool:native-echo@0.1.0', required: true },
        { type: 'stdout-contains', value: 'tool-v2-ok' },
        { type: 'artifact-json-path', path: '$.ok', equals: true },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'free',
      approvalPolicy: 'bypass-safe',
    })

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:tool-call-v2@0.1.0',
      casePath,
    })

    expect(result.status).toBe('succeeded')
    expect(result.ok).toBe(true)
    expect(result.evidence.stdoutPreview).toContain('tool-v2-ok')
  })

  test('runs V2 artifact-check benchmarks against real local files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-v2-artifact-benchmark-'))
    await writeJson(join(root, 'artifact.json'), {
      ok: true,
      nested: { value: 'artifact-v2-ok' },
    })
    const casePath = join(root, 'case.json')
    await writeJson(casePath, {
      schemaVersion: 2,
      id: 'artifact-check-v2',
      kind: 'artifact-check',
      task: {
        input: { path: 'artifact.json' },
      },
      checks: [
        { type: 'artifact-json-path', path: '$.ok', equals: true },
        {
          type: 'artifact-json-path',
          path: '$.nested.value',
          equals: 'artifact-v2-ok',
        },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'free',
      approvalPolicy: 'bypass-safe',
    })

    const result = await runMatOSBenchmarkCase({
      cwd: root,
      benchmarkRef: 'benchmark:artifact-check-v2@0.1.0',
      casePath,
    })

    expect(result.status).toBe('succeeded')
    expect(result.ok).toBe(true)
    expect(result.evidence.stdoutPreview).toContain('artifact-v2-ok')
  })
})
