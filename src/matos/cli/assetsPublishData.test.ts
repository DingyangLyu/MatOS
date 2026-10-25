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

import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runMatOSAssetsCommand } from './assets.js'

// Ambient deployment env would retarget asset discovery at real deployment
// roots; scrub the same keys the main assets CLI tests scrub.
const AMBIENT_DEPLOYMENT_ENV_KEYS = [
  'MATOS_DEPLOY_ROOT',
  'MATOS_DATA_DIR',
  'MATOS_SHARED_ASSET_ROOT',
  'MATOS_GLOBAL_ASSET_ROOT',
  'MATOS_BUNDLED_ASSET_ROOT',
  'MATOS_ASSET_ROOTS',
  'MATOS_INCLUDE_LEGACY_ASSETS',
  'MATOS_EDITABLE_CORE_ASSET_ROOT',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of AMBIENT_DEPLOYMENT_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  // Point the bundled root at an empty dir so tests only see project assets.
  process.env.MATOS_BUNDLED_ASSET_ROOT = '/nonexistent-matos-bundled-assets'
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

type Io = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  stdin?: () => Promise<string> | string
}

function makeIo(
  cwd: string,
  stdin?: () => Promise<string> | string,
): { io: Io; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
      ...(stdin ? { stdin } : {}),
    },
    out,
    err,
  }
}

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'matos-publish-data-'))
}

const SCENE = {
  schemaVersion: 1,
  name: 'HER benchtop demo',
  devices: [{ ref: 'data:vlab-tube-rack', position: [0, 0.4, 0] }],
}

async function writeSceneFile(cwd: string, name = 'scene-input.json'): Promise<string> {
  const path = join(cwd, name)
  await writeFile(path, JSON.stringify(SCENE, null, 2), 'utf8')
  return path
}

describe('matos assets publish-data', () => {
  test('publishes a scene document and round-trips through show', async () => {
    const cwd = await makeProject()
    const entryFile = await writeSceneFile(cwd)

    const { io, out } = makeIo(cwd)
    const code = await runMatOSAssetsCommand(
      [
        'publish-data',
        '--id', 'vlab-scene-her-demo',
        '--name', 'Virtual Lab Scene: HER benchtop demo',
        '--pack', 'virtual-lab-scenes',
        '--entry-file', entryFile,
        '--entry-name', 'scene.json',
        '--tag', 'virtual-lab-scene',
        '--tag', 'virtual-lab',
        '--description', 'Saved from the lab sandbox.',
        '--json',
      ],
      io,
    )
    expect(code).toBe(0)
    const result = JSON.parse(out.join('')) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.ref).toBe('data:vlab-scene-her-demo@0.1.0')
    expect(result.packId).toBe('virtual-lab-scenes')
    expect(result.entryName).toBe('scene.json')
    expect(result.overwritten).toBe(false)
    expect((result.validation as { ok: boolean }).ok).toBe(true)

    const manifestPath = join(
      cwd, '.matos', 'assets', 'packs', 'virtual-lab-scenes',
      'data', 'vlab-scene-her-demo', 'asset.json',
    )
    expect(result.manifestPath).toBe(
      '.matos/assets/packs/virtual-lab-scenes/data/vlab-scene-her-demo/asset.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      type: string
      version: string
      entry: string
      tags: string[]
      metadata: Record<string, unknown>
    }
    expect(manifest.type).toBe('data')
    expect(manifest.version).toBe('0.1.0')
    expect(manifest.entry).toBe('scene.json')
    expect(manifest.tags).toContain('virtual-lab-scene')
    expect(manifest.metadata.sourceFormat).toBe('cmatos-native-data')
    expect(manifest.metadata.publishedBy).toBe('cli')
    expect(typeof manifest.metadata.publishedAt).toBe('string')

    // The stored entry is the exact document that was published.
    const stored = JSON.parse(
      await readFile(join(cwd, String(result.entryPath)), 'utf8'),
    ) as typeof SCENE
    expect(stored).toEqual(SCENE)

    // The pack manifest was created for the new pack.
    const pack = JSON.parse(
      await readFile(
        join(cwd, '.matos', 'assets', 'packs', 'virtual-lab-scenes', 'matos.pack.json'),
        'utf8',
      ),
    ) as { id: string; metadata: Record<string, unknown> }
    expect(pack.id).toBe('virtual-lab-scenes')
    expect(pack.metadata.sourceFormat).toBe('matos-registered-data-pack')

    // Symmetric read: `assets show data:<id> --json` resolves the published
    // asset and reports the entry name plus workspace-relative locations.
    const show = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['show', 'data:vlab-scene-her-demo', '--json'],
        show.io,
      ),
    ).toBe(0)
    const shown = JSON.parse(show.out.join('')) as {
      asset: { entry: string; absolutePath: string; tags: string[] }
    }
    expect(shown.asset.entry).toBe('scene.json')
    expect(shown.asset.tags).toContain('virtual-lab-scene')
    expect(shown.asset.absolutePath.startsWith('<workspace>/')).toBe(true)

    // Discoverable through the normal list path and valid as a registry.
    const list = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(['list', '--type', 'data', '--json'], list.io),
    ).toBe(0)
    expect(list.out.join('')).toContain('vlab-scene-her-demo')
    const validate = makeIo(cwd)
    expect(await runMatOSAssetsCommand(['validate', '--json'], validate.io)).toBe(0)
  })

  test('reads the entry payload from stdin when --entry-file is "-"', async () => {
    const cwd = await makeProject()
    const { io, out } = makeIo(cwd, () => JSON.stringify(SCENE))
    const code = await runMatOSAssetsCommand(
      [
        'publish-data',
        '--id', 'vlab-scene-stdin',
        '--name', 'Stdin scene',
        '--entry-file', '-',
        '--entry-name', 'scene.json',
        '--tag', 'virtual-lab-scene',
        '--json',
      ],
      io,
    )
    expect(code).toBe(0)
    const result = JSON.parse(out.join('')) as { ref: string; packId: string }
    expect(result.ref).toBe('data:vlab-scene-stdin@0.1.0')
    // Default pack when --pack is omitted.
    expect(result.packId).toBe('published-data')
    const stored = JSON.parse(
      await readFile(
        join(
          cwd, '.matos', 'assets', 'packs', 'published-data',
          'data', 'vlab-scene-stdin', 'scene.json',
        ),
        'utf8',
      ),
    ) as typeof SCENE
    expect(stored).toEqual(SCENE)
  })

  test('requires id, name, and entry-file and validates slugs', async () => {
    const cwd = await makeProject()
    const missing = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['publish-data', '--id', 'x', '--name', 'X'],
        missing.io,
      ),
    ).toBe(1)
    expect(missing.err.join('')).toContain('--entry-file')

    const entryFile = await writeSceneFile(cwd)
    const badId = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['publish-data', '--id', 'Bad Id!', '--name', 'X', '--entry-file', entryFile],
        badId.io,
      ),
    ).toBe(1)
    expect(badId.err.join('')).toContain('--id must be a lowercase slug')

    const missingFile = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'x', '--name', 'X',
          '--entry-file', join(cwd, 'does-not-exist.json'),
        ],
        missingFile.io,
      ),
    ).toBe(1)
    expect(missingFile.err.join('')).toContain('cannot read --entry-file')
  })

  test('refuses path traversal and reserved entry names', async () => {
    const cwd = await makeProject()
    const entryFile = await writeSceneFile(cwd)
    for (const entryName of [
      '../evil.json',
      'sub/dir.json',
      '..\\evil.json',
      '.hidden.json',
      'asset.json',
      'matos.pack.json',
    ]) {
      const attempt = makeIo(cwd)
      expect(
        await runMatOSAssetsCommand(
          [
            'publish-data',
            '--id', 'traversal-check',
            '--name', 'Traversal check',
            '--entry-file', entryFile,
            '--entry-name', entryName,
          ],
          attempt.io,
        ),
      ).toBe(1)
      expect(attempt.err.join('')).toContain('--entry-name')
    }
    // Nothing was written for the rejected attempts.
    await expect(
      stat(join(cwd, '.matos', 'assets', 'packs', 'published-data', 'data', 'traversal-check')),
    ).rejects.toThrow()
    await expect(stat(join(cwd, '.matos', 'evil.json'))).rejects.toThrow()
  })

  test('rejects bad JSON entries and enforces the size cap', async () => {
    const cwd = await makeProject()
    const badJsonFile = join(cwd, 'broken.json')
    await writeFile(badJsonFile, '{"unterminated": true', 'utf8')
    const badJson = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'bad-json',
          '--name', 'Bad JSON',
          '--entry-file', badJsonFile,
          '--entry-name', 'scene.json',
        ],
        badJson.io,
      ),
    ).toBe(1)
    expect(badJson.err.join('')).toContain('not valid JSON')

    const hugeFile = join(cwd, 'huge.json')
    await writeFile(
      hugeFile,
      `{"blob":"${'x'.repeat(2 * 1024 * 1024)}"}`,
      'utf8',
    )
    const huge = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'huge-doc',
          '--name', 'Huge doc',
          '--entry-file', hugeFile,
        ],
        huge.io,
      ),
    ).toBe(1)
    expect(huge.err.join('')).toContain('exceeding')
    await expect(
      stat(join(cwd, '.matos', 'assets', 'packs', 'published-data', 'data', 'huge-doc')),
    ).rejects.toThrow()
  })

  test('refuses duplicates without --overwrite and replaces with it', async () => {
    const cwd = await makeProject()
    const entryFile = await writeSceneFile(cwd)
    const first = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'dup-scene', '--name', 'Dup scene',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--json',
        ],
        first.io,
      ),
    ).toBe(0)

    const second = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'dup-scene', '--name', 'Dup scene',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
        ],
        second.io,
      ),
    ).toBe(1)
    expect(second.err.join('')).toContain('already exists')

    const updatedScene = { ...SCENE, name: 'HER benchtop demo v2' }
    const updatedFile = join(cwd, 'scene-v2.json')
    await writeFile(updatedFile, JSON.stringify(updatedScene), 'utf8')
    const replaced = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'dup-scene', '--name', 'Dup scene v2',
          '--entry-file', updatedFile, '--entry-name', 'scene.json',
          '--overwrite', '--json',
        ],
        replaced.io,
      ),
    ).toBe(0)
    const result = JSON.parse(replaced.out.join('')) as { overwritten: boolean }
    expect(result.overwritten).toBe(true)
    const stored = JSON.parse(
      await readFile(
        join(cwd, '.matos', 'assets', 'packs', 'published-data', 'data', 'dup-scene', 'scene.json'),
        'utf8',
      ),
    ) as { name: string }
    expect(stored.name).toBe('HER benchtop demo v2')
  })

  test('version bumps replace the same asset dir only with --overwrite', async () => {
    const cwd = await makeProject()
    const entryFile = await writeSceneFile(cwd)
    const first = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'bump-scene', '--name', 'Bump scene',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--json',
        ],
        first.io,
      ),
    ).toBe(0)

    const bumpWithoutOverwrite = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'bump-scene', '--name', 'Bump scene',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--version', '0.2.0',
        ],
        bumpWithoutOverwrite.io,
      ),
    ).toBe(1)
    expect(bumpWithoutOverwrite.err.join('')).toContain('already exists')

    const bump = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'bump-scene', '--name', 'Bump scene',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--version', '0.2.0', '--overwrite', '--json',
        ],
        bump.io,
      ),
    ).toBe(0)
    const result = JSON.parse(bump.out.join('')) as { ref: string }
    expect(result.ref).toBe('data:bump-scene@0.2.0')
    const manifest = JSON.parse(
      await readFile(
        join(cwd, '.matos', 'assets', 'packs', 'published-data', 'data', 'bump-scene', 'asset.json'),
        'utf8',
      ),
    ) as { version: string }
    expect(manifest.version).toBe('0.2.0')
  })

  test('--overwrite refuses to shadow a copy outside the target pack', async () => {
    const cwd = await makeProject()
    const entryFile = await writeSceneFile(cwd)
    const first = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'cross-pack', '--name', 'Cross pack',
          '--pack', 'pack-a',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--json',
        ],
        first.io,
      ),
    ).toBe(0)

    const crossPack = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'cross-pack', '--name', 'Cross pack',
          '--pack', 'pack-b',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--overwrite',
        ],
        crossPack.io,
      ),
    ).toBe(1)
    expect(crossPack.err.join('')).toContain('only replaces the project-local copy')
  })

  test('rolls back (and restores the previous version) when validation fails', async () => {
    const cwd = await makeProject()
    const entryFile = await writeSceneFile(cwd)
    const first = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'rollback-scene', '--name', 'Rollback scene',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--json',
        ],
        first.io,
      ),
    ).toBe(0)

    // A broken sibling manifest with the same asset id (missing entry file)
    // makes the post-write validation report errors attributed to this id,
    // which must roll the new write back and restore the previous version.
    const brokenDir = join(cwd, '.matos', 'assets', 'packs', 'broken-pack', 'data', 'rollback-scene')
    await mkdir(brokenDir, { recursive: true })
    await writeFile(
      join(cwd, '.matos', 'assets', 'packs', 'broken-pack', 'matos.pack.json'),
      JSON.stringify({ id: 'broken-pack', name: 'Broken pack', version: '0.0.1' }),
      'utf8',
    )
    await writeFile(
      join(brokenDir, 'asset.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'rollback-scene',
        type: 'data',
        name: 'Broken sibling',
        version: '9.9.9',
        entry: 'missing-entry.json',
      }),
      'utf8',
    )

    const bump = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'publish-data',
          '--id', 'rollback-scene', '--name', 'Rollback scene v2',
          '--entry-file', entryFile, '--entry-name', 'scene.json',
          '--version', '0.2.0', '--overwrite', '--json',
        ],
        bump.io,
      ),
    ).toBe(1)
    const failure = JSON.parse(bump.out.join('')) as {
      ok: boolean
      rolledBack: boolean
      errors: Array<{ code: string }>
    }
    expect(failure.ok).toBe(false)
    expect(failure.rolledBack).toBe(true)
    expect(failure.errors.length).toBeGreaterThan(0)

    // The previously published 0.1.0 copy was restored, not deleted.
    const manifest = JSON.parse(
      await readFile(
        join(
          cwd, '.matos', 'assets', 'packs', 'published-data',
          'data', 'rollback-scene', 'asset.json',
        ),
        'utf8',
      ),
    ) as { version: string }
    expect(manifest.version).toBe('0.1.0')
  })
})
