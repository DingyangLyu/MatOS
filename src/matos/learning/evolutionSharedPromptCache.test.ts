import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { buildMatOSRoleLaunchInvocation } from '../cli/run.js'
import {
  buildMatOSEvolutionSharedEvidencePrefix,
  createMatOSEvolutionSharedPromptCacheRunner,
  resolveMatOSEvolutionSharedPromptCacheModel,
  sharedPromptCacheStageArgsCompatible,
} from './evolutionSharedPromptCache.js'
import { EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS } from './evolutionRoleSandbox.js'

async function writeSharedWorkerFixture(root: string): Promise<void> {
  const workerDir = join(root, '.matos', 'assets', 'roles', 'self-evolution-worker')
  await mkdir(workerDir, { recursive: true })
  await writeFile(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      { version: 1, assetRoots: ['assets'], includeDefaultAssetRoots: false },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(
    join(workerDir, 'asset.json'),
    `${JSON.stringify(
      {
        id: 'self-evolution-worker',
        type: 'role',
        name: 'Self evolution worker',
        version: '1.0.0',
        entry: 'prompt.md',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await writeFile(
    join(workerDir, 'prompt.md'),
    'Hidden self-evolution worker. Return JSON only.\n',
    'utf8',
  )
}

/**
 * Fake agent runtime: shared-child launches (identified by --input-format)
 * answer the evidence-prefix turn and then follow `sharedChildAfterPrefix`;
 * standalone launches print a `{"fallback":true}` result and exit cleanly.
 */
async function withFakeSharedRuntime<T>(
  sharedChildAfterPrefix: string[],
  fn: () => Promise<T>,
): Promise<T> {
  const readyLine = JSON.stringify({
    type: 'result',
    is_error: false,
    result: '{"schemaVersion":1,"ready":true}',
  })
  const fallbackLine = JSON.stringify({
    type: 'result',
    is_error: false,
    result: '{"fallback":true}',
  })
  const script = [
    '#!/bin/sh',
    'case "$*" in',
    '  *"--input-format"*)',
    '    read -r _prefix',
    `    printf '%s\\n' '${readyLine}'`,
    ...sharedChildAfterPrefix.map(line => `    ${line}`),
    '    ;;',
    '  *)',
    `    printf '%s\\n' '${fallbackLine}'`,
    '    exit 0',
    '    ;;',
    'esac',
    '',
  ].join('\n')
  const dir = await mkdtemp(join(tmpdir(), 'matos-fake-shared-runtime-'))
  const runtime = join(dir, 'fake-runtime.sh')
  await writeFile(runtime, script)
  await chmod(runtime, 0o755)
  const originalExecPath = process.execPath
  Object.defineProperty(process, 'execPath', {
    configurable: true,
    value: runtime,
  })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: originalExecPath,
    })
  }
}

describe('MatOS evolution shared prompt cache runner', () => {
  test('defaults the shared self-evolution worker to the configured fast model', () => {
    const previous = {
      MATOS_DSH_MODEL: process.env.MATOS_DSH_MODEL,
      MATOS_EVOLUTION_ROLE_MODEL: process.env.MATOS_EVOLUTION_ROLE_MODEL,
      MATOS_EVOLUTION_FAST_MODEL: process.env.MATOS_EVOLUTION_FAST_MODEL,
    }
    process.env.MATOS_DSH_MODEL = 'deepseek-pro'
    process.env.MATOS_EVOLUTION_FAST_MODEL = 'deepseek-flash'
    delete process.env.MATOS_EVOLUTION_ROLE_MODEL
    try {
      const resolved = resolveMatOSEvolutionSharedPromptCacheModel({})

      expect(resolved.env).toEqual({ MATOS_DSH_MODEL: 'deepseek-flash' })
      expect(resolved.args).toEqual(['--model', 'deepseek-flash'])
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test('respects explicit trace model overrides for the shared worker', () => {
    const resolved = resolveMatOSEvolutionSharedPromptCacheModel({
      traceEnv: { MATOS_DSH_MODEL: 'deepseek-pro' },
    })

    expect(resolved.env).toEqual({})
    expect(resolved.args).toEqual(['--model', 'deepseek-pro'])
  })

  test('allows shared prefix reuse when stage sandbox args match the worker sandbox', () => {
    expect(sharedPromptCacheStageArgsCompatible(undefined)).toBe(true)
    expect(sharedPromptCacheStageArgsCompatible([])).toBe(true)
    expect(
      sharedPromptCacheStageArgsCompatible([
        ...EVOLUTION_JSON_ONLY_ROLE_EXTRA_ARGS,
      ]),
    ).toBe(true)
    expect(
      sharedPromptCacheStageArgsCompatible([
        '--permission-mode',
        'dontAsk',
        '--allowed-tools',
        'Read,Edit',
      ]),
    ).toBe(false)
  })

  test('hidden shared-worker launch bypasses project membership enforcement', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-shared-worker-project-'),
    )
    const workerDir = join(
      root,
      '.matos',
      'assets',
      'roles',
      'self-evolution-worker',
    )
    await mkdir(workerDir, { recursive: true })
    await writeFile(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify({
        version: 1,
        assetRoots: ['assets'],
        includeDefaultAssetRoots: false,
      }, null, 2)}\n`,
      'utf8',
    )
    // Real user project: the roster binds only visible members, and the
    // interactive session exports MATOS_PROJECT_MEMBER_ID for its own role.
    // The hidden shared self-evolution worker must not be rejected by either.
    await writeFile(
      join(root, '.matos', 'project.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        id: 'shared-worker-project',
        name: 'Shared worker project',
        team: [{ roleRef: 'role:compute@1.0.0', memberId: 'agent-compute' }],
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(workerDir, 'asset.json'),
      `${JSON.stringify({
        id: 'self-evolution-worker',
        type: 'role',
        name: 'Self evolution worker',
        version: '1.0.0',
        entry: 'prompt.md',
      }, null, 2)}\n`,
      'utf8',
    )
    await writeFile(
      join(workerDir, 'prompt.md'),
      'Hidden self-evolution worker. Return JSON only.\n',
      'utf8',
    )

    const previousMemberId = process.env.MATOS_PROJECT_MEMBER_ID
    process.env.MATOS_PROJECT_MEMBER_ID = 'agent-compute'
    try {
      await expect(
        buildMatOSRoleLaunchInvocation(
          'self-evolution-worker',
          root,
          [],
          { projectAccessMode: 'internal-hidden' },
        ),
      ).resolves.toMatchObject({
        roleReference: 'role:self-evolution-worker',
      })
      // The default enforce path still rejects the non-member hidden role,
      // proving the bypass is what makes the hidden worker launchable.
      await expect(
        buildMatOSRoleLaunchInvocation('self-evolution-worker', root, []),
      ).rejects.toThrow(/is not bound to|not a member of project/)
    } finally {
      if (previousMemberId === undefined) {
        delete process.env.MATOS_PROJECT_MEMBER_ID
      } else {
        process.env.MATOS_PROJECT_MEMBER_ID = previousMemberId
      }
    }
  })

  test('falls back to a standalone role run when the shared child is already dead, and cleans its cli-arg files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-shared-dead-child-'))
    await writeSharedWorkerFixture(root)
    await withFakeSharedRuntime(['exit 0'], async () => {
      const runner = await createMatOSEvolutionSharedPromptCacheRunner({
        cwd: root,
        evidence: buildMatOSEvolutionSharedEvidencePrefix({
          jobId: 'job-shared-dead',
        }),
      })
      expect(runner).toBeDefined()
      // Let the shared child's exit-after-prefix close event land.
      await new Promise(resolve => setTimeout(resolve, 300))
      const result = await runner!.roleRunner({
        cwd: root,
        role: 'self-evolution-worker',
        prompt: 'Stage directive. Return JSON only.',
        jobId: 'job-shared-dead-stage',
        hidden: true,
        maxTurns: 1,
      })
      // The dead shared child is transport failure, not a stage verdict: the
      // stage must succeed through the standalone runner.
      expect(result.exitCode).toBe(0)
      expect(result.parsedResult).toEqual({ fallback: true })
      await runner!.close()
      await new Promise(resolve => setTimeout(resolve, 200))
      // The shared child's materialized cli-arg files were removed on close.
      const leftovers = await readdir(
        join(root, '.matos', 'runtime', 'cli-args'),
      ).catch(() => [] as string[])
      expect(leftovers).toEqual([])
    })
  }, 20_000)

  test('terminates a still-alive shared child when the evidence prefix turn fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-shared-prefix-error-'))
    await writeSharedWorkerFixture(root)
    const marker = join(root, 'sigterm-received.txt')
    const errorLine = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'provider rejected the evidence prefix',
    })
    // Unlike withFakeSharedRuntime, this child answers the prefix with an
    // error result and then stays alive; a bare non-escalating kill (and no
    // close() on the undefined runner) used to leak this process for good.
    const script = [
      '#!/bin/sh',
      `trap 'echo terminated > "${marker}"; exit 0' TERM`,
      'case "$*" in',
      '  *"--input-format"*)',
      '    read -r _prefix',
      `    printf '%s\\n' '${errorLine}'`,
      '    i=0',
      '    while [ $i -lt 200 ]; do',
      '      sleep 0.1 &',
      '      wait $!',
      '      i=$((i+1))',
      '    done',
      '    ;;',
      '  *)',
      '    exit 0',
      '    ;;',
      'esac',
      '',
    ].join('\n')
    const dir = await mkdtemp(join(tmpdir(), 'matos-fake-prefix-error-runtime-'))
    const runtime = join(dir, 'fake-runtime.sh')
    await writeFile(runtime, script)
    await chmod(runtime, 0o755)
    const originalExecPath = process.execPath
    Object.defineProperty(process, 'execPath', {
      configurable: true,
      value: runtime,
    })
    try {
      const runner = await createMatOSEvolutionSharedPromptCacheRunner({
        cwd: root,
        evidence: buildMatOSEvolutionSharedEvidencePrefix({
          jobId: 'job-prefix-error',
        }),
      })
      // Prefix submission is lazy: constructing the runner cannot spend a
      // model call. This legacy transport-failure fixture must request a stage
      // before asserting that the failed prefix child was terminated.
      expect(runner).toBeDefined()
      await runner!.roleRunner({
        cwd: root,
        role: 'self-evolution-worker',
        prompt: 'Stage directive. Return JSON only.',
        jobId: 'job-prefix-error-stage',
        hidden: true,
        maxTurns: 1,
      })
      // The wedged child must receive the termination signal promptly.
      let terminated = false
      for (let attempt = 0; attempt < 50 && !terminated; attempt += 1) {
        terminated = await readFile(marker, 'utf8')
          .then(() => true)
          .catch(() => false)
        if (!terminated) {
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      }
      expect(terminated).toBe(true)
      await runner!.close()
    } finally {
      Object.defineProperty(process, 'execPath', {
        configurable: true,
        value: originalExecPath,
      })
    }
  }, 20_000)

  test('retries the stage standalone when the shared child dies mid-turn instead of failing the stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-shared-midturn-death-'))
    await writeSharedWorkerFixture(root)
    await withFakeSharedRuntime(['read -r _stage', 'exit 7'], async () => {
      const runner = await createMatOSEvolutionSharedPromptCacheRunner({
        cwd: root,
        evidence: buildMatOSEvolutionSharedEvidencePrefix({
          jobId: 'job-shared-midturn',
        }),
      })
      expect(runner).toBeDefined()
      const result = await runner!.roleRunner({
        cwd: root,
        role: 'self-evolution-worker',
        prompt: 'Stage directive. Return JSON only.',
        jobId: 'job-shared-midturn-stage',
        hidden: true,
        maxTurns: 1,
      })
      // Child death mid-turn (exit 7) must not surface as the stage result;
      // the standalone retry's verdict wins.
      expect(result.exitCode).toBe(0)
      expect(result.parsedResult).toEqual({ fallback: true })
      await runner!.close()
    })
  }, 20_000)
})
