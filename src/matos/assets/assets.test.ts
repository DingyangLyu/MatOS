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

import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { validateMatOSAssets } from './validateAssets.js'
import type { MatOSAsset } from './types.js'

function validationAsset(
  root: string,
  input: {
    id: string
    type: MatOSAsset['type']
    version: string
    scope: string
    overlayOf?: string
  },
): MatOSAsset {
  return {
    id: input.id,
    type: input.type,
    name: `${input.scope} ${input.id}`,
    version: input.version,
    description: '',
    canonicalKey: `${input.type}:${input.id}@${input.version}`,
    relativePath: '.',
    absolutePath: root,
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: join(root, `${input.scope}-${input.id}.json`),
    manifestDir: root,
    source: 'project',
    sourcePath: root,
    packId: `${input.scope}-pack`,
    packName: `${input.scope} pack`,
    packVersion: '0.1.0',
    tags: [],
    permissions: {},
    dependencies: [],
    mounts: {},
    runtime: {},
    lifecycle: { status: 'enabled' },
    metadata: {
      ...(input.overlayOf ? { overlayOf: input.overlayOf } : {}),
      sourceProvenance: {
        type: 'git',
        sourceId: `${input.scope}-assets`,
        scope: input.scope,
      },
    },
  }
}

describe('MatOS assets', () => {
  test('loads manifests and reports duplicate ids and missing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'planner')
    const skillDir = join(root, '.matos', 'assets', 'roles', 'planner-copy')
    await mkdir(roleDir, { recursive: true })
    await mkdir(skillDir, { recursive: true })

    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(roleDir, 'asset.json'),
      JSON.stringify({
        id: 'planner',
        type: 'role',
        name: 'Planner',
        version: '0.1.0',
        path: '.',
        dependencies: ['skill:planner'],
      }),
    )
    await writeFile(
      join(skillDir, 'asset.json'),
      JSON.stringify({
        id: 'planner',
        type: 'role',
        name: 'Planner Copy',
        version: '0.1.0',
        path: 'missing.md',
      }),
    )

    const assets = await loadMatOSAssets(root)
    expect(assets.filter(asset => asset.id === 'planner')).toHaveLength(2)

    const result = await validateMatOSAssets(assets)
    expect(result.ok).toBe(false)
    expect(result.errors.some(error => error.code === 'duplicate_asset')).toBe(
      true,
    )
    expect(result.errors.some(error => error.code === 'missing_path')).toBe(
      true,
    )
  })

  test('reports malformed manifests as validation errors instead of crashing the load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-broken-manifest-'))
    const goodDir = join(root, '.matos', 'assets', 'knowledges', 'good')
    const brokenDir = join(root, '.matos', 'assets', 'knowledges', 'broken')
    await mkdir(goodDir, { recursive: true })
    await mkdir(brokenDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(goodDir, 'asset.json'),
      JSON.stringify({
        id: 'good',
        type: 'knowledge',
        name: 'Good',
        version: '0.1.0',
        path: '.',
      }),
    )
    await writeFile(join(brokenDir, 'asset.json'), '{ this is not json')

    const assets = await loadMatOSAssets(root)
    expect(assets.map(asset => asset.canonicalKey)).toContain(
      'knowledge:good@0.1.0',
    )

    const result = await validateMatOSAssets(assets)
    expect(result.ok).toBe(false)
    const invalidManifestErrors = result.errors.filter(
      error => error.code === 'invalid_manifest',
    )
    expect(invalidManifestErrors).toHaveLength(1)
    expect(invalidManifestErrors[0]?.manifestPath).toBe(
      join(brokenDir, 'asset.json'),
    )
    expect(result.errors).toHaveLength(1)

    const registry = buildMatOSAssetRegistry(assets)
    expect(registry.resolve('knowledge:good')?.canonicalKey).toBe(
      'knowledge:good@0.1.0',
    )
  })

  test('loads a root that points directly at a native asset pack', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-pack-root-'))
    const packRoot = join(root, 'bundled', 'packs', 'matos-support')
    const toolDir = join(packRoot, 'tools', 'support-search')
    await mkdir(toolDir, { recursive: true })
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['../bundled/packs/matos-support'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(packRoot, 'matos.pack.json'),
      JSON.stringify({ id: 'matos-support', version: '0.1.0' }),
    )
    await writeFile(
      join(toolDir, 'asset.json'),
      JSON.stringify({
        id: 'support-search',
        type: 'tool',
        name: 'Support Search',
        version: '0.1.0',
        path: '.',
      }),
    )

    const assets = await loadMatOSAssets(root)
    const asset = assets.find(
      item => item.canonicalKey === 'tool:support-search@0.1.0',
    )
    expect(asset?.source).toBe('pack')
    expect(asset?.packId).toBe('matos-support')

    const result = await validateMatOSAssets(assets)
    expect(result.ok).toBe(true)
  })

  test('skips git metadata when an asset root points at a checkout root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-git-root-'))
    const checkoutRoot = join(root, 'checkout')
    const roleDir = join(checkoutRoot, 'packs', 'matos-core', 'roles', 'compute')
    const gitDir = join(checkoutRoot, '.git')
    await mkdir(roleDir, { recursive: true })
    await mkdir(gitDir, { recursive: true })
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['../checkout'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(checkoutRoot, 'packs', 'matos-core', 'matos.pack.json'),
      JSON.stringify({
        id: 'matos-core',
        version: '1.0.0',
      }),
    )
    await writeFile(
      join(roleDir, 'asset.json'),
      JSON.stringify({
        id: 'compute',
        type: 'role',
        name: 'Compute',
        version: '1.0.0',
        path: '.',
      }),
    )
    await writeFile(
      join(gitDir, 'asset.json'),
      JSON.stringify({
        id: 'ghost',
        type: 'role',
        name: 'Ghost',
        version: '1.0.0',
        path: '.',
      }),
    )

    const assets = await loadMatOSAssets(root)
    expect(assets.map(asset => asset.canonicalKey)).toContain(
      'role:compute@1.0.0',
    )
    expect(assets.map(asset => asset.canonicalKey)).not.toContain(
      'role:ghost@1.0.0',
    )
  })

  test('does not recursively treat files inside an asset directory as separate manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-contained-asset-'))
    const skillDir = join(root, '.matos', 'assets', 'skills', 'chemistry')
    const subskillDir = join(skillDir, 'organic')
    const exampleDir = join(skillDir, 'examples', 'nested')
    await mkdir(subskillDir, { recursive: true })
    await mkdir(exampleDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(skillDir, 'asset.json'),
      JSON.stringify({
        id: 'chemistry',
        type: 'skill',
        name: 'Chemistry',
        version: '0.1.0',
        path: '.',
      }),
    )
    await writeFile(
      join(subskillDir, 'asset.json'),
      JSON.stringify({
        id: 'chemistry/organic',
        type: 'skill',
        name: 'Organic Chemistry',
        version: '0.1.0',
        path: '.',
      }),
    )
    await writeFile(
      join(exampleDir, 'asset.json'),
      JSON.stringify({
        id: 'should-not-load',
        type: 'skill',
        name: 'Nested Example',
        version: '0.1.0',
        path: '.',
      }),
    )

    const assets = await loadMatOSAssets(root)
    expect(assets.map(asset => asset.canonicalKey)).toContain(
      'skill:chemistry@0.1.0',
    )
    expect(assets.map(asset => asset.canonicalKey)).toContain(
      'skill:chemistry/organic@0.1.0',
    )
    expect(assets.map(asset => asset.canonicalKey)).not.toContain(
      'skill:should-not-load@0.1.0',
    )
  })

  test('reports malformed legacy roles.json as a validation error instead of crashing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-broken-roles-'))
    const goodDir = join(root, '.matos', 'assets', 'skills', 'good')
    await mkdir(goodDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(goodDir, 'asset.json'),
      JSON.stringify({
        id: 'good',
        type: 'skill',
        name: 'Good',
        version: '0.1.0',
        path: '.',
      }),
    )
    await writeFile(join(root, '.matos', 'assets', 'roles.json'), '{ not json')

    const assets = await loadMatOSAssets(root)
    expect(assets.map(asset => asset.canonicalKey)).toContain('skill:good@0.1.0')

    const result = await validateMatOSAssets(assets)
    expect(result.ok).toBe(false)
    expect(
      result.errors.some(
        error =>
          error.code === 'invalid_manifest' &&
          error.manifestPath === join(root, '.matos', 'assets', 'roles.json'),
      ),
    ).toBe(true)
  })

  test('loads directory asset mounts without native manifests and reports broken mounted manifests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-mounts-'))
    const plainDir = join(root, 'external-data')
    const altManifestDir = join(root, 'alt-manifest')
    const brokenMount = join(root, 'broken', 'asset.json')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(plainDir, { recursive: true })
    await mkdir(altManifestDir, { recursive: true })
    await mkdir(join(root, 'broken'), { recursive: true })
    await writeFile(
      join(altManifestDir, 'matos.asset.json'),
      JSON.stringify({
        id: 'alt-manifest',
        type: 'knowledge',
        name: 'Alt Manifest',
        version: '0.1.0',
        path: '.',
      }),
    )
    await writeFile(brokenMount, '{ broken json')
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
        assetMounts: [
          {
            id: 'ext-data',
            type: 'data',
            name: 'External Data',
            version: '0.1.0',
            path: 'external-data',
          },
          { path: 'alt-manifest' },
          { path: join('broken', 'asset.json') },
        ],
      }),
    )

    const assets = await loadMatOSAssets(root)
    expect(assets.map(asset => asset.canonicalKey)).toContain(
      'data:ext-data@0.1.0',
    )
    expect(assets.map(asset => asset.canonicalKey)).toContain(
      'knowledge:alt-manifest@0.1.0',
    )

    const result = await validateMatOSAssets(assets)
    const invalidManifestErrors = result.errors.filter(
      error => error.code === 'invalid_manifest',
    )
    expect(invalidManifestErrors).toHaveLength(1)
    expect(invalidManifestErrors[0]?.manifestPath).toBe(brokenMount)
    expect(
      result.errors.filter(error => error.code !== 'invalid_manifest'),
    ).toHaveLength(0)
  })

  test('tolerates dangling tools mounts but reports unresolved asset mounts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-tool-mounts-'))
    const roleDir = join(root, '.matos', 'assets', 'roles', 'runner')
    await mkdir(roleDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(roleDir, 'asset.json'),
      JSON.stringify({
        id: 'runner',
        type: 'role',
        name: 'Runner',
        version: '0.1.0',
        path: '.',
        mounts: {
          // Tools mounts are best-effort runtime bindings; unresolved refs
          // surface as skipped asset events at composition time instead of
          // hard validation errors.
          tools: ['tool:missing-tool', 'Read'],
          skills: ['skill:ghost-skill'],
        },
      }),
    )

    const result = await validateMatOSAssets(await loadMatOSAssets(root))
    expect(result.ok).toBe(false)
    expect(
      result.errors.some(
        error =>
          error.code === 'missing_mount' &&
          error.message.includes('skill:ghost-skill'),
      ),
    ).toBe(true)
    expect(
      result.errors.some(error => error.message.includes('tool:missing-tool')),
    ).toBe(false)
  })

  test.skipIf(process.getuid?.() === 0)(
    'skips unreadable asset subtrees instead of failing startup',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'matos-assets-unreadable-'))
      const readableDir = join(root, '.matos', 'assets', 'roles', 'planner')
      const unreadableDir = join(
        root,
        '.matos',
        'assets',
        'generated',
        'evolution',
        'bad-draft',
      )
      await mkdir(readableDir, { recursive: true })
      await mkdir(unreadableDir, { recursive: true })
      await writeFile(
        join(root, '.matos', 'matos.json'),
        JSON.stringify({
          version: 1,
          assetRoots: ['assets'],
          includeDefaultAssetRoots: false,
        }),
      )
      await writeFile(
        join(readableDir, 'asset.json'),
        JSON.stringify({
          id: 'planner',
          type: 'role',
          name: 'Planner',
          version: '0.1.0',
          path: '.',
        }),
      )
      await chmod(unreadableDir, 0o000)

      try {
        const assets = await loadMatOSAssets(root)
        expect(assets.map(asset => asset.canonicalKey)).toContain(
          'role:planner@0.1.0',
        )
      } finally {
        await chmod(unreadableDir, 0o755)
      }
    },
  )

  test('keeps generated evolution drafts out of the active runtime registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-draft-lifecycle-'))
    const first = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'episode-a',
      'evaluations',
      'learning-eval-demo',
    )
    const second = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'direct-editor',
      'run-a',
      'evaluations',
      'learning-eval-demo',
    )
    await mkdir(first, { recursive: true })
    await mkdir(second, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )

    await writeFile(
      join(first, 'asset.json'),
      JSON.stringify({
        id: 'learning-eval-demo',
        type: 'evaluation',
        name: 'Learning evaluation',
        version: '0.1.0',
        entry: 'evaluation.json',
        tags: ['generated', 'learning', 'evaluation'],
        metadata: {
          sourceFormat: 'matos-learning-evaluation',
        },
      }),
    )
    await writeFile(join(first, 'evaluation.json'), '{}\n')
    await writeFile(
      join(second, 'asset.json'),
      JSON.stringify({
        id: 'learning-eval-demo',
        type: 'evaluation',
        name: 'Proposal evaluation',
        version: '0.1.0',
        entry: 'EVALUATION.md',
        tags: ['draft', 'generated', 'learning', 'evaluation'],
        metadata: {
          sourceFormat: 'matos-self-evolution-direct-editor-evaluation',
          lifecycle: 'draft',
        },
      }),
    )
    await writeFile(join(second, 'EVALUATION.md'), '# Evaluation\n')

    const assets = await loadMatOSAssets(root)
    const draftEvaluations = assets.filter(asset => asset.type === 'evaluation')
    expect(draftEvaluations).toHaveLength(2)
    expect(draftEvaluations.every(asset => asset.lifecycle.status === 'draft')).toBe(
      true,
    )
    expect((await validateMatOSAssets(assets)).ok).toBe(true)
    expect(
      buildMatOSAssetRegistry(assets).resolve('evaluation:learning-eval-demo'),
    ).toBeUndefined()
    expect(
      buildMatOSAssetRegistry(assets, { includeDisabled: true }).resolve(
        'evaluation:learning-eval-demo',
      ),
    ).toBeDefined()
  })

  test('keeps generated draft experiences discoverable while other drafts stay inactive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-draft-experience-'))
    const experienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'bash-enospc-cascade-recovery',
    )
    const evaluationDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'evaluations',
      'learning-eval-demo',
    )
    await mkdir(experienceDir, { recursive: true })
    await mkdir(evaluationDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(experienceDir, 'asset.json'),
      JSON.stringify({
        id: 'bash-enospc-cascade-recovery',
        type: 'experience',
        name: 'Bash ENOSPC Cascade Detection and Recovery',
        version: '0.1.0',
        entry: 'EXPERIENCE.md',
        tags: ['generated', 'learning', 'draft', 'experience'],
        lifecycle: { status: 'draft' },
      }),
    )
    await writeFile(join(experienceDir, 'EXPERIENCE.md'), '# ENOSPC\n')
    await writeFile(
      join(evaluationDir, 'asset.json'),
      JSON.stringify({
        id: 'learning-eval-demo',
        type: 'evaluation',
        name: 'Learning evaluation',
        version: '0.1.0',
        entry: 'evaluation.json',
        tags: ['draft', 'generated', 'learning', 'evaluation'],
        lifecycle: { status: 'draft' },
      }),
    )
    await writeFile(join(evaluationDir, 'evaluation.json'), '{}\n')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    expect(
      registry.resolve('experience:bash-enospc-cascade-recovery@0.1.0')
        ?.canonicalKey,
    ).toBe('experience:bash-enospc-cascade-recovery@0.1.0')
    expect(registry.resolve('evaluation:learning-eval-demo')).toBeUndefined()
  })

  test('keeps generated experiences discoverable when default asset roots are disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-generated-experience-git-only-'))
    const experienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'evolution',
      'experiences',
      'git-only-feedback',
    )
    const scopedExperienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'evolution',
      'experiences',
      'alice-git-only-feedback',
    )
    await mkdir(experienceDir, { recursive: true })
    await mkdir(scopedExperienceDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: [],
        includeDefaultAssetRoots: false,
        assetSources: [],
      }),
    )
    await writeFile(
      join(experienceDir, 'asset.json'),
      JSON.stringify({
        id: 'git-only-feedback',
        type: 'experience',
        name: 'Git Only Feedback',
        version: '0.1.0',
        entry: 'EXPERIENCE.md',
        tags: ['generated', 'learning', 'draft', 'experience'],
        lifecycle: { status: 'draft' },
      }),
    )
    await writeFile(join(experienceDir, 'EXPERIENCE.md'), '# feedback\n')
    await writeFile(
      join(scopedExperienceDir, 'asset.json'),
      JSON.stringify({
        id: 'alice-git-only-feedback',
        type: 'experience',
        name: 'Alice Git Only Feedback',
        version: '0.1.0',
        entry: 'EXPERIENCE.md',
        tags: ['generated', 'learning', 'draft', 'experience'],
        lifecycle: { status: 'draft' },
        metadata: {
          scope: 'user',
          scopeRef: 'user:alice',
          baseExperienceId: 'git-only-feedback',
        },
      }),
    )
    await writeFile(
      join(scopedExperienceDir, 'EXPERIENCE.md'),
      '# scoped feedback\n',
    )

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))

    expect(
      registry.resolve('experience:git-only-feedback@0.1.0')?.canonicalKey,
    ).toBe('experience:git-only-feedback@0.1.0')
    expect(
      registry.resolve('experience:alice-git-only-feedback@0.1.0')?.canonicalKey,
    ).toBe('experience:alice-git-only-feedback@0.1.0')
  })

  test('ignores runtime assets under generated scoped evidence roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-generated-runtime-shadow-'))
    const workflowId = 'draft_duplicate'
    const workflowDir = join(root, '.matos', 'assets', 'workflows', workflowId)
    const generatedWorkflowDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'workflow',
      workflowId,
    )
    const scopedExperienceDir = join(
      root,
      '.matos',
      'assets',
      'generated',
      'scopes',
      'users',
      'alice',
      'evolution',
      'experiences',
      'workflow-builder-feedback',
    )
    await mkdir(workflowDir, { recursive: true })
    await mkdir(generatedWorkflowDir, { recursive: true })
    await mkdir(scopedExperienceDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
        assetSources: [],
      }),
    )
    const workflowManifest = {
      id: workflowId,
      type: 'workflow',
      name: 'Draft Duplicate',
      version: '0.1.0',
      entry: 'workflow.json',
    }
    const generatedWorkflowManifest = {
      ...workflowManifest,
      metadata: {
        scope: 'user',
        scopeRef: 'user:alice',
        generatedBy: 'matos.workflow.draft',
      },
    }
    await writeFile(join(workflowDir, 'asset.json'), JSON.stringify(workflowManifest))
    await writeFile(join(workflowDir, 'workflow.json'), '{}\n')
    await writeFile(
      join(generatedWorkflowDir, 'asset.json'),
      JSON.stringify(generatedWorkflowManifest),
    )
    await writeFile(join(generatedWorkflowDir, 'workflow.json'), '{}\n')
    await writeFile(
      join(scopedExperienceDir, 'asset.json'),
      JSON.stringify({
        id: 'workflow-builder-feedback',
        type: 'experience',
        name: 'Workflow Builder Feedback',
        version: '0.1.0',
        entry: 'EXPERIENCE.md',
        tags: ['generated', 'learning', 'draft', 'experience'],
        lifecycle: { status: 'draft' },
      }),
    )
    await writeFile(join(scopedExperienceDir, 'EXPERIENCE.md'), '# feedback\n')

    const assets = await loadMatOSAssets(root)
    const registry = buildMatOSAssetRegistry(assets)
    const validation = await validateMatOSAssets(assets)

    expect(
      assets.filter(asset => asset.canonicalKey === 'workflow:draft_duplicate@0.1.0'),
    ).toHaveLength(1)
    expect(
      registry.resolve('workflow:draft_duplicate@0.1.0')?.manifestPath,
    ).toBe(join(workflowDir, 'asset.json'))
    expect(
      registry.resolve('experience:workflow-builder-feedback@0.1.0')
        ?.canonicalKey,
    ).toBe('experience:workflow-builder-feedback@0.1.0')
    expect(
      validation.errors.some(error => error.code === 'duplicate_asset'),
    ).toBe(false)
  })

  test('requires explicit overlayOf for higher precedence duplicate assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-overlay-shadow-'))
    await mkdir(root, { recursive: true })
    const core = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '1.0.0',
      scope: 'core',
    })
    const userShadow = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '1.0.0',
      scope: 'user',
    })

    const validation = await validateMatOSAssets([core, userShadow])
    const registry = buildMatOSAssetRegistry([core, userShadow])

    expect(validation.ok).toBe(false)
    expect(
      validation.errors.some(error => error.code === 'duplicate_asset'),
    ).toBe(true)
    expect(registry.resolve('role:compute@1.0.0')?.name).toBe('core compute')
  })

  test('allows higher precedence duplicate assets with explicit overlayOf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-overlay-shadow-ok-'))
    await mkdir(root, { recursive: true })
    const core = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '1.0.0',
      scope: 'core',
    })
    const userShadow = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '1.0.0',
      scope: 'user',
      overlayOf: 'role:compute@1.0.0',
    })

    const validation = await validateMatOSAssets([core, userShadow])
    const registry = buildMatOSAssetRegistry([core, userShadow])

    expect(validation.ok).toBe(true)
    expect(registry.resolve('role:compute@1.0.0')?.name).toBe('user compute')
  })

  test('requires explicit overlayOf before scoped assets win unversioned aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-overlay-alias-'))
    await mkdir(root, { recursive: true })
    const core = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '1.0.0',
      scope: 'core',
    })
    const userNewer = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '2.0.0',
      scope: 'user',
    })

    const registry = buildMatOSAssetRegistry([core, userNewer])

    expect(registry.resolve('role:compute')?.name).toBe('core compute')
    expect(registry.resolve('role:compute@2.0.0')?.name).toBe('user compute')
  })

  test('allows scoped newer assets with explicit overlayOf to win unversioned aliases', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-assets-overlay-alias-ok-'))
    await mkdir(root, { recursive: true })
    const core = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '1.0.0',
      scope: 'core',
    })
    const userNewer = validationAsset(root, {
      id: 'compute',
      type: 'role',
      version: '2.0.0',
      scope: 'user',
      overlayOf: 'role:compute@1.0.0',
    })

    const registry = buildMatOSAssetRegistry([core, userNewer])

    expect(registry.resolve('role:compute')?.name).toBe('user compute')
  })

  test('accepts native benchmark-suite assets used by regression checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-benchmark-suite-assets-'))
    const suiteDir = join(root, '.matos', 'assets', 'benchmark-suites', 'core')
    await mkdir(suiteDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }),
    )
    await writeFile(
      join(suiteDir, 'asset.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'core',
        type: 'benchmark-suite',
        name: 'Core Benchmark Suite',
        version: '0.1.0',
        entry: 'suite.json',
      }),
    )
    await writeFile(
      join(suiteDir, 'suite.json'),
      JSON.stringify({ benchmarkRefs: ['benchmark:smoke@0.1.0'] }),
    )

    const assets = await loadMatOSAssets(root)
    const validation = await validateMatOSAssets(assets)

    expect(validation.ok).toBe(true)
    expect(assets[0]?.canonicalKey).toBe('benchmark-suite:core@0.1.0')
  })
})
