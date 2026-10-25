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
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { acquireMatOSExternalIntakeSource } from './externalIntakeAcquire.js'
import { previewMatOSWorkbenchExternalIntakeDraftPack } from './externalIntakeDraftPack.js'

const execFileAsync = promisify(execFile)

async function makeCwd(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'matos-intake-acquire-'))
}

async function makeToolRepo(root: string): Promise<string> {
  const repo = join(root, 'toy-mlip-tool')
  await mkdir(join(repo, 'src'), { recursive: true })
  await writeFile(join(repo, 'README.md'), '# Toy MLIP tool\nA tiny CLI tool.\n', 'utf8')
  await writeFile(join(repo, 'pyproject.toml'), '[project]\nname = "toy-mlip-tool"\n', 'utf8')
  await writeFile(join(repo, 'src', 'main.py'), 'print("relax")\n', 'utf8')
  return repo
}

describe('external intake acquisition', () => {
  test('passes plain local directories through unchanged', async () => {
    const cwd = await makeCwd()
    const repo = await makeToolRepo(cwd)
    const acquisition = await acquireMatOSExternalIntakeSource({ cwd, source: repo })
    expect(acquisition.sourceKind).toBe('local')
    expect(acquisition.staged).toBe(false)
    expect(acquisition.localPath).toBe(repo)
    expect(acquisition.issues).toEqual([])
  })

  test('unpacks zip archives into an idempotent stage keyed by content', async () => {
    const cwd = await makeCwd()
    const repo = await makeToolRepo(cwd)
    const zipPath = join(cwd, 'toy-mlip-tool.zip')
    await execFileAsync('zip', ['-qr', zipPath, 'toy-mlip-tool'], { cwd })

    const first = await acquireMatOSExternalIntakeSource({ cwd, source: zipPath })
    expect(first.sourceKind).toBe('archive')
    expect(first.staged).toBe(true)
    expect(first.reused).toBe(false)
    expect(first.provenance.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    // Single-top-level-dir archive collapses to the real directory name.
    expect(first.localPath.endsWith('/toy-mlip-tool')).toBe(true)
    expect((await stat(join(first.localPath, 'README.md'))).isFile()).toBe(true)

    const second = await acquireMatOSExternalIntakeSource({ cwd, source: zipPath })
    expect(second.reused).toBe(true)
    expect(second.localPath).toBe(first.localPath)
  })

  test('rejects zip archives with path traversal entries', async () => {
    const cwd = await makeCwd()
    // Build a malicious zip with a ../ entry via python (zip CLI refuses).
    const zipPath = join(cwd, 'evil.zip')
    await execFileAsync('python3', [
      '-c',
      [
        'import zipfile,sys',
        `z=zipfile.ZipFile(${JSON.stringify(zipPath)},'w')`,
        "z.writestr('../escape.txt','x')",
        "z.writestr('ok.txt','y')",
        'z.close()',
      ].join('\n'),
    ])
    const acquisition = await acquireMatOSExternalIntakeSource({ cwd, source: zipPath })
    expect(acquisition.issues.some(issue => issue.code === 'archive_unsafe_entries')).toBe(true)
  })

  test('clones git remotes shallowly and records the commit', async () => {
    const cwd = await makeCwd()
    const repo = await makeToolRepo(cwd)
    await execFileAsync('git', ['-C', repo, 'init', '-q'])
    await execFileAsync('git', ['-C', repo, 'add', '-A'])
    await execFileAsync('git', [
      '-C', repo,
      '-c', 'user.email=t@example.org',
      '-c', 'user.name=t',
      'commit', '-qm', 'init',
    ])

    const acquisition = await acquireMatOSExternalIntakeSource({
      cwd,
      source: `git+file://${repo}`,
    })
    expect(acquisition.sourceKind).toBe('git')
    expect(acquisition.staged).toBe(true)
    expect(acquisition.provenance.gitCommit).toMatch(/^[0-9a-f]{40}$/)
    expect((await stat(join(acquisition.localPath, 'pyproject.toml'))).isFile()).toBe(true)

    const reused = await acquireMatOSExternalIntakeSource({
      cwd,
      source: `git+file://${repo}`,
    })
    expect(reused.reused).toBe(true)
    expect(reused.localPath).toBe(acquisition.localPath)
  })

  test('normalizes GitHub deep links to the repository clone URL', async () => {
    const cwd = await makeCwd()
    const acquisition = await acquireMatOSExternalIntakeSource({
      cwd,
      source: 'https://github.com/org/repo/tree/main/subdir',
    })
    // Network is not assumed in tests: the clone fails, but the source must
    // have been classified as git with the normalized remote in the message.
    expect(acquisition.sourceKind).toBe('git')
    const issue = acquisition.issues.find(item => item.code === 'git_clone_failed')
    expect(issue?.message).toContain('https://github.com/org/repo.git')
  }, 30_000)

  test('intake-draft previews archives end to end with acquisition provenance', async () => {
    const cwd = await makeCwd()
    const repo = await makeToolRepo(cwd)
    const zipPath = join(cwd, 'toy-mlip-tool.zip')
    await execFileAsync('zip', ['-qr', zipPath, 'toy-mlip-tool'], { cwd })

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd,
      path: zipPath,
    })
    expect(preview.validation.ok).toBe(true)
    expect(preview.plan.intake.acquisition?.sourceKind).toBe('archive')
    expect(preview.plan.intake.acquisition?.archiveSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(preview.plan.proposedAssets.length).toBeGreaterThan(0)
    expect(preview.plan.targetPack.packId).toContain('toy-mlip-tool')

    // Preview twice: staging reuse keeps the confirmation fingerprint stable.
    const again = await previewMatOSWorkbenchExternalIntakeDraftPack({ cwd, path: zipPath })
    expect(again.transaction.confirmationFingerprint).toBe(
      preview.transaction.confirmationFingerprint,
    )
  })

  test('rejects oversized downloads before buffering the whole body', async () => {
    const cwd = await makeCwd()
    const previousLimit = process.env.MATOS_INTAKE_MAX_DOWNLOAD_BYTES
    process.env.MATOS_INTAKE_MAX_DOWNLOAD_BYTES = '1024'

    // Content-Length path: Bun sets a real Content-Length for a fixed body,
    // so an over-limit download is rejected up front without staging.
    const bigBody = 'A'.repeat(8 * 1024)
    const clServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(bigBody, { headers: { 'Content-Type': 'application/octet-stream' } }),
    })
    // Chunked/streaming path: no Content-Length, so the running cap must abort.
    const streamServer = Bun.serve({
      port: 0,
      fetch: () => {
        let sent = 0
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent >= 8 * 1024) {
              controller.close()
              return
            }
            sent += 512
            controller.enqueue(new Uint8Array(512))
          },
        })
        return new Response(stream, { headers: { 'Content-Type': 'application/octet-stream' } })
      },
    })
    try {
      const declared = await acquireMatOSExternalIntakeSource({
        cwd,
        source: `http://127.0.0.1:${clServer.port}/big.bin`,
      })
      expect(declared.sourceKind).toBe('download')
      expect(declared.staged).toBe(false)
      expect(declared.issues.some(issue => issue.code === 'download_too_large')).toBe(true)

      const streamed = await acquireMatOSExternalIntakeSource({
        cwd,
        source: `http://127.0.0.1:${streamServer.port}/stream.bin`,
      })
      expect(streamed.staged).toBe(false)
      expect(streamed.issues.some(issue => issue.code === 'download_too_large')).toBe(true)
    } finally {
      clServer.stop(true)
      streamServer.stop(true)
      if (previousLimit === undefined) {
        delete process.env.MATOS_INTAKE_MAX_DOWNLOAD_BYTES
      } else {
        process.env.MATOS_INTAKE_MAX_DOWNLOAD_BYTES = previousLimit
      }
    }
  })

  test('records download provenance in the acquire record for http sources', async () => {
    const cwd = await makeCwd()
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response('# Paper\n\nA tiny markdown paper about MLIP benchmarks.\n', {
          headers: { 'Content-Type': 'text/markdown' },
        }),
    })
    try {
      const url = `http://127.0.0.1:${server.port}/mlip-paper.md`
      const acquisition = await acquireMatOSExternalIntakeSource({ cwd, source: url })
      expect(acquisition.sourceKind).toBe('download')
      expect(acquisition.staged).toBe(true)
      expect(acquisition.provenance.downloadSha256).toMatch(/^[0-9a-f]{64}$/)
      expect(acquisition.localPath.endsWith('/mlip-paper.md')).toBe(true)
      expect(await readFile(acquisition.localPath, 'utf8')).toContain('MLIP benchmarks')

      const reused = await acquireMatOSExternalIntakeSource({ cwd, source: url })
      expect(reused.reused).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
