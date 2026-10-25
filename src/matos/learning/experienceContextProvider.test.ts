import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import {
  buildMatOSAssetRegistry,
  type MatOSAssetRegistry,
} from '../assets/registry.js'
import type { MatOSAsset } from '../assets/types.js'
import {
  buildMatOSExperienceContext,
  listMatOSExperienceContextProviderIds,
  registerMatOSExperienceContextProvider,
  resolveMatOSExperienceContextProvider,
} from './experienceContextProvider.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeSearchFallbackExperience(root: string): Promise<void> {
  const experienceDir = join(
    root,
    '.matos/assets/generated/evolution/experiences/glob-grep-ripgrep-missing-fallback',
  )
  await mkdir(experienceDir, { recursive: true })
  await writeJson(join(experienceDir, 'asset.json'), {
    schemaVersion: 1,
    type: 'experience',
    id: 'glob-grep-ripgrep-missing-fallback',
    version: '0.1.0',
    name: 'Glob/Grep Tool Failure Recovery via Bash find/grep',
    description:
      'Recover when Glob/Grep cannot locate vendored ripgrep.',
    entry: 'EXPERIENCE.md',
    tags: ['generated', 'learning', 'draft', 'experience'],
    lifecycle: { status: 'draft' },
    metadata: {
      sourceFormat: 'matos-experience-llm-v1',
      mergeKey: 'tools:search:ripgrep-vendor-missing',
      roles: ['compute'],
      toolNames: ['Glob', 'Grep', 'Bash', 'Read'],
      tools: ['glob', 'grep', 'bash', 'read'],
      signalKinds: ['failure', 'success'],
      quality: { level: 'high', score: 0.9, reasons: ['replayed'] },
      scenario: {
        domain: 'tools',
        taskType: 'file-discovery-and-content-search',
        failureMode: 'vendored-ripgrep-missing',
        appliesWhen: [
          'Glob or Grep returns ENOENT for src/utils/vendor/ripgrep.',
        ],
      },
      recommendedActions: [
        'Stop retrying Glob/Grep and switch to Bash find/grep.',
      ],
      avoidRepeating: [
        'Do not issue another large batch of Glob/Grep calls after the vendor rg ENOENT.',
      ],
    },
  })
  await writeFile(
    join(experienceDir, 'EXPERIENCE.md'),
    '# Glob/Grep Tool Failure Recovery via Bash find/grep\n',
    'utf8',
  )
}

async function writeUnrelatedExperience(root: string): Promise<void> {
  const experienceDir = join(
    root,
    '.matos/assets/generated/evolution/experiences/unrelated-general-note',
  )
  await mkdir(experienceDir, { recursive: true })
  await writeJson(join(experienceDir, 'asset.json'), {
    schemaVersion: 1,
    type: 'experience',
    id: 'unrelated-general-note',
    version: '0.1.0',
    name: 'Unrelated generic note',
    description: 'A generic draft that should not match compute tooling.',
    entry: 'EXPERIENCE.md',
    tags: ['generated', 'learning', 'draft', 'experience'],
    lifecycle: { status: 'draft' },
    metadata: {
      sourceFormat: 'matos-experience-llm-v1',
      mergeKey: 'unrelated:generic',
      recommendedActions: ['Do something generic.'],
    },
  })
  await writeFile(join(experienceDir, 'EXPERIENCE.md'), '# Unrelated\n', 'utf8')
}

describe('MatOS experience context provider', () => {
  test('uses the default asset metadata provider to build soft role context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-context-'))
    await writeSearchFallbackExperience(root)
    await writeUnrelatedExperience(root)
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const role = registry.resolve('role:compute')
    expect(role).toBeDefined()

    const provider = resolveMatOSExperienceContextProvider({})
    expect(provider.id).toBe('asset-metadata')

    // Draft experiences are excluded by default: they never passed an
    // acceptance gate, so they must not become live prompt guidance.
    expect(
      buildMatOSExperienceContext({
        registry,
        role: role as MatOSAsset,
        allowedTools: ['Glob', 'Grep', 'Bash', 'Read'],
        env: {},
      }),
    ).toBeUndefined()

    const context = buildMatOSExperienceContext({
      registry,
      role: role as MatOSAsset,
      allowedTools: ['Glob', 'Grep', 'Bash', 'Read'],
      env: { MATOS_EXPERIENCE_CONTEXT_ALLOW_DRAFT: '1' },
    })

    expect(context?.providerId).toBe('asset-metadata')
    expect(context?.prompt).toContain('Relevant MatOS experience assets')
    expect(context?.prompt).toContain(
      'experience:glob-grep-ripgrep-missing-fallback@0.1.0',
    )
    expect(context?.prompt).toContain('Stop retrying Glob/Grep')
    expect(context?.assets.map(asset => asset.canonicalKey)).toContain(
      'experience:glob-grep-ripgrep-missing-fallback@0.1.0',
    )
    expect(context?.assets.map(asset => asset.canonicalKey)).not.toContain(
      'experience:unrelated-general-note@0.1.0',
    )
  })

  test('redacts host paths and caps oversized experience context', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-experience-context-redact-'),
    )
    const experienceDir = join(
      root,
      '.matos/assets/generated/evolution/experiences/host-path-leak',
    )
    await mkdir(experienceDir, { recursive: true })
    const longText = 'X'.repeat(2000)
    await writeJson(join(experienceDir, 'asset.json'), {
      schemaVersion: 1,
      type: 'experience',
      id: 'host-path-leak',
      version: '0.1.0',
      name: 'Host path leak note',
      description: `See /vepfs-mlp2/example-project/example-user/secret-output for details. ${longText}`,
      entry: 'EXPERIENCE.md',
      tags: ['generated', 'learning', 'draft', 'experience'],
      lifecycle: { status: 'draft' },
      metadata: {
        sourceFormat: 'matos-experience-llm-v1',
        mergeKey: 'tools:search:host-path',
        roles: ['compute'],
        toolNames: ['Glob', 'Grep', 'Bash', 'Read'],
        tools: ['glob', 'grep', 'bash', 'read'],
        signalKinds: ['failure', 'success'],
        quality: { level: 'high', score: 0.9, reasons: ['replayed'] },
        recommendedActions: [
          'Read /vepfs-mlp2/example-project/example-user/run.log first.',
        ],
      },
    })
    await writeFile(join(experienceDir, 'EXPERIENCE.md'), '# Host path leak\n', 'utf8')

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const role = registry.resolve('role:compute') as MatOSAsset
    const context = buildMatOSExperienceContext({
      registry,
      role,
      allowedTools: ['Glob', 'Grep', 'Bash', 'Read'],
      env: {
        MATOS_EXPERIENCE_CONTEXT_MAX_CHARS: '600',
        MATOS_EXPERIENCE_CONTEXT_ALLOW_DRAFT: '1',
      },
    })
    expect(context?.prompt).toBeDefined()
    // Host paths scrubbed from injected text; oversized fields/total truncated.
    expect(context?.prompt).not.toContain('/vepfs-mlp2/example-project/example-user')
    expect((context?.prompt ?? '').length).toBeLessThanOrEqual(700)
  })

  test('can be disabled without changing runtime composition code', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-experience-context-off-'))
    await writeSearchFallbackExperience(root)
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const role = registry.resolve('role:compute') as MatOSAsset

    expect(
      resolveMatOSExperienceContextProvider({
        MATOS_EXPERIENCE_CONTEXT_PROVIDER: 'disabled',
      }).id,
    ).toBe('disabled')
    expect(
      buildMatOSExperienceContext({
        registry,
        role,
        allowedTools: ['Glob', 'Grep', 'Bash', 'Read'],
        env: { MATOS_EXPERIENCE_CONTEXT_PROVIDER: 'disabled' },
      }),
    ).toBeUndefined()
    expect(
      buildMatOSExperienceContext({
        registry,
        role,
        allowedTools: ['Glob', 'Grep', 'Bash', 'Read'],
        env: { MATOS_DISABLE_EXPERIENCE_CONTEXT: '1' },
      }),
    ).toBeUndefined()
  })

  test('supports registering and selecting a custom provider', () => {
    const providerId = 'unit-custom-experience-provider'
    registerMatOSExperienceContextProvider({
      id: providerId,
      buildContext: () => ({
        providerId,
        prompt: 'Custom provider context.',
        assets: [],
      }),
    })

    expect(listMatOSExperienceContextProviderIds()).toContain(providerId)
    const provider = resolveMatOSExperienceContextProvider({
      MATOS_EXPERIENCE_CONTEXT_PROVIDER: providerId,
    })
    expect(provider.id).toBe(providerId)
    expect(
      buildMatOSExperienceContext({
        registry: { experienceAssets: [] } as unknown as MatOSAssetRegistry,
        role: {} as MatOSAsset,
        allowedTools: [],
        env: { MATOS_EXPERIENCE_CONTEXT_PROVIDER: providerId },
      }),
    ).toEqual({
      providerId,
      prompt: 'Custom provider context.',
      assets: [],
    })
  })
})
