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

import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import type { MatOSRuntimeProjection } from './runtimeComposition.js'
import {
  cleanupMatOSRuntimeMaterialization,
  materializeMatOSRuntime,
} from './runtimeMaterialization.js'

const ASSET_TEST_ROOTS: string[] = []

async function mkAssetTestDir(prefix: string): Promise<string> {
  const root = await mkdtempInMatOSTmp({ prefix })
  ASSET_TEST_ROOTS.push(root)
  return root
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function minimalProjection(skillDirs: string[]): MatOSRuntimeProjection {
  return {
    selectedAgent: undefined,
    agents: {},
    appendSystemPrompt: [],
    skillDirs,
    pluginDirs: [],
    mcpConfigPaths: [],
    mcpConfigJson: [],
    allowedTools: [],
    disallowedTools: [],
    readablePaths: [],
    assetToolDirs: [],
    mountedWorkflowRefs: [],
    assetEvents: [],
  }
}

describe('MatOS runtime materialization', () => {
  afterEach(async () => {
    const roots = ASSET_TEST_ROOTS.splice(0)
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  })

  test('concurrent cached materializations converge on one stable published root', async () => {
    // Regression: the cache publish step used to rm(root) + rename
    // unconditionally, so the slower of two concurrent builders of the same
    // content-addressed key deleted the cache root the faster one had just
    // published — and possibly already handed to an agent run that was
    // reading skill files out of it. Losers must adopt the published root.
    const root = await mkAssetTestDir('matos-runtime-materialization-concurrent-')
    const skillDir = join(root, 'source', 'concurrent-skill')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'concurrent-skill',
      type: 'skill',
    })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      '---\nname: concurrent-skill\ndescription: Concurrency guard\n---\n\n# Concurrent Skill\n',
      'utf8',
    )

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          materializeMatOSRuntime(root, minimalProjection([skillDir]), {
            cache: true,
            cacheLabel: 'concurrent-guard',
          }),
        ),
      )
      const roots = new Set(results.map(result => result.addDirs[0]))
      expect(roots.size).toBe(1)
      const cacheRoot = [...roots][0]!
      await expect(
        readFile(
          join(cacheRoot, '.matos', 'skills', 'concurrent-skill', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('Concurrent Skill')
      await stat(join(cacheRoot, '.matos-runtime-materialization.json'))

      // No orphaned publish temp roots may remain after the race resolves.
      const runtimeEntries = await readdir(join(root, 'runtime'))
      expect(runtimeEntries.filter(entry => entry.includes('.tmp-'))).toEqual([])

      // A later call must keep reusing the surviving root untouched.
      const again = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
        { cache: true, cacheLabel: 'concurrent-guard' },
      )
      expect(again.addDirs[0]).toBe(cacheRoot)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('materializes unique leaf skill aliases as loader-visible directories', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-')
    const skillDir = join(root, 'source', 'materials-compute', 'electronic-spin-spectroscopy')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'materials-compute/electronic-spin-spectroscopy',
      type: 'skill',
    })
    await writeFile(
      join(skillDir, 'SKILL.md'),
      [
        '---',
        'name: materials-compute__electronic-spin-spectroscopy',
        'description: Electronic routing',
        '---',
        '',
        '# Electronic Routing',
      ].join('\n'),
      'utf8',
    )

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const skillsRoot = join(materialized.addDirs[0]!, '.matos', 'skills')
      const canonicalDir = join(
        skillsRoot,
        'materials-compute__electronic-spin-spectroscopy',
      )
      const aliasDir = join(skillsRoot, 'electronic-spin-spectroscopy')

      await stat(join(canonicalDir, 'SKILL.md'))
      await stat(join(aliasDir, 'SKILL.md'))
      expect((await lstat(aliasDir)).isSymbolicLink()).toBe(false)
      await expect(readFile(join(aliasDir, 'SKILL.md'), 'utf8')).resolves.toContain(
        'Electronic Routing',
      )
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('can stream-copy skill attachments when fast copy is unavailable', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-stream-')
    const skillDir = join(root, 'source', 'plot-inspection')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'plot-inspection',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Plot inspection\n', 'utf8')
    await writeFile(join(skillDir, 'example.bin'), Buffer.from([0, 1, 2, 3, 4]))

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    const previousCopyMode = process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE = 'stream'
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      await expect(
        readFile(join(materialized.addDirs[0]!, '.matos', 'skills', 'plot-inspection', 'example.bin')),
      ).resolves.toEqual(Buffer.from([0, 1, 2, 3, 4]))
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      if (previousCopyMode === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE = previousCopyMode
      }
    }
  })

  test('ignores container-only materialization roots when running on the host', async () => {
    const testTmpRoot = join(process.cwd(), '.tmp-test')
    await mkdir(testTmpRoot, { recursive: true })
    const root = await mkdtemp(join(testTmpRoot, 'matos-runtime-materialization-host-'))
    const skillDir = join(root, 'source', 'planning')
    const hostTmp = join(root, 'host-tmp')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'planning',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Planning\n', 'utf8')

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    const previousTestTmp = process.env.MATOS_TEST_TMPDIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR =
      '/workspace/caches/tmp/matos-runtime/asset-runtime'
    process.env.MATOS_TEST_TMPDIR = hostTmp
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )

      expect(materialized.addDirs[0]?.startsWith(
        join(hostTmp, 'matos-runtime', 'asset-runtime'),
      )).toBe(true)
      expect(materialized.addDirs[0]).not.toStartWith('/workspace/')
      await stat(join(materialized.addDirs[0]!, '.matos', 'skills', 'planning', 'SKILL.md'))
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      if (previousTestTmp === undefined) {
        delete process.env.MATOS_TEST_TMPDIR
      } else {
        process.env.MATOS_TEST_TMPDIR = previousTestTmp
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps skill examples by default during runtime materialization', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-cache-')
    const skillDir = join(root, 'source', 'molecular-qchem', 'thermochemistry')
    const vibDir = join(skillDir, 'examples', 'water', 'species_O2', 'vib')
    await mkdir(vibDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'molecular-qchem/thermochemistry',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Thermochemistry\n', 'utf8')
    await writeJson(join(vibDir, 'cache.0y+.json'), { generated: true })
    await writeJson(join(skillDir, 'examples', 'water', 'thermochemistry_results.json'), {
      deltaG: -1,
    })

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const skillRoot = join(
        materialized.addDirs[0]!,
        '.matos',
        'skills',
        'molecular-qchem__thermochemistry',
      )

      await expect(
        readFile(
          join(skillRoot, 'examples', 'water', 'thermochemistry_results.json'),
          'utf8',
        ),
      ).resolves.toContain('deltaG')
      await expect(
        stat(join(skillRoot, 'examples', 'water', 'species_O2', 'vib')),
      ).resolves.toBeTruthy()
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can skip skill examples when explicitly disabled', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-no-examples-')
    const skillDir = join(root, 'source', 'molecular-qchem', 'thermochemistry')
    await mkdir(join(skillDir, 'examples', 'water'), { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'molecular-qchem/thermochemistry',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Thermochemistry\n', 'utf8')
    await writeJson(join(skillDir, 'examples', 'water', 'thermochemistry_results.json'), {
      deltaG: -1,
    })

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    const previousExamples = process.env.MATOS_SKILL_MATERIALIZATION_INCLUDE_EXAMPLES
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    process.env.MATOS_SKILL_MATERIALIZATION_INCLUDE_EXAMPLES = '0'
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const skillRoot = join(
        materialized.addDirs[0]!,
        '.matos',
        'skills',
        'molecular-qchem__thermochemistry',
      )

      await expect(stat(join(skillRoot, 'examples'))).rejects.toThrow()
      const skipped = JSON.parse(
        await readFile(join(skillRoot, '.matos-skipped-files.json'), 'utf8'),
      )
      expect(skipped.skipped).toEqual([
        expect.objectContaining({
          path: 'examples/',
          reason: 'examples-directory',
        }),
      ])
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      if (previousExamples === undefined) {
        delete process.env.MATOS_SKILL_MATERIALIZATION_INCLUDE_EXAMPLES
      } else {
        process.env.MATOS_SKILL_MATERIALIZATION_INCLUDE_EXAMPLES = previousExamples
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('can stream-copy executable skill files when fast copy is unavailable', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-stream-')
    const skillDir = join(root, 'source', 'experimental-xrd', 'image-to-xrd')
    const scriptsDir = join(skillDir, 'scripts')
    const scriptPath = join(scriptsDir, 'eda_analyzer.py')
    await mkdir(scriptsDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'experimental-xrd/image-to-xrd',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Image to XRD\n', 'utf8')
    await writeFile(scriptPath, '#!/usr/bin/env python3\nprint("xrd")\n', 'utf8')
    await chmod(scriptPath, 0o755)

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    const previousCopyMode = process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE = 'stream'
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const copiedScript = join(
        materialized.addDirs[0]!,
        '.matos',
        'skills',
        'experimental-xrd__image-to-xrd',
        'scripts',
        'eda_analyzer.py',
      )

      await expect(readFile(copiedScript, 'utf8')).resolves.toContain('print("xrd")')
      expect((await lstat(copiedScript)).mode & 0o111).toBeGreaterThan(0)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      if (previousCopyMode === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE = previousCopyMode
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('reuses cached materialization roots and invalidates when skill content changes', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-reuse-')
    const skillDir = join(root, 'source', 'planning')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'planning',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Planning\n', 'utf8')

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const first = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
        { cache: true, cacheLabel: 'role:test' },
      )
      const second = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
        { cache: true, cacheLabel: 'role:test' },
      )

      expect(second.addDirs[0]).toBe(first.addDirs[0])
      await cleanupMatOSRuntimeMaterialization(root, first.addDirs)
      await expect(
        readFile(
          join(first.addDirs[0]!, '.matos', 'skills', 'planning', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('Planning')

      await writeFile(join(skillDir, 'SKILL.md'), '# Strategy\n', 'utf8')
      const sameSizeUpdated = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
        { cache: true, cacheLabel: 'role:test' },
      )

      expect(sameSizeUpdated.addDirs[0]).not.toBe(first.addDirs[0])
      await expect(
        readFile(
          join(sameSizeUpdated.addDirs[0]!, '.matos', 'skills', 'planning', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('Strategy')

      await writeFile(join(skillDir, 'SKILL.md'), '# Planning updated\n', 'utf8')
      const updated = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
        { cache: true, cacheLabel: 'role:test' },
      )

      expect(updated.addDirs[0]).not.toBe(sameSizeUpdated.addDirs[0])
      await expect(
        readFile(
          join(updated.addDirs[0]!, '.matos', 'skills', 'planning', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('Planning updated')
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      await rm(root, { recursive: true, force: true })
    }
  })

  test('defaults to a persistent fingerprint cache and skips re-copying on warm reuse', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-default-cache-')
    const skillDir = join(root, 'source', 'materials-compute', 'relaxation')
    const scriptsDir = join(skillDir, 'scripts')
    await mkdir(scriptsDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'materials-compute/relaxation',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Relaxation\n', 'utf8')
    for (let index = 0; index < 40; index += 1) {
      await writeFile(join(scriptsDir, `step-${index}.py`), `print(${index})\n`, 'utf8')
    }

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const coldStartedAt = performance.now()
      const first = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const coldMs = performance.now() - coldStartedAt

      const firstRoot = first.addDirs[0]!
      expect(basename(firstRoot).startsWith('cache-')).toBe(true)
      const markerPath = join(firstRoot, '.matos-runtime-materialization.json')
      const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
        cacheKey: string
      }
      expect(marker.cacheKey).toBe(basename(firstRoot).slice('cache-'.length))

      // A sentinel inside the cache dir plus a backdated marker prove the
      // second call reuses the tree in place (no rm/re-copy) and refreshes
      // the marker mtime for least-recently-used pruning.
      const sentinelPath = join(firstRoot, '.sentinel-keep')
      await writeFile(sentinelPath, 'keep\n', 'utf8')
      const backdated = new Date(Date.now() - 60 * 60 * 1000)
      await utimes(markerPath, backdated, backdated)

      const warmStartedAt = performance.now()
      const second = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const warmMs = performance.now() - warmStartedAt

      expect(second.addDirs[0]).toBe(firstRoot)
      await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('keep\n')
      const touched = await stat(markerPath)
      expect(Date.now() - touched.mtimeMs).toBeLessThan(30 * 60 * 1000)
      expect(warmMs).toBeLessThanOrEqual(coldMs)
      console.log(
        `materialization timing: cold=${coldMs.toFixed(1)}ms warm=${warmMs.toFixed(1)}ms`,
      )

      // Session-end cleanup must keep the persistent cache alive.
      await cleanupMatOSRuntimeMaterialization(root, second.addDirs)
      await stat(join(firstRoot, '.matos', 'skills'))
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('materializes a new fingerprint directory when skill content changes', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-invalidate-')
    const skillDir = join(root, 'source', 'planning')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'planning',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Planning\n', 'utf8')

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const first = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      await writeFile(join(skillDir, 'SKILL.md'), '# Planning v2\n', 'utf8')
      const second = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )

      expect(second.addDirs[0]).not.toBe(first.addDirs[0])
      await expect(
        readFile(
          join(second.addDirs[0]!, '.matos', 'skills', 'planning', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('Planning v2')
      // Recently used sibling fingerprints survive until they age out of the
      // prune window.
      await stat(join(first.addDirs[0]!, '.matos', 'skills'))
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('hardlinks materialized skill files on the same filesystem', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-hardlink-')
    const skillDir = join(root, 'source', 'experimental-xrd', 'image-to-xrd')
    const scriptsDir = join(skillDir, 'scripts')
    await mkdir(scriptsDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'experimental-xrd/image-to-xrd',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Image to XRD\n', 'utf8')
    const scriptPath = join(scriptsDir, 'eda_analyzer.py')
    await writeFile(scriptPath, '#!/usr/bin/env python3\nprint("xrd")\n', 'utf8')
    await chmod(scriptPath, 0o755)

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const skillsRoot = join(materialized.addDirs[0]!, '.matos', 'skills')
      const copiedScript = join(
        skillsRoot,
        'experimental-xrd__image-to-xrd',
        'scripts',
        'eda_analyzer.py',
      )
      const sourceInfo = await lstat(scriptPath)
      const targetInfo = await lstat(copiedScript)

      expect(targetInfo.ino).toBe(sourceInfo.ino)
      expect(targetInfo.dev).toBe(sourceInfo.dev)
      expect(targetInfo.mode & 0o111).toBeGreaterThan(0)
      await expect(readFile(copiedScript, 'utf8')).resolves.toContain(
        'print("xrd")',
      )
      // The unique leaf alias tree shares the same inodes.
      const aliasInfo = await lstat(
        join(skillsRoot, 'image-to-xrd', 'scripts', 'eda_analyzer.py'),
      )
      expect(aliasInfo.ino).toBe(sourceInfo.ino)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('falls back to byte copies when hardlinking is not possible', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-link-fallback-')
    // Prefer a real cross-device source (tmpfs at /dev/shm) so link() fails
    // with EXDEV against the vePFS/disk-backed materialization root. When the
    // environment lacks a second filesystem, force the byte-copy mode instead;
    // both paths must produce an independent, content-identical file.
    let sourceBase = join(root, 'source')
    let shmSourceRoot: string | undefined
    try {
      const shmInfo = await stat('/dev/shm')
      const rootInfo = await stat(root)
      if (shmInfo.isDirectory() && shmInfo.dev !== rootInfo.dev) {
        shmSourceRoot = await mkdtemp('/dev/shm/matos-materialization-xdev-')
        sourceBase = shmSourceRoot
      }
    } catch {
      // No usable /dev/shm; keep the same-filesystem source.
    }

    const skillDir = join(sourceBase, 'fallback-skill')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'fallback-skill',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Fallback\n', 'utf8')
    const payload = Buffer.from([7, 6, 5, 4, 3])
    await writeFile(join(skillDir, 'data.bin'), payload)

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    const previousCopyMode = process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    if (!shmSourceRoot) {
      process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE = 'copy'
    }
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )
      const copiedPath = join(
        materialized.addDirs[0]!,
        '.matos',
        'skills',
        'fallback-skill',
        'data.bin',
      )
      const sourceInfo = await lstat(join(skillDir, 'data.bin'))
      const targetInfo = await lstat(copiedPath)

      await expect(readFile(copiedPath)).resolves.toEqual(payload)
      expect(
        targetInfo.dev === sourceInfo.dev && targetInfo.ino === sourceInfo.ino,
      ).toBe(false)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      if (previousCopyMode === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_COPY_MODE = previousCopyMode
      }
      if (shmSourceRoot) {
        await rm(shmSourceRoot, { recursive: true, force: true })
      }
    }
  })

  test('prunes old fingerprint caches beyond the keep limit and abandoned scratch dirs', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-prune-')
    const runtimeRoot = join(root, 'runtime')
    await mkdir(runtimeRoot, { recursive: true })
    const hoursAgo = (hours: number) =>
      new Date(Date.now() - hours * 60 * 60 * 1000)

    const fakeCaches: string[] = []
    for (const [index, ageHours] of [2, 3, 4, 5].entries()) {
      const fakeRoot = join(runtimeRoot, `cache-fake${index}`)
      await mkdir(join(fakeRoot, '.matos', 'skills'), { recursive: true })
      const markerPath = join(fakeRoot, '.matos-runtime-materialization.json')
      await writeJson(markerPath, { version: 7, cacheKey: `fake${index}` })
      await utimes(markerPath, hoursAgo(ageHours), hoursAgo(ageHours))
      fakeCaches.push(fakeRoot)
    }
    const staleScratch = join(runtimeRoot, '.cache-fake0.tmp-stale')
    await mkdir(staleScratch, { recursive: true })
    await utimes(staleScratch, hoursAgo(25), hoursAgo(25))
    const freshScratch = join(runtimeRoot, '.cache-fake0.tmp-fresh')
    await mkdir(freshScratch, { recursive: true })

    const skillDir = join(root, 'source', 'planning')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'planning',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Planning\n', 'utf8')

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = runtimeRoot
    try {
      const materialized = await materializeMatOSRuntime(
        root,
        minimalProjection([skillDir]),
      )

      // Publishing a usable skill tree must not wait for recursive deletion
      // of old trees on the workspace's network filesystem.
      expect(existsSync(fakeCaches[3]!)).toBe(true)
      const cleanupDeadline = Date.now() + 5_000
      while (existsSync(fakeCaches[3]!) && Date.now() < cleanupDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await stat(materialized.addDirs[0]!)
      // Keep limit 3: the fresh tree plus the two most recently used caches.
      await stat(fakeCaches[0]!)
      await stat(fakeCaches[1]!)
      await expect(stat(fakeCaches[2]!)).rejects.toThrow()
      await expect(stat(fakeCaches[3]!)).rejects.toThrow()
      // Abandoned scratch dirs are reclaimed only after they age out.
      await expect(stat(staleScratch)).rejects.toThrow()
      await stat(freshScratch)
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('serves concurrent same-fingerprint materializations from a single cache', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-concurrent-')
    const skillDir = join(root, 'source', 'planning')
    await mkdir(skillDir, { recursive: true })
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'planning',
      type: 'skill',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Planning\n', 'utf8')

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = join(root, 'runtime')
    try {
      const [first, second] = await Promise.all([
        materializeMatOSRuntime(root, minimalProjection([skillDir])),
        materializeMatOSRuntime(root, minimalProjection([skillDir])),
      ])

      expect(second.addDirs[0]).toBe(first.addDirs[0]!)
      await expect(
        readFile(
          join(first.addDirs[0]!, '.matos', 'skills', 'planning', 'SKILL.md'),
          'utf8',
        ),
      ).resolves.toContain('Planning')
      // The losing writer must clean up its scratch tree.
      const leftovers = (await readdir(join(root, 'runtime'))).filter(name =>
        name.startsWith('.cache-'),
      )
      expect(leftovers).toEqual([])
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
    }
  })

  test('cleans only materialization run directories under the configured root', async () => {
    const root = await mkAssetTestDir('matos-runtime-materialization-cleanup-')
    const runtimeRoot = join(root, 'runtime')
    const runDir = join(runtimeRoot, 'run-1')
    const rootFile = join(runtimeRoot, 'keep.txt')
    const outsideDir = join(root, 'outside')
    await mkdir(runDir, { recursive: true })
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(runDir, 'scratch.txt'), 'scratch\n', 'utf8')
    await writeFile(rootFile, 'keep\n', 'utf8')
    await writeFile(join(outsideDir, 'outside.txt'), 'outside\n', 'utf8')

    const previousRoot = process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
    process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = runtimeRoot
    try {
      await cleanupMatOSRuntimeMaterialization(root, [
        runDir,
        runtimeRoot,
        outsideDir,
      ])
      await expect(stat(runDir)).rejects.toThrow()
      await expect(readFile(rootFile, 'utf8')).resolves.toBe('keep\n')
      await expect(readFile(join(outsideDir, 'outside.txt'), 'utf8')).resolves.toBe(
        'outside\n',
      )
    } finally {
      if (previousRoot === undefined) {
        delete process.env.MATOS_RUNTIME_MATERIALIZATION_DIR
      } else {
        process.env.MATOS_RUNTIME_MATERIALIZATION_DIR = previousRoot
      }
      await rm(root, { recursive: true, force: true })
    }
  })
})
