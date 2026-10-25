import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { validateMatOSAssets } from '../assets/validateAssets.js'

/**
 * Asset validation is the shared deterministic gate for `matos assets
 * validate`, the self-evolution direct-editor usability gate, and Gitea
 * acceptance. These tests prove a broken algorithm strategy edit is rejected
 * by that gate while a healthy strategy passes.
 */

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeStrategy(input: {
  root: string
  id: string
  entry?: string
  entrySource?: string
  surfaceId?: string
  protocol?: string
}): Promise<void> {
  const dir = join(input.root, '.matos/assets/strategies', input.id)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'asset.json'), {
    schemaVersion: 1,
    id: input.id,
    type: 'tool',
    name: input.id,
    version: '0.1.0',
    description: `strategy ${input.id}`,
    entry: input.entry ?? './strategy.cjs',
    tags: ['algorithm-layer'],
    metadata: {
      algorithmSurface: input.surfaceId ?? 'context-ranking',
      decisionProtocol: input.protocol ?? 'json-v1',
    },
  })
  if (input.entrySource !== undefined) {
    const entryName = (input.entry ?? './strategy.cjs').replace(/^\.\//, '')
    await writeFile(join(dir, entryName), input.entrySource, 'utf8')
  }
}

describe('algorithm strategy asset validation gate', () => {
  test('a healthy strategy tool asset validates cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-validate-ok-'))
    await writeStrategy({
      root,
      id: 'good-strategy',
      entrySource: 'process.stdout.write(JSON.stringify({decision:{ranked:[]}}))',
    })
    const validation = await validateMatOSAssets(await loadMatOSAssets(root))
    expect(
      validation.errors.filter(error => error.assetId === 'good-strategy'),
    ).toEqual([])
  })

  test('wrong protocol, unknown surface, and non-runnable entry are rejected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-validate-bad-'))
    await writeStrategy({
      root,
      id: 'bad-protocol',
      protocol: 'json-v999',
      entrySource: 'x',
    })
    await writeStrategy({
      root,
      id: 'bad-surface',
      surfaceId: 'not-a-surface',
      entrySource: 'x',
    })
    await writeStrategy({
      root,
      id: 'bad-entry',
      entry: './strategy.txt',
      entrySource: 'not runnable',
    })
    await writeStrategy({
      root,
      id: 'unsafe-python-entry',
      entry: './strategy.py',
      entrySource: 'print({"decision": {}})',
    })
    const validation = await validateMatOSAssets(await loadMatOSAssets(root))
    const messagesFor = (assetId: string): string =>
      validation.errors
        .filter(error => error.assetId === assetId)
        .map(error => error.message)
        .join('; ')
    expect(messagesFor('bad-protocol')).toContain('decisionProtocol')
    expect(messagesFor('bad-surface')).toContain('Unknown algorithm surface')
    expect(messagesFor('bad-entry')).toContain('Node file')
    expect(messagesFor('unsafe-python-entry')).toContain('Node file')
  })

  test('non-strategy tool assets are unaffected by the strategy gate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-algo-validate-plain-'))
    const dir = join(root, '.matos/assets/tools/plain-tool')
    await mkdir(dir, { recursive: true })
    await writeJson(join(dir, 'asset.json'), {
      schemaVersion: 1,
      id: 'plain-tool',
      type: 'tool',
      name: 'plain tool',
      version: '0.1.0',
      description: 'a normal tool asset without algorithm metadata',
      metadata: { kind: 'builtin-pack', builtinTools: ['Read'] },
    })
    const validation = await validateMatOSAssets(await loadMatOSAssets(root))
    expect(
      validation.errors.filter(error => error.assetId === 'plain-tool'),
    ).toEqual([])
  })
})
