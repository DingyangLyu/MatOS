import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  execNodeTimeoutMs,
  runWorkflowExecNode,
} from './nodeAdapters/execNode.js'
import {
  isMatOSWorkflowCliArgv,
  terminateWorkflowRunLocalProcesses,
} from './localProcessLifecycle.js'
import { withWorkflowRunLock } from './runLock.js'
import { requestWorkflowRunControl } from './workflowControl.js'
import {
  requestWorkflowRunCancel,
  respondToWorkflowNode,
  startWorkflowRun,
} from './workflowRuntime.js'
import type { MatOSWorkflowNode } from './types.js'

describe('MatOS workflow exec node', () => {
  function processStat(pid: number): string | undefined {
    try {
      return execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim()
    } catch {
      return undefined
    }
  }

  // Bun.spawn returns before the child completes execve, so for a short
  // window /proc/<pid>/environ still shows the parent's (marker-less)
  // environment. Production scans run long after spawn, but these tests scan
  // within milliseconds, so wait until the markers are actually visible.
  async function waitForEnvironMarker(pid: number, marker: string): Promise<void> {
    if (process.platform !== 'linux') {
      return
    }
    for (let i = 0; i < 200; i += 1) {
      try {
        const environ = await readFile(`/proc/${pid}/environ`, 'utf8')
        if (environ.split('\0').includes(marker)) {
          return
        }
      } catch {
        // Not yet spawned far enough or already gone; keep polling briefly.
      }
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(`process ${pid} never exposed environ marker ${marker}`)
  }

  test('passes args to direct exec commands without dropping them', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-args-'))
    const node: MatOSWorkflowNode = {
      id: 'python-args',
      type: 'exec',
      dependsOn: [],
      command: 'python3',
      args: [
        '-c',
        'import json, sys; print(json.dumps(sys.argv[1:]))',
        'alpha',
        'two words',
      ],
    }

    const result = await runWorkflowExecNode(node, { workspaceDir })

    expect(result.output).toMatchObject({ exitCode: 0 })
    expect(JSON.parse(String(result.output.stdout))).toEqual([
      'alpha',
      'two words',
    ])
  })

  test('uses bash for inline scripts that require bash shell semantics', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-bash-'))
    const node: MatOSWorkflowNode = {
      id: 'bash-script',
      type: 'exec',
      dependsOn: [],
      command: [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf "bash:%s\\n" "${BASH_VERSION%%.*}"',
      ].join('\n'),
    }

    const result = await runWorkflowExecNode(node, { workspaceDir })

    expect(result.output).toMatchObject({ exitCode: 0 })
    expect(String(result.output.stdout)).toStartWith('bash:')
  })

  test('exposes the loaded workflow source path to packaged exec helpers', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-source-'))
    const workflowSourcePath = join(workspaceDir, 'workflow-pack', 'workflow.yaml')
    const node: MatOSWorkflowNode = {
      id: 'workflow-source',
      type: 'exec',
      dependsOn: [],
      command:
        'printf "%s\\n%s\\n" "$MATOS_WORKFLOW_SOURCE_PATH" "$MATOS_WORKFLOW_SOURCE_DIR"',
    }

    const result = await runWorkflowExecNode(node, {
      workspaceDir,
      workflowSourcePath,
    })

    expect(String(result.output.stdout).trim().split('\n')).toEqual([
      workflowSourcePath,
      join(workspaceDir, 'workflow-pack'),
    ])
  })

  test('expands known MatOS runtime variables in cwd before spawning', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cwd-env-'))
    const artifactDir = join(workspaceDir, 'artifacts')
    await mkdir(artifactDir)
    const node: MatOSWorkflowNode = {
      id: 'cwd-runtime-variable',
      type: 'exec',
      dependsOn: [],
      command: 'pwd',
      cwd: '$MATOS_WORKSPACE_DIR/artifacts',
    }

    const result = await runWorkflowExecNode(node, { workspaceDir })

    expect(String(result.output.stdout).trim()).toBe(await realpath(artifactDir))
  })

  test('expands braced MatOS runtime variables in cwd before spawning', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cwd-braced-'))
    const artifactRoot = join(workspaceDir, 'workflow-artifacts')
    const nodeDir = join(artifactRoot, 'node-output')
    await mkdir(nodeDir, { recursive: true })
    const node: MatOSWorkflowNode = {
      id: 'cwd-braced-runtime-variable',
      type: 'exec',
      dependsOn: [],
      command: 'pwd',
      cwd: '${MATOS_WORKFLOW_ARTIFACT_ROOT}/node-output',
    }

    const result = await runWorkflowExecNode(node, {
      workspaceDir,
      artifactRoot,
    })

    expect(String(result.output.stdout).trim()).toBe(await realpath(nodeDir))
  })

  test('returns structured repair feedback when cwd does not exist', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cwd-missing-'))
    const node: MatOSWorkflowNode = {
      id: 'missing-cwd',
      type: 'exec',
      dependsOn: [],
      command: 'true',
      cwd: '$MATOS_WORKSPACE_DIR/not-created',
    }

    await expect(runWorkflowExecNode(node, { workspaceDir })).rejects.toMatchObject({
      code: 'workflow_exec_start_failed',
      details: {
        category: 'process_start',
        causeCode: 'ENOENT',
        cwd: join(workspaceDir, 'not-created'),
        cwdExists: false,
        action: 'repair_workflow_path',
      },
    })
  })

  test('returns structured repair feedback when cwd is a file', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cwd-file-'))
    const cwd = join(workspaceDir, 'not-a-directory')
    await writeFile(cwd, 'file\n', 'utf8')
    const node: MatOSWorkflowNode = {
      id: 'file-cwd',
      type: 'exec',
      dependsOn: [],
      command: 'true',
      cwd,
    }

    await expect(runWorkflowExecNode(node, { workspaceDir })).rejects.toMatchObject({
      code: 'workflow_exec_start_failed',
      details: {
        category: 'process_start',
        causeCode: 'ENOTDIR',
        cwd,
        cwdExists: true,
        cwdIsDirectory: false,
        action: 'repair_workflow_path',
      },
    })
  })

  test('returns structured repair feedback for a nonzero process exit', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-nonzero-'))
    const node: MatOSWorkflowNode = {
      id: 'nonzero',
      type: 'exec',
      dependsOn: [],
      command: 'printf "first error\\n" >&2; exit 7',
    }

    await expect(runWorkflowExecNode(node, { workspaceDir })).rejects.toMatchObject({
      code: 'workflow_exec_nonzero_exit',
      exitCode: 7,
      stderr: 'first error\n',
      details: {
        category: 'nonzero_exit',
        action: 'inspect_logs_and_repair',
        repairable: true,
      },
    })
  })

  test('returns structured feedback when the process is terminated by a signal', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-signal-'))
    const node: MatOSWorkflowNode = {
      id: 'signaled-command',
      type: 'exec',
      dependsOn: [],
      command: 'kill -TERM $$',
    }

    await expect(runWorkflowExecNode(node, { workspaceDir })).rejects.toMatchObject({
      code: 'workflow_exec_signaled',
      details: {
        category: 'signal',
        signal: 'SIGTERM',
        action: 'inspect_signal_before_retry',
      },
    })
  })

  test('terminates long-running local exec commands with a bounded timeout', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-timeout-'))
    const node: MatOSWorkflowNode = {
      id: 'slow',
      type: 'exec',
      dependsOn: [],
      command: 'sleep 2',
      timeoutSeconds: 0.01,
    }

    await expect(
      runWorkflowExecNode(node, { workspaceDir }),
    ).rejects.toMatchObject({
      code: 'workflow_exec_timeout',
      exitCode: 124,
      timedOut: true,
      details: {
        category: 'timeout',
        action: 'inspect_timeout_before_retry',
      },
    })
  })

  test('terminates background children when a shell command times out', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-tree-timeout-'))
    const node: MatOSWorkflowNode = {
      id: 'slow-tree',
      type: 'exec',
      dependsOn: [],
      command: 'sleep 10 & echo $! > child.pid; wait',
      timeoutSeconds: 0.01,
    }

    await expect(
      runWorkflowExecNode(node, { workspaceDir }),
    ).rejects.toMatchObject({
      exitCode: 124,
      timedOut: true,
    })

    const pid = Number((await readFile(join(workspaceDir, 'child.pid'), 'utf8')).trim())
    let stat: string | undefined
    for (let i = 0; i < 20; i += 1) {
      stat = processStat(pid)
      if (!stat || stat.startsWith('Z')) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(!stat || stat.startsWith('Z')).toBe(true)
  })

  test('terminates run-owned children that escape into another session', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-escaped-'))
    const runDir = join(workspaceDir, 'run-owned-processes')
    await mkdir(runDir)
    const pidPath = join(workspaceDir, 'escaped.pid')
    const node: MatOSWorkflowNode = {
      id: 'escaped-session',
      type: 'exec',
      dependsOn: [],
      command: `setsid sleep 30 >/dev/null 2>&1 & printf "%s" "$!" > "${pidPath}"; exit 7`,
    }

    await expect(
      runWorkflowExecNode(node, { workspaceDir, runDir }),
    ).rejects.toMatchObject({ exitCode: 7 })

    const pid = Number((await readFile(pidPath, 'utf8')).trim())
    let stat: string | undefined
    for (let i = 0; i < 20; i += 1) {
      stat = processStat(pid)
      if (!stat || stat.startsWith('Z')) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(!stat || stat.startsWith('Z')).toBe(true)
  })

  test('rechecks run ownership before terminating local processes', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-owned-'))
    const runDir = join(workspaceDir, 'owned-run')
    const otherRunDir = join(workspaceDir, 'other-run')
    const targetNodeId = 'target-node'
    const owned = Bun.spawn(['sleep', '30'], {
      env: {
        ...process.env,
        MATOS_WORKFLOW_RUN_DIR: runDir,
        MATOS_WORKFLOW_EXEC_PROCESS: '1',
        MATOS_WORKFLOW_EXEC_NODE_ID: targetNodeId,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const sibling = Bun.spawn(['sleep', '30'], {
      env: {
        ...process.env,
        MATOS_WORKFLOW_RUN_DIR: runDir,
        MATOS_WORKFLOW_EXEC_PROCESS: '1',
        MATOS_WORKFLOW_EXEC_NODE_ID: 'sibling-node',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    const other = Bun.spawn(['sleep', '30'], {
      env: {
        ...process.env,
        MATOS_WORKFLOW_RUN_DIR: otherRunDir,
        MATOS_WORKFLOW_EXEC_PROCESS: '1',
        MATOS_WORKFLOW_EXEC_NODE_ID: targetNodeId,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      await waitForEnvironMarker(owned.pid, `MATOS_WORKFLOW_RUN_DIR=${runDir}`)
      await waitForEnvironMarker(
        sibling.pid,
        `MATOS_WORKFLOW_RUN_DIR=${runDir}`,
      )
      await waitForEnvironMarker(
        other.pid,
        `MATOS_WORKFLOW_RUN_DIR=${otherRunDir}`,
      )
      const summary = await terminateWorkflowRunLocalProcesses(runDir, {
        nodeId: targetNodeId,
        termGraceMs: 100,
        pollMs: 10,
      })
      expect(summary.supported).toBe(process.platform === 'linux')
      if (process.platform === 'linux') {
        expect(summary.matchedPids).toContain(owned.pid)
        expect(summary.matchedPids).not.toContain(sibling.pid)
        expect(summary.matchedPids).not.toContain(other.pid)
        await owned.exited
        expect(processStat(owned.pid)).toBeUndefined()
        expect(processStat(sibling.pid)).toBeDefined()
        expect(processStat(other.pid)).toBeDefined()
      }
    } finally {
      owned.kill()
      sibling.kill()
      other.kill()
      await Promise.all([owned.exited, sibling.exited, other.exited])
    }
  })

  test(
    'settles a timed-out node and reaps escaped descendants even when they hold the stdio pipes open',
    async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-pipe-holder-'))
      const runDir = join(workspaceDir, 'pipe-holder-run')
      await mkdir(runDir)
      const pidPath = join(workspaceDir, 'holder.pid')
      // The setsid descendant leaves the exec process group but inherits the
      // node's stdout/stderr pipes, so the child's 'close' event can never
      // fire while it lives. Regression: the node promise used to hang and
      // the escaped process was never reaped.
      const node: MatOSWorkflowNode = {
        id: 'pipe-holder-timeout',
        type: 'exec',
        dependsOn: [],
        command: `setsid sleep 30 & printf "%s" "$!" > "${pidPath}"; sleep 30`,
        timeoutSeconds: 1,
      }

      const startedAt = Date.now()
      await expect(
        runWorkflowExecNode(node, { workspaceDir, runDir }),
      ).rejects.toMatchObject({
        code: 'workflow_exec_timeout',
        exitCode: 124,
        timedOut: true,
      })
      // Must settle via 'exit' plus the bounded close wait, far below the 30s
      // the pipe-holding descendant would otherwise impose.
      expect(Date.now() - startedAt).toBeLessThan(15_000)

      const pid = Number((await readFile(pidPath, 'utf8')).trim())
      let stat: string | undefined
      for (let i = 0; i < 20; i += 1) {
        stat = processStat(pid)
        if (!stat || stat.startsWith('Z')) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(!stat || stat.startsWith('Z')).toBe(true)
    },
    30_000,
  )

  test(
    'escalates a timed-out SIGTERM-ignoring process tree to SIGKILL',
    async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-sigkill-'))
      const pidPath = join(workspaceDir, 'stubborn.pid')
      // The shell ignores SIGTERM, so only the escalation timer can end it.
      // Regression: the SIGKILL timer was unref'd and could silently never
      // fire, leaving the tree alive and the node pending.
      const node: MatOSWorkflowNode = {
        id: 'sigterm-ignoring-tree',
        type: 'exec',
        dependsOn: [],
        command: `echo $$ > "${pidPath}"; trap "" TERM; while :; do sleep 1; done`,
        timeoutSeconds: 1,
      }

      const startedAt = Date.now()
      await expect(
        runWorkflowExecNode(node, { workspaceDir }),
      ).rejects.toMatchObject({
        code: 'workflow_exec_timeout',
        exitCode: 124,
        timedOut: true,
      })
      // Settlement must come from the SIGKILL escalation window (timeout at
      // ~1s plus the 5s escalation), not from SIGTERM.
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(5_500)

      const pid = Number((await readFile(pidPath, 'utf8')).trim())
      let stat: string | undefined
      for (let i = 0; i < 20; i += 1) {
        stat = processStat(pid)
        if (!stat || stat.startsWith('Z')) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(!stat || stat.startsWith('Z')).toBe(true)
    },
    30_000,
  )

  test('does not reap a nested MatOS workflow orchestrator as a run leaf', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-nested-orch-'))
    const runDir = join(workspaceDir, 'parent-run')
    await mkdir(runDir)
    const nodeId = 'parent-exec-node'
    const markerPath = join(workspaceDir, 'orchestrator.term')
    const fakeMatosPath = join(workspaceDir, 'matos')
    // Mimics a nested `matos workflow run`: same inherited parent markers,
    // while its own scientific child carries the *nested* run dir (real
    // orchestrators override MATOS_WORKFLOW_RUN_DIR for their exec nodes).
    // The TERM trap records any graceful-cancel signal it receives.
    await writeFile(
      fakeMatosPath,
      [
        '#!/bin/sh',
        `trap 'printf terminated > "$MATOS_TEST_TERM_MARKER"; exit 0' TERM`,
        'while :; do MATOS_WORKFLOW_RUN_DIR=nested-run-decoy sleep 30 & wait $!; done',
        '',
      ].join('\n'),
      { mode: 0o755 },
    )
    const ownershipMarkers = {
      MATOS_WORKFLOW_RUN_DIR: runDir,
      MATOS_WORKFLOW_EXEC_PROCESS: '1',
      MATOS_WORKFLOW_EXEC_NODE_ID: nodeId,
    }
    const orchestrator = Bun.spawn(
      [fakeMatosPath, 'workflow', 'run', 'nested-workflow.yaml'],
      {
        env: {
          ...process.env,
          ...ownershipMarkers,
          MATOS_TEST_TERM_MARKER: markerPath,
        },
        stdout: 'ignore',
        stderr: 'ignore',
      },
    )
    const leaf = Bun.spawn(['sleep', '30'], {
      env: { ...process.env, ...ownershipMarkers },
      stdout: 'ignore',
      stderr: 'ignore',
    })

    try {
      await waitForEnvironMarker(
        orchestrator.pid,
        `MATOS_WORKFLOW_RUN_DIR=${runDir}`,
      )
      await waitForEnvironMarker(leaf.pid, `MATOS_WORKFLOW_RUN_DIR=${runDir}`)
      const summary = await terminateWorkflowRunLocalProcesses(runDir, {
        nodeId,
        termGraceMs: 200,
        pollMs: 20,
      })
      expect(summary.supported).toBe(process.platform === 'linux')
      if (process.platform === 'linux') {
        // The genuine leaf must still be reaped (BUG 1 semantics preserved).
        expect(summary.matchedPids).toContain(leaf.pid)
        await leaf.exited
        expect(processStat(leaf.pid)).toBeUndefined()
        // The nested orchestrator must not be treated as an owned leaf: not
        // matched, not signalled, still running and unsignalled afterwards.
        expect(summary.matchedPids).not.toContain(orchestrator.pid)
        expect(summary.terminatedPids).not.toContain(orchestrator.pid)
        expect(summary.killedPids).not.toContain(orchestrator.pid)
        await new Promise(resolve => setTimeout(resolve, 100))
        const orchestratorStat = processStat(orchestrator.pid)
        expect(orchestratorStat).toBeDefined()
        expect(orchestratorStat?.startsWith('Z')).toBe(false)
        const markerWritten = await readFile(markerPath, 'utf8')
          .then(() => true)
          .catch(() => false)
        expect(markerWritten).toBe(false)
      }
    } finally {
      orchestrator.kill('SIGKILL')
      leaf.kill('SIGKILL')
      await Promise.all([orchestrator.exited, leaf.exited])
    }
  }, 15_000)

  test('recognizes MatOS workflow CLI argv shapes without false positives', () => {
    // Real shapes: bin/matos bash shim (shebang rewrite) and the bun
    // entrypoint it execs into.
    expect(
      isMatOSWorkflowCliArgv(['bash', '/app/bin/matos', 'workflow', 'run', 'w.yaml']),
    ).toBe(true)
    expect(
      isMatOSWorkflowCliArgv([
        'bun',
        '/app/src/entrypoints/matos.ts',
        'workflow',
        'resume',
        'run-1',
      ]),
    ).toBe(true)
    expect(
      isMatOSWorkflowCliArgv([
        'node',
        '--no-warnings',
        '/deploy/matos.mjs',
        'workflow',
        'run',
        'w.yaml',
      ]),
    ).toBe(true)
    expect(isMatOSWorkflowCliArgv(['/app/bin/matos', 'workflow', 'cancel', 'run-2'])).toBe(
      true,
    )
    // Leaf work processes must stay reapable.
    expect(isMatOSWorkflowCliArgv(['sleep', '30'])).toBe(false)
    expect(isMatOSWorkflowCliArgv(['mpirun', '-np', '8', 'pw.x'])).toBe(false)
    // Mentioning matos/workflow in arguments is not an orchestrator.
    expect(
      isMatOSWorkflowCliArgv(['python3', 'analyze.py', 'matos', 'workflow', 'run.log']),
    ).toBe(false)
    // A non-workflow matos helper command is not an orchestrator.
    expect(isMatOSWorkflowCliArgv(['bash', '/app/bin/matos', 'assets', 'list'])).toBe(
      false,
    )
    // The gateway bundle is not the workflow CLI image.
    expect(
      isMatOSWorkflowCliArgv([
        'node',
        '/app/.matos/gateway/matos-gateway-node.mjs',
        'gateway',
        'serve',
      ]),
    ).toBe(false)
  })

  test('a run cancel request terminates the in-flight exec process tree', async () => {
    // Regression: the scheduler only reads the control marker between nodes,
    // so a cancel used to leave an in-flight exec command (and any nested
    // orchestrator it spawned) running until its own timeout, up to 24h.
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cancel-'))
    const runDir = await mkdtemp(join(tmpdir(), 'matos-exec-cancel-run-'))
    const node: MatOSWorkflowNode = {
      id: 'cancellable-tree',
      type: 'exec',
      dependsOn: [],
      command: 'sleep 30 & echo $! > child.pid; wait',
      timeoutSeconds: 60,
    }

    const startedAt = Date.now()
    const pending = runWorkflowExecNode(node, { workspaceDir, runDir })
    await new Promise(resolve => setTimeout(resolve, 300))
    await requestWorkflowRunControl(runDir, 'cancel')

    await expect(pending).rejects.toMatchObject({
      code: 'workflow_exec_cancelled',
      retryable: false,
      details: {
        category: 'cancelled',
        nodeId: 'cancellable-tree',
      },
    })
    // Cancelled well before the command's own 30s/60s bounds.
    expect(Date.now() - startedAt).toBeLessThan(10_000)

    const pid = Number(
      (await readFile(join(workspaceDir, 'child.pid'), 'utf8')).trim(),
    )
    let stat: string | undefined
    for (let i = 0; i < 20; i += 1) {
      stat = processStat(pid)
      if (!stat || stat.startsWith('Z')) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(!stat || stat.startsWith('Z')).toBe(true)
  })

  test('bounds in-memory stdout retention and spills the full stream to the run dir', async () => {
    // Regression: full child output was accumulated unbounded in orchestrator
    // memory and copied into node-run records; chatty solvers (hours of logs)
    // could OOM the runtime. Retention is now a bounded head+tail window for
    // the attempt log plus a smaller node-output excerpt with truncation
    // metadata; the complete stream lands in a spill file under the node-run
    // dir.
    const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cap-'))
    const runDir = await mkdtemp(join(tmpdir(), 'matos-exec-cap-run-'))
    // Larger than the head+tail attempt-log retention window so the
    // in-memory bound is actually exercised.
    const totalBytes = 2_500_000
    const node: MatOSWorkflowNode = {
      id: 'chatty',
      type: 'exec',
      dependsOn: [],
      command: `head -c ${totalBytes} /dev/zero | tr '\\0' 'x'; printf END`,
    }

    const result = await runWorkflowExecNode(node, { workspaceDir, runDir })

    expect(result.output).toMatchObject({
      exitCode: 0,
      stdoutTruncated: true,
      stdoutChars: totalBytes + 'END'.length,
    })
    // Node-output copy: second-tier bounded head+tail excerpt.
    const embedded = String(result.output.stdout)
    expect(embedded.length).toBeLessThan(70_000)
    expect(embedded).toContain('stream truncated for node output')
    expect(embedded.endsWith('END')).toBe(true)
    // Attempt-log copy: first-tier bounded window, well below the full stream.
    expect(result.stdout.length).toBeLessThan(2_100_000)
    expect(result.stdout).toContain('[exec stream truncated:')
    expect(result.stdout.endsWith('END')).toBe(true)
    // The spill keeps the complete stream and flushes asynchronously relative
    // to the exec result.
    const spillPath = join(runDir, 'node-runs', 'chatty', 'live-stdout.log')
    let spilled = ''
    for (let i = 0; i < 100; i += 1) {
      spilled = await readFile(spillPath, 'utf8').catch(() => '')
      if (spilled.length >= totalBytes + 'END'.length) {
        break
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(spilled.length).toBe(totalBytes + 'END'.length)
    expect(spilled.endsWith('END')).toBe(true)
  })

  test(
    'fails a swallowed failure marker that scrolled out of the bounded stream buffers',
    async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-swallowed-'))
      // Regression (P0-1, false success): the close-time swallowed-failure
      // scan used to read only the bounded head+tail stream buffer (first
      // 1MB + last 1MB), so a solver that failed mid-run, printed a couple
      // more megabytes, and then had its exit status suppressed by a wrapper
      // resolved SUCCESS — the marker fell in the dropped middle. The
      // incremental full-stream scanner must classify this run as FAILED.
      const script = [
        'import sys',
        'def chat(n):',
        '    for i in range(n):',
        '        sys.stdout.write("progress line %07d still chatty\\n" % i)',
        // ~1.75MB before the marker pushes it past the retained 1MB head.
        'chat(50000)',
        'sys.stdout.write("SOLVER_EXIT=1\\n")',
        // ~2.45MB after the marker pushes it out of the retained 1MB tail.
        'chat(70000)',
        'sys.stdout.write("wrapper converted the failure into exit zero\\n")',
      ].join('\n')
      const node: MatOSWorkflowNode = {
        id: 'swallowed-marker',
        type: 'exec',
        dependsOn: [],
        command: 'python3',
        args: ['-c', script],
      }

      let error: unknown
      try {
        await runWorkflowExecNode(node, { workspaceDir })
        throw new Error('exec node unexpectedly resolved success')
      } catch (caught) {
        error = caught
      }
      expect(error).toMatchObject({
        code: 'workflow_process_failure_detected',
        exitCode: 0,
        details: {
          category: 'suppressed_exit',
          signatureId: 'suppressed-exit-status',
          source: 'stdout',
          suppressedFailure: true,
          detectedWhileRunning: false,
        },
      })
      // The marker must genuinely be outside every retained buffer — that is
      // exactly the case the bounded close-time scan could not see.
      const retainedStdout = (error as { stdout?: string }).stdout ?? ''
      expect(retainedStdout).not.toContain('SOLVER_EXIT=1')
      expect(retainedStdout).toContain('[exec stream truncated')
    },
    60_000,
  )

  test(
    'keeps explicit recovery semantics for markers beyond the bounded buffers',
    async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-recovered-big-'))
      // The same dropped-middle scenario, but the failure sentinel is
      // explicitly recovered before the flood of trailing output: the node
      // must still resolve success (a genuinely successful run must not be
      // reclassified by the full-stream scanner).
      const script = [
        'import sys',
        'def chat(n):',
        '    for i in range(n):',
        '        sys.stdout.write("progress line %07d still chatty\\n" % i)',
        'chat(50000)',
        'sys.stdout.write("PRIMARY_EXIT=7\\n")',
        'sys.stdout.write("fallback succeeded\\n")',
        'chat(70000)',
      ].join('\n')
      const node: MatOSWorkflowNode = {
        id: 'recovered-marker',
        type: 'exec',
        dependsOn: [],
        command: 'python3',
        args: ['-c', script],
      }

      const result = await runWorkflowExecNode(node, { workspaceDir })

      expect(result.output).toMatchObject({
        exitCode: 0,
        stdoutTruncated: true,
      })
    },
    60_000,
  )

  test(
    'settles a running exec node through group termination when the run is cancelled',
    async () => {
      const workspaceDir = await mkdtemp(join(tmpdir(), 'matos-exec-cancel-unit-'))
      const runDir = join(workspaceDir, 'cancel-run')
      await mkdir(runDir)
      const pidPath = join(workspaceDir, 'cancel-child.pid')
      // Regression (P1-2): the exec adapter did not watch the run cancel
      // marker, so a cooperative cancel could only wait for the node timeout
      // (here deliberately far beyond the test timeout).
      const node: MatOSWorkflowNode = {
        id: 'cancel-target',
        type: 'exec',
        dependsOn: [],
        command: `echo $$ > "${pidPath}"; sleep 30`,
        timeoutSeconds: 300,
      }

      const startedAt = Date.now()
      const pending = runWorkflowExecNode(node, { workspaceDir, runDir })
      let childPid = 0
      for (let i = 0; i < 200 && childPid === 0; i += 1) {
        childPid = await readFile(pidPath, 'utf8')
          .then(text => Number(text.trim()) || 0)
          .catch(() => 0)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(childPid).toBeGreaterThan(0)

      await requestWorkflowRunControl(runDir, 'cancel')

      await expect(pending).rejects.toMatchObject({
        code: 'workflow_exec_cancelled',
        retryable: false,
        details: {
          category: 'cancelled',
          action: 'none',
          repairable: false,
        },
      })
      // Settlement must come from the cancel watcher (250ms poll plus group
      // SIGTERM), nowhere near the 300s node timeout.
      expect(Date.now() - startedAt).toBeLessThan(10_000)

      let stat: string | undefined
      for (let i = 0; i < 20; i += 1) {
        stat = processStat(childPid)
        if (!stat || stat.startsWith('Z')) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(!stat || stat.startsWith('Z')).toBe(true)
    },
    30_000,
  )

  test(
    'workflow cancel stops an exec node whose child the run process sweep spares',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-exec-cancel-nested-'))
      const pidPath = join(root, 'orchestrator.pid')
      const fakeMatosPath = join(root, 'matos')
      // Mimics `matos workflow run` launched by an exec node: the /proc
      // cleanup sweep spares it (workflow CLI argv shape) and its scientific
      // child carries a *nested* run dir, so the sweep matches nothing at
      // all. Regression (P1-2): `matos workflow cancel` therefore killed
      // nothing — only the exec boundary's process-group termination can stop
      // this tree, and it never fired on cancel, so the node promise hung
      // until the node timeout while the nested subtree computed on.
      await writeFile(
        fakeMatosPath,
        [
          '#!/bin/sh',
          'printf "%s" "$$" > "$MATOS_TEST_ORCHESTRATOR_PID"',
          'while :; do MATOS_WORKFLOW_RUN_DIR=nested-run-decoy sleep 30 & wait $!; done',
          '',
        ].join('\n'),
        { mode: 0o755 },
      )
      const started = await startWorkflowRun({
        workflowsDir: join(root, 'workflows'),
        workflowRef: 'workflow:cancel-nested-orchestrator@0.1.0',
        parameters: {},
        workspaceDir: root,
        definition: {
          schemaVersion: 1,
          name: 'cancel nested orchestrator',
          parameters: {},
          policy: { approvalMode: 'bypass', defaultRisk: 'low' },
          outputs: {},
          nodes: [
            {
              id: 'launch',
              type: 'human',
              dependsOn: [],
              prompt: 'Launch the nested orchestrator cancel test',
              responseSchema: { type: 'object' },
            },
            {
              id: 'nested_orchestrator',
              type: 'exec',
              dependsOn: ['launch'],
              command: fakeMatosPath,
              args: ['workflow', 'run', 'nested-workflow.yaml'],
              timeoutSeconds: 300,
              env: { MATOS_TEST_ORCHESTRATOR_PID: pidPath },
            },
          ],
        },
      })
      expect(started.status).toBe('waiting_input')

      // Advance under the run lock exactly like the production service does
      // (workflowService withRunMutationLock), so the cancel request takes
      // the cooperative-marker path an actively advancing run exercises.
      const advancing = withWorkflowRunLock(
        started.runDir,
        () =>
          respondToWorkflowNode({
            runDir: started.runDir,
            nodeId: 'launch',
            response: { launch: true },
          }),
        { owner: 'workflow.respond' },
      )

      let orchestratorPid = 0
      for (let i = 0; i < 300 && orchestratorPid === 0; i += 1) {
        orchestratorPid = await readFile(pidPath, 'utf8')
          .then(text => Number(text.trim()) || 0)
          .catch(() => 0)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      expect(orchestratorPid).toBeGreaterThan(0)

      const cancelRequestedAt = Date.now()
      await requestWorkflowRunCancel(started.runDir)
      const cancelled = await advancing
      expect(cancelled.status).toBe('cancelled')
      // Settled through the cancel path, nowhere near the 300s node timeout.
      expect(Date.now() - cancelRequestedAt).toBeLessThan(15_000)

      const nodeRun = JSON.parse(
        await readFile(
          join(started.runDir, 'node-runs', 'nested_orchestrator', 'node-run.json'),
          'utf8',
        ),
      ) as { status?: string }
      expect(nodeRun.status).toBe('cancelled')

      let stat: string | undefined
      for (let i = 0; i < 20; i += 1) {
        stat = processStat(orchestratorPid)
        if (!stat || stat.startsWith('Z')) {
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(!stat || stat.startsWith('Z')).toBe(true)
    },
    30_000,
  )

  test('honors explicit multi-hour scientific compute timeouts', () => {
    const node: MatOSWorkflowNode = {
      id: 'long-scientific-compute',
      type: 'exec',
      dependsOn: [],
      command: 'true',
      timeoutSeconds: 8 * 60 * 60,
    }

    expect(execNodeTimeoutMs(node)).toBe(8 * 60 * 60 * 1_000)
  })

  test('keeps an upper safety bound on explicit exec timeouts', () => {
    const node: MatOSWorkflowNode = {
      id: 'bounded-compute',
      type: 'exec',
      dependsOn: [],
      command: 'true',
      timeoutSeconds: 48 * 60 * 60,
    }

    expect(execNodeTimeoutMs(node)).toBe(24 * 60 * 60 * 1_000)
  })
})
