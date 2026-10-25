import { chmod, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import type { MatOSAssetHistoryValidationResult } from '../assets/history/index.js'
import type { EvolutionRoleInvocationInput } from './evolutionRoleRunner.js'
import { EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS } from './evolutionRoleSandbox.js'
import {
  SEMANTIC_ACCEPTANCE_PROMPT_VERSION,
  runMatOSSemanticAcceptanceJudge,
  type MatOSSemanticAcceptanceJudgeInput,
} from './semanticAcceptanceJudge.js'

function acceptVerdict(reason: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    verdict: 'accept',
    confidence: 0.9,
    reason,
    resolvedUserProblem: true,
    overfitRisk: 'low',
    assetPollutionRisk: 'low',
    missingEvidence: [],
    recommendedFollowup: [],
  }
}

const VALIDATION: MatOSAssetHistoryValidationResult = {
  ok: true,
  gateProfile: 'smoke',
  assetValidation: { ok: true, errors: [] },
  secretScan: { ok: true, findings: [] },
  workflowValidation: [],
}

function baseInput(root: string): Omit<MatOSSemanticAcceptanceJudgeInput, 'roleRunner'> {
  return {
    cwd: root,
    runId: 'judge-test-run',
    scope: 'core',
    beforeSnapshot: 'asset-snapshot-before',
    afterSnapshot: 'asset-snapshot-after',
    promptInput: {
      currentEvolutionContext: {
        trigger: { key: 'tool-failure:x' },
        sessionPath: '/s.jsonl',
        events: [],
        monitorRecords: [],
      },
    },
    editorOutput: {
      summary: 'edited',
      modifiedFiles: ['a'],
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
    },
    validation: VALIDATION,
    modifiedFiles: ['a'],
    createdAssets: [],
    updatedAssets: [],
    disabledAssets: [],
    evidenceRefs: [],
  }
}

function semanticCacheDir(root: string): string {
  return join(root, '.matos', 'evolution', 'direct-editor', 'semantic-cache')
}

describe('MatOS semantic acceptance judge', () => {
  test('rolls back and does not cache a failed judge run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-fail-'))
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: async () => ({
        exitCode: 1,
        roleReference: 'role:semantic-acceptance-judge',
        stdout: '',
        stderr: 'judge boom',
      }),
    })
    expect(result.verdict).toBe('rollback')
    // A transient judge failure must not be pinned in the cache for the TTL.
    const cacheFiles = await readdir(semanticCacheDir(root)).catch(() => [])
    expect(cacheFiles.length).toBe(0)
  })

  test('caches a successful verdict with secrets redacted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-ok-'))
    const secret = 'sk-ABCDEFGHIJKLMNOP1234567890'
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: async () => ({
        exitCode: 0,
        roleReference: 'role:semantic-acceptance-judge',
        stdout: '',
        stderr: '',
        parsedResult: {
          schemaVersion: 1,
          verdict: 'accept',
          confidence: 0.9,
          reason: `looks good ${secret}`,
          resolvedUserProblem: true,
          overfitRisk: 'low',
          assetPollutionRisk: 'low',
          missingEvidence: [],
          recommendedFollowup: [],
        },
      }),
    })
    expect(result.verdict).toBe('accept')
    // Returned result and persisted cache are both scrubbed of the secret.
    expect(JSON.stringify(result)).not.toContain(secret)
    const cacheFiles = await readdir(semanticCacheDir(root))
    expect(cacheFiles.length).toBe(1)
    const raw = await readFile(join(semanticCacheDir(root), cacheFiles[0] ?? ''), 'utf8')
    expect(raw).not.toContain(secret)
    expect(raw).toContain('[redacted]')
  })

  test('uses more permissive acceptance guidance for scoped user assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-user-scope-'))
    const calls: EvolutionRoleInvocationInput[] = []
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      scope: 'user',
      scopeRef: 'user:alice',
      roleRunner: async input => {
        calls.push(input)
        return {
          exitCode: 0,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: '',
          parsedResult: {
            schemaVersion: 1,
            verdict: 'accept',
            confidence: 0.82,
            reason: 'Low-risk scoped edit is acceptable.',
            resolvedUserProblem: true,
            overfitRisk: 'medium',
            assetPollutionRisk: 'low',
            missingEvidence: [],
            recommendedFollowup: [],
          },
        }
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.maxTurns).toBe(0)
    expect(result.cache.promptVersion).toBe(SEMANTIC_ACCEPTANCE_PROMPT_VERSION)
    expect(SEMANTIC_ACCEPTANCE_PROMPT_VERSION).toBe(
      'matos-semantic-acceptance-v4',
    )
    expect(calls[0]?.prompt).toContain(
      'For user, team, and project scoped assets, accept low-risk edits',
    )
    expect(calls[0]?.prompt).toContain('"scopeRef": "user:alice"')
    expect(calls[0]?.prompt).toContain(
      'This is a prospective acceptance decision',
    )
    expect(calls[0]?.prompt).toContain(
      'roll back a knowledge-only or role-only edit',
    )
    expect(calls[0]?.prompt).not.toContain(
      'Use rollback for useful but weak, ambiguous, high-risk, or human-review-needed edits.',
    )
  })

  test('reuses shared evidence prefix when the shared runner declares equivalent sandbox args', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-shared-prefix-'))
    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner = (async (input: EvolutionRoleInvocationInput) => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:semantic-acceptance-judge',
        stdout: '',
        stderr: '',
        parsedResult: {
          schemaVersion: 1,
          verdict: 'accept',
          confidence: 0.9,
          reason: 'shared prefix evidence supports the edit',
          resolvedUserProblem: true,
          overfitRisk: 'low',
          assetPollutionRisk: 'low',
          missingEvidence: [],
          recommendedFollowup: [],
        },
      }
    }) as unknown as ((
      input: EvolutionRoleInvocationInput,
    ) => Promise<{
      exitCode: number
      roleReference: string
      stdout: string
      stderr: string
      parsedResult: Record<string, unknown>
    }>) & {
      usesSharedEvidencePrefix: true
      sharedEvidencePrefixKey: string
      sharedEvidenceCwd: string
      sharedStageExtraArgs: readonly string[]
    }
    roleRunner.usesSharedEvidencePrefix = true
    roleRunner.sharedEvidencePrefixKey = 'shared-prefix-test'
    roleRunner.sharedEvidenceCwd = root
    roleRunner.sharedStageExtraArgs = [...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS]

    await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner,
      // Shared-prefix judging is opt-in now: the shared worker runs on the
      // fast evolution model, so the strong-judge default is standalone.
      env: { MATOS_EVOLUTION_JUDGE_SHARED_PREFIX: '1' },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.extraArgs).toEqual([...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS])
    expect(calls[0]?.prompt).toContain(
      'Use the earlier matos-evolution-shared-evidence-prefix',
    )
    expect(calls[0]?.prompt).toContain('"sharedEvidencePrefix": true')
    expect(calls[0]?.prompt).not.toContain('"promptInput"')

    // Default path (no opt-in): the same shared-capable runner must receive a
    // full standalone prompt so the verdict comes from the strong judge role.
    calls.length = 0
    await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      runId: 'run-standalone-default',
      roleRunner,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).not.toContain(
      'Use the earlier matos-evolution-shared-evidence-prefix',
    )
    expect(calls[0]?.prompt).toContain('"promptInput"')
  })

  test('retries a transient judge execution failure once before condemning the edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-retry-'))
    let calls = 0
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: async () => {
        calls += 1
        if (calls === 1) {
          return {
            exitCode: 1,
            roleReference: 'role:semantic-acceptance-judge',
            stdout: '',
            stderr: 'transient infrastructure failure',
          }
        }
        return {
          exitCode: 0,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: '',
          parsedResult: acceptVerdict('second attempt verdict'),
        }
      },
    })
    // One infra blip must not roll back an already-applied edit.
    expect(calls).toBe(2)
    expect(result.verdict).toBe('accept')
    expect(result.judgeFailed).toBeUndefined()
  })

  test('retries when the judge exits 0 without a parseable verdict object', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-retry-unparseable-'))
    let calls = 0
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: async () => {
        calls += 1
        if (calls === 1) {
          return {
            exitCode: 0,
            roleReference: 'role:semantic-acceptance-judge',
            stdout: 'not json at all',
            stderr: '',
          }
        }
        return {
          exitCode: 0,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: '',
          parsedResult: acceptVerdict('parseable on retry'),
        }
      },
    })
    expect(calls).toBe(2)
    expect(result.verdict).toBe('accept')
    expect(result.judgeFailed).toBeUndefined()
  })

  test('marks the verdict judgeFailed only after the retry also fails, and still does not cache it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-retry-exhausted-'))
    let calls = 0
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: async () => {
        calls += 1
        return {
          exitCode: 1,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: 'judge keeps failing',
        }
      },
    })
    expect(calls).toBe(2)
    expect(result.verdict).toBe('rollback')
    expect(result.judgeFailed).toBe(true)
    expect(result.reason).toContain('judge-run-failed')
    const cacheFiles = await readdir(semanticCacheDir(root)).catch(() => [])
    expect(cacheFiles.length).toBe(0)
  })

  test('does not retry deterministic quota failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-no-retry-quota-'))
    let calls = 0
    const result = await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: async () => {
        calls += 1
        return {
          exitCode: 1,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: 'API Error: 402 {"error":{"message":"Insufficient Balance"}}',
        }
      },
    })
    // An identical retry cannot fix an exhausted balance; do not double-bill.
    expect(calls).toBe(1)
    expect(result.verdict).toBe('rollback')
    expect(result.judgeFailed).toBe(true)
  })

  test('falls back to a standalone judge run when the shared-prefix runner fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-shared-fallback-'))
    let sharedCalls = 0
    const roleRunner = (async (input: EvolutionRoleInvocationInput) => {
      sharedCalls += 1
      void input
      return {
        exitCode: 1,
        roleReference: 'role:semantic-acceptance-judge',
        stdout: '',
        stderr: 'shared child died mid-turn',
      }
    }) as unknown as ((
      input: EvolutionRoleInvocationInput,
    ) => Promise<{
      exitCode: number
      roleReference: string
      stdout: string
      stderr: string
    }>) & {
      usesSharedEvidencePrefix: true
      sharedEvidencePrefixKey: string
      sharedEvidenceCwd: string
      sharedStageExtraArgs: readonly string[]
    }
    roleRunner.usesSharedEvidencePrefix = true
    roleRunner.sharedEvidencePrefixKey = 'shared-prefix-fallback-test'
    roleRunner.sharedEvidenceCwd = root
    roleRunner.sharedStageExtraArgs = [...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS]

    // The standalone retry goes through the real runEvolutionRole; give it a
    // fake agent runtime that answers with a valid verdict.
    const fakeDir = await mkdtemp(join(tmpdir(), 'matos-judge-fake-runtime-'))
    const runtime = join(fakeDir, 'fake-runtime.sh')
    const resultLine = JSON.stringify({
      type: 'result',
      is_error: false,
      result: JSON.stringify(acceptVerdict('standalone retry verdict')),
    })
    await writeFile(
      runtime,
      `#!/bin/sh\nprintf '%s\\n' '${resultLine}'\nexit 0\n`,
    )
    await chmod(runtime, 0o755)
    const originalExecPath = process.execPath
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: runtime,
    })
    try {
      const result = await runMatOSSemanticAcceptanceJudge({
        ...baseInput(root),
        roleRunner,
      })
      // The shared runner failed once; the standalone retry's verdict wins.
      expect(sharedCalls).toBe(1)
      expect(result.verdict).toBe('accept')
      expect(result.judgeFailed).toBeUndefined()
      expect(result.reason).toBe('standalone retry verdict')
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        value: originalExecPath,
      })
    }
  }, 20_000)

  test('writes the semantic cache atomically and throttles prune scans between writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-judge-prune-throttle-'))
    const acceptRunner = async () => ({
      exitCode: 0,
      roleReference: 'role:semantic-acceptance-judge',
      stdout: '',
      stderr: '',
      parsedResult: acceptVerdict('prune throttle verdict'),
    })
    // First successful verdict stamps the prune throttle for this cache dir.
    await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      roleRunner: acceptRunner,
    })
    const dir = semanticCacheDir(root)
    await writeFile(
      join(dir, 'semantic-expired-entry.json'),
      `${JSON.stringify({ schemaVersion: 1, createdAt: new Date(0).toISOString() })}\n`,
      'utf8',
    )
    await runMatOSSemanticAcceptanceJudge({
      ...baseInput(root),
      afterSnapshot: 'asset-snapshot-after-second',
      roleRunner: acceptRunner,
    })
    const entries = (await readdir(dir)).sort()
    // Atomic rename leaves no temp files behind.
    expect(entries.filter(entry => entry.includes('.tmp'))).toEqual([])
    // The expired entry survives the second write: the prune scan is
    // throttled after the first write stamped this directory.
    expect(entries).toContain('semantic-expired-entry.json')
    expect(entries.length).toBe(3)
  })
})
