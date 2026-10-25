import { expect, test } from 'bun:test'
import {
  sharedEvidenceCacheMaterial,
  restoreSharedEvidenceForStandalone,
  MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION,
  type MatOSEvolutionSharedEvidencePrefix,
} from './evolutionSharedPromptCache.js'
import { EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS } from './evolutionRoleSandbox.js'

const evidence: MatOSEvolutionSharedEvidencePrefix = {
  schemaVersion: 1 as const,
  cacheVersion: MATOS_EVOLUTION_SHARED_PROMPT_CACHE_VERSION,
  jobId: 'job-a',
  events: [{ timestamp: '2026-09-14', evidence: 'authoritative evidence' }],
}
test('descriptive job IDs do not bust cache while changed evidence does', () => {
  expect(sharedEvidenceCacheMaterial(evidence)).toEqual(
    sharedEvidenceCacheMaterial({ ...evidence, jobId: 'job-b' }),
  )
  expect(sharedEvidenceCacheMaterial(evidence)).not.toEqual(
    sharedEvidenceCacheMaterial({ ...evidence, events: [] }),
  )
})
test('standalone fallback restores stripped evidence without crossing editor sandbox boundaries', () => {
  const stage = {
    cwd: '/isolated/scope',
    role: 'user-feedback-critic',
    jobId: 'job',
    prompt: 'stage only',
    extraArgs: [...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS],
  }
  expect(
    restoreSharedEvidenceForStandalone(stage, evidence, stage.cwd).prompt,
  ).toContain('authoritative evidence')
  expect(
    restoreSharedEvidenceForStandalone(
      { ...stage, cwd: '/editor' },
      evidence,
      stage.cwd,
    ).prompt,
  ).toBe('stage only')
  expect(
    restoreSharedEvidenceForStandalone(
      { ...stage, extraArgs: ['--allowed-tools', 'Bash'] },
      evidence,
      stage.cwd,
    ).prompt,
  ).toBe('stage only')
})
