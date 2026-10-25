import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { runMatOSWorkbenchCommand } from '../cli/workbench.js'
import {
  classifyMatOSExternalIntakeSource,
  fingerprintMatOSExternalIntakeSource,
} from './externalIntakeClassification.js'
import {
  applyMatOSWorkbenchExternalIntakeDraftPack,
  classifyMatOSWorkbenchExternalIntakeSource,
  previewMatOSWorkbenchExternalIntakeDraftPack,
} from './externalIntakeDraftPack.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function createIntakeFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-intake-draft-'))
  await mkdir(join(root, '.matos'), { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  return root
}

async function createPythonToolRepo(root: string, name = 'pytool'): Promise<string> {
  const repo = join(root, 'sources', name)
  await mkdir(join(repo, 'src', name), { recursive: true })
  await mkdir(join(repo, 'scripts'), { recursive: true })
  await mkdir(join(repo, 'tests'), { recursive: true })
  await writeFile(
    join(repo, 'pyproject.toml'),
    [
      '[project]',
      `name = "${name}"`,
      'version = "1.2.3"',
      '',
      '[project.scripts]',
      `${name} = "${name}.cli:main"`,
      '',
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(repo, 'README.md'),
    `# ${name}\n\nA structure relaxation command line helper.\n`,
    'utf8',
  )
  await writeFile(join(repo, 'src', name, 'cli.py'), 'def main():\n    return 0\n', 'utf8')
  await writeFile(join(repo, 'scripts', 'run_relax.py'), 'print("relax")\n', 'utf8')
  await writeFile(join(repo, 'tests', 'test_cli.py'), 'def test_ok():\n    assert True\n', 'utf8')
  return repo
}

async function createMarkdownCorpus(root: string, name = 'mlip-handbook'): Promise<string> {
  const corpus = join(root, 'sources', name)
  await mkdir(join(corpus, 'docs'), { recursive: true })
  await writeFile(join(corpus, 'README.md'), '# MLIP Handbook\n\nOperational notes.\n', 'utf8')
  for (const chapter of ['training', 'evaluation-metrics', 'deployment', 'troubleshooting']) {
    await writeFile(
      join(corpus, 'docs', `${chapter}.md`),
      `# ${chapter}\n\nReference notes about ${chapter}.\n`,
      'utf8',
    )
  }
  return corpus
}

async function createStructureDataRepo(root: string, name = 'cu-structures'): Promise<string> {
  const repo = join(root, 'sources', name)
  await mkdir(join(repo, 'structures'), { recursive: true })
  await writeFile(join(repo, 'README.md'), '# Cu structures\n', 'utf8')
  for (let index = 0; index < 6; index += 1) {
    await writeFile(
      join(repo, 'structures', `cu-${index}.cif`),
      `data_cu_${index}\n_cell_length_a 3.6\n`,
      'utf8',
    )
    await writeFile(
      join(repo, 'structures', `cu-${index}.xyz`),
      `1\ncu frame ${index}\nCu 0 0 0\n`,
      'utf8',
    )
  }
  return repo
}

async function createPaperMarkdown(root: string, name = 'diffusion-mlip-survey.md'): Promise<string> {
  const dir = join(root, 'sources', 'papers')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(
    path,
    '# Diffusion Models for MLIP Data Generation\n\n## Abstract\n\nA survey of diffusion-based structure generation.\n',
    'utf8',
  )
  return path
}

async function createPaperPdf(root: string, name = 'phonon-transport.pdf'): Promise<string> {
  const dir = join(root, 'sources', 'papers')
  await mkdir(dir, { recursive: true })
  const path = join(dir, name)
  await writeFile(path, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8')
  return path
}

type CliRun = {
  exitCode: number
  stdout: string
  stderr: string
}

async function runWorkbenchCli(root: string, args: string[]): Promise<CliRun> {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = await runMatOSWorkbenchCommand(args, {
    cwd: root,
    stdout: text => stdout.push(text),
    stderr: text => stderr.push(text),
  })
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') }
}

describe('matos external intake classification (repo2asset/paper2asset)', () => {
  test('classifies a python tool repository as a tool-first bundle, not a skill', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/pytool',
    })
    expect(classification.validation.ok).toBe(true)
    expect(classification.source.kind).toBe('repository')
    expect(classification.source.slug).toBe('pytool')
    expect(classification.primaryType).toBe('tool')
    expect(classification.proposals[0]).toEqual(expect.objectContaining({
      type: 'tool',
      id: 'pytool',
      ref: 'tool:pytool@0.1.0',
      primary: true,
    }))
    expect(classification.signals.map(signal => signal.code)).toEqual(
      expect.arrayContaining(['python-package-manifest', 'python-cli-entrypoints']),
    )
    const proposalTypes = classification.proposals.map(proposal => proposal.type)
    expect(proposalTypes).toContain('knowledge')
    expect(proposalTypes).not.toContain('skill')
    expect(proposalTypes).not.toContain('role')

    // Deterministic: same source classifies identically and fingerprints stably.
    const again = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/pytool',
    })
    expect(again).toEqual(classification)
    const [first, second] = await Promise.all([
      fingerprintMatOSExternalIntakeSource({
        rootPath: classification.source.path,
        files: classification.files,
      }),
      fingerprintMatOSExternalIntakeSource({
        rootPath: classification.source.path,
        files: classification.files,
      }),
    ])
    expect(first.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(first.fingerprint).toBe(second.fingerprint)
  })

  test('classifies a markdown corpus as knowledge instead of flattening into skills', async () => {
    const root = await createIntakeFixtureRoot()
    await createMarkdownCorpus(root)

    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/mlip-handbook',
    })
    expect(classification.validation.ok).toBe(true)
    expect(classification.primaryType).toBe('knowledge')
    expect(classification.proposals.map(proposal => proposal.type)).not.toContain('skill')
  })

  test('classifies structure-data heavy repositories as data-first bundles', async () => {
    const root = await createIntakeFixtureRoot()
    await createStructureDataRepo(root)

    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/cu-structures',
    })
    expect(classification.validation.ok).toBe(true)
    expect(classification.primaryType).toBe('data')
    expect(
      classification.signals.find(signal => signal.code === 'structure-data-files')?.evidence,
    ).toContain('structures/cu-0.cif')
  })

  test('classifies single paper files as paper2asset knowledge with content hash', async () => {
    const root = await createIntakeFixtureRoot()
    const markdownPath = await createPaperMarkdown(root)
    const pdfPath = await createPaperPdf(root)

    const markdown = await classifyMatOSExternalIntakeSource({ cwd: root, path: markdownPath })
    expect(markdown.validation.ok).toBe(true)
    expect(markdown.source.kind).toBe('document')
    expect(markdown.source.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(markdown.primaryType).toBe('knowledge')
    expect(markdown.proposals).toHaveLength(1)
    expect(markdown.signals[0]?.code).toBe('paper-text-document')

    const pdf = await classifyMatOSExternalIntakeSource({ cwd: root, path: pdfPath })
    expect(pdf.source.kind).toBe('paper')
    expect(pdf.primaryType).toBe('knowledge')
    expect(pdf.signals[0]?.code).toBe('paper-pdf-document')
  })

  test('reports missing sources as classification errors', async () => {
    const root = await createIntakeFixtureRoot()
    const classification = await classifyMatOSExternalIntakeSource({
      cwd: root,
      path: 'sources/not-there',
    })
    expect(classification.validation.ok).toBe(false)
    expect(classification.validation.issues[0]?.code).toBe('source_missing')
    expect(classification.proposals).toHaveLength(0)
  })

  test('wraps classification with intake descriptor and follow-up draft command', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    const result = await classifyMatOSWorkbenchExternalIntakeSource({
      cwd: root,
      path: 'sources/pytool',
    })
    expect(result.mode).toBe('external-intake-classify')
    expect(result.intake).toEqual(expect.objectContaining({
      intakeId: 'intake-pytool',
      intakeRef: 'external-intake:pytool',
      sourcePath: 'sources/pytool',
      sourceKind: 'repository',
      truncated: false,
    }))
    expect(result.intake.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.next.draft.argv).toEqual([
      'workbench',
      'search',
      'intake-draft',
      'sources/pytool',
      '--json',
    ])
  })
})

describe('matos external intake draft packs', () => {
  test('previews a draft pack plan without writing anything', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
    })
    expect(preview.mode).toBe('external-intake-draft-pack-preview')
    expect(preview.validation.ok).toBe(true)
    expect(preview.write.enabled).toBe(false)
    expect(preview.plan.targetPack).toEqual({
      packId: 'intake-pytool',
      relativePath: '.matos/assets/packs/intake-pytool',
      manifestRelativePath: '.matos/assets/packs/intake-pytool/matos.pack.json',
    })
    expect(preview.plan.proposedAssets[0]).toEqual(expect.objectContaining({
      type: 'tool',
      ref: 'tool:pytool@0.1.0',
      primary: true,
      manifestRelativePath: '.matos/assets/packs/intake-pytool/tool/pytool/asset.json',
      entryRelativePath: '.matos/assets/packs/intake-pytool/tool/pytool/REFERENCE.md',
    }))
    expect(preview.plan.provenance.sourceFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(preview.transaction.confirmationFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(preview.transaction.requestedMutation).toBe('external-intake-draft-pack')
    expect(existsSync(join(root, '.matos', 'assets', 'packs'))).toBe(false)

    // Preview fingerprints are stable while the source is unchanged.
    const again = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
    })
    expect(again.transaction.confirmationFingerprint).toBe(
      preview.transaction.confirmationFingerprint,
    )
  })

  test('rejects invalid pack ids in preview validation', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
      packId: 'Bad/Pack!',
    })
    expect(preview.validation.ok).toBe(false)
    expect(preview.validation.issues.map(issue => issue.code)).toContain('invalid_pack_id')
  })

  test('applies a draft pack with provenance, validation, and draft lifecycle', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
    })
    const applied = await applyMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
      fingerprint: preview.transaction.confirmationFingerprint,
      reason: 'repo2asset draft test',
    })

    expect(applied.mode).toBe('external-intake-draft-pack-controlled-write')
    expect(applied.applied).toBe(true)
    expect(applied.write.status).toBe('applied')
    expect(applied.targetPackPath).toBe('.matos/assets/packs/intake-pytool')
    expect(applied.validation.ok).toBe(true)
    expect(applied.validation.gateProfile).toBe('draft-pack')
    expect(applied.validation.assetValidation.ok).toBe(true)
    expect(applied.validation.assetValidation.errors).toHaveLength(0)
    expect(applied.validation.missingAssetRefs).toHaveLength(0)
    expect(applied.validation.secretScan.ok).toBe(true)
    expect(applied.validation.resolvedAssetRefs).toEqual(
      applied.plan.proposedAssets.map(asset => asset.ref),
    )
    expect(applied.snapshots.before.snapshotId).toBeTruthy()
    expect(applied.snapshots.after?.snapshotId).toBeTruthy()
    expect(applied.writtenPaths).toHaveLength(
      1 + applied.plan.proposedAssets.length * 2,
    )

    const packManifest = JSON.parse(
      await readFile(join(root, '.matos', 'assets', 'packs', 'intake-pytool', 'matos.pack.json'), 'utf8'),
    ) as {
      id: string
      metadata: {
        sourceFormat: string
        draftedAt: string
        intake: Record<string, unknown>
      }
    }
    expect(packManifest.id).toBe('intake-pytool')
    expect(packManifest.metadata.sourceFormat).toBe('matos-external-intake-draft-pack')
    expect(Date.parse(packManifest.metadata.draftedAt)).toBeGreaterThan(0)
    expect(packManifest.metadata.intake).toEqual(expect.objectContaining({
      intakeId: 'intake-pytool',
      intakeRef: 'external-intake:pytool',
      sourcePath: 'sources/pytool',
      sourceKind: 'repository',
      sourceFingerprint: preview.plan.provenance.sourceFingerprint,
      primaryType: 'tool',
    }))

    const toolManifest = JSON.parse(
      await readFile(
        join(root, '.matos', 'assets', 'packs', 'intake-pytool', 'tool', 'pytool', 'asset.json'),
        'utf8',
      ),
    ) as Record<string, unknown> & {
      lifecycle: { status: string }
      dependencies?: string[]
      metadata: {
        intake: Record<string, unknown>
        proposal: { primary: boolean; reasons: string[] }
      }
    }
    expect(toolManifest).toEqual(expect.objectContaining({
      schemaVersion: 1,
      id: 'pytool',
      type: 'tool',
      version: '0.1.0',
      entry: 'REFERENCE.md',
    }))
    expect(toolManifest.lifecycle.status).toBe('draft')
    expect(toolManifest.dependencies).toContain('knowledge:pytool@0.1.0')
    expect(toolManifest.metadata.intake).toEqual(expect.objectContaining({
      intakeRef: 'external-intake:pytool',
      sourcePath: 'sources/pytool',
      sourceFingerprint: preview.plan.provenance.sourceFingerprint,
    }))
    expect(toolManifest.metadata.proposal.primary).toBe(true)
    expect(toolManifest.metadata.proposal.reasons).toContain('python-package-manifest')

    // Entry files reference the source by path/fingerprint instead of copying it.
    const entry = await readFile(
      join(root, '.matos', 'assets', 'packs', 'intake-pytool', 'tool', 'pytool', 'REFERENCE.md'),
      'utf8',
    )
    expect(entry).toContain('Source path: sources/pytool')
    expect(entry).toContain(`Source fingerprint: ${preview.plan.provenance.sourceFingerprint}`)
    expect(entry).toContain('Intake ref: external-intake:pytool')
    expect(entry).not.toContain('[project.scripts]')

    // The generated pack is discoverable through the native asset loader with
    // draft lifecycle and pack identity. Intake draft packs are deliberately
    // project-local (isProjectLocalPack) so the native asset builder can edit
    // them in place.
    const assets = await loadMatOSAssets(root)
    const packAssets = assets.filter(asset => asset.packId === 'intake-pytool')
    expect(packAssets.map(asset => `${asset.type}:${asset.id}`).sort()).toEqual([
      'knowledge:pytool',
      'tool:pytool',
    ])
    for (const asset of packAssets) {
      expect(asset.lifecycle.status).toBe('draft')
      expect(asset.source).toBe('project')
    }
  })

  test('drafts a single paper file into a knowledge reference pack', async () => {
    const root = await createIntakeFixtureRoot()
    const paperPath = await createPaperMarkdown(root)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: paperPath,
    })
    expect(preview.validation.ok).toBe(true)
    expect(preview.plan.targetPack.packId).toBe('intake-diffusion-mlip-survey')
    const applied = await applyMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: paperPath,
      fingerprint: preview.transaction.confirmationFingerprint,
    })
    expect(applied.applied).toBe(true)
    expect(applied.plan.proposedAssets).toHaveLength(1)
    expect(applied.plan.proposedAssets[0]?.type).toBe('knowledge')
    const manifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos/assets/packs/intake-diffusion-mlip-survey/knowledge/diffusion-mlip-survey/asset.json',
        ),
        'utf8',
      ),
    ) as { metadata: { intake: { sourceKind: string; sourcePath: string } } }
    expect(manifest.metadata.intake.sourceKind).toBe('document')
    expect(manifest.metadata.intake.sourcePath).toBe('sources/papers/diffusion-mlip-survey.md')
  })

  test('blocks stale fingerprints and duplicate draft packs', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    expect(
      applyMatOSWorkbenchExternalIntakeDraftPack({
        cwd: root,
        path: 'sources/pytool',
        fingerprint: 'sha256:stale',
      }),
    ).rejects.toThrow(/confirmation fingerprint does not match/)

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
    })
    const applied = await applyMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
      fingerprint: preview.transaction.confirmationFingerprint,
    })
    expect(applied.applied).toBe(true)

    const duplicate = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/pytool',
    })
    expect(duplicate.validation.ok).toBe(false)
    expect(duplicate.validation.issues.map(issue => issue.code)).toEqual(
      expect.arrayContaining(['target_pack_already_exists', 'target_asset_already_exists']),
    )
    expect(
      applyMatOSWorkbenchExternalIntakeDraftPack({
        cwd: root,
        path: 'sources/pytool',
        fingerprint: duplicate.transaction.confirmationFingerprint,
      }),
    ).rejects.toThrow(/blocked because preview validation failed/)
  })

  test('rolls back draft packs whose generated evidence trips the secret scan', async () => {
    const root = await createIntakeFixtureRoot()
    const corpus = await createMarkdownCorpus(root, 'leaky-handbook')
    // A real source file whose name looks like a credential assignment. The
    // generated evidence list embeds the file name, so the post-write secret
    // scan must reject the pack and restore the before-state.
    await writeFile(
      join(corpus, 'docs', 'password: hunter2abcdef0.md'),
      '# Rotation runbook\n',
      'utf8',
    )

    const preview = await previewMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/leaky-handbook',
    })
    expect(preview.validation.ok).toBe(true)
    const applied = await applyMatOSWorkbenchExternalIntakeDraftPack({
      cwd: root,
      path: 'sources/leaky-handbook',
      fingerprint: preview.transaction.confirmationFingerprint,
    })
    expect(applied.applied).toBe(false)
    expect(applied.write.status).toBe('rolled-back')
    expect(applied.write.reason).toContain('secret scan')
    expect(applied.validation.secretScan.ok).toBe(false)
    expect(applied.validation.secretScan.findings.length).toBeGreaterThan(0)
    // Secret-looking content must never enter asset-history snapshots, so the
    // rollback removes the pack directly without after/rollback snapshots.
    expect(applied.snapshots.before.snapshotId).toBeTruthy()
    expect(applied.snapshots.after).toBeUndefined()
    expect(applied.snapshots.rollback).toBeUndefined()
    expect(
      existsSync(join(root, '.matos', 'assets', 'packs', 'intake-leaky-handbook')),
    ).toBe(false)
  })
})

describe('matos external intake draft CLI', () => {
  test('classifies sources through the workbench search CLI in JSON', async () => {
    const root = await createIntakeFixtureRoot()
    await createPythonToolRepo(root)

    const missing = await runWorkbenchCli(root, ['search', 'intake-classify'])
    expect(missing.exitCode).toBe(1)
    expect(missing.stderr).toContain('requires <source-path>')

    const run = await runWorkbenchCli(root, ['search', 'intake-classify', 'sources/pytool', '--json'])
    expect(run.exitCode).toBe(0)
    const result = JSON.parse(run.stdout) as {
      mode: string
      intake: { intakeId: string; sourcePath: string; fingerprint?: string }
      classification: { primaryType?: string; proposals: Array<{ ref: string }> }
      validation: { ok: boolean }
    }
    expect(result.mode).toBe('external-intake-classify')
    expect(result.validation.ok).toBe(true)
    expect(result.intake.intakeId).toBe('intake-pytool')
    expect(result.intake.sourcePath).toBe('sources/pytool')
    expect(result.intake.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(result.classification.primaryType).toBe('tool')
    expect(result.classification.proposals.map(proposal => proposal.ref)).toContain(
      'tool:pytool@0.1.0',
    )
  })

  test('drafts packs through the CLI with preview-then-apply fingerprints', async () => {
    const root = await createIntakeFixtureRoot()
    await createMarkdownCorpus(root)

    const blockedApply = await runWorkbenchCli(root, [
      'search',
      'intake-draft-apply',
      'sources/mlip-handbook',
    ])
    expect(blockedApply.exitCode).toBe(1)
    expect(blockedApply.stderr).toContain('--fingerprint')

    const previewRun = await runWorkbenchCli(root, [
      'search',
      'intake-draft',
      'sources/mlip-handbook',
      '--pack-id',
      'handbook-draft',
      '--json',
    ])
    expect(previewRun.exitCode).toBe(0)
    const preview = JSON.parse(previewRun.stdout) as {
      mode: string
      plan: { targetPack: { packId: string }; proposedAssets: Array<{ ref: string }> }
      validation: { ok: boolean }
      transaction: { confirmationFingerprint: string }
    }
    expect(preview.mode).toBe('external-intake-draft-pack-preview')
    expect(preview.validation.ok).toBe(true)
    expect(preview.plan.targetPack.packId).toBe('handbook-draft')
    expect(existsSync(join(root, '.matos', 'assets', 'packs', 'handbook-draft'))).toBe(false)

    const applyRun = await runWorkbenchCli(root, [
      'search',
      'intake-draft',
      'sources/mlip-handbook',
      '--pack-id',
      'handbook-draft',
      '--apply',
      '--fingerprint',
      preview.transaction.confirmationFingerprint,
      '--reason',
      'cli paper2asset test',
      '--json',
    ])
    expect(applyRun.exitCode).toBe(0)
    const applied = JSON.parse(applyRun.stdout) as {
      mode: string
      applied: boolean
      validation: { ok: boolean; gateProfile: string }
      writtenPaths: string[]
      audit: { operation: string }
    }
    expect(applied.mode).toBe('external-intake-draft-pack-controlled-write')
    expect(applied.applied).toBe(true)
    expect(applied.validation.ok).toBe(true)
    expect(applied.validation.gateProfile).toBe('draft-pack')
    expect(applied.audit.operation).toBe('search.intake-draft')
    expect(applied.writtenPaths).toContain(
      '.matos/assets/packs/handbook-draft/matos.pack.json',
    )
    expect(
      existsSync(join(root, '.matos', 'assets', 'packs', 'handbook-draft', 'matos.pack.json')),
    ).toBe(true)

    const knowledgeManifest = JSON.parse(
      await readFile(
        join(
          root,
          '.matos/assets/packs/handbook-draft/knowledge/mlip-handbook/asset.json',
        ),
        'utf8',
      ),
    ) as { type: string; lifecycle: { status: string } }
    expect(knowledgeManifest.type).toBe('knowledge')
    expect(knowledgeManifest.lifecycle.status).toBe('draft')
  })
})
