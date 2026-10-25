import { describe, expect, test } from 'bun:test'
import {
  buildSearchIndex,
  searchDocumentFromAsset,
  tokenizeAssetGraphText,
} from './searchIndex.js'
import type { MatOSAsset } from '../types.js'

function fakeAsset(input: {
  id: string
  type?: string
  name: string
  description?: string
  tags?: string[]
}): MatOSAsset {
  const type = input.type ?? 'knowledge'
  return {
    id: input.id,
    type,
    name: input.name,
    version: '0.1.0',
    canonicalKey: `${type}:${input.id}@0.1.0`,
    ...(input.description ? { description: input.description } : {}),
    tags: input.tags ?? [],
    dependencies: [],
    mounts: {},
    runtime: {},
    metadata: {},
    lifecycle: { status: 'enabled' },
    source: 'project',
    packId: 'test-pack',
    relativePath: `packs/test/${input.id}`,
    absolutePath: `/tmp/packs/test/${input.id}`,
    sourcePath: `/tmp/packs/test/${input.id}`,
    manifestPath: `/tmp/packs/test/${input.id}/asset.json`,
  } as unknown as MatOSAsset
}

describe('asset graph text tokenizer', () => {
  test('keeps latin/digit terms as before', () => {
    expect(tokenizeAssetGraphText('VASP relaxation ENCUT k-point')).toEqual([
      'vasp',
      'relaxation',
      'encut',
      'k-point',
    ])
  })

  test('expands Chinese runs into character bigrams', () => {
    const tokens = tokenizeAssetGraphText('计算铜的扩散系数')
    expect(tokens).toContain('计算')
    expect(tokens).toContain('扩散')
    expect(tokens).toContain('系数')
    // Bigrams only — the old behavior emitted the whole sentence as one token.
    expect(tokens).not.toContain('计算铜的扩散系数')
  })

  test('handles mixed Chinese/latin terms', () => {
    const tokens = tokenizeAssetGraphText('用VASP计算 copper diffusion 扩散系数')
    expect(tokens).toContain('vasp')
    expect(tokens).toContain('copper')
    expect(tokens).toContain('diffusion')
    expect(tokens).toContain('扩散')
    expect(tokens).toContain('系数')
  })

  test('keeps a lone CJK char only when it is the whole term', () => {
    expect(tokenizeAssetGraphText('铜')).toEqual(['铜'])
    // Single char glued to latin is separator noise, dropped.
    expect(tokenizeAssetGraphText('用vasp')).toEqual(['vasp'])
  })
})

describe('search index Chinese matching', () => {
  test('a Chinese query matches documents with Chinese prose', () => {
    const diffusionDoc = searchDocumentFromAsset(
      fakeAsset({
        id: 'cu-diffusion-runbook',
        name: '铜扩散系数计算指南',
        description: '使用分子动力学计算铜的扩散系数的操作规程',
      }),
    )
    const unrelatedDoc = searchDocumentFromAsset(
      fakeAsset({
        id: 'xrd-analysis',
        name: 'XRD 分析策略',
        description: 'X射线衍射谱图分析',
      }),
    )
    const index = buildSearchIndex([diffusionDoc, unrelatedDoc])
    const queryTerms = tokenizeAssetGraphText('计算铜的扩散系数')

    const scoreFor = (docId: string): number => {
      const document = index.documents[docId]
      if (!document) return 0
      let score = 0
      for (const term of queryTerms) {
        score += document.terms[term] ?? 0
      }
      return score
    }

    expect(scoreFor(diffusionDoc.id)).toBeGreaterThan(0)
    expect(scoreFor(diffusionDoc.id)).toBeGreaterThan(scoreFor(unrelatedDoc.id))
  })
})
