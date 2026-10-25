import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { adoptMatOSExternalIntakeDraftPack } from './externalIntakeAdopt.js'
import {
  applyMatOSWorkbenchExternalIntakeDraftPack,
  previewMatOSWorkbenchExternalIntakeDraftPack,
} from './externalIntakeDraftPack.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MatOS Test',
      GIT_AUTHOR_EMAIL: 'matos-test@localhost',
      GIT_COMMITTER_NAME: 'MatOS Test',
      GIT_COMMITTER_EMAIL: 'matos-test@localhost',
    },
  })
  return stdout.trim()
}

const ADOPT_ENV = { MATOS_SCOPE_REF: 'user:alice', MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '1' }

// A workspace with alice's accepted user source and one drafted runbook.
async function draftedWorkspace(): Promise<{ root: string; repo: string; seedCommit: string }> {
  const root = await mkdtemp(join(tmpdir(), 'matos-intake-adopt-root-'))
  const repo = await mkdtemp(join(tmpdir(), 'matos-intake-adopt-repo-'))
  await writeFile(join(repo, 'README.md'), 'alice assets\n', 'utf8')
  await git(repo, ['init', '-b', 'main'])
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'seed'])
  const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
  await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeFile(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify({
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [
        {
          type: 'git',
          id: 'alice-assets',
          repo,
          ref: 'main',
          runtimeRef: { mode: 'accepted-ref', ref: 'accepted/alice-assets/stable', commit: seedCommit },
          scope: 'user',
          scopeRef: 'user:alice',
          refresh: 'manual',
        },
      ],
    }, null, 2)}\n`,
  )
  await mkdir(join(root, 'sources'), { recursive: true })
  await writeFile(
    join(root, 'sources', 'pellet-runbook.md'),
    '# Electrolyte pellet runbook\n\nDry the powder at 120 C for 12 h, then press at 380 MPa.\n',
  )
  const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({ cwd: root, path: 'sources/pellet-runbook.md' })
  await applyMatOSWorkbenchExternalIntakeDraftPack({
    cwd: root,
    path: 'sources/pellet-runbook.md',
    fingerprint: preview.transaction.confirmationFingerprint,
  })
  return { root, repo, seedCommit }
}

describe('adopting external intake drafts', () => {
  test('publishes a draft pack into the scoped accepted source as enabled assets', async () => {
    const { root, repo, seedCommit } = await draftedWorkspace()
    const packDir = join(root, '.matos', 'assets', 'packs', 'intake-pellet-runbook')
    expect(existsSync(packDir)).toBe(true)

    const result = await adoptMatOSExternalIntakeDraftPack({
      cwd: root,
      packId: 'intake-pellet-runbook',
      env: ADOPT_ENV,
    })

    expect(result).toMatchObject({ ok: true, scopeRef: 'user:alice' })
    expect(result.adoptedRefs).toEqual(['knowledge:pellet-runbook@0.1.0'])
    expect(existsSync(packDir)).toBe(false)
    const accepted = await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])
    expect(accepted).not.toBe(seedCommit)
    const manifest = JSON.parse(
      await git(repo, ['show', 'accepted/alice-assets/stable:knowledge/pellet-runbook/asset.json']),
    ) as { name: string; tags: string[]; lifecycle: { status: string } }
    expect(manifest.lifecycle.status).toBe('enabled')
    expect(manifest.tags).not.toContain('draft')
    expect(manifest.name).not.toContain('intake draft')

    const adopted = (await loadMatOSAssets(root)).filter(
      asset => asset.type === 'knowledge' && asset.id === 'pellet-runbook',
    )
    expect(adopted).toHaveLength(1)
    expect(adopted[0]?.lifecycle.status).toBe('enabled')
  })

  test('refuses without a scope and for unknown packs', async () => {
    const { root } = await draftedWorkspace()
    expect(
      await adoptMatOSExternalIntakeDraftPack({ cwd: root, packId: 'intake-pellet-runbook', env: {} }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('scope') })
    expect(
      await adoptMatOSExternalIntakeDraftPack({ cwd: root, packId: 'intake-missing', env: ADOPT_ENV }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('No external intake drafts') })
    expect(
      await adoptMatOSExternalIntakeDraftPack({ cwd: root, packId: '../escape', env: ADOPT_ENV }),
    ).toMatchObject({ ok: false, error: expect.stringContaining('Invalid') })
  })
})
