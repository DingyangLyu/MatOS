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

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { gitBuffer } from './gitBackend.js'
import { snapshotRecordsDir } from './records.js'
import {
  MatOSAssetHistorySnapshotRaceError,
  createMatOSAssetHistorySnapshot,
  matOSGitBlobSha1,
} from './snapshot.js'
import type { MatOSAssetHistorySnapshotRecord } from './types.js'

const execFileAsync = promisify(execFile)

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createCoreFixture(extraNoteCount = 0): Promise<{
  root: string
  roleDir: string
  hotPath: string
  hotLogicalPath: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'matos-asset-history-race-'))
  const roleDir = join(
    root,
    'matos-assets',
    'packs',
    'matos-core',
    'roles',
    'compute',
  )
  await mkdir(roleDir, { recursive: true })
  await writeJson(join(roleDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'compute',
    type: 'role',
    name: 'Compute',
    version: '0.1.0',
    entry: 'ROLE.md',
  })
  await writeFile(join(roleDir, 'ROLE.md'), '# Compute\n\nStable body.\n', 'utf8')
  for (let index = 0; index < extraNoteCount; index += 1) {
    await writeFile(
      join(roleDir, `note-${String(index).padStart(2, '0')}.md`),
      `# Note ${index}\n\nStatic content ${index}.\n`,
      'utf8',
    )
  }
  const hotPath = join(roleDir, 'HOT.md')
  await writeFile(hotPath, '# Hot\n\nrevision 0\n', 'utf8')
  return {
    root,
    roleDir,
    hotPath,
    hotLogicalPath: 'matos-assets/packs/matos-core/roles/compute/HOT.md',
  }
}

describe('MatOS asset history snapshot consistency', () => {
  test('matOSGitBlobSha1 matches real git hash-object blob ids', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'matos-blob-sha1-'))
    const samplePath = join(scratch, 'sample.md')
    const content = Buffer.from('# Sample\n\nblob-id check \u00e9\u4e2d\n', 'utf8')
    await writeFile(samplePath, content)
    const result = await execFileAsync('git', ['hash-object', samplePath], {
      cwd: scratch,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
    })
    const gitBlobId = String(result.stdout ?? '').trim()
    expect(matOSGitBlobSha1(content)).toHaveLength(40)
    if (gitBlobId.length === 40) {
      expect(matOSGitBlobSha1(content)).toBe(gitBlobId)
    }
  })

  test('snapshot record writes leave no temp residue in the records dir', async () => {
    const { root } = await createCoreFixture()
    const record = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      message: 'atomic record write',
    })
    const entries = await readdir(snapshotRecordsDir(root))
    expect(entries).toContain(`${record.snapshotId}.json`)
    expect(entries.filter(entry => !entry.endsWith('.json'))).toEqual([])
  })

  test('a snapshot raced by a concurrent writer never records hashes that disagree with its commit', async () => {
    // Without staged-byte verification, buildFileRecords scanned one version
    // of the file while `git hash-object` staged a newer one, producing a
    // snapshot whose record sha256 disagrees with the committed blob — and
    // every later restore/rollback of that snapshot failed. The only allowed
    // outcomes now are a self-consistent snapshot (possibly after retries) or
    // an explicit race error.
    const { root, hotPath, hotLogicalPath } = await createCoreFixture(12)

    let settled = false
    const writer = (async () => {
      let revision = 0
      const deadline = Date.now() + 20_000
      while (!settled && Date.now() < deadline) {
        revision += 1
        await writeFile(
          hotPath,
          `# Hot\n\nrevision ${revision} ${'x'.repeat(revision % 9)}\n`,
          'utf8',
        )
      }
    })()

    let record: MatOSAssetHistorySnapshotRecord | undefined
    let raceError: unknown
    try {
      record = await createMatOSAssetHistorySnapshot({
        cwd: root,
        kind: 'manual',
        scope: 'core',
        message: 'hot-file race',
      })
    } catch (error) {
      if (!(error instanceof MatOSAssetHistorySnapshotRaceError)) {
        settled = true
        await writer
        throw error
      }
      raceError = error
    } finally {
      settled = true
    }
    await writer

    if (record) {
      for (const logicalPath of [
        hotLogicalPath,
        'matos-assets/packs/matos-core/roles/compute/ROLE.md',
      ]) {
        const fileRecord = record.files.find(file => file.path === logicalPath)
        expect(fileRecord).toBeDefined()
        const committed = await gitBuffer(root, [
          'show',
          `${record.commit}:${logicalPath}`,
        ])
        expect(createHash('sha256').update(committed).digest('hex')).toBe(
          fileRecord!.sha256,
        )
        expect(committed.byteLength).toBe(fileRecord!.sizeBytes)
      }
    } else {
      expect(raceError).toBeInstanceOf(MatOSAssetHistorySnapshotRaceError)
      expect(String((raceError as Error).message)).toContain(
        'raced a concurrent modification',
      )
    }
  })
})
