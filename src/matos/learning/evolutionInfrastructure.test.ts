import { expect, test } from 'bun:test'
import { evolutionInfrastructureFailureCode } from './evolutionInfrastructure.js'
import { buildPreviousAttemptFromRecord } from './directAssetEditorAttempts.js'
import type { MatOSDirectAssetEditorRunRecord } from './directAssetEditor.js'

test('authentication, transport and version failures never instruct the editor to rewrite assets again', () => {
  for (const error of ['Authentication failed', 'unable to write new index file', 'Refusing non-fast-forward accepted ref update', 'Gitea request timed out']) {
    const record = {
      status: 'rolled_back', sourceCommitErrors: [{ sourceId: 'user-assets', error }],
      rollback: { reason: `Gitea-backed source acceptance failed: ${error}` },
    } as MatOSDirectAssetEditorRunRecord
    expect(evolutionInfrastructureFailureCode(record)).toBeDefined()
    expect(buildPreviousAttemptFromRecord(record, 1)).toBeUndefined()
  }
  expect(evolutionInfrastructureFailureCode({ error: 'Candidate edited no source files; use the correct creation root' })).toBeUndefined()
  expect(evolutionInfrastructureFailureCode({ error: 'Semantic model call timed out' })).toBeUndefined()
})
