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

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createMatOSAssetHistorySnapshot } from '../assets/history/index.js'
import { git } from '../assets/history/gitBackend.js'
import { runMatOSEvolveCommand } from './evolve.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeProjectConfig(root: string): Promise<void> {
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeJson(join(root, '.matos', 'matos.json'), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
}

async function writeExperience(root: string): Promise<void> {
  const dir = join(root, '.matos', 'assets', 'experiences', 'queue-policy')
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'asset.json'), {
    schemaVersion: 1,
    id: 'queue-policy',
    type: 'experience',
    name: 'Queue Policy',
    version: '0.1.0',
    description: 'Prefer local idle GPUs before remote queues.',
    entry: 'EXPERIENCE.md',
    lifecycle: { status: 'draft' },
    metadata: {
      mergeKey: 'compute:queue-policy',
      evidenceCount: 2,
      signalKinds: ['correction', 'acceptance'],
      evidenceRefs: ['trace:queue-policy'],
      recommendedActions: [
        'Prefer local idle GPUs.',
        'Do not leak /vepfs-mlp2/example-project/private/path or sk-1234567890abcdef.',
      ],
    },
  })
  await writeFile(
    join(dir, 'EXPERIENCE.md'),
    '# Queue Policy\n\nPrefer local idle GPUs.\n',
    'utf8',
  )
}

async function writeDirectEditorRun(
  root: string,
  options: {
    runId?: string
    status?: string
    rawStatus?: string
    statusReason?: string
    createdAt?: string
    updatedAt?: string
    trigger?: { kind: string; key: string }
    usage?: Record<string, number>
    totalCostUsd?: number
    semanticAcceptance?: Record<string, unknown>
    beforeSnapshot?: string
    pendingMerge?: string
    mergeConflicts?: Array<{ path: string; reason: string }>
  } = {},
): Promise<void> {
  const runId = options.runId ?? 'run-1'
  const status = options.status ?? 'edited'
  const createdAt = options.createdAt ?? '2026-06-05T00:00:00.000Z'
  const updatedAt = options.updatedAt ?? createdAt
  const dir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId)
  await mkdir(dir, { recursive: true })
  const record = {
    runId,
    status,
    ...(options.rawStatus ? { rawStatus: options.rawStatus } : {}),
    ...(options.statusReason ? { statusReason: options.statusReason } : {}),
    createdAt,
    updatedAt,
    scope: 'core',
    input: {
      generatedAt: createdAt,
      scope: 'core',
      editableRoots: ['matos-assets/packs/matos-core'],
      ...(options.trigger
        ? {
            currentEvolutionContext: {
              trigger: { ...options.trigger, summary: 'Trigger summary.' },
            },
          }
        : {}),
      experiences: [],
      targetAssets: [],
    },
    editorOutput: {
      summary: 'Updated compute role.',
      modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
      createdAssets: [],
      updatedAssets: ['role:compute@1.0.0'],
      disabledAssets: [],
      evidenceRefs: ['experience:queue-policy@0.1.0'],
    },
    modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
    createdAssets: [],
    updatedAssets: ['role:compute@1.0.0'],
    disabledAssets: [],
    evidenceRefs: ['experience:queue-policy@0.1.0'],
    roleExitCode: 0,
    ...(options.beforeSnapshot ? { beforeSnapshot: options.beforeSnapshot } : {}),
    ...(options.pendingMerge ? { pendingMerge: options.pendingMerge } : {}),
    ...(options.mergeConflicts ? { mergeConflicts: options.mergeConflicts } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.totalCostUsd !== undefined
      ? { totalCostUsd: options.totalCostUsd }
      : {}),
    ...(options.semanticAcceptance
      ? { semanticAcceptance: options.semanticAcceptance }
      : {}),
  }
  await writeJson(join(dir, 'run.json'), record)
}

async function writeResolvableDirectEditorPendingMerge(root: string): Promise<{
  runId: string
  rolePath: string
}> {
  const runId = 'run-resolvable-merge'
  const rolePath = await writeCoreComputeRole(root, 'Base guidance.')
  const stable = await createMatOSAssetHistorySnapshot({
    cwd: root,
    kind: 'manual',
    scope: 'core',
  })
  await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
  await writeFile(rolePath, '# Compute\n\nDeveloper guidance.\n', 'utf8')
  const before = await createMatOSAssetHistorySnapshot({
    cwd: root,
    kind: 'direct-editor-before',
    scope: 'core',
  })
  const pendingPath = `.matos/evolution/direct-editor/pending-merges/${runId}/record.json`
  const conflict = {
    path: 'matos-assets/packs/matos-core/roles/compute/ROLE.md',
    reason: 'same hunk changed in current assets and direct-editor output',
  }
  await writeDirectEditorRun(root, {
    runId,
    status: 'pending_merge',
    beforeSnapshot: before.snapshotId,
    pendingMerge: pendingPath,
    mergeConflicts: [conflict],
  })
  const dir = join(root, '.matos', 'evolution', 'direct-editor', 'pending-merges', runId)
  await mkdir(join(dir, 'files'), { recursive: true })
  await writeFile(join(dir, 'files', 'compute-role.base'), '# Compute\n\nBase guidance.\n', 'utf8')
  await writeFile(join(dir, 'files', 'compute-role.current'), '# Compute\n\nDeveloper guidance.\n', 'utf8')
  await writeFile(join(dir, 'files', 'compute-role.edit'), '# Compute\n\nSelf-evolved guidance.\n', 'utf8')
  await writeJson(join(dir, 'record.json'), {
    schemaVersion: 1,
    runId,
    status: 'pending',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    scope: 'core',
    mergeMode: 'conflict',
    dirtyFilesAtStart: [conflict.path],
    conflicts: [conflict],
    files: [
      {
        path: conflict.path,
        basePath: 'files/compute-role.base',
        baseKind: 'file',
        currentPath: 'files/compute-role.current',
        currentKind: 'file',
        editPath: 'files/compute-role.edit',
        editKind: 'file',
      },
    ],
    runRecordPath: `.matos/evolution/direct-editor/runs/${runId}/run.json`,
  })
  return { runId, rolePath }
}

async function writeDirectEditorPendingMerge(root: string): Promise<void> {
  const runId = 'run-pending-merge'
  const dir = join(root, '.matos', 'evolution', 'direct-editor', 'pending-merges', runId)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'record.json'), {
    schemaVersion: 1,
    runId,
    status: 'pending',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
    scope: 'core',
    mergeMode: 'conflict',
    dirtyFilesAtStart: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
    conflicts: [
      {
        path: 'matos-assets/packs/matos-core/roles/compute/ROLE.md',
        reason: 'same hunk changed in current assets and direct-editor output',
      },
    ],
    files: [
      {
        path: 'matos-assets/packs/matos-core/roles/compute/ROLE.md',
        basePath: 'files/compute-role.base',
        currentPath: 'files/compute-role.current',
        editPath: 'files/compute-role.edit',
      },
    ],
    runRecordPath: '.matos/evolution/direct-editor/runs/run-pending-merge/run.json',
    giteaReview: {
      provider: 'gitea',
      status: 'created',
      owner: 'matos-core',
      repo: 'assets',
      branch: 'evolution/run-pending-merge',
      baseBranch: 'main',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
      pullRequest: {
        number: 12,
        url: 'https://matos.top/git/matos-core/assets/pulls/12',
        state: 'open',
      },
    },
  })
}

async function writeEvolutionRoleCache(root: string): Promise<void> {
  const dir = join(root, '.matos', 'evolution', 'role-run-cache')
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'role-feedback-critic.json'), {
    schemaVersion: 1,
    cache: {
      key: 'role-feedback-critic',
      hit: false,
      path: '.matos/evolution/role-run-cache/role-feedback-critic.json',
      promptVersion: 'matos-evolution-role-cache-v1',
      roleReference: 'role:user-feedback-critic',
      modelId: 'deepseek-v4-pro[1m]',
      inputHash: 'a'.repeat(64),
    },
    result: {
      exitCode: 0,
      roleReference: 'role:user-feedback-critic',
      resultText: '{"shouldUseFeedback":true}',
      parsedResult: { shouldUseFeedback: true },
      stdout: '',
      stderr: '',
      upstreamSessionId: 'hidden-critic-session',
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 30,
      },
      totalCostUsd: 0.01,
    },
    createdAt: '2026-06-05T00:00:00.000Z',
  })
}

async function writeMonitorRecord(root: string): Promise<void> {
  const dir = join(root, '.matos', 'evolution', 'monitor', 'sessions', 'session-1')
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'records.jsonl'),
    `${JSON.stringify({
      recordId: 'monitor-1',
      sessionId: 'session-1',
      triggerKind: 'tool-failure',
      triggerKey: 'tool-failure:event-1',
      status: 'analysis-complete',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
      summary: 'Tool failure triggered self-evolution analysis.',
      eventId: 'event-1',
      feedbackAnalysis: {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'Full critic output.',
        signals: [],
        decisions: [],
      },
    })}\n`,
    'utf8',
  )
}

async function writeCoreComputeRole(root: string, body = 'Before guidance.'): Promise<string> {
  const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
  await mkdir(roleDir, { recursive: true })
  await writeJson(join(roleDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'compute',
    type: 'role',
    name: 'Compute',
    version: '0.1.0',
    entry: 'ROLE.md',
  })
  const rolePath = join(roleDir, 'ROLE.md')
  await writeFile(rolePath, `# Compute\n\n${body}\n`, 'utf8')
  return rolePath
}

describe('matos evolve CLI', () => {
  test('prints nested help without executing expensive evolve subcommands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-help-'))
    await writeProjectConfig(root)

    for (const args of [
      ['direct-editor', '--help'],
      ['direct-editor', 'list', '--help'],
      ['monitor', '--help'],
      ['monitor', 'list', '--help'],
      ['daily-report', '--help'],
    ] as const) {
      const stdout: string[] = []
      const stderr: string[] = []
      expect(
        await runMatOSEvolveCommand([...args], {
          cwd: root,
          stdout: chunk => stdout.push(chunk),
          stderr: chunk => stderr.push(chunk),
          env: {},
        }),
      ).toBe(0)
      expect(stdout.join('')).toContain('Usage:')
      expect(stdout.join('')).not.toContain('No MatOS')
      expect(stdout.join('')).not.toContain('usersScanned=')
      expect(stderr.join('')).toBe('')
    }
  })

  test('reports self-evolution status as json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-status-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeDirectEditorRun(root)
    await writeMonitorRecord(root)
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      provider: string
      directEditScope: string
      directEditScopePolicy?: string
      experienceCount: number
      directEditorRunCount: number
      monitorRecordCount: number
    }
    expect(parsed.provider).toBe('direct-editor')
    expect(parsed.directEditScope).toBe('runtime-scope')
    expect(parsed.directEditScopePolicy).toBe(
      'user/team/project scope first; core only for explicit core/developer runs',
    )
    expect(parsed.experienceCount).toBe(1)
    expect(parsed.directEditorRunCount).toBe(1)
    expect(parsed.monitorRecordCount).toBe(1)
    expect((parsed as { directEditorStatusCounts?: Record<string, number> }).directEditorStatusCounts).toMatchObject({
      edited: 1,
    })
  })

  test('reports legacy provider1 promotion packets as ignored status evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-legacy-provider1-'))
    await writeProjectConfig(root)
    const legacyDir = join(
      root,
      '.matos',
      'internal',
      'evolution',
      'promotion-packets',
    )
    await mkdir(legacyDir, { recursive: true })
    await writeJson(join(legacyDir, 'packet-a.json'), {
      packetId: 'packet-a',
      status: 'ready_for_review',
      evidenceRefs: ['experience:bash-enospc-cascade-recovery@0.1.0'],
    })
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      legacyProvider1?: {
        removed: boolean
        ignored: boolean
        promotionPacketCount: number
        statusCounts: Record<string, number>
        replacementCommands: string[]
      }
    }
    expect(parsed.legacyProvider1).toMatchObject({
      removed: true,
      ignored: true,
      promotionPacketCount: 1,
      statusCounts: {
        ready_for_review: 1,
      },
    })
    expect(parsed.legacyProvider1?.replacementCommands).toContain(
      'matos evolve experiences list --json',
    )
  })

  test('status distinguishes the active experience/direct-editor pipeline from legacy blocked evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-current-pipeline-'))
    await writeProjectConfig(root)
    await writeDirectEditorRun(root, {
      runId: 'run-accepted',
      status: 'accepted_merged',
    })
    await writeDirectEditorRun(root, {
      runId: 'run-legacy-dirty',
      status: 'blocked',
      rawStatus: 'failed',
      statusReason: 'legacy_dirty_preflight',
    })
    await writeDirectEditorRun(root, {
      runId: 'run-active-pending',
      status: 'pending_merge',
    })
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      activePipeline?: {
        provider: string
        legacyProvider1Active: boolean
        evidenceAssets: string[]
        optionalEvidenceAssets: string[]
        experienceLayerDefault: string
        editableTargets: string[]
      }
      directEditorEffectiveness?: {
        effectiveCount: number
        activeBlockedCount: number
        legacyBlockedCount: number
        summary?: string
      }
      directEditorStatusCounts?: Record<string, number>
      directEditorActiveStatusCounts?: Record<string, number>
      directEditorLegacyStatusCounts?: Record<string, number>
      directEditorBlockedCount?: number
      directEditorActiveBlockedCount?: number
      directEditorLegacyBlockedCount?: number
      legacyProvider1?: {
        removed: boolean
        ignored: boolean
        active: boolean
      }
    }
    expect(parsed.activePipeline).toMatchObject({
      provider: 'direct-editor',
      evidenceAssets: [],
      optionalEvidenceAssets: ['experience'],
      experienceLayerDefault: 'disabled',
      legacyProvider1Active: false,
      editableTargets: ['role', 'skill', 'workflow', 'tool', 'mcp', 'knowledge'],
    })
    expect(parsed.legacyProvider1).toMatchObject({
      removed: true,
      ignored: true,
      active: false,
    })
    expect(parsed.directEditorEffectiveness).toMatchObject({
      effectiveCount: 1,
      activeBlockedCount: 1,
      legacyBlockedCount: 1,
    })
    expect(parsed.directEditorEffectiveness?.summary).toContain(
      'Legacy blocked direct-editor records are historical dirty-preflight evidence',
    )
    expect(parsed.directEditorStatusCounts).toMatchObject({
      blocked: 1,
      pending_merge: 1,
      accepted_merged: 1,
    })
    expect(parsed.directEditorActiveStatusCounts).toMatchObject({
      pending_merge: 1,
      accepted_merged: 1,
    })
    expect(parsed.directEditorActiveStatusCounts?.blocked ?? 0).toBe(0)
    expect(parsed.directEditorLegacyStatusCounts).toMatchObject({
      blocked: 1,
    })
    expect(parsed.directEditorBlockedCount).toBe(2)
    expect(parsed.directEditorActiveBlockedCount).toBe(1)
    expect(parsed.directEditorLegacyBlockedCount).toBe(1)
  })

  test('reports direct editor blocked and failed counts separately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-status-counts-'))
    await writeProjectConfig(root)
    await writeDirectEditorRun(root, { runId: 'run-accepted', status: 'accepted' })
    await writeDirectEditorRun(root, { runId: 'run-blocked', status: 'blocked' })
    await writeDirectEditorRun(root, { runId: 'run-failed', status: 'failed' })
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      directEditorRunCount: number
      directEditorStatusCounts: Record<string, number>
      directEditorActiveStatusCounts: Record<string, number>
      directEditorLegacyStatusCounts: Record<string, number>
      directEditorBlockedCount: number
      directEditorActiveBlockedCount: number
      directEditorLegacyBlockedCount: number
      directEditorFailedCount: number
    }
    expect(parsed.directEditorRunCount).toBe(3)
    expect(parsed.directEditorStatusCounts).toMatchObject({
      accepted: 1,
      blocked: 1,
      failed: 1,
    })
    expect(parsed.directEditorBlockedCount).toBe(1)
    expect(parsed.directEditorActiveBlockedCount).toBe(1)
    expect(parsed.directEditorLegacyBlockedCount).toBe(0)
    expect(parsed.directEditorActiveStatusCounts).toMatchObject({
      accepted: 1,
      blocked: 1,
      failed: 1,
    })
    expect(parsed.directEditorLegacyStatusCounts).toEqual({})
    expect(parsed.directEditorFailedCount).toBe(1)
  })

  test('does not count interrupted edited/validated checkpoints as effective', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-effective-statuses-'))
    await writeProjectConfig(root)
    await writeDirectEditorRun(root, { runId: 'run-edited', status: 'edited' })
    await writeDirectEditorRun(root, { runId: 'run-validated', status: 'validated' })
    await writeDirectEditorRun(root, { runId: 'run-accepted', status: 'accepted' })
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      directEditorEffectiveness?: {
        effectiveCount: number
        acceptedCount: number
        editedCount: number
      }
    }
    // edited/validated are interrupted-checkpoint statuses of crashed
    // finalizes, not terminal successes; only accepted(+merged) is effective.
    expect(parsed.directEditorEffectiveness).toMatchObject({
      effectiveCount: 1,
      acceptedCount: 1,
      editedCount: 2,
    })
  })

  test('reports post-acceptance trigger-key recurrence in status output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-status-recurrence-'))
    await writeProjectConfig(root)
    const acceptedAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
    const recurredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await writeDirectEditorRun(root, {
      runId: 'run-recurred',
      status: 'accepted',
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-recur' },
    })
    await writeDirectEditorRun(root, {
      runId: 'run-quiet',
      status: 'accepted',
      createdAt: acceptedAt,
      updatedAt: acceptedAt,
      trigger: { kind: 'session-end', key: 'session-end:sess-quiet' },
    })
    const monitorDir = join(
      root,
      '.matos',
      'evolution',
      'monitor',
      'sessions',
      'sess-recur',
    )
    await mkdir(monitorDir, { recursive: true })
    await writeFile(
      join(monitorDir, 'records.jsonl'),
      `${JSON.stringify({
        recordId: 'monitor-refire',
        sessionId: 'sess-recur',
        triggerKind: 'session-end',
        triggerKey: 'session-end:sess-recur',
        status: 'detected',
        createdAt: recurredAt,
        updatedAt: recurredAt,
        summary: 'Same trigger fired again after acceptance.',
      })}\n`,
      'utf8',
    )
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      effectivenessRecurrence?: {
        acceptedTotal: number
        quiet: number
        recurred: number
        unknown: number
        recurrenceRate: number
        lookbackDays: number
        perRun: Array<{
          runId: string
          classification: string
          triggerKey?: string
          recurredAt?: string
        }>
      }
    }
    expect(parsed.effectivenessRecurrence).toMatchObject({
      acceptedTotal: 2,
      quiet: 0,
      recurred: 1,
      unknown: 1,
      recurrenceRate: 1,
      lookbackDays: 30,
    })
    const byRunId = new Map(
      (parsed.effectivenessRecurrence?.perRun ?? []).map(entry => [
        entry.runId,
        entry,
      ]),
    )
    expect(byRunId.get('run-recurred')).toMatchObject({
      classification: 'recurred',
      triggerKey: 'session-end:sess-recur',
      recurredAt,
    })
    expect(byRunId.get('run-quiet')).toMatchObject({ classification: 'unknown' })

    const humanOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['status'], {
        cwd: root,
        stdout: chunk => humanOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    expect(humanOutput.join('')).toContain(
      'effectivenessRecurrence=accepted:2 quiet:0 recurred:1 unknown:1 rate:1 lookbackDays:30',
    )
  })

  test('reports direct editor stable baseline health', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-status-health-'))
    await writeProjectConfig(root)
    const rolePath = await writeCoreComputeRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await writeFile(rolePath, '# Compute\n\nNormal asset update.\n', 'utf8')
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['status', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      directEditorHealth?: {
        status: string
        needsRebaseline: boolean
        currentDiffersFromStable: boolean
        stableSnapshot?: string
        stableCommit?: string
      }
    }
    expect(parsed.directEditorHealth).toMatchObject({
      status: 'needs_rebaseline',
      needsRebaseline: true,
      currentDiffersFromStable: true,
      stableSnapshot: stable.snapshotId,
      stableCommit: stable.commit,
    })
  })

  test('reports hidden self-evolution token cost ledger as json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-cost-'))
    await writeProjectConfig(root)
    await writeEvolutionRoleCache(root)
    await writeDirectEditorRun(root, {
      runId: 'run-cost',
      status: 'accepted',
      usage: {
        input_tokens: 50,
        output_tokens: 10,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 5,
      },
      totalCostUsd: 0.02,
      semanticAcceptance: {
        schemaVersion: 1,
        verdict: 'accept',
        confidence: 0.9,
        reason: 'useful reusable update',
        resolvedUserProblem: true,
        overfitRisk: 'low',
        assetPollutionRisk: 'low',
        missingEvidence: [],
        recommendedFollowup: [],
        judgeRoleExitCode: 0,
        createdAt: '2026-06-05T00:00:10.000Z',
        upstreamSessionId: 'hidden-judge-session',
        usage: {
          input_tokens: 40,
          output_tokens: 8,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 4,
        },
        totalCostUsd: 0.03,
      },
    })
    const output: string[] = []

    const exitCode = await runMatOSEvolveCommand(['cost', '--json'], {
      cwd: root,
      stdout: chunk => output.push(chunk),
      stderr: () => {},
      env: {},
    })

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      totals: {
        recordCount: number
        totalTokens: number
        inputTokens: number
        outputTokens: number
        cacheCreationInputTokens: number
        cacheReadInputTokens: number
        totalCostUsd: number
      }
      byStage: Record<string, { recordCount: number; totalTokens: number; totalCostUsd: number }>
      records: Array<{ stage: string; totalTokens: number; totalCostUsd: number }>
    }
    expect(parsed.totals).toMatchObject({
      recordCount: 3,
      totalTokens: 272,
      inputTokens: 190,
      outputTokens: 38,
      cacheCreationInputTokens: 5,
      cacheReadInputTokens: 39,
      totalCostUsd: 0.06,
    })
    expect(parsed.byStage['role:user-feedback-critic']).toMatchObject({
      recordCount: 1,
      totalTokens: 155,
      totalCostUsd: 0.01,
    })
    expect(parsed.byStage['direct-asset-editor']).toMatchObject({
      recordCount: 1,
      totalTokens: 65,
      totalCostUsd: 0.02,
    })
    expect(parsed.byStage['semantic-acceptance-judge']).toMatchObject({
      recordCount: 1,
      totalTokens: 52,
      totalCostUsd: 0.03,
    })
    expect(parsed.records).toHaveLength(3)
  })

  test('lists and shows experience assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-experience-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['experiences', 'list', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const listed = JSON.parse(output.join('')) as {
      experiences: Array<{ ref: string; manifestPath: string; metadata: unknown }>
    }
    expect(listed.experiences[0]?.ref).toBe('experience:queue-policy@0.1.0')
    expect(listed.experiences[0]?.manifestPath).toContain('<workspace>/')
    expect(output.join('')).not.toContain(root)
    expect(output.join('')).not.toContain('/vepfs-mlp2')
    expect(output.join('')).not.toContain('sk-1234567890abcdef')

    output.length = 0
    expect(
      await runMatOSEvolveCommand(
        ['experiences', 'show', 'queue-policy', '--json'],
        {
          cwd: root,
          stdout: chunk => output.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)
    const shown = JSON.parse(output.join('')) as {
      experience: { ref: string; name: string }
    }
    expect(shown.experience.ref).toBe('experience:queue-policy@0.1.0')
    expect(shown.experience.name).toBe('Queue Policy')
  })

  test('lists compact evolution records with pagination for webviews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-compact-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeDirectEditorRun(root)
    await writeMonitorRecord(root)

    const experienceOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['experiences', 'list', '--compact', '--limit', '1', '--json'],
        {
          cwd: root,
          stdout: chunk => experienceOutput.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)
    const experiences = JSON.parse(experienceOutput.join('')) as {
      experiences: Array<{ ref: string; metadata?: unknown }>
      page: { limit: number; total: number }
    }
    expect(experiences.experiences).toHaveLength(1)
    expect(experiences.experiences[0]?.ref).toBe('experience:queue-policy@0.1.0')
    expect(experiences.experiences[0]?.metadata).toBeUndefined()
    expect(experiences.page).toMatchObject({ limit: 1, total: 1 })

    const runOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['direct-editor', 'list', '--compact', '--limit', '1', '--json'],
        {
          cwd: root,
          stdout: chunk => runOutput.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)
    const runs = JSON.parse(runOutput.join('')) as {
      runs: Array<{ runId: string; summary?: string; editorOutput?: unknown }>
    }
    expect(runs.runs[0]).toMatchObject({
      runId: 'run-1',
      summary: 'Updated compute role.',
    })
    expect(runs.runs[0]?.editorOutput).toBeUndefined()

    const monitorOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['monitor', 'list', '--compact', '--limit', '1', '--json'],
        {
          cwd: root,
          stdout: chunk => monitorOutput.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)
    const records = JSON.parse(monitorOutput.join('')) as {
      records: Array<{ recordId: string; feedbackAnalysis?: unknown }>
    }
    expect(records.records[0]?.recordId).toBe('monitor-1')
    expect(records.records[0]?.feedbackAnalysis).toBeUndefined()
  })

  test('lists and shows direct editor runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-'))
    await writeProjectConfig(root)
    await writeDirectEditorRun(root)
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['direct-editor', 'list', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const listed = JSON.parse(output.join('')) as {
      runs: Array<{ runId: string; status: string }>
    }
    expect(listed.runs[0]).toMatchObject({ runId: 'run-1', status: 'edited' })

    output.length = 0
    expect(
      await runMatOSEvolveCommand(['direct-editor', 'show', 'run-1', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const shown = JSON.parse(output.join('')) as {
      run: { runId: string; editorOutput: { summary: string } }
    }
    expect(shown.run.runId).toBe('run-1')
    expect(shown.run.editorOutput.summary).toContain('Updated compute role')
  })

  test('recovers an interrupted direct editor run from the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-recover-'))
    await writeProjectConfig(root)
    await writeCoreComputeRole(root)
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'core',
    })
    await writeDirectEditorRun(root, {
      runId: 'run-recover',
      status: 'validated',
      beforeSnapshot: before.snapshotId,
    })
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(
        ['direct-editor', 'recover', 'run-recover', '--json'],
        {
          cwd: root,
          stdout: chunk => output.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)

    const parsed = JSON.parse(output.join('')) as {
      run: { runId: string; status: string; statusReason?: string }
    }
    expect(parsed.run).toMatchObject({
      runId: 'run-recover',
      status: 'noop',
      statusReason: 'interrupted_finalize_recovered_no_changes',
    })
  })

  test('lists and shows pending direct editor merge records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-merge-'))
    await writeProjectConfig(root)
    await writeDirectEditorPendingMerge(root)
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['direct-editor', 'merge', 'list', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const listed = JSON.parse(output.join('')) as {
      pendingMerges: Array<{
        runId: string
        status: string
        conflicts: Array<{ path: string }>
        giteaReview?: { pullRequest?: { url?: string } }
      }>
    }
    expect(listed.pendingMerges[0]).toMatchObject({
      runId: 'run-pending-merge',
      status: 'pending',
      giteaReview: {
        pullRequest: {
          url: 'https://matos.top/git/matos-core/assets/pulls/12',
        },
      },
      conflicts: [
        {
          path: 'matos-assets/packs/matos-core/roles/compute/ROLE.md',
        },
      ],
    })

    output.length = 0
    expect(
      await runMatOSEvolveCommand(['direct-editor', 'merge', 'show', 'run-pending-merge', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const shown = JSON.parse(output.join('')) as {
      pendingMerge: {
        runId: string
        mergeMode: string
        dirtyFilesAtStart: string[]
        giteaReview?: { pullRequest?: { url?: string } }
      }
    }
    expect(shown.pendingMerge).toMatchObject({
      runId: 'run-pending-merge',
      mergeMode: 'conflict',
      dirtyFilesAtStart: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
      giteaReview: {
        pullRequest: {
          url: 'https://matos.top/git/matos-core/assets/pulls/12',
        },
      },
    })

    output.length = 0
    expect(
      await runMatOSEvolveCommand(['direct-editor', 'merge', 'list'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    expect(output.join('')).toContain(
      'pr=https://matos.top/git/matos-core/assets/pulls/12',
    )
  })

  test('applies a direct editor pending merge from the CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-merge-apply-'))
    await writeProjectConfig(root)
    const { runId, rolePath } = await writeResolvableDirectEditorPendingMerge(root)
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(
        ['direct-editor', 'merge', 'apply', runId, 'edit', '--json'],
        {
          cwd: root,
          stdout: chunk => output.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)

    const parsed = JSON.parse(output.join('')) as {
      result: {
        status: string
        strategy: string
        run: { status: string; statusReason?: string; pendingMerge?: string }
      }
    }
    expect(parsed.result).toMatchObject({
      status: 'applied',
      strategy: 'edit',
      run: {
        status: 'accepted_merged',
        statusReason: 'pending_merge_applied_edit',
      },
    })
    expect(parsed.result.run.pendingMerge).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\nSelf-evolved guidance.\n')

    output.length = 0
    expect(
      await runMatOSEvolveCommand(['direct-editor', 'merge', 'list', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const listed = JSON.parse(output.join('')) as { pendingMerges: unknown[] }
    expect(listed.pendingMerges).toHaveLength(0)
  })

  test('rebaselines direct editor stable scope from the current core assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-rebaseline-'))
    await writeProjectConfig(root)
    const rolePath = await writeCoreComputeRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await writeFile(rolePath, '# Compute\n\nNormal asset update.\n', 'utf8')
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['direct-editor', 'rebaseline', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)

    const parsed = JSON.parse(output.join('')) as {
      rebaseline: { status: string; snapshot: { commit: string }; validation: { ok: boolean } }
    }
    expect(parsed.rebaseline.status).toBe('updated')
    expect(parsed.rebaseline.validation.ok).toBe(true)
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(parsed.rebaseline.snapshot.commit)
  })

  test('syncs stale direct editor stable scope after developer asset edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-sync-'))
    await writeProjectConfig(root)
    const rolePath = await writeCoreComputeRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await writeFile(rolePath, '# Compute\n\nDeveloper-approved guidance.\n', 'utf8')
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['direct-editor', 'sync', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)

    const parsed = JSON.parse(output.join('')) as {
      sync: {
        status: string
        scope: string
        healthBefore: { status: string; needsRebaseline: boolean }
        rebaseline?: { status: string; snapshot: { commit: string }; validation: { ok: boolean } }
        healthAfter?: { status: string; needsRebaseline: boolean; stableSnapshot?: string }
      }
    }
    expect(parsed.sync).toMatchObject({
      status: 'updated',
      scope: 'core',
      healthBefore: {
        status: 'needs_rebaseline',
        needsRebaseline: true,
      },
      healthAfter: {
        status: 'ready',
        needsRebaseline: false,
      },
    })
    expect(parsed.sync.rebaseline?.status).toBe('updated')
    expect(parsed.sync.rebaseline?.validation.ok).toBe(true)
    expect(parsed.sync.rebaseline?.snapshot).toBeDefined()
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(parsed.sync.rebaseline!.snapshot!.commit)
  })

  test('sync reports current when developer assets already match stable baseline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-sync-current-'))
    await writeProjectConfig(root)
    await writeCoreComputeRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['direct-editor', 'sync', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)

    const parsed = JSON.parse(output.join('')) as {
      sync: {
        status: string
        healthBefore: { status: string; needsRebaseline: boolean }
        healthAfter?: { status: string; needsRebaseline: boolean }
        rebaseline?: unknown
      }
    }
    expect(parsed.sync.status).toBe('current')
    expect(parsed.sync.healthBefore).toMatchObject({
      status: 'ready',
      needsRebaseline: false,
    })
    expect(parsed.sync.healthAfter).toMatchObject({
      status: 'ready',
      needsRebaseline: false,
    })
    expect(parsed.sync.rebaseline).toBeUndefined()
  })

  test('rolls back a direct editor run from its before snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-direct-editor-rollback-'))
    await writeProjectConfig(root)
    const roleDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    await mkdir(roleDir, { recursive: true })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '0.1.0',
      entry: 'ROLE.md',
    })
    const rolePath = join(roleDir, 'ROLE.md')
    await writeFile(rolePath, '# Compute\n\nBefore guidance.\n', 'utf8')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'core',
    })
    await writeFile(rolePath, '# Compute\n\nAfter bad guidance.\n', 'utf8')
    const after = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-after',
      scope: 'core',
      parentCommit: before.commit,
    })
    const runDir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', 'run-rollback')
    await mkdir(runDir, { recursive: true })
    await writeJson(join(runDir, 'run.json'), {
      runId: 'run-rollback',
      status: 'validated',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
      scope: 'core',
      beforeSnapshot: before.snapshotId,
      afterSnapshot: after.snapshotId,
      input: {
        generatedAt: '2026-06-05T00:00:00.000Z',
        scope: 'core',
        editableRoots: ['matos-assets/packs/matos-core'],
        experiences: [],
        targetAssets: [],
      },
      editorOutput: {
        summary: 'Bad update.',
        modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
        createdAssets: [],
        updatedAssets: ['role:compute@0.1.0'],
        disabledAssets: [],
        evidenceRefs: [],
      },
      modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
      createdAssets: [],
      updatedAssets: ['role:compute@0.1.0'],
      disabledAssets: [],
      evidenceRefs: [],
      roleExitCode: 0,
    })
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(
        ['direct-editor', 'rollback', 'run-rollback', '--json'],
        {
          cwd: root,
          stdout: chunk => output.push(chunk),
          stderr: () => {},
        },
      ),
    ).toBe(0)

    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\nBefore guidance.\n')
    const parsed = JSON.parse(output.join('')) as {
      run: { status: string; rollbackSnapshot: string }
    }
    expect(parsed.run.status).toBe('rolled_back')
    expect(parsed.run.rollbackSnapshot).toMatch(/^asset-snapshot-/)
  })

  test('lists and shows live self-evolution monitor records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-monitor-'))
    await writeProjectConfig(root)
    await writeMonitorRecord(root)
    const output: string[] = []

    expect(
      await runMatOSEvolveCommand(['monitor', 'list', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const listed = JSON.parse(output.join('')) as {
      records: Array<{ recordId: string; status: string }>
    }
    expect(listed.records[0]).toMatchObject({
      recordId: 'monitor-1',
      status: 'analysis-complete',
    })

    output.length = 0
    expect(
      await runMatOSEvolveCommand(['monitor', 'show', 'monitor-1', '--json'], {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
      }),
    ).toBe(0)
    const shown = JSON.parse(output.join('')) as {
      record: { recordId: string; feedbackAnalysis: { summary: string } }
    }
    expect(shown.record.feedbackAnalysis.summary).toBe('Full critic output.')
  })

  test('lists and shows workflow replay candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-replay-'))
    await writeProjectConfig(root)
    const dir = join(
      root,
      '.matos',
      'evolution',
      'replay-candidates',
      'replay-run-demo',
    )
    await mkdir(join(dir, 'benchmark'), { recursive: true })
    await writeJson(join(dir, 'candidate.json'), {
      schemaVersion: 1,
      candidateId: 'replay-run-demo',
      status: 'draft',
      trigger: 'workflow-failed',
      workflowRef: 'workflow:demo@0.1.0',
      runId: 'run-demo',
      runStatus: 'failed',
      evidenceId: 'workflow-evidence-run-demo',
      failedNodeIds: ['broken_step'],
      failureSignature: 'a'.repeat(64),
      benchmarkCaseId: 'replay-run-demo',
      provenance: {
        evidenceRef: 'workflow-evidence:workflow-evidence-run-demo',
        runRef: 'workflow-run:run-demo',
        sourceRefs: ['workflow-run:run-demo'],
      },
      files: {
        candidate: 'candidate.json',
        failureSignature: 'failure_signature.json',
        repairStrategy: 'repair_strategy.json',
        replayPlan: 'replay_plan.json',
        benchmarkCase: 'benchmark/case.json',
      },
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T00:00:00.000Z',
    })
    const listOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['replay-candidates', 'list', '--json'], {
        cwd: root,
        stdout: chunk => listOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    const listed = JSON.parse(listOutput.join('')) as {
      candidates: Array<{ candidateId: string; trigger: string }>
    }
    expect(listed.candidates).toHaveLength(1)
    expect(listed.candidates[0]?.candidateId).toBe('replay-run-demo')
    expect(listed.candidates[0]?.trigger).toBe('workflow-failed')

    const showOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['replay-candidates', 'show', 'replay-run-demo', '--json'],
        {
          cwd: root,
          stdout: chunk => showOutput.push(chunk),
          stderr: () => {},
          env: {},
        },
      ),
    ).toBe(0)
    const shown = JSON.parse(showOutput.join('')) as {
      candidate: { workflowRef: string; failedNodeIds: string[] }
    }
    expect(shown.candidate.workflowRef).toBe('workflow:demo@0.1.0')
    expect(shown.candidate.failedNodeIds).toEqual(['broken_step'])

    const statusOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['status', '--json'], {
        cwd: root,
        stdout: chunk => statusOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    expect(
      (JSON.parse(statusOutput.join('')) as { replayCandidateCount: number })
        .replayCandidateCount,
    ).toBe(1)
  })

  test('lists and shows replay clusters and improvement candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-replay-cluster-'))
    await writeProjectConfig(root)
    const signature = 'b'.repeat(64)
    const clusterId = `cluster-${signature.slice(0, 16)}`
    const clusterDir = join(root, '.matos', 'evolution', 'replay-clusters', clusterId)
    await mkdir(clusterDir, { recursive: true })
    await writeJson(join(clusterDir, 'cluster.json'), {
      schemaVersion: 1,
      clusterId,
      status: 'open',
      workflowRef: 'workflow:demo@0.1.0',
      failureSignature: signature,
      occurrences: 2,
      candidateIds: ['replay-run-a', 'replay-run-b'],
      runIds: ['run-a', 'run-b'],
      firstSeenAt: '2026-06-10T00:00:00.000Z',
      lastSeenAt: '2026-06-10T01:00:00.000Z',
      proposal: {
        kind: 'repeated-failure',
        summary: 'Workflow workflow:demo@0.1.0 failed 2 times with the same failure signature.',
        suggestedTargets: ['workflow', 'skill'],
      },
    })
    const improvementId = `stable-improvement-${signature.slice(0, 16)}`
    const improvementDir = join(
      root,
      '.matos',
      'evolution',
      'stable-improvement-candidates',
      improvementId,
    )
    await mkdir(improvementDir, { recursive: true })
    await writeJson(join(improvementDir, 'candidate.json'), {
      schemaVersion: 1,
      id: improvementId,
      status: 'awaiting-promotion',
      workflowRef: 'workflow:demo@0.1.0',
      failureSignature: signature,
      clusterRef: `replay-cluster:${clusterId}`,
      draftRefs: { replayCandidateIds: ['replay-run-a', 'replay-run-b'] },
      evidence: {
        reproducedRunIds: ['run-replay-1'],
        workflowEvidenceRefs: ['workflow-evidence:we-a', 'workflow-evidence:we-b'],
      },
      gates: {
        promotion: {
          status: 'blocked',
          reason: 'explicit operator promotion required',
        },
      },
      createdAt: '2026-06-10T00:00:00.000Z',
      updatedAt: '2026-06-10T01:00:00.000Z',
    })

    const clusterList: string[] = []
    expect(
      await runMatOSEvolveCommand(['replay-clusters', 'list', '--json'], {
        cwd: root,
        stdout: chunk => clusterList.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    const clusters = JSON.parse(clusterList.join('')) as {
      clusters: Array<{ clusterId: string; occurrences: number }>
    }
    expect(clusters.clusters).toHaveLength(1)
    expect(clusters.clusters[0]?.clusterId).toBe(clusterId)
    expect(clusters.clusters[0]?.occurrences).toBe(2)

    const clusterShow: string[] = []
    expect(
      await runMatOSEvolveCommand(['replay-clusters', 'show', clusterId, '--json'], {
        cwd: root,
        stdout: chunk => clusterShow.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    expect(
      (JSON.parse(clusterShow.join('')) as { cluster: { workflowRef: string } })
        .cluster.workflowRef,
    ).toBe('workflow:demo@0.1.0')

    const improvementList: string[] = []
    expect(
      await runMatOSEvolveCommand(['improvement-candidates', 'list', '--json'], {
        cwd: root,
        stdout: chunk => improvementList.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    const improvements = JSON.parse(improvementList.join('')) as {
      candidates: Array<{ id: string; status: string }>
    }
    expect(improvements.candidates).toHaveLength(1)
    expect(improvements.candidates[0]?.id).toBe(improvementId)
    expect(improvements.candidates[0]?.status).toBe('awaiting-promotion')

    const improvementShow: string[] = []
    expect(
      await runMatOSEvolveCommand(
        ['improvement-candidates', 'show', improvementId, '--json'],
        {
          cwd: root,
          stdout: chunk => improvementShow.push(chunk),
          stderr: () => {},
          env: {},
        },
      ),
    ).toBe(0)
    const improvementShown = JSON.parse(improvementShow.join('')) as {
      candidate: { gates: { promotion: { status: string } } }
    }
    expect(improvementShown.candidate.gates.promotion.status).toBe('blocked')

    const statusOutput: string[] = []
    expect(
      await runMatOSEvolveCommand(['status', '--json'], {
        cwd: root,
        stdout: chunk => statusOutput.push(chunk),
        stderr: () => {},
        env: {},
      }),
    ).toBe(0)
    const status = JSON.parse(statusOutput.join('')) as {
      replayClusterCount: number
      improvementCandidateCount: number
    }
    expect(status.replayClusterCount).toBe(1)
    expect(status.improvementCandidateCount).toBe(1)
  })

  test('rejects removed native commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-removed-'))
    const stderr: string[] = []

    const exitCode = await runMatOSEvolveCommand(['jobs', 'drain'], {
      cwd: root,
      stdout: () => {},
      stderr: chunk => stderr.push(chunk),
    })

    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('Legacy native evolution commands')
  })

  test('feedback submit parses flags and reports suppressed state as json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-feedback-'))
    const output: string[] = []

    // Worker dispatch stays disabled so the CLI test never spawns a real
    // hidden evolution worker; the suppressed status still proves flag
    // parsing, validation, and JSON envelope shape.
    const exitCode = await runMatOSEvolveCommand(
      [
        'feedback',
        'submit',
        '--memory-id', 'rule_dark_theme_charts',
        '--memory-type', 'rule',
        '--title', 'Prefer dark theme charts',
        '--detail', 'Assertion: charts default to dark theme.',
        '--extraction-source', 'manual',
        '--json',
      ],
      {
        cwd: root,
        stdout: chunk => output.push(chunk),
        stderr: () => {},
        env: { MATOS_DISABLE_EVOLUTION_WORKER: '1' },
      },
    )

    expect(exitCode).toBe(0)
    const parsed = JSON.parse(output.join('')) as {
      feedback: { status: string; triggerKey?: string }
    }
    expect(parsed.feedback.status).toBe('suppressed')
    expect(
      parsed.feedback.triggerKey?.startsWith(
        'user-feedback:od-memory:rule_dark_theme_charts:',
      ),
    ).toBe(true)
  })

  test('feedback submit rejects invalid input with exit code 1', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-evolve-feedback-invalid-'))
    const stderr: string[] = []

    const exitCode = await runMatOSEvolveCommand(
      ['feedback', 'submit', '--memory-id', '../escape', '--memory-type', 'rule', '--title', 't', '--detail', 'd'],
      {
        cwd: root,
        stdout: () => {},
        stderr: chunk => stderr.push(chunk),
        env: { MATOS_DISABLE_EVOLUTION_WORKER: '1' },
      },
    )

    expect(exitCode).toBe(1)
    expect(stderr.join('')).toContain('invalid feedback submission')
  })
})
