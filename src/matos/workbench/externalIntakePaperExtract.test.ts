import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { classifyMatOSExternalIntakeSource } from './externalIntakeClassification.js'
import {
  extractMatOSExternalIntakePaperText,
  normalizeMatOSExternalIntakePaperSummary,
} from './externalIntakePaperExtract.js'

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-paper-extract-'))
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeFile(
    getMatOSConfigPath(root),
    `${JSON.stringify(
      { version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false },
      null,
      2,
    )}\n`,
    'utf8',
  )
  return root
}

describe('external intake paper text extraction', () => {
  test('reads markdown/document sources directly and finds title + abstract', async () => {
    const root = await createFixtureRoot()
    const dir = join(root, 'sources', 'papers')
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'survey.md')
    await writeFile(
      path,
      '# A Survey Of Widgets\n\n## Abstract\n\nWidgets are useful. We review 30 papers on widgets.\n\n## Methods\n\nWe searched three databases.\n',
      'utf8',
    )
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path,
    })
    const { extraction, text } = await extractMatOSExternalIntakePaperText({
      cwd: root,
      classification,
    })
    expect(extraction.ok).toBe(true)
    expect(extraction.method).toBe('plain-read')
    expect(extraction.title).toBe('A Survey Of Widgets')
    expect(extraction.abstract).toContain('Widgets are useful')
    expect(extraction.headings).toEqual(
      expect.arrayContaining(['A Survey Of Widgets', 'Abstract', 'Methods']),
    )
    expect(extraction.textDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(text).toContain('We searched three databases')
  })

  test('repository sources are rejected for paper extraction', async () => {
    const root = await createFixtureRoot()
    const repo = join(root, 'sources', 'repo')
    await mkdir(repo, { recursive: true })
    await writeFile(join(repo, 'README.md'), '# repo\n', 'utf8')
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/repo',
    })
    const { extraction } = await extractMatOSExternalIntakePaperText({
      cwd: root,
      classification,
    })
    expect(extraction.ok).toBe(false)
    expect(extraction.method).toBe('none')
  })
})

describe('paper summary normalization', () => {
  test('accepts a well-formed summary and clamps arrays', () => {
    const summary = normalizeMatOSExternalIntakePaperSummary(
      {
        schemaVersion: 1,
        summary: 'A faithful summary of the paper.',
        citation: 'Doe et al., 2026',
        keyFindings: ['finding one', 'finding two', 'finding one'],
        methods: ['method a'],
        protocolSteps: ['step 1', 'step 2'],
        reproducibility: ['Table 1'],
        tags: ['widgets'],
      },
      'deepseek-v4-flash',
      false,
    )
    expect(summary?.enabled).toBe(true)
    if (summary?.enabled) {
      expect(summary.summary).toBe('A faithful summary of the paper.')
      expect(summary.citation).toBe('Doe et al., 2026')
      // Deduplicated.
      expect(summary.keyFindings).toEqual(['finding one', 'finding two'])
      expect(summary.protocolSteps).toEqual(['step 1', 'step 2'])
      expect(summary.cacheHit).toBe(false)
    }
  })

  test('rejects summaries without a summary string', () => {
    expect(
      normalizeMatOSExternalIntakePaperSummary(
        { keyFindings: ['x'] },
        'model',
        false,
      ),
    ).toBeUndefined()
    expect(
      normalizeMatOSExternalIntakePaperSummary(null, 'model', false),
    ).toBeUndefined()
  })
})
