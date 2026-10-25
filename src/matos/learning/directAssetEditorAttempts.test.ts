import { describe, expect, test } from 'bun:test'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'
import { buildPreviousAttemptFromRecord } from './directAssetEditorAttempts.js'

function rolledBackRecord(
  overrides: Record<string, unknown>,
): MatOSDirectAssetEditorRunRecord {
  return {
    runId: 'direct-editor-attempts-test',
    status: 'rolled_back',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:01.000Z',
    scope: 'user',
    editorOutput: {
      summary: 'Edited a scoped role.',
      modifiedFiles: ['user-assets/packs/user-alice/roles/compute/ROLE.md'],
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
    },
    modifiedFiles: ['user-assets/packs/user-alice/roles/compute/ROLE.md'],
    createdAssets: [],
    updatedAssets: [],
    disabledAssets: [],
    evidenceRefs: [],
    roleExitCode: 0,
    ...overrides,
  } as never
}

describe('buildPreviousAttemptFromRecord retry classification', () => {
  test('retries Gitea source acceptance failure even when sourceCommitErrors are recorded', () => {
    // Production shape: finalize sets rollback.reason from
    // directEditorSourceAcceptanceFailureMessage(sourceCommitErrors), so this
    // rollback reason always arrives together with non-empty
    // sourceCommitErrors. The corrective retry path must still fire.
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason:
            'Gitea-backed source acceptance failed: no matching Gitea asset source accepted ref was advanced.',
        },
        sourceCommitErrors: [
          {
            sourceId: 'alice-assets',
            error: 'no matching Gitea asset source accepted ref was advanced',
          },
        ],
      }),
      2,
    )

    expect(feedback).toMatchObject({
      attempt: 2,
      rejectionStage: 'unknown',
    })
    expect(feedback?.reason).toContain(
      'Gitea-backed source acceptance failed:',
    )
    expect(feedback?.reason).toContain('targetAssetCreationRoots')
    expect(feedback?.reason).toContain('.matos/source-cache')
  })

  test('does not retry writable-scope guard rollbacks', () => {
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason:
            'files modified outside direct-editor writable scope: src/index.ts, package.json',
        },
      }),
      1,
    )

    expect(feedback).toBeUndefined()
  })

  test('does not retry protected core guard rollbacks', () => {
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason:
            'protected core asset files modified outside direct-editor scope: matos-assets/packs/matos-core/AGENTS.md',
        },
      }),
      1,
    )

    expect(feedback).toBeUndefined()
  })

  test('still retries semantic rejections', () => {
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason: 'semantic acceptance rejected the edit',
        },
        semanticAcceptance: {
          verdict: 'rollback',
          reason: 'The edit overfits one incident.',
        },
      }),
      1,
    )

    expect(feedback).toMatchObject({
      attempt: 1,
      rejectionStage: 'gate2-semantic',
      reason: 'semantic acceptance rejected the edit',
      judgeReason: 'The edit overfits one incident.',
    })
  })

  test('still retries introduced validation failures', () => {
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason: 'introduced validation errors',
        },
        introducedValidationErrors: [
          {
            code: 'duplicate_asset',
            message: 'duplicate role id compute',
            assetKey: 'role:compute',
          },
        ],
      }),
      1,
    )

    expect(feedback).toMatchObject({
      attempt: 1,
      rejectionStage: 'gate1-validation',
      reason: 'introduced validation errors',
    })
    expect(feedback?.introducedValidationErrors).toEqual([
      'duplicate_asset [role:compute]: duplicate role id compute',
    ])
  })

  test('still skips retry for non-Gitea source commit errors', () => {
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason: 'accepted source commit failed mid-push',
        },
        sourceCommitErrors: [
          { sourceId: 'alice-assets', error: 'remote push rejected' },
        ],
      }),
      1,
    )

    expect(feedback).toBeUndefined()
  })

  test('still skips retry when the semantic judge itself failed', () => {
    const feedback = buildPreviousAttemptFromRecord(
      rolledBackRecord({
        rollback: {
          reason: 'semantic acceptance judge failed',
        },
        semanticAcceptance: {
          verdict: 'rollback',
          reason: 'judge invocation failed',
          judgeFailed: true,
        },
      }),
      1,
    )

    expect(feedback).toBeUndefined()
  })
})
