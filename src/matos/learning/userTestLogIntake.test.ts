import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMatOSEvolveCommand } from '../cli/evolve.js'
import {
  collectMatOSUserTestLogIntake,
  listMatOSUserTestLogIntakes,
  parseMatOSIntakeSince,
  readMatOSUserTestLogEpisode,
} from './userTestLogIntake.js'

const ORIGINAL_ENV = { ...process.env }

// Intake collection follows runtime env (deploy roots, scope dirs). Tests must
// see only their own tmp fixtures, never ambient deployment state from the
// invoking shell.
const ISOLATED_ENV_KEYS = [
  'MATOS_SESSION_DIR',
  'MATOS_WORKFLOW_RUNS_DIR',
  'MATOS_RUNTIME_DATA_DIR',
  'MATOS_INTERNAL_STATE_DIR',
  'MATOS_FEEDBACK_DIR',
  'MATOS_DAEMON_JOB_LEDGER',
]

beforeEach(() => {
  for (const key of ISOLATED_ENV_KEYS) {
    delete process.env[key]
  }
})

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

type EventSpec = {
  id: string
  type: string
  data: Record<string, unknown>
  timestamp?: string
  scopeRef?: string
  traceId?: string
  roleRef?: string
}

async function writeSession(input: {
  root: string
  sessionId: string
  events: EventSpec[]
}): Promise<void> {
  const dir = join(input.root, '.matos', 'sessions')
  await mkdir(dir, { recursive: true })
  const lines = input.events.map(event =>
    JSON.stringify({
      id: event.id,
      schemaVersion: 1,
      sessionId: input.sessionId,
      timestamp: event.timestamp ?? isoMinutesAgo(10),
      type: event.type,
      data: event.data,
      ...(event.scopeRef ? { scopeRef: event.scopeRef } : {}),
      ...(event.traceId ? { traceId: event.traceId } : {}),
      ...(event.roleRef ? { roleRef: event.roleRef } : {}),
    }),
  )
  await writeFile(
    join(dir, `${input.sessionId}.jsonl`),
    `${lines.join('\n')}\n`,
    'utf8',
  )
}

async function writeFailedComputeSession(
  root: string,
  options: { sessionId?: string; scopeRef?: string; timestamp?: string } = {},
): Promise<void> {
  const sessionId = options.sessionId ?? 'session-failed-1'
  const timestamp = options.timestamp ?? isoMinutesAgo(15)
  await writeSession({
    root,
    sessionId,
    events: [
      {
        id: `${sessionId}-start`,
        type: 'matos.session.started',
        data: { command: 'matos run' },
        timestamp,
        roleRef: 'role:compute',
        traceId: `trace-${sessionId}`,
        ...(options.scopeRef ? { scopeRef: options.scopeRef } : {}),
      },
      {
        id: `${sessionId}-turn`,
        type: 'matos.turn.started',
        data: {
          prompt:
            'Submit a VASP relax job, my api_key=sk-supersecret-value-123 should never leak.',
        },
        timestamp,
        ...(options.scopeRef ? { scopeRef: options.scopeRef } : {}),
      },
      {
        id: `${sessionId}-tool`,
        type: 'matos.tool.call.completed',
        data: {
          toolName: 'hpc_submit',
          isError: true,
          resultPreview: 'queue rejects CustomTask; token=abc-secret-999',
        },
        timestamp,
        ...(options.scopeRef ? { scopeRef: options.scopeRef } : {}),
      },
      {
        id: `${sessionId}-failed`,
        type: 'matos.session.failed',
        data: { exitCode: 1 },
        timestamp,
        ...(options.scopeRef ? { scopeRef: options.scopeRef } : {}),
      },
    ],
  })
}

async function writeWorkflowRun(input: {
  runsDir: string
  runId: string
  workflowRef: string
  status: string
  updatedAt: string
}): Promise<void> {
  const dir = join(input.runsDir, input.runId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'run.json'),
    `${JSON.stringify({
      runId: input.runId,
      workflowRef: input.workflowRef,
      status: input.status,
      parameters: {},
      outputs: {},
      createdAt: input.updatedAt,
      updatedAt: input.updatedAt,
    })}\n`,
    'utf8',
  )
  await writeFile(join(dir, 'events.jsonl'), '', 'utf8')
}

async function writeFeedback(root: string): Promise<string> {
  const dir = join(root, 'feedback-reports')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'feedback-1.json'),
    `${JSON.stringify({
      id: 'feedback-1',
      createdAt: isoMinutesAgo(5),
      status: 'open',
      kind: 'bug',
      severity: 'high',
      title: 'Workflow demo failed',
      messagePreview: 'The QE demo failed twice in a row.',
    })}\n`,
    'utf8',
  )
  return dir
}

async function writeDaemonLedger(root: string): Promise<string> {
  const path = join(root, 'daemon-jobs.json')
  await writeFile(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      updatedAt: isoMinutesAgo(2),
      jobs: [
        {
          jobId: 'job-1',
          pid: 123,
          status: 'failed',
          argvPreview: 'matos run --role compute password=hunter2',
          cwd: '/workspace/group/shared',
          envKeys: [],
          startedAt: isoMinutesAgo(9),
          completedAt: isoMinutesAgo(8),
          exitCode: 1,
          metadata: { traceId: 'trace-job-1', sessionId: 'session-job-1' },
        },
      ],
    })}\n`,
    'utf8',
  )
  return path
}

describe('parseMatOSIntakeSince', () => {
  test('parses relative windows and ISO timestamps', () => {
    const now = new Date('2026-07-08T12:00:00Z')
    expect(parseMatOSIntakeSince('24h', now).toISOString()).toBe(
      '2026-07-07T12:00:00.000Z',
    )
    expect(parseMatOSIntakeSince('7d', now).toISOString()).toBe(
      '2026-07-01T12:00:00.000Z',
    )
    expect(parseMatOSIntakeSince('90m', now).toISOString()).toBe(
      '2026-07-08T10:30:00.000Z',
    )
    expect(
      parseMatOSIntakeSince('2026-07-08T00:00:00Z', now).toISOString(),
    ).toBe('2026-07-08T00:00:00.000Z')
    expect(() => parseMatOSIntakeSince('yesterday', now)).toThrow(/Invalid/)
  })
})

describe('user-test-logs intake', () => {
  test('collects sessions, workflow runs, daemon jobs, and feedback into intake + episodes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-utl-intake-'))
    await writeFailedComputeSession(root)
    const runsDir = join(root, 'wf-runs')
    await writeWorkflowRun({
      runsDir,
      runId: 'run-failed-1',
      workflowRef: 'workflow:qe-si-vc-relax-local@0.1.0',
      status: 'failed',
      updatedAt: isoMinutesAgo(20),
    })
    await writeWorkflowRun({
      runsDir,
      runId: 'run-fixed-2',
      workflowRef: 'workflow:qe-si-vc-relax-local@0.1.0',
      status: 'completed',
      updatedAt: isoMinutesAgo(4),
    })
    process.env.MATOS_WORKFLOW_RUNS_DIR = runsDir
    const feedbackDir = await writeFeedback(root)
    const ledgerPath = await writeDaemonLedger(root)

    const result = await collectMatOSUserTestLogIntake({
      cwd: root,
      since: '24h',
      env: {
        ...process.env,
        MATOS_FEEDBACK_DIR: feedbackDir,
        MATOS_DAEMON_JOB_LEDGER: ledgerPath,
      },
    })

    expect(result.intake.stats.sessionCount).toBe(1)
    expect(result.intake.stats.failedSessionCount).toBe(1)
    expect(result.intake.stats.workflowRunCount).toBe(2)
    expect(result.intake.stats.failedWorkflowRunCount).toBe(1)
    expect(result.intake.stats.daemonJobCount).toBe(1)
    expect(result.intake.stats.failedDaemonJobCount).toBe(1)
    expect(result.intake.stats.feedbackCount).toBe(1)
    expect(result.intake.stats.episodeCount).toBe(
      result.intake.episodeIds.length,
    )

    const kinds: string[] = result.episodes.map(episode => episode.kind).sort()
    expect(kinds).toEqual(
      ['session-failure', 'tool-failure', 'user-feedback', 'workflow-failure'].sort(),
    )

    const workflowEpisode = result.episodes.find(
      episode => episode.kind === 'workflow-failure',
    )
    expect(workflowEpisode?.suspectedRefs).toEqual([
      'workflow:qe-si-vc-relax-local@0.1.0',
    ])
    expect(workflowEpisode?.laterFixed).toBe(true)
    expect(workflowEpisode?.benchmarkCandidate?.kind).toBe('workflow-run')

    const sessionEpisode = result.episodes.find(
      episode => episode.kind === 'session-failure',
    )
    expect(sessionEpisode?.userIntent).toContain('VASP relax')
    expect(sessionEpisode?.suspectedRefs).toEqual(['role:compute'])

    const toolEpisode = result.episodes.find(
      episode => episode.kind === 'tool-failure',
    )
    expect(toolEpisode?.suspectedRefs).toEqual(['tool:hpc_submit'])
    expect(toolEpisode?.benchmarkCandidate?.ref).toBe('tool:hpc_submit')

    // Redaction: secret values from prompts, tool output, and daemon argv
    // never land in intake or episode files.
    const intakeText = await readFile(result.intakePath, 'utf8')
    const episodeTexts = await Promise.all(
      result.episodePaths.map(path => readFile(path, 'utf8')),
    )
    for (const text of [intakeText, ...episodeTexts]) {
      expect(text).not.toContain('sk-supersecret-value-123')
      expect(text).not.toContain('abc-secret-999')
      expect(text).not.toContain('hunter2')
    }

    // Records round-trip through the list/read helpers.
    const listed = await listMatOSUserTestLogIntakes(root)
    expect(listed.map(item => item.intakeId)).toContain(result.intake.intakeId)
    const episode = await readMatOSUserTestLogEpisode(
      root,
      result.episodes[0]!.episodeId,
    )
    expect(episode?.intakeId).toBe(result.intake.intakeId)
  })

  test('scope filter excludes other users and window excludes old sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-utl-scope-'))
    await writeFailedComputeSession(root, {
      sessionId: 'session-alice',
      scopeRef: 'user:alice',
    })
    await writeFailedComputeSession(root, {
      sessionId: 'session-bob',
      scopeRef: 'user:bob',
    })
    await writeFailedComputeSession(root, {
      sessionId: 'session-old',
      scopeRef: 'user:alice',
      timestamp: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    })
    const result = await collectMatOSUserTestLogIntake({
      cwd: root,
      scopeRef: 'user:alice',
      since: '24h',
      env: { ...process.env },
    })
    expect(
      result.intake.evidence.sessions.map(session => session.sessionId),
    ).toEqual(['session-alice'])
    expect(result.intake.scopeRef).toBe('user:alice')
    expect(
      result.episodes.every(episode => episode.privacy.scopeRef === 'user:alice'),
    ).toBe(true)
  })

  test('missing sources produce an empty intake instead of failing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-utl-empty-'))
    const result = await collectMatOSUserTestLogIntake({
      cwd: root,
      env: { ...process.env },
    })
    expect(result.intake.stats).toMatchObject({
      sessionCount: 0,
      workflowRunCount: 0,
      daemonJobCount: 0,
      feedbackCount: 0,
      episodeCount: 0,
    })
    expect(result.episodes).toEqual([])
  })

  test('CLI: matos evolve intake user-test-logs --json returns intake and episode ids', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-utl-cli-'))
    await writeFailedComputeSession(root)
    const stdout: string[] = []
    const stderr: string[] = []
    const exitCode = await runMatOSEvolveCommand(
      ['intake', 'user-test-logs', '--since', '24h', '--json'],
      {
        cwd: root,
        env: { ...process.env },
        stdout: text => stdout.push(text),
        stderr: text => stderr.push(text),
      },
    )
    expect(exitCode).toBe(0)
    const parsed = JSON.parse(stdout.join('')) as {
      intakeId: string
      stats: { sessionCount: number; episodeCount: number }
      episodeIds: string[]
    }
    expect(parsed.intakeId).toMatch(/^intake-/)
    expect(parsed.stats.sessionCount).toBe(1)
    expect(parsed.stats.episodeCount).toBeGreaterThan(0)
    expect(parsed.episodeIds.length).toBe(parsed.stats.episodeCount)
  })
})
