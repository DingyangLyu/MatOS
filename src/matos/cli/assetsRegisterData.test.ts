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
}

function makeIo(cwd: string): { io: Io; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  return {
    io: {
      cwd,
      stdout: (text: string) => out.push(text),
      stderr: (text: string) => err.push(text),
    },
    out,
    err,
  }
}

async function makeProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'matos-register-data-'))
}

describe('matos assets register-data', () => {
  test('registers a reference-only data asset with DOI, URL, and verified payload', async () => {
    const cwd = await makeProject()
    await mkdir(join(cwd, 'datasets', 'her'), { recursive: true })
    await writeFile(join(cwd, 'datasets', 'her', 'traj.xyz'), 'payload\n', 'utf8')

    const { io, out } = makeIo(cwd)
    const code = await runMatOSAssetsCommand(
      [
        'register-data',
        '--id', 'her-pt-cations',
        '--name', 'Alkaline HER Pt cations MD',
        '--doi', '10.5281/zenodo.7026971',
        '--url', 'https://zenodo.org/records/7026971',
        '--path', 'datasets/her/traj.xyz',
        '--description', 'AIMD trajectories for alkaline HER on Pt.',
        '--domain', 'Catalysis',
        '--tag', 'materials',
        '--tag', 'catalysis',
        '--json',
      ],
      io,
    )
    expect(code).toBe(0)
    const result = JSON.parse(out.join('')) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.ref).toBe('data:her-pt-cations@1.0.0')
    expect(result.payloadStatus).toBe('verified')
    expect(result.doi).toBe('10.5281/zenodo.7026971')

    const manifestPath = join(
      cwd, '.matos', 'assets', 'packs', 'registered-data', 'data', 'her-pt-cations', 'asset.json',
    )
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      type: string
      tags: string[]
      metadata: Record<string, unknown>
    }
    expect(manifest.type).toBe('data')
    expect(manifest.tags).toContain('catalysis')
    expect(manifest.metadata.doi).toBe('10.5281/zenodo.7026971')
    expect(manifest.metadata.sourceUrls).toEqual([
      'https://zenodo.org/records/7026971',
      'https://doi.org/10.5281/zenodo.7026971',
    ])
    expect(manifest.metadata.payloadStatus).toBe('verified')
    expect(manifest.metadata.sizeBytes).toBe(8)
    expect(manifest.metadata.payloadPolicy).toBe('reference-only')

    // The registered asset is discoverable through the normal list path.
    const list = makeIo(cwd)
    expect(await runMatOSAssetsCommand(['list', '--type', 'data', '--json'], list.io)).toBe(0)
    expect(list.out.join('')).toContain('her-pt-cations')
  })

  test('requires at least one source of truth and a valid id', async () => {
    const cwd = await makeProject()
    const missingSource = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['register-data', '--id', 'x', '--name', 'X'],
        missingSource.io,
      ),
    ).toBe(1)
    expect(missingSource.err.join('')).toContain('--url, --doi, or --path')

    const badId = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['register-data', '--id', 'Bad Id!', '--name', 'X', '--url', 'https://example.org/x'],
        badId.io,
      ),
    ).toBe(1)
    expect(badId.err.join('')).toContain('--id must be a lowercase slug')
  })

  test('refuses duplicates without --replace and honors --require-path', async () => {
    const cwd = await makeProject()
    const first = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['register-data', '--id', 'dup', '--name', 'Dup', '--url', 'https://example.org/d', '--json'],
        first.io,
      ),
    ).toBe(0)

    const second = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        ['register-data', '--id', 'dup', '--name', 'Dup', '--url', 'https://example.org/d'],
        second.io,
      ),
    ).toBe(1)
    expect(second.err.join('')).toContain('already exists')

    const replaced = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'register-data',
          '--id', 'dup',
          '--name', 'Dup v2',
          '--url', 'https://example.org/d2',
          '--replace',
          '--json',
        ],
        replaced.io,
      ),
    ).toBe(0)
    const manifest = JSON.parse(
      await readFile(
        join(cwd, '.matos', 'assets', 'packs', 'registered-data', 'data', 'dup', 'asset.json'),
        'utf8',
      ),
    ) as { name: string }
    expect(manifest.name).toBe('Dup v2')

    const strictPath = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'register-data',
          '--id', 'strict',
          '--name', 'Strict',
          '--path', 'datasets/missing.xyz',
          '--require-path',
        ],
        strictPath.io,
      ),
    ).toBe(1)
    expect(strictPath.err.join('')).toContain('--require-path')
    await expect(
      stat(join(cwd, '.matos', 'assets', 'packs', 'registered-data', 'data', 'strict')),
    ).rejects.toThrow()
  })

  test('records missing payload paths as a warning and payloadStatus=missing', async () => {
    const cwd = await makeProject()
    const { io, out } = makeIo(cwd)
    expect(
      await runMatOSAssetsCommand(
        [
          'register-data',
          '--id', 'cold-ref',
          '--name', 'Cold TOS reference',
          '--url', 'https://zenodo.org/records/12345',
          '--path', '/workspace/knowledge/material-bench-datasets/does-not-exist-here',
          '--tos-archive', 'tos-example-bucket/example/bucket',
          '--json',
        ],
        io,
      ),
    ).toBe(0)
    const result = JSON.parse(out.join('')) as {
      payloadStatus: string
      warnings?: string[]
    }
    expect(result.payloadStatus).toBe('missing')
    expect(result.warnings?.[0]).toContain('not readable')
    const manifest = JSON.parse(
      await readFile(
        join(cwd, '.matos', 'assets', 'packs', 'registered-data', 'data', 'cold-ref', 'asset.json'),
        'utf8',
      ),
    ) as { metadata: Record<string, unknown> }
    expect(manifest.metadata.tosArchive).toBe('tos-example-bucket/example/bucket')
    expect(manifest.metadata.storagePolicy).toBe('payload-stays-in-tos')
  })
})
