import { describe, expect, test } from 'bun:test'
import { shouldIgnoreMatOSAssetHistoryPath } from './policy.js'

describe('MatOS asset history path ignore policy', () => {
  test('ignores direct-editor provenance artifacts under .matos/evolution', () => {
    for (const path of [
      '.matos/evolution/audit/direct-editor/direct-editor-20260805T064135429Z/audit.json',
      '.matos/evolution/audit/direct-editor/direct-editor-20260805T064135429Z/diff.patch',
      '.matos/source-cache/scopes/users/alice/git/matos-user-assets-alice/.matos/evolution/audit/direct-editor/run-1/audit.json',
      '/abs/checkout/.matos/evolution/direct-editor/runs/run-1/run.json',
    ]) {
      expect(shouldIgnoreMatOSAssetHistoryPath(path)).toBe(true)
    }
  })

  test('keeps generated evolution assets and normal asset paths visible', () => {
    for (const path of [
      '.matos/assets/generated/evolution/experiences/some-lesson/asset.json',
      '.matos/assets/generated/scopes/users/alice/knowledge/note/asset.json',
      'matos-assets/packs/matos-core/knowledge/evolution/KNOWLEDGE.md',
      'knowledge/evolution-notes/KNOWLEDGE.md',
      '.matos/source-cache/scopes/users/alice/git/matos-user-assets-alice/matos-assets/knowledge/n/asset.json',
    ]) {
      expect(shouldIgnoreMatOSAssetHistoryPath(path)).toBe(false)
    }
  })

  test('still ignores classic generated dirs and files', () => {
    expect(shouldIgnoreMatOSAssetHistoryPath('packs/x/.git/config')).toBe(true)
    expect(shouldIgnoreMatOSAssetHistoryPath('packs/x/tool.pyc')).toBe(true)
    expect(shouldIgnoreMatOSAssetHistoryPath('packs/x/__pycache__/a.py')).toBe(true)
  })
})
