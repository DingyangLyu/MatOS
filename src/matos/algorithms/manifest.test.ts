import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { withMatOSWorkflowExecutionContext } from '../workflows/executionContext.js'
import {
  MATOS_ALGORITHM_RUN_MANIFEST_MAX_BYTES,
  matOSAlgorithmRunManifestPath,
  matOSAlgorithmSurfacePinsFromManifest,
  readMatOSAlgorithmRunManifest,
  readMatOSAlgorithmRunManifestForExecution,
  requireMatOSAlgorithmRunManifest,
  writeMatOSAlgorithmRunManifest,
} from './manifest.js'
import {
  MatOSAlgorithmPinnedProviderUnavailableError,
  createMatOSAlgorithmSurface,
} from './surface.js'

const surface = createMatOSAlgorithmSurface<
  { value: number },
  { value: number }
>({
  surfaceId: 'manifest-pinning-test',
  envVar: 'MATOS_ALGO_MANIFEST_PINNING_TEST',
  baseline: { decide: input => ({ value: input.value }) },
})

const providerOne = {
  id: 'provider-one',
  version: '1.0.0',
  assetRef: 'tool:provider-one@1.0.0',
  configDigest: '1'.repeat(64),
  implementationDigest: '2'.repeat(64),
  decide: (input: { value: number }) => ({ value: input.value + 1 }),
}

surface.register(providerOne)
surface.register({
  id: 'provider-two',
  version: '2.0.0',
  implementationDigest: '3'.repeat(64),
  decide: input => ({ value: input.value + 2 }),
})

describe('MatOS algorithm run manifest', () => {
  test('publishes once atomically and pins provider identity for the run', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-algo-manifest-'))
    const input = {
      runDir,
      runId: 'run-manifest-1',
      workflowRef: 'workflow:manifest-test@1.0.0',
    }
    const first = await writeMatOSAlgorithmRunManifest({
      ...input,
      env: {
        MATOS_ALGO_MANIFEST_PINNING_TEST: 'provider-one',
        MATOS_ALGO_MANIFEST_PINNING_TEST_SHADOW: 'provider-two',
      },
    })
    expect(first).toBeDefined()
    const pinnedSurface = first.surfaces.find(
      item => item.surfaceId === surface.surfaceId,
    )
    expect(pinnedSurface?.version).toBeTruthy()
    expect(pinnedSurface?.configDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(pinnedSurface?.implementationDigest).toMatch(/^[a-f0-9]{64}$/)
    const second = await writeMatOSAlgorithmRunManifest({
      ...input,
      env: { MATOS_ALGO_MANIFEST_PINNING_TEST: 'provider-two' },
    })
    expect(second?.manifestDigest).toBe(first?.manifestDigest)
    expect(
      second?.surfaces.find(item => item.surfaceId === surface.surfaceId)
        ?.providerId,
    ).toBe('provider-one')
    expect(
      second?.surfaces.find(item => item.surfaceId === surface.surfaceId)
        ?.shadow?.providerId,
    ).toBe('provider-two')

    const result = withMatOSWorkflowExecutionContext(
      {
        runId: input.runId,
        runDir,
        projectCwd: runDir,
        algorithmSurfacePins: matOSAlgorithmSurfacePinsFromManifest(
          first as NonNullable<typeof first>,
        ),
      },
      () =>
        surface.decideSync(
          { value: 10 },
          { env: { MATOS_ALGO_MANIFEST_PINNING_TEST: 'provider-two' } },
        ),
    )
    expect(result.providerId).toBe('provider-one')
    expect(result.decision.value).toBe(11)

    const mode = (await stat(matOSAlgorithmRunManifestPath(runDir))).mode & 0o777
    expect(mode).toBe(0o600)
    expect(
      (await readdir(runDir)).filter(name => name.endsWith('.tmp')),
    ).toEqual([])
  })

  test('fails closed when a same-id implementation no longer matches the pin', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-algo-manifest-pin-'))
    const manifest = await writeMatOSAlgorithmRunManifest({
      runDir,
      runId: 'run-manifest-pin',
      workflowRef: 'workflow:manifest-test@1.0.0',
      env: { MATOS_ALGO_MANIFEST_PINNING_TEST: 'provider-one' },
    })
    expect(manifest).toBeDefined()
    surface.unregister('provider-one')
    surface.register({
      ...providerOne,
      implementationDigest: '9'.repeat(64),
    })
    try {
      expect(() =>
        withMatOSWorkflowExecutionContext(
          {
            runId: 'run-manifest-pin',
            runDir,
            projectCwd: runDir,
            algorithmSurfacePins: matOSAlgorithmSurfacePinsFromManifest(
              manifest as NonNullable<typeof manifest>,
            ),
          },
          () => surface.decideSync({ value: 1 }),
        ),
      ).toThrow(MatOSAlgorithmPinnedProviderUnavailableError)
    } finally {
      surface.unregister('provider-one')
      surface.register(providerOne)
    }
  })

  test('rejects missing digests, oversized files, and symlink destinations', async () => {
    const missingDigestDir = await mkdtemp(
      join(tmpdir(), 'matos-algo-manifest-missing-'),
    )
    await writeFile(
      matOSAlgorithmRunManifestPath(missingDigestDir),
      `${JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        runId: 'run-missing',
        workflowRef: 'workflow:test@1',
        baselineGuaranteed: true,
        surfaces: [],
        configurationDigest: '0'.repeat(64),
      })}\n`,
      'utf8',
    )
    expect(await readMatOSAlgorithmRunManifest(missingDigestDir)).toBeUndefined()
    await expect(
      requireMatOSAlgorithmRunManifest(missingDigestDir),
    ).rejects.toThrow(/manifest/i)

    const oversizedDir = await mkdtemp(join(tmpdir(), 'matos-algo-manifest-big-'))
    await writeFile(
      matOSAlgorithmRunManifestPath(oversizedDir),
      'x'.repeat(MATOS_ALGORITHM_RUN_MANIFEST_MAX_BYTES + 1),
      'utf8',
    )
    expect(await readMatOSAlgorithmRunManifest(oversizedDir)).toBeUndefined()

    const symlinkDir = await mkdtemp(join(tmpdir(), 'matos-algo-manifest-link-'))
    const target = join(symlinkDir, 'outside.json')
    await writeFile(target, 'do-not-replace\n', 'utf8')
    await symlink(target, matOSAlgorithmRunManifestPath(symlinkDir))
    await expect(
      writeMatOSAlgorithmRunManifest({
        runDir: symlinkDir,
        runId: 'run-link',
        workflowRef: 'workflow:test@1',
      }),
    ).rejects.toThrow(/manifest/i)
    expect(await readFile(target, 'utf8')).toBe('do-not-replace\n')
  })

  test('registry-local providers remain bound to their manifest identity', async () => {
    const runDir = await mkdtemp(join(tmpdir(), 'matos-algo-scoped-pin-'))
    const firstOverrides = new Map([
      [
        'scoped-asset',
        {
          id: 'scoped-asset',
          version: '1.0.0',
          assetRef: 'tool:scoped-asset@1.0.0',
          configDigest: 'a'.repeat(64),
          implementationDigest: 'b'.repeat(64),
          decide: () => ({ value: 11 }),
        },
      ],
    ])
    const first = surface.resolve({
      providerId: 'scoped-asset',
      providerOverrides: firstOverrides,
      ignoreExecutionPin: true,
    }).provider
    const pins = new Map([
      [
        surface.surfaceId,
        {
          surfaceId: surface.surfaceId,
          providerId: first.id,
          source: 'explicit' as const,
          version: first.version,
          assetRef: first.assetRef,
          configDigest: first.configDigest,
          implementationDigest: first.implementationDigest,
          manifestDigest: 'c'.repeat(64),
        },
      ],
    ])
    const changedOverrides = new Map([
      [
        'scoped-asset',
        {
          ...firstOverrides.get('scoped-asset')!,
          implementationDigest: 'd'.repeat(64),
          decide: () => ({ value: 99 }),
        },
      ],
    ])

    expect(() =>
      withMatOSWorkflowExecutionContext(
        { runId: 'scoped-run', runDir, projectCwd: runDir, algorithmSurfacePins: pins },
        () =>
          surface.decideSync(
            { value: 1 },
            { providerOverrides: changedOverrides },
          ),
      ),
    ).toThrow(MatOSAlgorithmPinnedProviderUnavailableError)
  })

  test('a manifest-required run cannot downgrade to unpinned execution', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'matos-algo-legacy-run-'))
    expect(
      await readMatOSAlgorithmRunManifestForExecution(legacyDir),
    ).toBeUndefined()

    const runDir = await mkdtemp(join(tmpdir(), 'matos-algo-required-run-'))
    await writeMatOSAlgorithmRunManifest({
      runDir,
      runId: 'run-required',
      workflowRef: 'workflow:required@1.0.0',
    })
    await writeFile(matOSAlgorithmRunManifestPath(runDir), '{}\n', 'utf8')
    await expect(
      readMatOSAlgorithmRunManifestForExecution(runDir, {
        runId: 'run-required',
      }),
    ).rejects.toThrow(/manifest-required execution/i)
  })
})
