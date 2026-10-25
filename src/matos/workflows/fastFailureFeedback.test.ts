import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  inspectWorkflowRun,
  startWorkflowRun,
} from './workflowRuntime.js'
import { readWorkflowRunEvents } from './workflowStore.js'
import {
  workflowNodeErrorFeedback,
  workflowNodeErrorInfo,
} from './nodeLifecycle.js'
import type {
  MatOSWorkflowDefinition,
  MatOSWorkflowNode,
} from './types.js'

function definition(nodes: MatOSWorkflowNode[]): MatOSWorkflowDefinition {
  return {
    schemaVersion: 1,
    name: 'fast-failure-feedback',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {},
    nodes,
  }
}

describe('MatOS workflow fast failure feedback', () => {
  test('scrubs secret-shaped arbitrary error codes from snapshots and feedback', () => {
    const error = Object.assign(new Error('safe failure'), {
      code: 'token=sk-livecanaryvalue123456789',
    })
    const info = workflowNodeErrorInfo(error)
    const feedback = workflowNodeErrorFeedback(info)

    expect(JSON.stringify(info)).not.toContain('sk-livecanaryvalue123456789')
    expect(JSON.stringify(feedback)).not.toContain('sk-livecanaryvalue123456789')
    expect(info.code).toContain('[redacted]')
    expect(feedback.code).toContain('[redacted]')
  })

  test('fails an exec node before a wrapper can hide MPI_ABORT behind a zero shell exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-mpi-abort-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:hidden-mpi-abort@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'qe_run',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "MPI_ABORT was invoked on rank 0; token=sk-livecanaryvalue123456789\\n" >&2; true',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.error).toMatchObject({
      code: 'workflow_process_failure_detected',
      details: {
        nodeId: 'qe_run',
        category: 'mpi_abort',
        action: 'repair_before_retry',
        repairable: true,
        detectedWhileRunning: true,
      },
    })
    expect(String(inspected.nodes?.[0]?.error)).not.toContain('undefined')
    await expect(
      readFile(
        join(run.runDir, 'node-runs', 'qe_run', 'attempts', '1', 'stderr.log'),
        'utf8',
      ),
    ).resolves.toContain('MPI_ABORT')
    const failedEvent = (await readWorkflowRunEvents(run.runDir)).find(
      event => event.type === 'workflow.node.failed',
    )
    expect(failedEvent?.data?.feedback).toMatchObject({
      code: 'workflow_process_failure_detected',
      category: 'mpi_abort',
      action: 'repair_before_retry',
      repairable: true,
      detectedWhileRunning: true,
      hint: expect.stringContaining('first rank-local error'),
    })
    expect(JSON.stringify(failedEvent?.data?.feedback)).not.toContain('matchedText')
    expect(JSON.stringify(failedEvent)).not.toContain(
      'sk-livecanaryvalue123456789',
    )
    expect(JSON.stringify(inspected.nodes?.[0]?.error)).not.toContain(
      'sk-livecanaryvalue123456789',
    )
    const attemptDir = join(
      run.runDir,
      'node-runs',
      'qe_run',
      'attempts',
      '1',
    )
    await expect(readFile(join(attemptDir, 'error.json'), 'utf8')).resolves.not.toContain(
      'sk-livecanaryvalue123456789',
    )
    await expect(readFile(join(attemptDir, 'stderr.log'), 'utf8')).resolves.toContain(
      'sk-livecanaryvalue123456789',
    )
  })

  test('fails an exec node immediately before a CUDA OOM wrapper can return zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-cuda-oom-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:hidden-cuda-oom@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'train',
          type: 'exec',
          dependsOn: [],
          command: 'printf "RuntimeError: CUDA out of memory. Tried to allocate 8 GiB\\n"; exit 0',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.error).toMatchObject({
      code: 'workflow_process_failure_detected',
      details: {
        category: 'out_of_memory',
        action: 'repair_before_retry',
        repairable: true,
      },
    })
  })

  test('fails a wrapper that prints an explicit nonzero child-exit sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-hidden-exit-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:hidden-exit@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'wrapped_solver',
          type: 'exec',
          dependsOn: [],
          command: 'false || printf "SOLVER_EXIT=7\\n"; true',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.error).toMatchObject({
      code: 'workflow_process_failure_detected',
      details: {
        category: 'suppressed_exit',
        signatureId: 'suppressed-exit-status',
        action: 'repair_before_retry',
      },
    })
  })

  test('allows an intermediate child-exit sentinel followed by explicit recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recovered-exit-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recovered-exit@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'fallback_solver',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "PRIMARY_EXIT=7\\n"; sleep 0.05; printf "fallback succeeded\\n"; true',
        },
      ]),
    })

    expect(run.status).toBe('completed')
  })

  test('does not let an earlier recovery hide a later child-exit sentinel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-late-hidden-exit-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:late-hidden-exit@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'fallback_then_failure',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "PRIMARY_EXIT=7\\nfallback succeeded\\nSECONDARY_EXIT=9\\n"; true',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const node = (await inspectWorkflowRun(run.runDir)).nodes?.[0]
    expect(node?.error).toMatchObject({
      code: 'workflow_process_failure_detected',
      details: { category: 'suppressed_exit' },
    })
  })

  test('fails an unhandled Python traceback only after the wrapper exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-hidden-trace-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:hidden-trace@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'wrapped_python',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "Traceback (most recent call last):\\n  File \\\"worker.py\\\", line 1, in <module>\\nFileNotFoundError: missing input\\n"; true',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.error).toMatchObject({
      code: 'workflow_process_failure_detected',
      details: {
        category: 'unhandled_exception',
        signatureId: 'python-traceback',
        suppressedFailure: true,
        detectedWhileRunning: false,
      },
    })
  })

  test('emits bounded actionable feedback for an ordinary nonzero exit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-nonzero-feedback-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:nonzero-feedback@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'failing_command',
          type: 'exec',
          dependsOn: [],
          command: 'printf "private diagnostic\\n" >&2; exit 9',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const failedEvent = (await readWorkflowRunEvents(run.runDir)).find(
      event => event.type === 'workflow.node.failed',
    )
    expect(failedEvent?.data?.feedback).toMatchObject({
      code: 'workflow_exec_nonzero_exit',
      exitCode: 9,
      category: 'nonzero_exit',
      action: 'inspect_logs_and_repair',
      repairable: true,
      hint: expect.stringContaining('first error'),
    })
    expect(JSON.stringify(failedEvent?.data?.feedback)).not.toContain(
      'private diagnostic',
    )
  })

  test('emits the terminating signal without inventing an exit code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-signal-feedback-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:signal-feedback@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'terminated_command',
          type: 'exec',
          dependsOn: [],
          command: 'kill -TERM $$',
          policy: { retry: { maxAttempts: 2, retryableExitCodes: [1] } },
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const node = (await inspectWorkflowRun(run.runDir)).nodes?.[0]
    expect(node?.attempts).toBe(1)
    expect((node?.error as { exitCode?: number } | undefined)?.exitCode).toBeUndefined()
    const failedEvent = (await readWorkflowRunEvents(run.runDir)).find(
      event => event.type === 'workflow.node.failed',
    )
    expect(failedEvent?.data?.feedback).toMatchObject({
      code: 'workflow_exec_signaled',
      category: 'signal',
      signal: 'SIGTERM',
      sameInputRetrySafe: false,
      action: 'inspect_signal_before_retry',
    })
    expect(
      (failedEvent?.data?.feedback as { exitCode?: number } | undefined)?.exitCode,
    ).toBeUndefined()
  })

  test('does not reject ordinary output that merely discusses preventive checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-healthy-output-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:healthy-output@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'report',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "Preflight includes MPI abort and out-of-memory prevention checks.\\n"',
        },
      ]),
    })

    expect(run.status).toBe('completed')
  })

  test('does not blindly retry a classified non-retryable native crash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-no-crash-retry-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:no-crash-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'native_solver',
          type: 'exec',
          dependsOn: [],
          command:
            'printf x >> native-attempts.txt; printf "Segmentation fault (core dumped)\\n" >&2; true',
          policy: { retry: { maxAttempts: 2 } },
        },
      ]),
    })

    expect(run.status).toBe('failed')
    await expect(readFile(join(root, 'native-attempts.txt'), 'utf8')).resolves.toBe(
      'x',
    )
  })

  test('retries a repairable OOM only when policy explicitly matches its classified error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-oom-retry-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:oom-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'gpu_solver',
          type: 'exec',
          dependsOn: [],
          command:
            'printf x >> oom-attempts.txt; printf "RuntimeError: CUDA out of memory.\\n" >&2; true',
          policy: {
            retry: {
              maxAttempts: 2,
              retryableErrorPatterns: ['out_of_memory'],
            },
          },
        },
      ]),
    })

    expect(run.status).toBe('failed')
    await expect(readFile(join(root, 'oom-attempts.txt'), 'utf8')).resolves.toBe(
      'xx',
    )
    const retryEvent = (await readWorkflowRunEvents(run.runDir)).find(
      event => event.type === 'workflow.node.retry_scheduled',
    )
    expect(retryEvent?.data?.feedback).toMatchObject({
      code: 'workflow_process_failure_detected',
      category: 'out_of_memory',
      action: 'repair_before_retry',
    })
  })

  test('does not replay a repair-required OOM without an explicit retry match', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-oom-no-blind-retry-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:oom-no-blind-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'gpu_solver',
          type: 'exec',
          dependsOn: [],
          command:
            'printf x >> oom-attempts.txt; printf "RuntimeError: CUDA out of memory.\\n" >&2; true',
          policy: { retry: { maxAttempts: 2 } },
        },
      ]),
    })

    expect(run.status).toBe('failed')
    await expect(readFile(join(root, 'oom-attempts.txt'), 'utf8')).resolves.toBe(
      'x',
    )
  })

  test('preserves generic exec retry behavior when no structured fatal class vetoes it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-generic-retry-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:generic-retry@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'transient_command',
          type: 'exec',
          dependsOn: [],
          command:
            'if [ ! -f generic-retry-marker ]; then touch generic-retry-marker; exit 7; fi; printf recovered',
          policy: { retry: { maxAttempts: 2 } },
        },
      ]),
    })

    expect(run.status).toBe('completed')
    expect((await inspectWorkflowRun(run.runDir)).nodes?.[0]?.attempts).toBe(2)
  })

  test('does not fail a successful node merely because it reports a handled traceback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-handled-trace-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:handled-trace@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'handled_exception_report',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "Traceback (most recent call last):\\nValueError: optional parser failed\\nHandled by fallback parser.\\n"',
        },
      ]),
    })

    expect(run.status).toBe('completed')
  })

  test('leaves recovered scientific convergence semantics to explicit validation checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-recovered-scf-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:recovered-scf@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'scf_recovery',
          type: 'exec',
          dependsOn: [],
          command:
            'printf "SCF did not converge with the initial guess.\\nconvergence achieved after restart.\\n"',
        },
      ]),
    })

    expect(run.status).toBe('completed')
  })

  test('does not reject a diagnostic report that cites a remediated MPI_ABORT marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-mpi-report-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:mpi-report@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'postmortem_report',
          type: 'exec',
          dependsOn: [],
          command: 'printf "MPI_ABORT marker diagnosed; remediation applied.\\n"',
        },
      ]),
    })

    expect(run.status).toBe('completed')
  })

  test('supports an explicit opt-out for commands that intentionally replay fatal logs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-fatal-log-replay-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:fatal-log-replay@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'log_replay',
          type: 'exec',
          dependsOn: [],
          detectKnownProcessFailures: false,
          command:
            'printf "MPI_ABORT was invoked on rank 0 in communicator MPI_COMM_WORLD\\n"',
        },
      ]),
    })

    expect(run.status).toBe('completed')
  })

  test('terminates a still-running wrapper as soon as a strong fatal signature is streamed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-stream-failure-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:stream-failure@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'hung_wrapper',
          type: 'exec',
          dependsOn: [],
          timeoutSeconds: 10,
          command:
            'printf "RuntimeError: CUDA out of memory. Tried to allocate 8 GiB\\n" >&2; sleep 2; printf survived > should-not-exist.txt',
        },
      ]),
    })

    expect(run.status).toBe('failed')
    await expect(readFile(join(root, 'should-not-exist.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('numeric validation can reject a finite sentinel value with structured repair feedback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-zero-result-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:zero-result@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'validate_energy',
          type: 'validate',
          dependsOn: [],
          checks: [
            {
              id: 'computed-energy',
              type: 'numeric_range',
              value: 0,
              min: -100000,
              max: 100000,
              notEqual: 0,
              failureCode: 'sentinel_energy',
              failureMessage:
                'Parsed energy is still the zero fallback sentinel; token=sk-validationcanary123456789.',
              repairHint:
                'Inspect the upstream solver log and parser; never replace a failed calculation with zero.',
              retryable: true,
            },
          ],
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.nodes?.[0]?.output).toMatchObject({
      ok: false,
      checks: [
        {
          id: 'computed-energy',
          code: 'sentinel_energy',
          observed: 0,
          expected: {
            min: -100000,
            max: 100000,
            notEqual: 0,
          },
          hint:
            'Inspect the upstream solver log and parser; never replace a failed calculation with zero.',
          retryable: true,
        },
      ],
    })
    expect(inspected.nodes?.[0]?.error).toMatchObject({
      code: 'workflow_validation_failed',
      details: {
        nodeId: 'validate_energy',
        recommendation: 'fail',
        failedChecks: [
          expect.objectContaining({
            code: 'sentinel_energy',
            hint: expect.stringContaining('never replace'),
          }),
        ],
      },
    })
    const events = await readWorkflowRunEvents(run.runDir)
    const validationDecision = events.find(
      event => event.type === 'workflow.validation.decision',
    )
    const serializedValidationDecision = JSON.stringify(validationDecision)
    expect(serializedValidationDecision).not.toContain(
      'sk-validationcanary123456789',
    )
    expect(serializedValidationDecision).toContain('[redacted]')
    expect(
      validationDecision?.data?.feedback,
    ).toMatchObject({
      recommendation: 'fail',
      failedChecks: [
        expect.objectContaining({
          code: 'sentinel_energy',
          hint: expect.stringContaining('never replace'),
          retryable: true,
        }),
      ],
    })
    expect(
      events.find(event => event.type === 'workflow.node.failed')?.data?.feedback,
    ).toMatchObject({
      code: 'workflow_validation_failed',
      failedChecks: [
        expect.objectContaining({ code: 'sentinel_energy' }),
      ],
    })
    expect(
      events.find(event => event.type === 'workflow.node.failed')?.data,
    ).not.toHaveProperty('output')
  })

  test('regex and file-size checks reject non-finite output and empty artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-artifact-health-'))
    const run = await startWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:artifact-health@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: definition([
        {
          id: 'write_results',
          type: 'exec',
          dependsOn: [],
          command: 'printf "energy=NaN\\n" > result.txt; : > trajectory.xyz',
        },
        {
          id: 'validate_results',
          type: 'validate',
          dependsOn: ['write_results'],
          checks: [
            {
              id: 'finite-result-text',
              type: 'regex',
              path: 'result.txt',
              pattern: '(?:^|[=:,\\s])(?:NaN|[+-]?Inf)(?:$|[,\\s])',
              flags: 'im',
              negate: true,
              failureCode: 'non_finite_result',
              repairHint: 'Trace the first non-finite value to the producing node.',
            },
            {
              id: 'trajectory-not-empty',
              type: 'file_size',
              path: 'trajectory.xyz',
              minBytes: 1,
              failureCode: 'empty_artifact',
              repairHint: 'Require the simulation to write at least one complete frame.',
            },
          ],
        },
      ]),
    })

    expect(run.status).toBe('failed')
    const inspected = await inspectWorkflowRun(run.runDir)
    const checks = (inspected.nodes?.find(node => node.nodeId === 'validate_results')
      ?.output as { checks?: Array<Record<string, unknown>> } | undefined)?.checks
    expect(checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'non_finite_result', ok: false }),
        expect.objectContaining({ code: 'empty_artifact', ok: false }),
      ]),
    )
  })
})
