import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'
import { createMatOSEventRecorder } from '../sessions/eventRecorder.js'
import { readMatOSSessionEvents } from '../sessions/sessionIndex.js'
import {
  maintainMatOSExperienceAssetsForSession,
  maintainMatOSExperienceAssetsForWorkflowEvidence,
  type MatOSExperienceRefiner,
} from './experienceAssets.js'
import type { MatOSWorkflowEvidence } from './workflowEvidence.js'
import type {
  MatOSUserFeedbackAnalysis,
  MatOSUserFeedbackAnalyzer,
} from './userFeedbackSignals.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

async function writeIsolatedMatOSConfig(root: string): Promise<void> {
  await mkdir(join(root, '.matos'), { recursive: true })
  await Bun.write(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        assetRoots: [],
        includeDefaultAssetRoots: false,
      },
      null,
      2,
    )}\n`,
  )
}

async function recordQueueExperience(
  root: string,
  input: {
    traceId: string
    prompt: string
    toolUseId: string
    resultPreview?: string
  },
): Promise<string> {
  const recorder = await createMatOSEventRecorder(root, {
    command: 'matos --role compute',
    cwd: root,
    traceId: input.traceId,
    roleRef: 'role:compute',
    scopeRef: 'user:alice',
  })
  await recorder.record({
    type: 'matos.turn.started',
    data: { prompt: input.prompt },
  })
  await recorder.record({
    type: 'matos.tool.call.completed',
    data: {
      toolName: 'hpc_submit',
      toolUseId: input.toolUseId,
      isError: true,
      ...(input.resultPreview ? { resultPreview: input.resultPreview } : {}),
    },
  })
  await recorder.record({
    type: 'matos.session.completed',
    data: { exitCode: 0 },
  })
  return recorder.sessionId
}

async function recordGenericBashFailure(root: string): Promise<string> {
  const recorder = await createMatOSEventRecorder(root, {
    command: 'matos --role general',
    cwd: root,
    traceId: 'trace-generic-bash-noise',
    roleRef: 'role:general',
    scopeRef: 'user:alice',
  })
  await recorder.record({
    type: 'matos.tool.call.completed',
    data: {
      toolName: 'Bash',
      toolUseId: 'toolu_bash_1',
      isError: true,
    },
  })
  await recorder.record({
    type: 'matos.session.completed',
    data: { exitCode: 0 },
  })
  await recorder.close()
  return recorder.sessionId
}

describe('MatOS experience evolution provider', () => {

  test('writes LLM-refined experience assets without learning signal side effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-provider-'))
    await writeIsolatedMatOSConfig(root)

    const sessionId = await recordQueueExperience(root, {
      traceId: 'trace-experience-queue-1',
      toolUseId: 'toolu_queue_1',
      prompt:
        '提交失败了，不应该只看历史任务列表。应该先检查队列是否支持 CustomTask 和 idle GPU，然后再提交。这样就对。',
      resultPreview:
        'resource queue allows payload types: OrdinaryDevInstance/RemoteDevInstance excluding CustomTask',
    })

    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'llm-hpc-queue-payload-check',
      mergeKey: 'llm:compute:queue-payload-check',
      name: 'LLM refined queue payload experience',
      summary:
        'LLM summary: verify payload compatibility before submitting queue jobs.',
      scenario: {
        domain: 'compute',
        taskType: 'queue-submission',
        failureMode: 'payload-compatibility',
        appliesWhen: [
          'LLM background: the agent is choosing a queue for a CustomTask.',
        ],
        doesNotApplyWhen: [
          'LLM boundary: the task is only starting a DevInstance.',
        ],
      },
      problemSignals: ['LLM signal: submit error mentions excluding CustomTask.'],
      failureModes: [
        {
          name: 'LLM failure: incompatible payload queue',
          symptoms: ['LLM symptom: queue rejects CustomTask payload.'],
          rootCause:
            'LLM root cause: the agent ranked idle GPUs before queue payload support.',
          avoidance: [
            'LLM avoidance: inspect queue workload types before submit.',
          ],
        },
      ],
      recommendedActions: [
        'LLM action: query queues with the intended payload before YAML generation.',
      ],
      avoidRepeating: [
        'LLM anti-repeat: do not retry a DevInstance-only queue for CustomTask.',
      ],
      checklist: ['LLM checklist: CustomTask support confirmed.'],
      examples: [
        {
          outcome: 'failure-to-success',
          errorSummary:
            'LLM example error: queue allows DevInstance but excludes CustomTask.',
          recoverySummary:
            'LLM recovery: mark incompatible queue and select a compatible idle queue.',
        },
      ],
    })
    await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: `${root}/.matos/sessions/${sessionId}.jsonl`,
      refiner,
    })

    const events = await readMatOSSessionEvents(root, sessionId)
    expect(
      events.filter(event => event.type.startsWith('matos.learning.')),
    ).toEqual([])
    const assets = await loadMatOSAssets(root)
    const experienceAssets = assets.filter(asset => asset.type === 'experience')
    expect(experienceAssets).toHaveLength(1)
    expect(experienceAssets[0]).toMatchObject({
      canonicalKey: 'experience:alice-llm-hpc-queue-payload-check@0.1.0',
      lifecycle: { status: 'draft' },
      metadata: expect.objectContaining({
        sourceFormat: 'matos-experience-llm-v1',
        baseExperienceId: 'llm-hpc-queue-payload-check',
        mergeKey: 'llm:compute:queue-payload-check',
        scope: 'user',
        scopeRef: 'user:alice',
        scenario: expect.objectContaining({
          domain: 'compute',
          taskType: 'queue-submission',
          failureMode: 'payload-compatibility',
        }),
      }),
    })

    const validation = await validateMatOSAssets(assets, { includeDrafts: true })
    expect(validation).toEqual({ ok: true, errors: [] })

    const content = await readFile(
      experienceAssets[0]?.entryAbsolutePath ?? '',
      'utf8',
    )
    expect(content).toContain('## Background And Applicability')
    expect(content).toContain('## Problem Signals')
    expect(content).toContain('## Error Case')
    expect(content).toContain('## Root Cause')
    expect(content).toContain('## Recommended Procedure')
    expect(content).toContain('## Avoid Repeating')
    expect(content).toContain('## Applicability Boundaries')
    expect(content).toContain('## Anti-Regression Checklist')
    expect(content).toContain('LLM background')
    expect(content).toContain('LLM root cause')
    expect(content).toContain('LLM action')
    expect(content).toContain('LLM checklist')
    expect(content).toContain('trace:trace-experience-queue-1')
  })

  test('passes user feedback critic output into the experience refiner and asset metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-provider-feedback-'))
    await writeIsolatedMatOSConfig(root)
    const sessionId = await recordQueueExperience(root, {
      traceId: 'trace-feedback-experience-1',
      toolUseId: 'toolu_feedback_queue_1',
      prompt:
        '不对，agent应该优先找又空闲的队列，本地的gpu优先级别最高。',
      resultPreview: 'resource queue excludes CustomTask',
    })
    const feedbackAnalysis: MatOSUserFeedbackAnalysis = {
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'User feedback supports local idle GPU priority.',
      signals: [
        {
          id: 'feedback-local-gpu-priority',
          kind: 'instruction',
          severity: 'high',
          explicitness: 'explicit',
          claim: 'Prefer local idle GPUs before remote queues.',
          target: {
            assetTypes: ['role', 'skill'],
            roleRefs: ['role:compute'],
            toolNames: ['hpc_submit'],
            workflowRefs: [],
          },
          evidenceExcerpt: '本地的gpu优先级别最高',
          sourceEventRefs: ['event:feedback-turn'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'feedback-local-gpu-priority',
          reasonableness: 'strong',
          evidenceSupport: 'supported',
          generalizability: 'role_specific',
          risk: 'low',
          recommendedAction: 'direct_edit',
          why: 'The trace supports making compute resource selection more explicit.',
          counterArguments: [
            'Remote queues may still be appropriate when local GPUs are busy.',
          ],
          confidence: 0.86,
        },
      ],
    }
    const feedbackCalls: Parameters<MatOSUserFeedbackAnalyzer>[0][] = []
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async input => {
      feedbackCalls.push(input)
      return feedbackAnalysis
    }
    let refinerFeedback: MatOSUserFeedbackAnalysis | undefined
    const refiner: MatOSExperienceRefiner = async input => {
      refinerFeedback = input.feedbackAnalysis
      return {
        shouldWrite: true,
        id: 'compute-local-gpu-priority',
        mergeKey: 'compute:resource-selection:local-gpu-priority',
        name: 'Compute local GPU priority',
        summary: 'Prefer local idle GPUs before remote queues when appropriate.',
        scenario: {
          domain: 'compute',
          taskType: 'resource-selection',
          failureMode: 'remote-queue-before-local-idle-gpu',
          appliesWhen: ['A compute role chooses between local GPUs and queues.'],
          doesNotApplyWhen: ['Local GPUs are busy or unsuitable for the job.'],
        },
        problemSignals: ['User corrected queue selection priority.'],
        failureModes: [
          {
            name: 'Remote queue chosen too early',
            symptoms: ['Queue probing continues while local GPUs are available.'],
            rootCause: 'Resource selection policy did not prioritize local idle GPUs.',
            avoidance: ['Check local GPU idleness before remote queues.'],
          },
        ],
        recommendedActions: ['Prefer local idle GPUs before remote queues.'],
        avoidRepeating: ['Do not keep probing remote queues first.'],
        checklist: ['Local GPU idleness checked.'],
        examples: [
          {
            outcome: 'correction',
            excerpt: '本地的gpu优先级别最高',
          },
        ],
      }
    }

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(
        root,
        '.matos',
        'sessions',
        `${sessionId}.jsonl`,
      ),
      feedbackAnalyzer,
      refiner,
    })

    expect(feedbackCalls).toHaveLength(1)
    expect(refinerFeedback?.decisions[0]?.recommendedAction).toBe('direct_edit')
    expect(refs).toEqual(['experience:alice-compute-local-gpu-priority@0.1.0'])
    const asset = JSON.parse(
      await readFile(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'experiences',
          'alice-compute-local-gpu-priority',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { metadata: Record<string, unknown> }
    expect(asset.metadata.feedbackAnalysis).toEqual(feedbackAnalysis)
    expect(asset.metadata).toMatchObject({
      baseExperienceId: 'compute-local-gpu-priority',
      mergeKey: 'compute:resource-selection:local-gpu-priority',
      scope: 'user',
      scopeRef: 'user:alice',
    })
  })

  test('rejects experience assets when feedback critic output contains secret-like text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-provider-feedback-secret-'))
    await writeIsolatedMatOSConfig(root)
    const sessionId = await recordQueueExperience(root, {
      traceId: 'trace-feedback-secret-1',
      toolUseId: 'toolu_feedback_secret_1',
      prompt: '不对，应该记录这个失败模式。',
      resultPreview: 'queue submit failed',
    })
    const feedbackAnalyzer: MatOSUserFeedbackAnalyzer = async () => ({
      schemaVersion: 1,
      shouldUseFeedback: true,
      summary: 'secret-like feedback must not be persisted',
      signals: [
        {
          id: 'secret-feedback',
          kind: 'correction',
          severity: 'high',
          explicitness: 'explicit',
          claim: 'Do not persist secrets.',
          target: {
            assetTypes: ['skill'],
            roleRefs: [],
            toolNames: [],
            workflowRefs: [],
          },
          evidenceExcerpt: 'api_key=sk-1234567890abcdefghijklmnop',
          sourceEventRefs: ['event:secret'],
          confidence: 0.9,
        },
      ],
      decisions: [
        {
          signalId: 'secret-feedback',
          reasonableness: 'unsafe',
          evidenceSupport: 'supported',
          generalizability: 'one_off',
          risk: 'high',
          recommendedAction: 'ignore',
          why: 'Secret-like text must not be persisted.',
          counterArguments: [],
          confidence: 0.9,
        },
      ],
    })
    const refiner: MatOSExperienceRefiner = async () => ({
      shouldWrite: true,
      id: 'secret-feedback-should-not-write',
      mergeKey: 'security:feedback:secret',
      name: 'Secret feedback should not write',
      summary: 'This should be rejected because feedback has a secret.',
      scenario: {
        domain: 'security',
        taskType: 'feedback',
        failureMode: 'secret-like-feedback',
        appliesWhen: ['feedback contains secret-like content'],
        doesNotApplyWhen: ['feedback is redacted'],
      },
      problemSignals: ['secret-like feedback'],
      failureModes: [
        {
          name: 'Secret-like feedback',
          symptoms: ['secret-like text present'],
          rootCause: 'feedback was not redacted',
          avoidance: ['reject the asset'],
        },
      ],
      recommendedActions: ['reject'],
      avoidRepeating: ['persisting secrets'],
      checklist: ['secret scan passed'],
      examples: [{ outcome: 'rejected' }],
    })

    const refs = await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: join(
        root,
        '.matos',
        'sessions',
        `${sessionId}.jsonl`,
      ),
      feedbackAnalyzer,
      refiner,
    })

    expect(refs).toEqual([])
  })

  test('does not write an asset when the LLM refiner declines', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-provider-skip-'))
    await writeIsolatedMatOSConfig(root)

    const sessionId = await recordQueueExperience(root, {
      traceId: 'trace-experience-skip',
      toolUseId: 'toolu_queue_skip',
      prompt: '这只是普通运行，没有可复用经验。',
      resultPreview: 'short generic failure',
    })

    await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: `${root}/.matos/sessions/${sessionId}.jsonl`,
      refiner: async () => ({
        shouldWrite: false,
        reason: 'No reusable operational experience.',
      }),
    })

    const assets = (await loadMatOSAssets(root)).filter(
      asset => asset.type === 'experience',
    )
    expect(assets).toEqual([])
  })

  test('rejects LLM-refined experience assets that contain secret-like text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-provider-merge-'))
    await writeIsolatedMatOSConfig(root)

    const sessionId = await recordQueueExperience(root, {
      traceId: 'trace-secret-reject',
      toolUseId: 'toolu_secret',
      prompt: '总结经验时不能泄露 token。',
      resultPreview: 'tool failed',
    })
    await maintainMatOSExperienceAssetsForSession({
      cwd: root,
      sessionPath: `${root}/.matos/sessions/${sessionId}.jsonl`,
      refiner: async () => ({
        shouldWrite: true,
        id: 'secret-leak',
        mergeKey: 'secret:leak',
        name: 'Secret leak',
        summary: 'Do not write this sk-1234567890abcdef1234567890abcdef.',
        scenario: {
          domain: 'runtime',
          taskType: 'api-key',
          failureMode: 'leak',
          appliesWhen: ['secret appears'],
          doesNotApplyWhen: ['never'],
        },
        failureModes: [
          {
            name: 'leak',
            symptoms: ['secret-like token appeared'],
            rootCause: 'copied a raw token',
            avoidance: ['redact it'],
          },
        ],
        recommendedActions: ['redact it'],
        avoidRepeating: ['copying raw token'],
        checklist: ['no secret-like content'],
        examples: [{ outcome: 'blocked' }],
      }),
    })

    const assets = (await loadMatOSAssets(root)).filter(
      asset => asset.type === 'experience',
    )
    expect(assets).toEqual([])
  })

  test('does not write generic Bash noise as an experience asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-provider-noise-'))
    await writeIsolatedMatOSConfig(root)
    process.env.MATOS_EXPERIENCE_REFINER = 'off'

    const sessionId = await recordGenericBashFailure(root)

    const events = await readMatOSSessionEvents(root, sessionId)
    expect(
      events.filter(event => event.type.startsWith('matos.learning.')),
    ).toEqual([])
    const assets = (await loadMatOSAssets(root)).filter(
      asset => asset.type === 'experience',
    )
    expect(assets).toEqual([])
  })

  test('writes workflow evidence through the LLM refiner instead of the old template', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-workflow-'))
    await writeIsolatedMatOSConfig(root)
    const evidence: MatOSWorkflowEvidence = {
      schemaVersion: 1,
      evidenceId: 'workflow-evidence-run-llm',
      runId: 'run-llm',
      workflowRef: 'workflow:atomistic-materials-discovery@1.0.0',
      status: 'completed',
      traceId: 'trace-workflow-llm',
      sourceRefs: ['workflow-run:run-llm'],
      nodeSummary: [
        {
          nodeId: 'execute_protocol_plan',
          status: 'completed',
          attempts: 1,
          hasError: false,
        },
      ],
      eventTypes: ['workflow.run.completed'],
      artifactRefs: [],
      suggestedAssetTypes: ['workflow', 'benchmark'],
      createdAt: '2026-06-03T09:50:00.000Z',
    }
    const refiner: MatOSExperienceRefiner = async input => {
      expect(input.events[0]?.data).toMatchObject({
        workflowRef: 'workflow:atomistic-materials-discovery@1.0.0',
        runId: 'run-llm',
      })
      return {
        shouldWrite: true,
        id: 'llm-workflow-agent-experience',
        mergeKey: 'llm:workflow:agent',
        name: 'LLM refined workflow agent experience',
        summary: 'LLM workflow summary: agent workflows verify headless runtime.',
        scenario: {
          domain: 'workflow',
          taskType: 'agent-run',
          failureMode: 'runtime-verification',
          appliesWhen: ['LLM workflow background: running workflow agent cases.'],
          doesNotApplyWhen: ['LLM workflow boundary: non-workflow runs.'],
        },
        problemSignals: ['LLM workflow signal: agent workflow output must be JSON.'],
        failureModes: [
          {
            name: 'LLM workflow failure mode',
            symptoms: ['LLM workflow symptom'],
            rootCause: 'LLM workflow root cause text.',
            avoidance: ['LLM workflow avoidance text.'],
          },
        ],
        recommendedActions: ['LLM workflow action text.'],
        avoidRepeating: ['LLM workflow anti-repeat text.'],
        checklist: ['LLM workflow checklist text.'],
        examples: [{ outcome: 'completed' }],
      }
    }

    await maintainMatOSExperienceAssetsForWorkflowEvidence({
      cwd: root,
      evidence,
      refiner,
    })

    const assets = (await loadMatOSAssets(root)).filter(
      asset => asset.type === 'experience',
    )
    expect(assets).toHaveLength(1)
    expect(assets[0]).toMatchObject({
      canonicalKey: 'experience:llm-workflow-agent-experience@0.1.0',
      metadata: expect.objectContaining({
        sourceFormat: 'matos-experience-llm-v1',
        mergeKey: 'llm:workflow:agent',
      }),
    })
    const content = await readFile(assets[0]?.entryAbsolutePath ?? '', 'utf8')
    expect(content).toContain('LLM workflow background')
    expect(content).toContain('LLM workflow root cause')
    expect(content).toContain('LLM workflow action')
    expect(content).not.toContain('## Soft Policy')
  })
})
