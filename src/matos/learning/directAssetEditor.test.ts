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

import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, test } from 'bun:test'
import {
  buildEvolutionRoleInvocation,
  type EvolutionRoleInvocationInput,
} from './evolutionRoleRunner.js'
import {
  abortMatOSDirectAssetEditorPendingMerge,
  applyMatOSDirectAssetEditorPendingMerge,
  approveMatOSDirectAssetEditorProposal,
  ensureCwdLocalCoreEditablePack,
  listMatOSDirectAssetEditorProposals,
  listMatOSDirectAssetEditorRuns,
  listMatOSDirectAssetEditorPendingMerges,
  readMatOSDirectAssetEditorRun,
  readMatOSDirectAssetEditorPendingMerge,
  rebaselineMatOSDirectAssetEditorScope,
  recoverInterruptedMatOSDirectAssetEditorRun,
  rejectMatOSDirectAssetEditorProposal,
  runMatOSDirectAssetEditor,
  rollbackMatOSDirectAssetEditorRun,
  type MatOSDirectAssetEditorPromptInput,
  type MatOSDirectAssetEditorRoleRunner,
  type MatOSDirectAssetEditorRunRecord,
} from './directAssetEditor.js'
import { writeMatOSDirectAssetEditorRunRecord } from './directAssetEditorRecords.js'
import { buildPromptInput, directEditorPrompt } from './directAssetEditorPrompt.js'
import {
  assertDirectEditorWritableRoots,
  createDirectEditorIsolationWorkspace,
  restoreDirectEditorImportBackups,
} from './directAssetEditorFilesystem.js'
import { buildPreviousAttemptFromRecord } from './directAssetEditorAttempts.js'
import {
  runMatOSSemanticAcceptanceJudge,
  type MatOSSemanticAcceptanceJudge,
} from './semanticAcceptanceJudge.js'
import {
  createMatOSAssetHistorySnapshot,
  readMatOSAssetHistorySnapshot,
  withMatOSAssetHistoryLock,
} from '../assets/history/index.js'
import { git } from '../assets/history/gitBackend.js'
import {
  readMatOSProjectConfig,
  type MatOSAssetSourceConfig,
  type MatOSGitAssetSourceConfig,
} from '../project.js'

const execFileAsync = promisify(execFile)

// Explicit per-test ceilings guard against hangs, but they must not defeat
// the repo-wide MATOS_TEST_TIMEOUT_MS escape hatch used on loaded hosts where
// the pipeline's many git/child-process spawns run several times slower.
const ENV_TEST_TIMEOUT_MS = Number(process.env.MATOS_TEST_TIMEOUT_MS ?? '')
function testTimeoutMs(defaultMs: number): number {
  return Number.isFinite(ENV_TEST_TIMEOUT_MS) && ENV_TEST_TIMEOUT_MS > defaultMs
    ? ENV_TEST_TIMEOUT_MS
    : defaultMs
}

async function gitRepo(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 20 * 1024 * 1024,
  })
  return String(result.stdout ?? '')
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('missing port'))
        return
      }
      resolve(address.port)
    })
  })
}

function gitAssetSourceAt(
  sources: MatOSAssetSourceConfig[] | undefined,
  index: number,
): MatOSGitAssetSourceConfig | undefined {
  const source = sources?.[index]
  return source?.type === 'git' ? source : undefined
}

async function writeProjectConfig(root: string): Promise<void> {
  await Bun.write(
    join(root, '.matos', 'matos.json'),
    `${JSON.stringify(
      {
        version: 1,
        assetRoots: ['assets', '../matos-assets'],
        includeDefaultAssetRoots: false,
      },
      null,
      2,
    )}\n`,
  )
}

async function writeExperience(root: string): Promise<void> {
  const dir = join(
    root,
    '.matos',
    'assets',
    'generated',
    'evolution',
    'experiences',
    'compute-queue-selection',
  )
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'compute-queue-selection',
        type: 'experience',
        name: 'Compute queue selection',
        version: '0.1.0',
        description: 'Choose local idle GPUs before remote queues.',
        entry: 'EXPERIENCE.md',
        tags: ['generated', 'learning', 'draft', 'experience'],
        metadata: {
          sourceFormat: 'matos-experience-llm-v1',
          mergeKey: 'compute:queue-selection:compatibility',
          recommendedActions: [
            'Prefer local idle GPUs first.',
            'Mark DevInstance-only queues incompatible for CustomTask jobs.',
          ],
          scenario: {
            domain: 'compute',
            taskType: 'resource-selection',
            failureMode: 'incompatible-queue',
          },
          feedbackAnalysis: {
            schemaVersion: 1,
            shouldUseFeedback: true,
            summary: `User feedback supports prioritizing local idle GPUs before remote queues. ${'f'.repeat(1600)}-FEEDBACK-FULL-END`,
            signals: [
              {
                id: 'feedback-local-gpu-priority',
                kind: 'instruction',
                severity: 'high',
                explicitness: 'explicit',
                claim: 'Prefer local idle GPUs before remote queues.',
                target: {
                  assetTypes: ['role', 'skill'],
                  roleRefs: ['role:compute'],
                  toolNames: ['hpc_submit'],
                },
                evidenceExcerpt: '本地的gpu优先级别最高',
                sourceEventRefs: ['event:turn-feedback'],
                confidence: 0.91,
              },
            ],
            decisions: [
              {
                signalId: 'feedback-local-gpu-priority',
                reasonableness: 'strong',
                evidenceSupport: 'supported',
                generalizability: 'role_specific',
                risk: 'low',
                recommendedAction: 'direct_edit',
                why:
                  'Trace evidence supports making local GPU priority explicit for compute.',
                counterArguments: [
                  'Remote queues can still be useful when local GPUs are busy.',
                ],
                confidence: 0.88,
              },
            ],
          },
          evidenceRefs: ['trace:queue-selection-test'],
        },
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(
    join(dir, 'EXPERIENCE.md'),
    [
      '# Compute queue selection',
      '',
      'Prefer local idle GPUs before remote queues.',
      'If a queue only supports DevInstance payloads, do not use it for CustomTask.',
      `${'e'.repeat(1600)}-EXPERIENCE-FULL-END`,
      '',
    ].join('\n'),
  )
}

async function writeCoreComputeRole(root: string): Promise<string> {
  const dir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'compute',
        type: 'role',
        name: 'Compute',
        version: '0.1.0',
        description: 'Compute role.',
        entry: 'ROLE.md',
        overlayOf: 'role:compute@0.1.0',
        tags: ['compute'],
      },
      null,
      2,
    )}\n`,
  )
  const rolePath = join(dir, 'ROLE.md')
  await Bun.write(
    rolePath,
    `# Compute\n\nChoose remote queues.\n${'r'.repeat(1000)}-ROLE-FULL-END\n`,
  )
  return rolePath
}

async function writeGitCoreComputeRolePack(input: {
  repo: string
  content?: string
}): Promise<string> {
  const packRoot = join(input.repo, 'packs', 'matos-core')
  await Bun.write(
    join(packRoot, 'matos.pack.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'matos-core',
        name: 'MatOS Core',
        version: '1.0.0',
        assets: [],
      },
      null,
      2,
    )}\n`,
  )
  const dir = join(packRoot, 'roles', 'compute')
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'compute',
        type: 'role',
        name: 'Compute',
        version: '0.1.0',
        description: 'Compute role.',
        entry: 'ROLE.md',
        tags: ['compute'],
      },
      null,
      2,
    )}\n`,
  )
  const rolePath = join(dir, 'ROLE.md')
  await Bun.write(
    rolePath,
    input.content ?? '# Compute\n\nChoose remote queues.\n',
  )
  return rolePath
}

async function writeScopedComputeRolePack(
  assetRoot: string,
  packId: string,
): Promise<string> {
  const dir = join(assetRoot, 'packs', packId, 'roles', 'compute')
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'compute',
        type: 'role',
        name: 'Compute',
        version: '0.1.0',
        description: `${packId} scoped compute role.`,
        entry: 'ROLE.md',
        overlayOf: 'role:compute@0.1.0',
        tags: ['compute', packId],
      },
      null,
      2,
    )}\n`,
  )
  const rolePath = join(dir, 'ROLE.md')
  await Bun.write(rolePath, '# Scoped Compute\n\nChoose remote queues.\n')
  return rolePath
}

async function writeUserComputeRole(userAssetRoot: string): Promise<string> {
  const dir = join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute')
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'compute',
        type: 'role',
        name: 'Compute',
        version: '0.1.0',
        description: 'User scoped compute role.',
        entry: 'ROLE.md',
        overlayOf: 'role:compute@0.1.0',
        tags: ['compute', 'user'],
      },
      null,
      2,
    )}\n`,
  )
  const rolePath = join(dir, 'ROLE.md')
  await Bun.write(
    rolePath,
    `# User Compute\n\nChoose remote queues.\n${'u'.repeat(1000)}-USER-ROLE-END\n`,
  )
  return rolePath
}

async function writeCoreQueueSkill(root: string): Promise<string> {
  const dir = coreSkillDir(root, 'compute-queue-policy')
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'compute-queue-policy',
        type: 'skill',
        name: 'Compute Queue Policy',
        version: '0.1.0',
        description: 'Compute queue selection policy.',
        entry: 'SKILL.md',
        tags: ['compute'],
      },
      null,
      2,
    )}\n`,
  )
  const skillPath = join(dir, 'SKILL.md')
  await Bun.write(
    skillPath,
    '# Compute Queue Policy\n\nChoose remote queues.\n',
  )
  return skillPath
}

function coreComputeRolePath(root: string): string {
  return join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute', 'ROLE.md')
}

function coreComputeAssetPath(root: string): string {
  return join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute', 'asset.json')
}

function hiddenDirectEditorRolePath(root: string): string {
  return join(
    root,
    'matos-assets',
    'packs',
    'matos-core',
    'roles',
    'direct-asset-editor',
    'ROLE.md',
  )
}

function coreSkillDir(root: string, skillId: string): string {
  return join(root, 'matos-assets', 'packs', 'matos-core', 'skills', skillId)
}

function coreSkillAssetJson(skillId: string, name: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id: skillId,
      type: 'skill',
      name,
      version: '0.1.0',
      description: `${name} skill.`,
      entry: 'SKILL.md',
      tags: ['compute', 'evolution-test'],
    },
    null,
    2,
  )}\n`
}

function coreToolDir(root: string, toolId: string): string {
  return join(root, 'matos-assets', 'packs', 'matos-core', 'tools', toolId)
}

function coreKnowledgeDir(root: string, knowledgeId: string): string {
  return join(root, 'matos-assets', 'packs', 'matos-core', 'knowledge', knowledgeId)
}

const acceptSemanticJudge: MatOSSemanticAcceptanceJudge = async input => ({
  schemaVersion: 1,
  verdict: 'accept',
  confidence: 0.91,
  reason: 'The edit is low-risk and directly addresses the reusable feedback.',
  resolvedUserProblem: true,
  overfitRisk: 'low',
  assetPollutionRisk: 'low',
  missingEvidence: [],
  recommendedFollowup: [],
  cache: {
    key: `test-cache-${input.runId}`,
    hit: false,
    path: `.matos/evolution/direct-editor/semantic-cache/test-cache-${input.runId}.json`,
    promptVersion: 'test',
    modelId: 'test-model',
    inputHash: `test-hash-${input.runId}`,
  },
  judgeRoleExitCode: 0,
  createdAt: '2026-06-05T00:00:00.000Z',
})

async function writeHiddenCoreRole(root: string): Promise<void> {
  const dir = join(
    root,
    'matos-assets',
    'packs',
    'matos-core',
    'roles',
    'direct-asset-editor',
  )
  await Bun.write(
    join(dir, 'asset.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: 'direct-asset-editor',
        type: 'role',
        name: 'Direct Asset Editor',
        version: '0.1.0',
        description: 'Hidden editor role.',
        entry: 'ROLE.md',
        overlayOf: 'role:direct-asset-editor@0.1.0',
        metadata: {
          hidden: true,
        },
      },
      null,
      2,
    )}\n`,
  )
  await Bun.write(join(dir, 'ROLE.md'), '# Hidden\n\nDo not target this role.\n')
}

describe('MatOS direct asset editor', () => {
  test('rejects unusable writable roots before direct asset editing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-bad-root-'))
    await mkdir(join(root, '.matos'), { recursive: true })
    await writeFile(join(root, '.matos', 'assets'), 'not a directory\n', 'utf8')

    await expect(
      assertDirectEditorWritableRoots({ cwd: root, scope: 'user' }),
    ).rejects.toThrow(/not usable|not a directory/i)
  })

  test('materializes bundled core pack into foreign cwd before editing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-materialize-'))
    const bundledRoot = await mkdtemp(join(tmpdir(), 'matos-direct-editor-bundled-'))
    const bundledComputeRoleDir = join(
      bundledRoot,
      'packs',
      'matos-core',
      'roles',
      'compute',
    )
    await mkdir(bundledComputeRoleDir, { recursive: true })
    await Bun.write(
      join(bundledComputeRoleDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          entry: 'ROLE.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(bundledComputeRoleDir, 'ROLE.md'),
      '# Compute\n\nChoose remote queues.\n',
    )
    await writeProjectConfig(root)
    const previousBundled = process.env.MATOS_BUNDLED_ASSET_ROOT
    process.env.MATOS_BUNDLED_ASSET_ROOT = bundledRoot
    try {
      await ensureCwdLocalCoreEditablePack(root)
      expect(
        await exists(join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute', 'ROLE.md')),
      ).toBe(true)
      expect(await readFile(coreComputeRolePath(root), 'utf8')).toContain(
        'Choose remote queues',
      )
    } finally {
      if (previousBundled === undefined) {
        delete process.env.MATOS_BUNDLED_ASSET_ROOT
      } else {
        process.env.MATOS_BUNDLED_ASSET_ROOT = previousBundled
      }
    }
  })

  test('skips generated Python bytecode when creating an isolation workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-isolation-pycache-'))
    await writeProjectConfig(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const pycacheDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'tools',
      'hpc-common',
      '__pycache__',
    )
    await mkdir(pycacheDir, { recursive: true })
    await Bun.write(join(pycacheDir, 'hpc_common.cpython-313.pyc'), 'bytecode\n')

    const isolation = await createDirectEditorIsolationWorkspace({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-isolation-pycache',
    })
    try {
      expect(
        await exists(join(
          isolation.cwd,
          'matos-assets',
          'packs',
          'matos-core',
          'roles',
          'compute',
          'ROLE.md',
        )),
      ).toBe(true)
      expect(
        await exists(join(
          isolation.cwd,
          'matos-assets',
          'packs',
          'matos-core',
          'tools',
          'hpc-common',
          '__pycache__',
        )),
      ).toBe(false)
    } finally {
      await isolation.cleanup()
    }
  })

  test('tolerates undeletable cross-UID residue when restoring import backups', async () => {
    // Requires root so the test can drop to an unprivileged euid and get a
    // real EACCES, matching host-root residue inside a user source checkout.
    if (process.getuid?.() !== 0 || typeof process.seteuid !== 'function') {
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-import-residue-'))
    const knowledgeDir = join(root, 'matos-assets', 'packs', 'matos-core', 'knowledge')
    const writableDir = join(knowledgeDir, 'writable')
    await mkdir(writableDir, { recursive: true })
    const keptPath = join(writableDir, 'kept.md')
    await writeFile(keptPath, 'edited by import\n', 'utf8')
    const residuePath = join(knowledgeDir, 'residue-created.json')
    await writeFile(residuePath, '{"createdBy":"host-root-provisioning"}\n', 'utf8')
    // The content-restore target dir is writable for the unprivileged euid;
    // the residue parent stays root-only so unlink fails with EACCES.
    await chmod(writableDir, 0o777)

    const modeRestores: Array<{ path: string; mode: number }> = []
    let current = await realpath(root)
    while (true) {
      const info = await stat(current)
      const mode = info.mode & 0o7777
      if ((mode & 0o001) === 0) {
        modeRestores.push({ path: current, mode })
        await chmod(current, mode | 0o011)
      }
      const parent = dirname(current)
      if (parent === current) {
        break
      }
      current = parent
    }
    try {
      process.seteuid!(65534)
      const restore = await restoreDirectEditorImportBackups({
        cwd: root,
        backups: [
          {
            absolutePath: keptPath,
            existed: true,
            entry: { kind: 'file', content: Buffer.from('original content\n') },
          },
          { absolutePath: residuePath, existed: false },
        ],
      })
      expect(restore.skippedRemovals).toEqual([residuePath])
    } finally {
      process.seteuid!(0)
      for (const entry of modeRestores) {
        await chmod(entry.path, entry.mode)
      }
    }
    expect(await readFile(keptPath, 'utf8')).toBe('original content\n')
    expect(await exists(residuePath)).toBe(true)
  })

  test('adds caller-supplied mutating tools to the isolated editor deny list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-isolation-deny-'))
    await writeProjectConfig(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const isolation = await createDirectEditorIsolationWorkspace({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-isolation-deny',
      env: {
        ...process.env,
        MATOS_DIRECT_EDITOR_EXTRA_DISALLOWED_TOOLS:
          'mcp__matos_asset__workflow_edit,mcp__matos_asset__asset_edit',
      },
    })
    try {
      const manifest = JSON.parse(
        await readFile(
          join(
            isolation.cwd,
            'matos-assets',
            'packs',
            'matos-core',
            'roles',
            'direct-asset-editor',
            'asset.json',
          ),
          'utf8',
        ),
      ) as { runtime?: { disallowedTools?: string[] } }
      expect(manifest.runtime?.disallowedTools).toEqual(
        expect.arrayContaining([
          'Bash',
          'PowerShell',
          'mcp__matos_asset__workflow_edit',
          'mcp__matos_asset__asset_edit',
        ]),
      )
    } finally {
      await isolation.cleanup()
    }
  })

  test('runs a hidden LLM3 editor that directly modifies core role assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const calls: EvolutionRoleInvocationInput[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      await Bun.write(
        coreComputeRolePath(input.cwd),
        [
          '# Compute',
          '',
          'Prefer local idle GPUs before remote queues.',
          'Reject DevInstance-only queues for CustomTask jobs.',
          '',
        ].join('\n'),
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role queue selection policy.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-test-run',
      evolutionContext: {
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:queue-submit',
          eventId: 'tool-submit-failed',
          summary: `Queue submit failure should update compute guidance. ${'t'.repeat(1600)}-TRIGGER-FULL-END`,
        },
        sessionPath: '/tmp/full-session.jsonl',
        events: [
          {
            id: 'turn-full-context',
            schemaVersion: 1,
            traceId: 'trace-full-context',
            sessionId: 'session-full-context',
            timestamp: '2026-06-05T00:00:00.000Z',
            execution: 'interactive',
            roleRef: 'role:compute',
            type: 'matos.turn.started',
            data: {
              prompt: `本地 gpu 应该优先。${'p'.repeat(1600)}-EVENT-FULL-END`,
            },
            sourcePath: '/tmp/full-session.jsonl',
          },
        ],
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: `LLM1 says this is reusable. ${'c'.repeat(1600)}-CURRENT-CRITIC-FULL-END`,
          signals: [],
          decisions: [],
        },
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        monitorRecords: [
          {
            recordId: 'monitor-current',
            status: 'analysis-complete',
            summary: `Previous hidden LLM analysis. ${'m'.repeat(1600)}-MONITOR-FULL-END`,
          },
        ],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-test-run',
      status: 'accepted',
      scope: 'core',
      modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
      updatedAssets: ['role:compute@0.1.0'],
    })
    expect(run?.beforeSnapshot).toMatch(/^asset-snapshot-/)
    expect(run?.afterSnapshot).toMatch(/^asset-snapshot-/)
    expect(run?.diffPatchPath).toBe(
      '.matos/evolution/direct-editor/runs/direct-editor-test-run/diff.patch',
    )
    expect(run?.validation?.ok).toBe(true)
    expect(run?.semanticAcceptance?.verdict).toBe('accept')
    const afterSnapshot = await readMatOSAssetHistorySnapshot(
      root,
      run?.afterSnapshot ?? '',
    )
    expect(afterSnapshot).toBeDefined()
    if (!afterSnapshot) {
      throw new Error('after snapshot missing')
    }
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(afterSnapshot.commit)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      role: 'direct-asset-editor',
      jobId: 'direct-asset-editor-direct-editor-test-run',
      maxTurns: 0,
      hidden: true,
    })
    expect(calls[0]?.cwd).not.toBe(root)
    expect(calls[0]?.extraArgs).toContain('--permission-mode')
    expect(calls[0]?.extraArgs).toContain('dontAsk')
    expect(calls[0]?.extraArgs).toContain('--allowed-tools')
    const allowedToolsFlagIndex =
      calls[0]?.extraArgs?.indexOf('--allowed-tools') ?? -1
    expect(allowedToolsFlagIndex).toBeGreaterThanOrEqual(0)
    const allowedToolsArg =
      calls[0]?.extraArgs?.[allowedToolsFlagIndex + 1] ?? ''
    expect(allowedToolsArg).toContain('Read(//')
    expect(allowedToolsArg).toContain('Edit(//')
    expect(allowedToolsArg).not.toContain(`Read(${calls[0]?.cwd}`)
    expect(calls[0]?.prompt).toContain('directly edit the files')
    expect(calls[0]?.prompt).toContain('matos-assets/packs/matos-core/roles/compute/ROLE.md')
    expect(calls[0]?.prompt).toContain('feedbackAnalysis')
    expect(calls[0]?.prompt).toContain('recommendedAction')
    expect(calls[0]?.prompt).toContain('direct_edit')
    expect(calls[0]?.prompt).toContain('FEEDBACK-FULL-END')
    expect(calls[0]?.prompt).toContain('EXPERIENCE-FULL-END')
    expect(calls[0]?.prompt).toContain('ROLE-FULL-END')
    expect(calls[0]?.prompt).toContain('TRIGGER-FULL-END')
    expect(calls[0]?.prompt).toContain('EVENT-FULL-END')
    expect(calls[0]?.prompt).toContain('CURRENT-CRITIC-FULL-END')
    expect(calls[0]?.prompt).toContain('MONITOR-FULL-END')
    expect(calls[0]?.prompt).not.toContain(
      'matos-assets/packs/matos-core/roles/direct-asset-editor/ROLE.md',
    )
    expect(calls[0]?.prompt).toContain('experience:compute-queue-selection@0.1.0')
    // The editor must be told its absolute working directory and that it has and
    // must use real file-editing tools, so it does not probe wrong paths, wrongly
    // conclude it lacks tools, or only "describe" the edit and no-op.
    expect(calls[0]?.prompt).toContain(
      `Your current working directory is: ${calls[0]?.cwd}`,
    )
    expect(calls[0]?.prompt).toContain(
      'You HAVE the Read, Glob, Grep, Edit, Write',
    )
    expect(calls[0]?.prompt).toContain('you MUST actually call the Edit or Write tool')
    expect(calls[0]?.prompt).toContain(
      `${calls[0]?.cwd}/matos-assets/packs/matos-core`,
    )

    const updated = await readFile(rolePath, 'utf8')
    expect(updated).toContain('Prefer local idle GPUs')
    expect(updated).toContain('Reject DevInstance-only queues')

    const listed = await listMatOSDirectAssetEditorRuns(root)
    expect(listed.map(item => item.runId)).toEqual(['direct-editor-test-run'])
    const read = await readMatOSDirectAssetEditorRun(root, 'direct-editor-test-run')
    expect(read?.editorOutput.summary).toContain('Updated compute role')
    expect(read?.beforeSnapshot).toBe(run?.beforeSnapshot)
    expect(read?.afterSnapshot).toBe(run?.afterSnapshot)
    expect(await readFile(join(root, read?.diffPatchPath ?? ''), 'utf8')).toContain(
      '+Prefer local idle GPUs before remote queues.',
    )
  })

  test('releases the asset-history lock during the isolated editor run so concurrent writers are not starved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-lock-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    let lockFreeDuringRun: boolean | undefined
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // A concurrent user-facing asset-history writer must be able to acquire
      // the global lock while the hidden editor role runs in its isolation
      // workspace. Before the two-phase lock fix this acquisition timed out
      // because the editor held the lock for the entire multi-minute run.
      try {
        await withMatOSAssetHistoryLock(
          {
            cwd: root,
            operation: 'concurrent-user-writer',
            timeoutMs: 300,
            pollMs: 10,
          },
          async () => {
            lockFreeDuringRun = true
          },
        )
      } catch {
        lockFreeDuringRun = false
      }
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role queue selection policy.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-lock-run',
      evolutionContext: {
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:queue-submit',
          eventId: 'tool-submit-failed',
          summary: 'Queue submit failure should update compute guidance.',
        },
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(lockFreeDuringRun).toBe(true)
    expect(run?.status).toBe('accepted')
    const updated = await readFile(rolePath, 'utf8')
    expect(updated).toContain('Prefer local idle GPUs')
  })

  test('runs the hidden editor in an isolated workspace and imports only allowed asset changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-isolated-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const calls: EvolutionRoleInvocationInput[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      expect(input.cwd).not.toBe(root)
      const invocation = await buildEvolutionRoleInvocation(input)
      const agentArgsText = invocation.agentArgs.join('\n')
      expect(invocation.agentArgs).not.toContain('--dangerously-skip-permissions')
      expect(agentArgsText).toContain(`Write(/${input.cwd}/matos-assets/packs/matos-core/roles/**)`)
      expect(agentArgsText).not.toContain('Read,Write,Edit,Glob,Grep,NotebookEdit')
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nImported from isolated direct editor workspace.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role in isolation.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-isolated-import',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-isolated-import',
      status: 'accepted',
      roleExitCode: 0,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.extraArgs).toContain('--permission-mode')
    expect(calls[0]?.extraArgs).toContain('dontAsk')
    expect(calls[0]?.extraArgs).toContain('--allowed-tools')
    expect(await readFile(rolePath, 'utf8')).toContain(
      'Imported from isolated direct editor workspace',
    )
  })

  test('rolls back direct edits when asset validation fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-rollback-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const assetPath = coreComputeAssetPath(root)
    const originalAsset = await readFile(assetPath, 'utf8')
    const originalRole = await readFile(rolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeAssetPath(input.cwd),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: 'compute',
            type: 'role',
            version: '0.1.0',
            entry: 'ROLE.md',
          },
          null,
          2,
        )}\n`,
      )
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\nBroken guidance.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Made invalid compute role manifest.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/roles/compute/asset.json',
            'matos-assets/packs/matos-core/roles/compute/ROLE.md',
          ],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-invalid-run',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-invalid-run',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.validation?.ok).toBe(false)
    expect(run?.rollbackSnapshot).toMatch(/^asset-snapshot-/)
    expect(await readFile(assetPath, 'utf8')).toBe(originalAsset)
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  }, testTimeoutMs(15000))

  test('accepts a clean edit even when the core pack has pre-existing validation errors', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-direct-asset-editor-preexisting-'),
    )
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    // Compute role declares a dependency/mount on a data asset that is NOT part
    // of the editable core pack (mirrors production where core assets depend on
    // mounted `data:` assets). This makes asset validation fail for reasons the
    // edit does not introduce.
    const computeDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    await Bun.write(
      join(computeDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          description: 'Compute role.',
          entry: 'ROLE.md',
          tags: ['compute'],
          dependencies: ['data:mounted-only-dataset'],
          mounts: { data: ['data:mounted-only-dataset'] },
        },
        null,
        2,
      )}\n`,
    )
    const rolePath = join(computeDir, 'ROLE.md')
    await Bun.write(
      rolePath,
      `# Compute\n\nChoose remote queues.\n${'r'.repeat(1000)}-ROLE-FULL-END\n`,
    )

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Clean edit: updates ROLE.md prose and bumps the asset version, but
      // never touches the missing dependency. The version bump re-keys the
      // pre-existing environmental errors (role:compute@0.1.0 -> @0.2.0) and
      // must NOT be counted as newly introduced breakage.
      await Bun.write(
        coreComputeRolePath(input.cwd),
        [
          '# Compute',
          '',
          'Prefer local idle GPUs before remote queues.',
          'Reject DevInstance-only queues for CustomTask jobs.',
          '',
        ].join('\n'),
      )
      const manifestPath = coreComputeAssetPath(input.cwd)
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >
      await Bun.write(
        manifestPath,
        `${JSON.stringify({ ...manifest, version: '0.2.0' }, null, 2)}\n`,
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role queue selection policy.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/roles/compute/ROLE.md',
            'matos-assets/packs/matos-core/roles/compute/asset.json',
          ],
          updatedAssets: ['role:compute@0.2.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-preexisting',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('accepted')
    // The pre-existing missing-dependency error keeps after-validation not ok...
    expect(run?.validation?.ok).toBe(false)
    expect(run?.validationBaseline?.ok).toBe(false)
    // ...but the edit introduced no NEW validation errors, so it is not blocked.
    expect(run?.introducedValidationErrors).toEqual([])
    expect(run?.semanticAcceptance?.verdict).toBe('accept')
    expect(await readFile(rolePath, 'utf8')).toContain(
      'Prefer local idle GPUs before remote queues.',
    )
    const afterSnapshot = await readMatOSAssetHistorySnapshot(
      root,
      run?.afterSnapshot ?? '',
    )
    expect(afterSnapshot).toBeDefined()
    if (!afterSnapshot) {
      throw new Error('after snapshot missing')
    }
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(afterSnapshot.commit)
  })

  test('blocks an edit that introduces a NEW validation error on top of pre-existing ones', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-direct-asset-editor-introduced-'),
    )
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    const computeDir = join(root, 'matos-assets', 'packs', 'matos-core', 'roles', 'compute')
    await Bun.write(
      join(computeDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          description: 'Compute role.',
          entry: 'ROLE.md',
          tags: ['compute'],
          dependencies: ['data:mounted-only-dataset'],
          mounts: { data: ['data:mounted-only-dataset'] },
        },
        null,
        2,
      )}\n`,
    )
    const rolePath = join(computeDir, 'ROLE.md')
    await Bun.write(rolePath, '# Compute\n\nChoose remote queues.\n')
    const originalAsset = await readFile(join(computeDir, 'asset.json'), 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Corrupt the asset manifest: introduces a NEW validation error.
      await Bun.write(
        coreComputeAssetPath(input.cwd),
        '{ this is not valid json',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Broke the compute manifest.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/asset.json'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-introduced',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('rolled_back')
    expect((run?.introducedValidationErrors ?? []).length).toBeGreaterThan(0)
    expect(run?.rollback?.reason).toContain('introduced')
    // Rollback restores the original valid manifest.
    expect(await readFile(join(computeDir, 'asset.json'), 'utf8')).toBe(originalAsset)
  }, testTimeoutMs(15000))

  test('rolls back file changes even when the editor role exits with failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-failed-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nFailed run side effect.\n',
      )
      return {
        exitCode: 1,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: 'role failed after editing',
        parsedResult: undefined,
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-failed-side-effect',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-failed-side-effect',
      status: 'rolled_back',
      roleExitCode: 1,
    })
    expect(run?.afterSnapshot).toMatch(/^asset-snapshot-/)
    expect(run?.rollback?.reason).toContain('role failed')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
    expect(await readMatOSDirectAssetEditorRun(root, 'direct-editor-failed-side-effect')).toMatchObject({
      status: 'rolled_back',
    })
  })

  test('detects real file changes even when the editor output reports a noop', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-false-noop-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nDetected change despite noop output.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No changes reported.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-false-noop',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-false-noop',
      status: 'accepted',
      roleExitCode: 0,
    })
    expect(run?.afterSnapshot).toMatch(/^asset-snapshot-/)
    expect(run?.validation?.ok).toBe(true)
    expect(await readFile(rolePath, 'utf8')).toContain('Detected change')
  })

  test('rolls back semantically rejected direct edits after usability validation passes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-semantic-rollback-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nAlways use remote queues even when local GPUs are idle.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Made a semantically wrong queue policy.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      confidence: 0.93,
      reason: 'The edit contradicts the user evidence that local idle GPUs should be preferred.',
      resolvedUserProblem: false,
      overfitRisk: 'high',
      assetPollutionRisk: 'high',
    })

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-semantic-rollback',
      roleRunner,
      semanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-semantic-rollback',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.validation?.ok).toBe(true)
    expect(run?.semanticAcceptance?.verdict).toBe('rollback')
    expect(run?.rollback?.reason).toContain('semantic acceptance rollback')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  })

  test('treats unsupported review judge output as rollback during test-stage rollout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-unsupported-review-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local GPUs, but disable all remote queues permanently.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Added overly broad queue guidance.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = input =>
      runMatOSSemanticAcceptanceJudge({
        cwd: input.cwd,
        runId: input.runId,
        scope: input.scope,
        beforeSnapshot: input.beforeSnapshot,
        afterSnapshot: input.afterSnapshot,
        ...(input.diffPatchPath ? { diffPatchPath: input.diffPatchPath } : {}),
        promptInput: input.promptInput,
        editorOutput: input.editorOutput,
        validation: input.validation,
        modifiedFiles: input.modifiedFiles,
        createdAssets: input.createdAssets,
        updatedAssets: input.updatedAssets,
        disabledAssets: input.disabledAssets,
        evidenceRefs: input.evidenceRefs,
        env: { MATOS_DSH_MODEL: 'test-model' },
        roleRunner: async () => ({
          exitCode: 0,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: '',
          parsedResult: {
            verdict: 'needs_review',
            confidence: 0.72,
            reason:
              'Local GPU priority is supported, but permanently disabling remote queues needs operator review.',
            resolvedUserProblem: true,
            overfitRisk: 'medium',
            assetPollutionRisk: 'medium',
            missingEvidence: ['Whether remote queues should be globally disabled.'],
            recommendedFollowup: [],
          },
        }),
      })

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-semantic-unsupported-review',
      roleRunner,
      semanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-semantic-unsupported-review',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.semanticAcceptance?.verdict).toBe('rollback')
    expect(run?.rollbackSnapshot).toMatch(/^asset-snapshot-/)
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  }, testTimeoutMs(15000))

  test('caches semantic acceptance verdicts by stable judge inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-acceptance-cache-'))
    await Bun.write(
      join(
        root,
        '.matos',
        'evolution',
        'direct-editor',
        'runs',
        'semantic-cache-run',
        'diff.patch',
      ),
      'diff --git a/ROLE.md b/ROLE.md\n+Prefer local GPUs.\n',
    )
    let calls = 0
    const roleRunner = async () => {
      calls += 1
      return {
        exitCode: 0,
        roleReference: 'role:semantic-acceptance-judge',
        stdout: '',
        stderr: '',
        parsedResult: {
          verdict: 'accept',
          confidence: 0.88,
          reason: 'The edit directly addresses the supplied evidence.',
          resolvedUserProblem: true,
          overfitRisk: 'low',
          assetPollutionRisk: 'low',
          missingEvidence: [],
          recommendedFollowup: [],
        },
      }
    }
    const input = {
      cwd: root,
      runId: 'semantic-cache-run',
      scope: 'core',
      beforeSnapshot: 'asset-snapshot-before',
      afterSnapshot: 'asset-snapshot-after',
      diffPatchPath:
        '.matos/evolution/direct-editor/runs/semantic-cache-run/diff.patch',
      promptInput: {
        currentEvolutionContext: {
          trigger: { key: 'user-feedback:event-1' },
          events: [{ id: 'event-1', data: { prompt: '本地 GPU 优先。' } }],
          experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      },
      editorOutput: { summary: 'Updated compute role.' },
      validation: {
        ok: true,
        gateProfile: 'smoke' as const,
        assetValidation: { ok: true, errors: [] },
        secretScan: { ok: true, findings: [] },
        workflowValidation: [],
      },
      modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
      createdAssets: [],
      updatedAssets: ['role:compute@0.1.0'],
      disabledAssets: [],
      evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
      roleRunner,
      env: { MATOS_DSH_MODEL: 'test-model' },
    }

    const first = await runMatOSSemanticAcceptanceJudge(input)
    const second = await runMatOSSemanticAcceptanceJudge(input)
    const third = await runMatOSSemanticAcceptanceJudge({
      ...input,
      editorOutput: { summary: 'Updated compute role with a different rationale.' },
    })

    expect(first.cache.hit).toBe(false)
    expect(second.cache.hit).toBe(true)
    expect(second.cache.key).toBe(first.cache.key)
    expect(third.cache.hit).toBe(false)
    expect(third.cache.key).not.toBe(first.cache.key)
    expect(calls).toBe(2)
  })

  test('ignores expired semantic acceptance cache entries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-acceptance-cache-ttl-'))
    const previousTtl = process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
    process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS = '1000'
    try {
      await Bun.write(
        join(
          root,
          '.matos',
          'evolution',
          'direct-editor',
          'runs',
          'semantic-cache-ttl-run',
          'diff.patch',
        ),
        'diff --git a/ROLE.md b/ROLE.md\n+Prefer local GPUs.\n',
      )
      let calls = 0
      const roleRunner = async () => {
        calls += 1
        return {
          exitCode: 0,
          roleReference: 'role:semantic-acceptance-judge',
          stdout: '',
          stderr: '',
          parsedResult: {
            verdict: 'accept',
            confidence: 0.88,
            reason: 'The edit directly addresses the supplied evidence.',
            resolvedUserProblem: true,
            overfitRisk: 'low',
            assetPollutionRisk: 'low',
            missingEvidence: [],
            recommendedFollowup: [],
          },
        }
      }
      const input = {
        cwd: root,
        runId: 'semantic-cache-ttl-run',
        scope: 'core',
        beforeSnapshot: 'asset-snapshot-before',
        afterSnapshot: 'asset-snapshot-after',
        diffPatchPath:
          '.matos/evolution/direct-editor/runs/semantic-cache-ttl-run/diff.patch',
        promptInput: {
          currentEvolutionContext: {
            trigger: { key: 'user-feedback:event-ttl' },
            events: [{ id: 'event-ttl', data: { prompt: '本地 GPU 优先。' } }],
            experienceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
        },
        editorOutput: { summary: 'Updated compute role.' },
        validation: {
          ok: true,
          gateProfile: 'smoke' as const,
          assetValidation: { ok: true, errors: [] },
          secretScan: { ok: true, findings: [] },
          workflowValidation: [],
        },
        modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
        createdAssets: [],
        updatedAssets: ['role:compute@0.1.0'],
        disabledAssets: [],
        evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        roleRunner,
        env: { MATOS_DSH_MODEL: 'test-model' },
      }

      const first = await runMatOSSemanticAcceptanceJudge(input)
      const cachePath = join(root, first.cache.path)
      const staleRecord = JSON.parse(await readFile(cachePath, 'utf8')) as {
        createdAt: string
      }
      staleRecord.createdAt = new Date(Date.now() - 60_000).toISOString()
      await writeFile(cachePath, `${JSON.stringify(staleRecord, null, 2)}\n`, 'utf8')

      const second = await runMatOSSemanticAcceptanceJudge(input)

      expect(first.cache.hit).toBe(false)
      expect(second.cache.hit).toBe(false)
      expect(calls).toBe(2)
    } finally {
      if (previousTtl === undefined) {
        delete process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS
      } else {
        process.env.MATOS_EVOLUTION_ROLE_CACHE_TTL_MS = previousTtl
      }
    }
  })

  test('semantic judge keeps full evidence when sandbox args force shared-prefix fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-semantic-shared-fallback-'))
    await Bun.write(
      join(
        root,
        '.matos',
        'evolution',
        'direct-editor',
        'runs',
        'semantic-shared-fallback',
        'diff.patch',
      ),
      'diff --git a/ROLE.md b/ROLE.md\n+Prefer local GPUs.\n',
    )
    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner = (async (input: EvolutionRoleInvocationInput) => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:semantic-acceptance-judge',
        stdout: '',
        stderr: '',
        parsedResult: {
          verdict: 'accept',
          confidence: 0.9,
          reason: 'The full trajectory evidence supports the edit.',
          resolvedUserProblem: true,
          overfitRisk: 'low',
          assetPollutionRisk: 'low',
          missingEvidence: [],
          recommendedFollowup: [],
        },
      }
    }) as unknown as ((
      input: EvolutionRoleInvocationInput,
    ) => Promise<{
      exitCode: number
      roleReference: string
      stdout: string
      stderr: string
      parsedResult: Record<string, unknown>
    }>) & {
      usesSharedEvidencePrefix: true
      sharedEvidencePrefixKey: string
      sharedEvidenceCwd: string
    }
    roleRunner.usesSharedEvidencePrefix = true
    roleRunner.sharedEvidencePrefixKey = 'shared-prefix-test'
    roleRunner.sharedEvidenceCwd = root

    await runMatOSSemanticAcceptanceJudge({
      cwd: root,
      runId: 'semantic-shared-fallback',
      scope: 'core',
      beforeSnapshot: 'asset-snapshot-before',
      afterSnapshot: 'asset-snapshot-after',
      diffPatchPath:
        '.matos/evolution/direct-editor/runs/semantic-shared-fallback/diff.patch',
      promptInput: {
        currentEvolutionContext: {
          trigger: { key: 'user-feedback:event-1' },
          events: [
            {
              id: 'event-1',
              data: { prompt: '用户明确要求本地 GPU 优先。' },
            },
          ],
        },
      },
      editorOutput: { summary: 'Updated compute role.' },
      validation: {
        ok: true,
        gateProfile: 'smoke',
        assetValidation: { ok: true, errors: [] },
        secretScan: { ok: true, findings: [] },
        workflowValidation: [],
      },
      modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
      createdAssets: [],
      updatedAssets: ['role:compute@0.1.0'],
      disabledAssets: [],
      evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
      roleRunner,
      env: { MATOS_DSH_MODEL: 'test-model' },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.extraArgs).toContain('--disallowed-tools')
    expect(calls[0]?.prompt).toContain('Use only the evidence in this prompt.')
    expect(calls[0]?.prompt).toContain('"promptInput"')
    expect(calls[0]?.prompt).toContain('用户明确要求本地 GPU 优先')
    expect(calls[0]?.prompt).not.toContain('"sharedEvidencePrefix": true')
  })

  test('removes new invalid asset directories when direct editor validation rolls back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-new-invalid-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const newSkillDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'skills',
      'generated-bad-skill',
    )

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const isolatedNewSkillDir = coreSkillDir(input.cwd, 'generated-bad-skill')
      await Bun.write(
        join(isolatedNewSkillDir, 'asset.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: 'generated-bad-skill',
            type: 'skill',
            version: '0.1.0',
            entry: 'SKILL.md',
          },
          null,
          2,
        )}\n`,
      )
      await Bun.write(join(isolatedNewSkillDir, 'SKILL.md'), '# Bad Skill\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Created invalid skill.',
          modifiedFiles: [],
          createdAssets: ['skill:generated-bad-skill@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-new-invalid-asset',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-new-invalid-asset',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.validation?.ok).toBe(false)
    expect(await exists(join(newSkillDir, 'asset.json'))).toBe(false)
    expect(await exists(join(newSkillDir, 'SKILL.md'))).toBe(false)
  }, testTimeoutMs(15000))

  test('rolls back and records the run when after snapshot creation rejects secret content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-secret-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const secretPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'skills',
      'secret-skill',
      '.env',
    )

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        join(coreSkillDir(input.cwd, 'secret-skill'), '.env'),
        'DEEPSEEK_API_KEY=secret-value-123456789\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Created secret file by mistake.',
          modifiedFiles: [],
          createdAssets: ['skill:secret-skill@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-secret-rollback',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-secret-rollback',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.rollback?.reason).toContain('secret-looking')
    expect(await exists(secretPath)).toBe(false)
    expect(await readMatOSDirectAssetEditorRun(root, 'direct-editor-secret-rollback')).toMatchObject({
      status: 'rolled_back',
    })
  })

  test('directly edits core tool and knowledge assets when experience targets them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-tool-knowledge-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const toolDir = coreToolDir(root, 'hpc-submit')
    const toolPromptPath = join(toolDir, 'prompt.md')
    await mkdir(toolDir, { recursive: true })
    await Bun.write(
      join(toolDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'hpc-submit',
          type: 'tool',
          name: 'HPC Submit',
          version: '0.1.0',
          entry: 'prompt.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(toolPromptPath, 'Submit generated YAML after digest checks.\n')
    const knowledgeDir = coreKnowledgeDir(root, 'hpc-submit-runbook')
    const knowledgePath = join(knowledgeDir, 'KNOWLEDGE.md')
    await mkdir(knowledgeDir, { recursive: true })
    await Bun.write(
      join(knowledgeDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'hpc-submit-runbook',
          type: 'knowledge',
          name: 'HPC Submit Runbook',
          version: '0.1.0',
          entry: 'KNOWLEDGE.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(knowledgePath, '# HPC Submit Runbook\n\nPreserve task ids.\n')
    const calls: EvolutionRoleInvocationInput[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      await Bun.write(
        join(coreToolDir(input.cwd, 'hpc-submit'), 'prompt.md'),
        'Submit generated YAML only after digest checks and workdir validation.\n',
      )
      await Bun.write(
        join(coreKnowledgeDir(input.cwd, 'hpc-submit-runbook'), 'KNOWLEDGE.md'),
        '# HPC Submit Runbook\n\nPreserve task ids and write retry lessons into the runbook.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated HPC tool and runbook guidance from experience.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/tools/hpc-submit/prompt.md',
            'matos-assets/packs/matos-core/knowledge/hpc-submit-runbook/KNOWLEDGE.md',
          ],
          createdAssets: [],
          updatedAssets: [
            'tool:hpc-submit@0.1.0',
            'knowledge:hpc-submit-runbook@0.1.0',
          ],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-tool-knowledge',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-tool-knowledge',
      status: 'accepted',
      roleExitCode: 0,
    })
    expect(run?.updatedAssets).toEqual(
      expect.arrayContaining([
        'knowledge:hpc-submit-runbook@0.1.0',
        'tool:hpc-submit@0.1.0',
      ]),
    )
    expect(calls[0]?.prompt).toContain('Allowed target asset types: role, skill, workflow, tool, mcp, knowledge.')
    expect(calls[0]?.prompt).toContain('Do not stop at an experience asset')
    expect(calls[0]?.prompt).toContain('matos-assets/packs/matos-core/tools/hpc-submit/prompt.md')
    expect(calls[0]?.prompt).toContain('matos-assets/packs/matos-core/knowledge/hpc-submit-runbook/KNOWLEDGE.md')
    expect(await readFile(toolPromptPath, 'utf8')).toContain('workdir validation')
    expect(await readFile(knowledgePath, 'utf8')).toContain('retry lessons')
  })

  test('persists target decisions and passes target conformance into semantic acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-target-contract-tool-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const toolDir = coreToolDir(root, 'hpc-submit')
    const toolPromptPath = join(toolDir, 'prompt.md')
    await mkdir(toolDir, { recursive: true })
    await Bun.write(
      join(toolDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'hpc-submit',
          type: 'tool',
          name: 'HPC Submit',
          version: '0.1.0',
          entry: 'prompt.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(toolPromptPath, 'Submit generated YAML after digest checks.\n')
    const calls: EvolutionRoleInvocationInput[] = []
    const judgeInputs: unknown[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      await Bun.write(
        join(coreToolDir(input.cwd, 'hpc-submit'), 'prompt.md'),
        'Submit generated YAML after digest checks, workdir validation, and wrapper-path preflight.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated HPC submit tool guidance.',
          targetDecision: {
            selectedTypes: ['tool'],
            selectedRefs: ['tool:hpc-submit@0.1.0'],
            rejectedRefs: ['role:compute@0.1.0'],
            fallbackUsed: false,
            reason:
              'The failure belongs to the submit tool contract rather than broad compute role behavior.',
          },
          modifiedFiles: [
            'matos-assets/packs/matos-core/tools/hpc-submit/prompt.md',
          ],
          createdAssets: [],
          updatedAssets: ['tool:hpc-submit@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => {
      judgeInputs.push(input)
      return {
        ...(await acceptSemanticJudge(input)),
        reason: 'Accepted because target conformance matched the explicit tool contract.',
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-target-contract-tool',
      evolutionContext: {
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:hpc_submit',
          eventId: 'hpc-submit-wrapper-failed',
          summary:
            'hpc_submit generated a bad remote wrapper path and should update the submit tool asset.',
        },
        targetContract: {
          schemaVersion: 1,
          mode: 'strict',
          expectedTypes: ['tool'],
          preferredRefs: ['tool:hpc-submit@0.1.0'],
          disallowedFallbackTypes: ['role'],
          reason:
            'The reusable fix belongs in tool preflight and error-classification guidance.',
        },
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'Tool-specific failure should update the HPC submit tool.',
          signals: [
            {
              id: 'feedback-tool-contract',
              kind: 'correction',
              severity: 'high',
              explicitness: 'explicit',
              claim: 'Update the HPC submit tool guidance.',
              target: {
                assetTypes: ['tool'],
                toolRefs: ['tool:hpc-submit'],
                toolNames: ['hpc_submit'],
              },
              evidenceExcerpt: 'The submit MCP tool generated a bad wrapper path.',
              sourceEventRefs: ['event:hpc-submit-wrapper-failed'],
              confidence: 0.94,
            },
          ],
          decisions: [
            {
              signalId: 'feedback-tool-contract',
              reasonableness: 'strong',
              evidenceSupport: 'supported',
              generalizability: 'global',
              risk: 'low',
              recommendedAction: 'direct_edit',
              why: 'The tool-specific fix is reusable and low risk.',
              counterArguments: [],
              confidence: 0.92,
            },
          ],
        },
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      } as never,
      roleRunner,
      semanticJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1' },
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-target-contract-tool',
      status: 'accepted',
      roleExitCode: 0,
    })
    expect(calls[0]?.prompt).toContain('"targetContract"')
    expect(calls[0]?.prompt).toContain('"targetDecision"')
    expect(calls[0]?.prompt).toContain('tool:hpc-submit@0.1.0')
    expect(calls[0]?.prompt).toContain('STRICT target contract:')
    expect(run?.editorOutput).toMatchObject({
      targetDecision: {
        selectedTypes: ['tool'],
        selectedRefs: ['tool:hpc-submit@0.1.0'],
        fallbackUsed: false,
      },
    })
    expect(run?.acceptanceEvidence?.targetConformance).toMatchObject({
      status: 'matched',
      expectedTypes: ['tool'],
      actualTypes: ['tool'],
    })
    expect(judgeInputs[0]).toMatchObject({
      acceptanceEvidence: {
        targetConformance: {
          status: 'matched',
        },
      },
    })
  })

  test('strict target conformance rolls back role-only edits before semantic judge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-target-contract-rollback-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const toolDir = coreToolDir(root, 'hpc-submit')
    await mkdir(toolDir, { recursive: true })
    await Bun.write(
      join(toolDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'hpc-submit',
          type: 'tool',
          name: 'HPC Submit',
          version: '0.1.0',
          entry: 'prompt.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(join(toolDir, 'prompt.md'), 'Submit generated YAML.\n')
    const originalRole = await readFile(rolePath, 'utf8')
    let judgeCalls = 0
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nBroadly mention HPC submit retry behavior in the role.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role instead of the submit tool.',
          targetDecision: {
            selectedTypes: ['role'],
            selectedRefs: ['role:compute@0.1.0'],
            rejectedRefs: ['tool:hpc-submit@0.1.0'],
            fallbackUsed: false,
            reason: 'Chose the broad role despite the tool contract.',
          },
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => {
      judgeCalls += 1
      return acceptSemanticJudge(input)
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-target-contract-role-rollback',
      evolutionContext: {
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:hpc_submit',
          eventId: 'hpc-submit-wrapper-failed',
          summary: 'The hpc_submit tool needs a reusable preflight fix.',
        },
        targetContract: {
          schemaVersion: 1,
          mode: 'strict',
          expectedTypes: ['tool'],
          preferredRefs: ['tool:hpc-submit@0.1.0'],
          disallowedFallbackTypes: ['role'],
          reason: 'Tool failures must update the tool asset unless a fallback is justified.',
        },
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      } as never,
      roleRunner,
      semanticJudge,
    })

    expect(judgeCalls).toBe(0)
    expect(run).toMatchObject({
      runId: 'direct-editor-target-contract-role-rollback',
      status: 'rolled_back',
      roleExitCode: 0,
      acceptanceEvidence: {
        targetConformance: {
          status: 'deviated',
          expectedTypes: ['tool'],
          actualTypes: ['role'],
        },
      },
    })
    expect(run?.rollback?.reason).toContain('high-risk asset policy')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  }, testTimeoutMs(10000))

  test('advisory workflow target blocks high-risk role fallback before semantic judge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-high-risk-role-fallback-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')
    let judgeCalls = 0

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nRoute failed XRD workflow attempts through a broad role rule.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated a broad role even though the trigger targeted a workflow.',
          targetDecision: {
            selectedTypes: ['role'],
            selectedRefs: ['role:compute@0.1.0'],
            rejectedRefs: ['workflow:image-to-xrd-phase@2.0.0'],
            fallbackUsed: true,
            fallbackReason: 'Attempted to encode workflow behavior in the role.',
          },
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => {
      judgeCalls += 1
      return acceptSemanticJudge(input)
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-advisory-workflow-role-fallback',
      evolutionContext: {
        trigger: {
          kind: 'workflow-failure',
          key: 'workflow-failure:image-to-xrd-phase',
          eventId: 'workflow-xrd-failed',
          summary:
            'The image-to-XRD workflow failed and should update its workflow asset.',
        },
        targetContract: {
          schemaVersion: 1,
          mode: 'advisory',
          expectedTypes: ['workflow'],
          preferredRefs: ['workflow:image-to-xrd-phase@2.0.0'],
          disallowedFallbackTypes: ['role'],
          reason:
            'Workflow failures should repair the workflow asset instead of broad role policy.',
        },
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      } as never,
      roleRunner,
      semanticJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1' },
    })

    expect(judgeCalls).toBe(0)
    expect(run).toMatchObject({
      runId: 'direct-editor-advisory-workflow-role-fallback',
      status: 'rolled_back',
      acceptanceEvidence: {
        targetConformance: {
          status: 'deviated',
          expectedTypes: ['workflow'],
          actualTypes: ['role'],
        },
        highRiskAssetPolicy: {
          status: 'blocked',
          blocked: true,
          highRiskActualTypes: ['role'],
          highRiskExpectedTypes: ['workflow'],
        },
      },
    })
    expect(run?.rollback?.reason).toContain('high-risk asset policy')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  }, testTimeoutMs(10000))

  test('Gitea-native direct edits block before editing when no accepted source can be advanced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-gitea-required-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')
    // A run that requires Gitea acceptance with no matching git source is
    // guaranteed to fail at the acceptance gate, so the preflight must block
    // before spending the editor/validation/judge chain.
    let roleRunnerInvoked = false
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async () => {
      roleRunnerInvoked = true
      throw new Error('editor must not run without an acceptable Gitea source')
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-gitea-source-required',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: {
        MATOS_EVOLUTION_REQUIRE_GITEA_SOURCE_ACCEPTANCE: '1',
      },
    })

    expect(roleRunnerInvoked).toBe(false)
    expect(run).toMatchObject({
      runId: 'direct-editor-gitea-source-required',
      status: 'blocked',
      statusReason: 'direct_editor_scoped_source_unavailable',
    })
    expect(run?.stderr).toContain('Gitea source acceptance is required')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  })

  test('treats MCP assets as tool-like self-evolution targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-mcp-target-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const mcpDir = coreToolDir(root, 'atomistic-mcp-mace')
    await mkdir(mcpDir, { recursive: true })
    await Bun.write(
      join(mcpDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'atomistic-mcp-mace',
          type: 'mcp',
          name: 'Atomistic MACE MCP',
          version: '0.1.0',
          entry: 'mcp.json',
          description: 'MCP server exposing MACE atomistic tools.',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(mcpDir, 'mcp.json'),
      `${JSON.stringify(
        {
          mcpServers: {
            'atomistic-mcp-mace': {
              command: '/opt/matos-tools/conda/envs/matos-mlip-py311/bin/python',
              args: ['-m', 'atomistic_mcp_mace.server'],
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No edit needed in this MCP targeting smoke.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-mcp-target',
      evolutionContext: {
        trigger: {
          kind: 'mcp-failure',
          key: 'mcp-failure:atomistic-mcp-mace',
          eventId: 'mcp-startup-failed',
          summary:
            'The atomistic-mcp-mace MCP server should update its startup env preflight as a reusable tool surface.',
        },
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'Explicit MCP asset target from tool startup feedback.',
          signals: [
            {
              id: 'feedback-mcp-target',
              kind: 'correction',
              severity: 'high',
              explicitness: 'explicit',
              claim:
                'The atomistic MACE MCP server should evolve its startup preflight.',
              target: {
                assetTypes: ['mcp'],
                assetRefs: ['mcp:atomistic-mcp-mace@0.1.0'],
                mcpRefs: ['mcp:atomistic-mcp-mace'],
                roleRefs: [],
                toolNames: ['mcp__matos_asset__atomistic_mace'],
                toolRefs: [],
                knowledgeRefs: [],
                workflowRefs: [],
              },
              evidenceExcerpt:
                'MCP startup failed because the configured conda env was missing.',
              sourceEventRefs: ['event:mcp-startup-failed'],
              confidence: 0.9,
            },
          ],
          decisions: [
            {
              signalId: 'feedback-mcp-target',
              reasonableness: 'strong',
              evidenceSupport: 'supported',
              generalizability: 'global',
              risk: 'low',
              recommendedAction: 'direct_edit',
              why:
                'The MCP launch config is a reusable tool surface and should be repaired as an asset.',
              counterArguments: [],
              confidence: 0.9,
            },
          ],
        },
      },
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-mcp-target',
      status: 'noop',
      roleExitCode: 0,
    })
    expect(calls[0]?.prompt).toContain('Allowed target asset types: role, skill, workflow, tool, mcp, knowledge.')
    expect(calls[0]?.prompt).toContain('matos-core/tools/<asset-id>/ directory layout')
    expect(calls[0]?.prompt).toContain('mcp:atomistic-mcp-mace@0.1.0')
    expect(calls[0]?.prompt).toContain(
      'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/mcp.json',
    )
  })

  test('exposes MCP and tool implementation files as direct-editor editable files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-code-files-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const mcpDir = coreToolDir(root, 'atomistic-mcp-mace')
    await mkdir(mcpDir, { recursive: true })
    await Bun.write(
      join(mcpDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'atomistic-mcp-mace',
          type: 'mcp',
          name: 'Atomistic MACE MCP',
          version: '0.1.0',
          entry: 'mcp.json',
          description: 'MCP server exposing MACE atomistic tools.',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(join(mcpDir, 'mcp.json'), '{"mcpServers":{}}\n')
    await Bun.write(join(mcpDir, 'server.py'), 'def main():\n    return None\n')
    await Bun.write(join(mcpDir, 'input.schema.json'), '{"type":"object"}\n')
    await Bun.write(join(mcpDir, 'RUNBOOK.md'), '# MACE MCP Runbook\n')
    await Bun.write(join(mcpDir, '.env'), 'TOKEN=secret\n')
    await mkdir(join(mcpDir, '.matos'), { recursive: true })
    await Bun.write(join(mcpDir, '.matos', 'source.json'), '{"secret":"hidden"}\n')
    await mkdir(join(mcpDir, 'node_modules'), { recursive: true })
    await Bun.write(join(mcpDir, 'node_modules', 'generated.js'), 'module.exports = {}\n')

    const toolDir = coreToolDir(root, 'hpc-submit')
    await mkdir(toolDir, { recursive: true })
    await Bun.write(
      join(toolDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'hpc-submit',
          type: 'tool',
          name: 'HPC Submit Tool',
          version: '0.1.0',
          entry: 'prompt.md',
          metadata: {
            toolNames: ['hpc_submit'],
          },
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(join(toolDir, 'prompt.md'), 'Submit HPC YAML.\n')
    await Bun.write(join(toolDir, 'tool.py'), 'def run():\n    return {"ok": True}\n')
    await Bun.write(join(toolDir, 'input.schema.json'), '{"type":"object"}\n')
    await Bun.write(join(toolDir, 'secret.yaml'), 'token: secret\n')

    const input = await buildPromptInput({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-code-files',
      evolutionContext: {
        trigger: {
          kind: 'tool-failure',
          key: 'tool-failure:hpc-submit',
          eventId: 'tool-failure-event',
          summary:
            'The HPC submit tool and MACE MCP implementation should improve their preflight behavior.',
        },
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'Explicit tool and MCP implementation fix.',
          signals: [
            {
              id: 'feedback-tool-mcp-code',
              kind: 'correction',
              severity: 'high',
              explicitness: 'explicit',
              claim:
                'The MCP server code and tool Python implementation need optimization.',
              target: {
                assetTypes: ['tool', 'mcp'],
                assetRefs: [
                  'tool:hpc-submit@0.1.0',
                  'mcp:atomistic-mcp-mace@0.1.0',
                ],
                toolRefs: ['tool:hpc-submit'],
                mcpRefs: ['mcp:atomistic-mcp-mace'],
                roleRefs: [],
                toolNames: ['hpc_submit'],
                knowledgeRefs: [],
                workflowRefs: [],
              },
              evidenceExcerpt:
                'Tool and MCP failures were traced to reusable code and prompt gaps.',
              sourceEventRefs: ['event:tool-failure-event'],
              confidence: 0.95,
            },
          ],
          decisions: [
            {
              signalId: 'feedback-tool-mcp-code',
              reasonableness: 'strong',
              evidenceSupport: 'supported',
              generalizability: 'global',
              risk: 'low',
              recommendedAction: 'direct_edit',
              why: 'The fix belongs in the tool/MCP implementation assets.',
              counterArguments: [],
              confidence: 0.9,
            },
          ],
        },
      },
    })

    const mcp = input.targetAssets.find(asset => asset.assetRef === 'mcp:atomistic-mcp-mace@0.1.0')
    expect(mcp?.editableFiles).toEqual(
      expect.arrayContaining([
        'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/asset.json',
        'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/mcp.json',
        'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/server.py',
        'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/input.schema.json',
        'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/RUNBOOK.md',
      ]),
    )
    expect(mcp?.editableFiles ?? []).not.toContain(
      'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/.env',
    )
    expect(mcp?.editableFiles ?? []).not.toContain(
      'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/.matos/source.json',
    )
    expect(mcp?.editableFiles ?? []).not.toContain(
      'matos-assets/packs/matos-core/tools/atomistic-mcp-mace/node_modules/generated.js',
    )
    const tool = input.targetAssets.find(asset => asset.assetRef === 'tool:hpc-submit@0.1.0')
    expect(tool?.editableFiles).toEqual(
      expect.arrayContaining([
        'matos-assets/packs/matos-core/tools/hpc-submit/asset.json',
        'matos-assets/packs/matos-core/tools/hpc-submit/prompt.md',
        'matos-assets/packs/matos-core/tools/hpc-submit/tool.py',
        'matos-assets/packs/matos-core/tools/hpc-submit/input.schema.json',
      ]),
    )
    expect(tool?.editableFiles ?? []).not.toContain(
      'matos-assets/packs/matos-core/tools/hpc-submit/secret.yaml',
    )
  })

  test('prioritizes evidence-relevant tool and knowledge assets before the target cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-target-rank-'))
    const previousHideInternal = process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE
    process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = '1'
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    for (let index = 0; index < 40; index += 1) {
      const toolId = `aaa-filler-tool-${String(index).padStart(2, '0')}`
      const dir = coreToolDir(root, toolId)
      await mkdir(dir, { recursive: true })
      await Bun.write(
        join(dir, 'asset.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: toolId,
            type: 'tool',
            name: `Filler Tool ${index}`,
            version: '0.1.0',
            entry: 'prompt.md',
          },
          null,
          2,
        )}\n`,
      )
      await Bun.write(join(dir, 'prompt.md'), `Filler tool ${index}.\n`)
    }
    const relevantToolDir = coreToolDir(root, 'zzz-hpc-submit')
    await mkdir(relevantToolDir, { recursive: true })
    await Bun.write(
      join(relevantToolDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'zzz-hpc-submit',
          type: 'tool',
          name: 'HPC Submit Tool',
          version: '0.1.0',
          entry: 'prompt.md',
          metadata: {
            toolNames: ['hpc_submit'],
          },
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(join(relevantToolDir, 'prompt.md'), 'Submit HPC YAML.\n')
    const relevantKnowledgeDir = coreKnowledgeDir(root, 'zzz-hpc-submit-runbook')
    await mkdir(relevantKnowledgeDir, { recursive: true })
    await Bun.write(
      join(relevantKnowledgeDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'zzz-hpc-submit-runbook',
          type: 'knowledge',
          name: 'HPC Submit Runbook',
          version: '0.1.0',
          entry: 'KNOWLEDGE.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(relevantKnowledgeDir, 'KNOWLEDGE.md'),
      '# HPC Runbook\n\nVASP band quality retry evidence.\n',
    )
    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No edit needed in this ranking smoke.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    let run: Awaited<ReturnType<typeof runMatOSDirectAssetEditor>> | undefined
    try {
      run = await runMatOSDirectAssetEditor({
        cwd: root,
        scope: 'core',
        runId: 'direct-editor-target-rank',
        evolutionContext: {
          trigger: {
            kind: 'tool-failure',
            key: 'tool-failure:hpc_submit',
            eventId: 'hpc-submit-failure',
            summary:
              'The hpc_submit tool and zzz-hpc-submit-runbook knowledge should be updated for VASP band quality retries.',
          },
          feedbackAnalysis: {
            schemaVersion: 1,
            shouldUseFeedback: true,
            summary: 'Explicitly update compute role guidance for local GPU priority.',
            signals: [
              {
                id: 'feedback-compute-role-target',
                kind: 'instruction',
                severity: 'high',
                explicitness: 'explicit',
                claim: 'Update compute role.',
	                target: {
	                  assetTypes: ['role'],
	                  roleRefs: ['role:compute'],
	                  assetRefs: ['knowledge:zzz-hpc-submit-runbook'],
	                  toolNames: ['hpc_submit'],
	                  knowledgeRefs: ['knowledge:zzz-hpc-submit-runbook'],
	                  workflowRefs: [],
	                },
                evidenceExcerpt: 'compute role should learn this',
                sourceEventRefs: ['event:role-target'],
                confidence: 0.9,
              },
            ],
            decisions: [
              {
                signalId: 'feedback-compute-role-target',
                reasonableness: 'strong',
                evidenceSupport: 'supported',
                generalizability: 'role_specific',
                risk: 'low',
                recommendedAction: 'direct_edit',
                why: 'The role target is explicit.',
                counterArguments: [],
                confidence: 0.9,
              },
            ],
          },
        },
        roleRunner,
      })
    } finally {
      if (previousHideInternal === undefined) {
        delete process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE
      } else {
        process.env.MATOS_HIDE_INTERNAL_ASSET_SOURCE = previousHideInternal
      }
    }

    expect(run).toMatchObject({
      runId: 'direct-editor-target-rank',
      status: 'noop',
      roleExitCode: 0,
    })
    expect(calls[0]?.prompt).toContain('matos-assets/packs/matos-core/tools/zzz-hpc-submit/prompt.md')
    expect(calls[0]?.prompt).toContain('matos-assets/packs/matos-core/knowledge/zzz-hpc-submit-runbook/KNOWLEDGE.md')
    expect(calls[0]?.prompt).toContain('matos-assets/packs/matos-core/roles/compute/ROLE.md')
  }, testTimeoutMs(15_000))

  test('copies core tool assets into the isolated editor workspace for dependency validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-isolated-tools-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const toolPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'tools',
      'files-core',
      'asset.json',
    )
    await mkdir(dirname(toolPath), { recursive: true })
    await Bun.write(
      toolPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'files-core',
          type: 'tool',
          name: 'Files Core',
          version: '1.0.0',
        },
        null,
        2,
      )}\n`,
    )

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-isolated-tools',
      roleRunner: async input => {
        expect(
          await exists(
            join(
              input.cwd,
              'matos-assets',
              'packs',
              'matos-core',
              'tools',
              'files-core',
              'asset.json',
            ),
          ),
        ).toBe(true)
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'No edits needed.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [],
          },
        }
      },
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-isolated-tools',
      status: 'noop',
      roleExitCode: 0,
    })
  })

  test('keeps tool:files-core mounted in the isolated editor manifest so file tools stay registered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-files-core-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    // Hidden editor role declaring the files-core builtin-pack exactly like the
    // real core asset. The isolation rewrite must NOT strip it: files-core is
    // the only thing that registers Read/Write/Edit/... into the role, so
    // dropping it leaves the editor with only MCP + Skill tools and every real
    // run silently degrades to a no-op.
    const editorDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'roles',
      'direct-asset-editor',
    )
    await mkdir(editorDir, { recursive: true })
    await Bun.write(
      join(editorDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'direct-asset-editor',
          type: 'role',
          name: 'Direct Asset Editor',
          version: '0.1.0',
          description: 'Hidden editor role.',
          entry: 'ROLE.md',
          dependencies: ['skill:system-role', 'tool:files-core'],
          mounts: { skills: ['skill:system-role'], tools: ['tool:files-core'] },
          runtime: { permissionMode: 'bypassPermissions' },
          metadata: { hidden: true },
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(editorDir, 'ROLE.md'),
      '# Hidden\n\nDo not target this role.\n',
    )
    const toolPath = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'tools',
      'files-core',
      'asset.json',
    )
    await mkdir(dirname(toolPath), { recursive: true })
    await Bun.write(
      toolPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'files-core',
          type: 'tool',
          name: 'Files Core',
          version: '1.0.0',
          metadata: {
            kind: 'builtin-pack',
            builtinTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit'],
          },
        },
        null,
        2,
      )}\n`,
    )

    let isolatedManifest:
      | { dependencies?: unknown; mounts?: { tools?: unknown } }
      | undefined
    await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-files-core',
      roleRunner: async input => {
        isolatedManifest = JSON.parse(
          await readFile(
            join(
              input.cwd,
              'matos-assets',
              'packs',
              'matos-core',
              'roles',
              'direct-asset-editor',
              'asset.json',
            ),
            'utf8',
          ),
        ) as { dependencies?: unknown; mounts?: { tools?: unknown } }
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'No edits needed.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [],
          },
        }
      },
    })

    expect(isolatedManifest).toBeDefined()
    expect((isolatedManifest?.mounts?.tools as string[]) ?? []).toContain(
      'tool:files-core',
    )
    expect((isolatedManifest?.dependencies as string[]) ?? []).toContain(
      'tool:files-core',
    )
  })

  test('rolls back workspace files outside the direct-editor writable scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-outside-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const runtimePath = join(root, 'src', 'runtime.ts')
    const leakedPath = join(root, 'docs', 'leaked.md')
    await Bun.write(runtimePath, 'export const runtime = true\n')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(join(input.cwd, 'src', 'runtime.ts'), 'export const runtime = false\n')
      await Bun.write(join(input.cwd, 'docs', 'leaked.md'), 'leaked change\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Mutated files outside the asset editor scope by mistake.',
          modifiedFiles: ['src/runtime.ts', 'docs/leaked.md'],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-outside-write',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-outside-write',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.rollback?.reason).toContain('outside direct-editor writable scope')
    expect(await readFile(runtimePath, 'utf8')).toBe('export const runtime = true\n')
    expect(await exists(leakedPath)).toBe(false)
    expect(await exists(join(root, 'docs'))).toBe(false)
  })

  test('ignores hidden runtime session logs while importing isolated asset edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-session-log-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nAlways record solver metadata before remote execution.\n',
      )
      await mkdir(join(input.cwd, '.matos', 'sessions'), { recursive: true })
      await Bun.write(
        join(input.cwd, '.matos', 'sessions', 'live-direct-editor.jsonl'),
        '{"type":"matos.agent.message"}\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-session-log-runtime',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('accepted')
    expect(run?.rollback).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toContain('solver metadata')
    expect(await exists(join(root, '.matos', 'sessions', 'live-direct-editor.jsonl'))).toBe(
      false,
    )
  })

  test('ignores isolated algorithm telemetry emitted while composing the hidden editor role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-algo-log-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nAlways record solver metadata before remote execution.\n',
      )
      await mkdir(join(input.cwd, '.matos', 'algorithms'), { recursive: true })
      await Bun.write(
        join(input.cwd, '.matos', 'algorithms', 'decisions.jsonl'),
        '{"schemaVersion":1,"surfaceId":"role-composition"}\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role while role composition emitted telemetry.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-algorithm-telemetry-runtime',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('accepted')
    expect(run?.rollback).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toContain('solver metadata')
    expect(await exists(join(root, '.matos', 'algorithms', 'decisions.jsonl'))).toBe(
      false,
    )
  })

  test('rolls back hidden core role assets even though they live under editable roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-hidden-protected-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const hiddenRolePath = hiddenDirectEditorRolePath(root)
    const originalHiddenRole = await readFile(hiddenRolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        hiddenDirectEditorRolePath(input.cwd),
        '# Hidden\n\nMutated hidden editor role.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Mutated a hidden role by mistake.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/direct-asset-editor/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:direct-asset-editor@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-hidden-protected',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-hidden-protected',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.rollback?.reason).toContain('protected')
    expect(await readFile(hiddenRolePath, 'utf8')).toBe(originalHiddenRole)
  })

  test('leaves a pending merge instead of overwriting concurrent real editable asset changes during isolated editor import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-concurrent-real-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nIsolated direct-editor change.\n',
      )
      await Bun.write(rolePath, '# Compute\n\nConcurrent external real change.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-concurrent-real',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-concurrent-real',
      status: 'pending_merge',
      roleExitCode: 0,
    })
    expect(run?.mergeConflicts?.[0]?.path).toBe(
      'matos-assets/packs/matos-core/roles/compute/ROLE.md',
    )
    expect(run?.pendingMerge).toBe(
      '.matos/evolution/direct-editor/pending-merges/direct-editor-concurrent-real/record.json',
    )
    expect(run?.rollback).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toBe(
      '# Compute\n\nConcurrent external real change.\n',
    )
  })

  test('allows internal runtime cli-args scratch files during real hidden editor runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-runtime-scratch-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const scratchPath = join(
      root,
      '.matos',
      'runtime',
      'cli-args',
      'evolution-prompt-test.md',
    )

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        join(input.cwd, '.matos', 'runtime', 'cli-args', 'evolution-prompt-test.md'),
        'temporary hidden role prompt materialization\n',
      )
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\nValidated change with scratch.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role and used runtime scratch.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-runtime-scratch',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-runtime-scratch',
      status: 'accepted',
      roleExitCode: 0,
    })
    expect(await exists(scratchPath)).toBe(false)
    expect(await readFile(rolePath, 'utf8')).toContain('Validated change with scratch')
  })

  test('accepts merged direct edits when unrelated current assets differ from the stable snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-dirty-unrelated-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    const skillPath = await writeCoreQueueSkill(root)
    await writeHiddenCoreRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await Bun.write(rolePath, '# Compute\n\nPre-existing operator edit.\n')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        join(coreSkillDir(input.cwd, 'compute-queue-policy'), 'SKILL.md'),
        '# Compute Queue Policy\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute queue skill.',
          modifiedFiles: ['matos-assets/packs/matos-core/skills/compute-queue-policy/SKILL.md'],
          createdAssets: [],
          updatedAssets: ['skill:compute-queue-policy@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-dirty-unrelated',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-dirty-unrelated',
      status: 'accepted_merged',
      roleExitCode: 0,
      mergeMode: 'dirty-auto',
    })
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\nPre-existing operator edit.\n')
    expect(await readFile(skillPath, 'utf8')).toContain('Prefer local idle GPUs')
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).not.toBe(stable.commit)
  })

  test('keeps concurrently-created new files and still imports unrelated direct-editor asset files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-concurrent-new-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const concurrentSkillId = 'concurrent-new-skill'
    const unrelatedSkillId = 'paper-database-runbook'
    const concurrentCurrentBody = '# Concurrent New Skill\n\nAlready accepted current version.\n'
    const concurrentEditorBody = '# Concurrent New Skill\n\nDirect editor proposed version.\n'
    const unrelatedEditorBody = '# Paper Database Runbook\n\nRecover paper database connectivity.\n'

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const isolatedConcurrent = coreSkillDir(input.cwd, concurrentSkillId)
      await Bun.write(
        join(isolatedConcurrent, 'asset.json'),
        coreSkillAssetJson(concurrentSkillId, 'Concurrent New Skill'),
      )
      await Bun.write(join(isolatedConcurrent, 'SKILL.md'), concurrentEditorBody)

      const isolatedUnrelated = coreSkillDir(input.cwd, unrelatedSkillId)
      await Bun.write(
        join(isolatedUnrelated, 'asset.json'),
        coreSkillAssetJson(unrelatedSkillId, 'Paper Database Runbook'),
      )
      await Bun.write(join(isolatedUnrelated, 'SKILL.md'), unrelatedEditorBody)

      const realConcurrent = coreSkillDir(root, concurrentSkillId)
      await Bun.write(
        join(realConcurrent, 'asset.json'),
        coreSkillAssetJson(concurrentSkillId, 'Concurrent New Skill'),
      )
      await Bun.write(join(realConcurrent, 'SKILL.md'), concurrentCurrentBody)

      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Created paper database runbook while a sibling skill was created concurrently.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/skills/concurrent-new-skill/asset.json',
            'matos-assets/packs/matos-core/skills/concurrent-new-skill/SKILL.md',
            'matos-assets/packs/matos-core/skills/paper-database-runbook/asset.json',
            'matos-assets/packs/matos-core/skills/paper-database-runbook/SKILL.md',
          ],
          createdAssets: [
            'skill:concurrent-new-skill@0.1.0',
            'skill:paper-database-runbook@0.1.0',
          ],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-concurrent-new-files',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-concurrent-new-files',
      status: 'accepted_merged',
      roleExitCode: 0,
      mergeMode: 'dirty-auto',
    })
    expect(run?.pendingMerge).toBeUndefined()
    expect(run?.mergeConflicts).toBeUndefined()
    expect(
      await readFile(join(coreSkillDir(root, concurrentSkillId), 'SKILL.md'), 'utf8'),
    ).toBe(concurrentCurrentBody)
    expect(
      await readFile(join(coreSkillDir(root, unrelatedSkillId), 'SKILL.md'), 'utf8'),
    ).toBe(unrelatedEditorBody)
  })

  test('ignores generated Python bytecode during direct-editor import merges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-pycache-import-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const pycacheDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'skills',
      'academic',
      'tools',
      '__pycache__',
    )
    await mkdir(pycacheDir, { recursive: true })
    await writeFile(join(pycacheDir, 'paper_fetch.cpython-313.pyc'), 'bytecode-v1', 'utf8')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await writeFile(join(pycacheDir, 'paper_fetch.cpython-313.pyc'), 'bytecode-v2', 'utf8')
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nAlways activate the matos conda environment before VASP.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role VASP preflight.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-pycache-import',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-pycache-import',
      status: 'accepted',
      roleExitCode: 0,
    })
    expect(run?.mergeConflicts).toBeUndefined()
    expect(run?.pendingMerge).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toContain('Always activate')
  })

  test('imports edits based on the dirty input without an unnecessary three-way merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-dirty-merge-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(
      rolePath,
      [
        '# Compute',
        '',
        'Queue policy:',
        '- Choose remote queues.',
        '',
        'Safety policy:',
        '- Keep logs.',
        '',
      ].join('\n'),
    )
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await Bun.write(
      rolePath,
      [
        '# Compute',
        '',
        'Queue policy:',
        '- Choose remote queues.',
        '',
        'Safety policy:',
        '- Keep detailed logs.',
        '',
      ].join('\n'),
    )

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        [
          '# Compute',
          '',
          'Queue policy:',
          '- Prefer local idle GPUs before remote queues.',
          '',
          'Safety policy:',
          '- Keep detailed logs.',
          '',
        ].join('\n'),
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Merged queue policy into dirty compute role.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-dirty-merge',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-dirty-merge',
      status: 'accepted_merged',
      mergeMode: 'dirty-auto',
      roleExitCode: 0,
    })
    const merged = await readFile(rolePath, 'utf8')
    expect(merged).toContain('Prefer local idle GPUs')
    expect(merged).toContain('Keep detailed logs')
  })

  test('records pending merge when a direct edit conflicts with a dirty asset file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-dirty-conflict-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\n- Prefer local idle GPUs.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Conflicting queue policy edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-dirty-conflict',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-dirty-conflict',
      status: 'pending_merge',
      mergeMode: 'conflict',
      roleExitCode: 0,
    })
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\n- Prefer Slurm queues.\n')
    expect(run?.pendingMerge).toBe(
      '.matos/evolution/direct-editor/pending-merges/direct-editor-dirty-conflict/record.json',
    )
    const pending = await readMatOSDirectAssetEditorPendingMerge(
      root,
      'direct-editor-dirty-conflict',
    )
    expect(pending).toMatchObject({
      runId: 'direct-editor-dirty-conflict',
      status: 'pending',
      conflicts: [
        {
          path: 'matos-assets/packs/matos-core/roles/compute/ROLE.md',
        },
      ],
    })
    const pendingList = await listMatOSDirectAssetEditorPendingMerges(root)
    expect(pendingList.map(item => item.runId)).toEqual([
      'direct-editor-dirty-conflict',
    ])
  })

  test('keeps concurrent real changes when hidden editor reports no asset edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-noop-concurrent-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Original policy.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async () => {
      await Bun.write(rolePath, '# Compute\n\n- Concurrent real user edit.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No direct edits performed; experience is sufficient.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-noop-concurrent',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-noop-concurrent',
      status: 'noop',
      roleExitCode: 0,
    })
    expect(run?.pendingMerge).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toBe(
      '# Compute\n\n- Concurrent real user edit.\n',
    )
  })

  test('reads pending merge records for scoped user asset edits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-user-pending-'))
    await writeProjectConfig(root)
    const pendingDir = join(
      root,
      '.matos',
      'evolution',
      'direct-editor',
      'pending-merges',
      'direct-editor-user-conflict',
    )
    await mkdir(pendingDir, { recursive: true })
    await writeFile(
      join(pendingDir, 'record.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          runId: 'direct-editor-user-conflict',
          status: 'pending',
          createdAt: '2026-06-20T00:00:00.000Z',
          updatedAt: '2026-06-20T00:00:00.000Z',
          scope: 'user',
          mergeMode: 'conflict',
          dirtyFilesAtStart: ['assets/packs/user/roles/custom/asset.json'],
          conflicts: [
            {
              path: 'assets/packs/user/roles/custom/asset.json',
              reason: 'same hunk changed in current assets and direct-editor output',
            },
          ],
          files: [
            {
              path: 'assets/packs/user/roles/custom/asset.json',
              basePath: 'files/custom.base',
              baseKind: 'file',
              currentPath: 'files/custom.current',
              currentKind: 'file',
              editPath: 'files/custom.edit',
              editKind: 'file',
            },
          ],
          runRecordPath:
            '.matos/evolution/direct-editor/runs/direct-editor-user-conflict/run.json',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const pending = await readMatOSDirectAssetEditorPendingMerge(
      root,
      'direct-editor-user-conflict',
    )
    expect(pending).toMatchObject({
      runId: 'direct-editor-user-conflict',
      status: 'pending',
      scope: 'user',
      conflicts: [
        {
          path: 'assets/packs/user/roles/custom/asset.json',
        },
      ],
    })
    const pendingList = await listMatOSDirectAssetEditorPendingMerges(root)
    expect(pendingList.map(item => `${item.scope}:${item.runId}`)).toContain(
      'user:direct-editor-user-conflict',
    )
  })

  test('creates a Gitea review branch and PR for configured pending merges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-gitea-pr-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const requests: Array<{ method: string; url: string; body: string }> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', body })
        res.setHeader('content-type', 'application/json')
        if (
          req.method === 'GET' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/branches/evolution%2Fdirect-editor-gitea-pr'
        ) {
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/branches'
        ) {
          expect(JSON.parse(body)).toEqual({
            new_branch_name: 'evolution/direct-editor-gitea-pr',
            old_branch_name: 'main',
          })
          res.statusCode = 201
          res.end('{}')
          return
        }
        if (
          req.method === 'GET' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/roles/compute/ROLE.md?ref=evolution%2Fdirect-editor-gitea-pr'
        ) {
          res.statusCode = 404
          res.end('missing')
          return
        }
        if (
          req.method === 'POST' &&
          req.url ===
            '/api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/roles/compute/ROLE.md'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed.branch).toBe('evolution/direct-editor-gitea-pr')
          expect(Buffer.from(parsed.content, 'base64').toString('utf8')).toBe(
            '# Compute\n\n- Prefer local idle GPUs.\n',
          )
          res.statusCode = 201
          res.end(JSON.stringify({ content: {} }))
          return
        }
        if (
          req.method === 'POST' &&
          req.url === '/api/v1/repos/matos-core/assets/pulls'
        ) {
          const parsed = JSON.parse(body)
          expect(parsed).toMatchObject({
            head: 'evolution/direct-editor-gitea-pr',
            base: 'main',
            title: 'MatOS evolution review direct-editor-gitea-pr',
          })
          res.statusCode = 201
          res.end(
            JSON.stringify({
              number: 88,
              state: 'open',
              html_url: 'https://matos.top/git/matos-core/assets/pulls/88',
              head: { ref: parsed.head },
              base: { ref: parsed.base },
            }),
          )
          return
        }
        res.statusCode = 500
        res.end(JSON.stringify({ error: 'unexpected' }))
      })
    })
    const port = await listen(server)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\n- Prefer local idle GPUs.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Conflicting queue policy edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:queue-policy@0.1.0'],
        },
      }
    }

    try {
      const run = await runMatOSDirectAssetEditor({
        cwd: root,
        scope: 'core',
        runId: 'direct-editor-gitea-pr',
        roleRunner,
        semanticJudge: acceptSemanticJudge,
        env: {
          MATOS_GITEA_API_URL: `http://127.0.0.1:${port}/api/v1`,
          MATOS_GITEA_TOKEN: 'secret-gitea-review-token',
        },
      })

      expect(run).toMatchObject({
        runId: 'direct-editor-gitea-pr',
        status: 'pending_merge',
        giteaReview: {
          status: 'created',
          owner: 'matos-core',
          repo: 'assets',
          branch: 'evolution/direct-editor-gitea-pr',
          pullRequest: {
            number: 88,
            url: 'https://matos.top/git/matos-core/assets/pulls/88',
          },
        },
      })
      const pending = await readMatOSDirectAssetEditorPendingMerge(
        root,
        'direct-editor-gitea-pr',
      )
      expect(pending?.giteaReview?.pullRequest?.number).toBe(88)
      expect(JSON.stringify({ run, pending })).not.toContain('secret-gitea-review-token')
      expect(requests.map(request => `${request.method} ${request.url}`)).toEqual([
        'GET /api/v1/repos/matos-core/assets/branches/evolution%2Fdirect-editor-gitea-pr',
        'POST /api/v1/repos/matos-core/assets/branches',
        'GET /api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/roles/compute/ROLE.md?ref=evolution%2Fdirect-editor-gitea-pr',
        'POST /api/v1/repos/matos-core/assets/contents/matos-assets/packs/matos-core/roles/compute/ROLE.md',
        'POST /api/v1/repos/matos-core/assets/pulls',
      ])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  test('applies a pending merge resolution and clears the pending record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-apply-merge-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\n- Prefer local idle GPUs.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Conflicting queue policy edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const pendingRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-apply-merge',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(pendingRun?.status).toBe('pending_merge')

    const applied = await applyMatOSDirectAssetEditorPendingMerge({
      cwd: root,
      runId: 'direct-editor-apply-merge',
      strategy: 'edit',
    })

    expect(applied).toMatchObject({
      status: 'applied',
      strategy: 'edit',
      run: {
        runId: 'direct-editor-apply-merge',
        status: 'accepted_merged',
        statusReason: 'pending_merge_applied_edit',
      },
    })
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\n- Prefer local idle GPUs.\n')
    expect(
      await readMatOSDirectAssetEditorPendingMerge(root, 'direct-editor-apply-merge'),
    ).toBeUndefined()
    const resolvedRun = await readMatOSDirectAssetEditorRun(root, 'direct-editor-apply-merge')
    expect(resolvedRun?.pendingMerge).toBeUndefined()
    expect(resolvedRun?.afterSnapshot).toMatch(/^asset-snapshot-/)
  })

  test('applies a pending merge resolution through the Gitea accepted runtime ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-apply-merge-gitea-'))
    const seedRepo = join(root, 'seed-core-assets')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(seedRepo, { recursive: true })
    await writeGitCoreComputeRolePack({ repo: seedRepo })
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed core assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, [
      'branch',
      'accepted/matos-core-assets/stable',
      seedCommit,
    ])
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'matos-core-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/matos-core-assets/stable',
                commit: seedCommit,
              },
              scope: 'core',
              refresh: 'manual',
              provider: 'gitea',
              gitea: {
                owner: 'matos-core',
                repo: 'assets',
                visibility: 'internal',
                cloneUrl: seedRepo,
              },
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\n- Prefer local idle GPUs.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Resolved compute queue policy through pending merge.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const pendingRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-apply-merge-gitea',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(pendingRun?.status).toBe('pending_merge')

    const applied = await applyMatOSDirectAssetEditorPendingMerge({
      cwd: root,
      runId: 'direct-editor-apply-merge-gitea',
      strategy: 'edit',
    })

    expect(applied).toMatchObject({
      status: 'applied',
      strategy: 'edit',
      run: {
        runId: 'direct-editor-apply-merge-gitea',
        status: 'accepted_merged',
        sourceCommits: [
          {
            sourceId: 'matos-core-assets',
            branch: 'evolution/direct-editor-apply-merge-gitea',
            pushed: true,
          },
        ],
        sourceAcceptance: [
          {
            sourceId: 'matos-core-assets',
            acceptedBranch: 'accepted/matos-core-assets/stable',
            ok: true,
            pushed: true,
            validationOk: true,
          },
        ],
      },
    })
    const acceptedCommit = (
      await gitRepo(seedRepo, ['rev-parse', 'accepted/matos-core-assets/stable'])
    ).trim()
    expect(acceptedCommit).not.toBe(seedCommit)
    expect(applied?.run.sourceRollback).toEqual([expect.objectContaining({
      sourceId: 'matos-core-assets', commit: seedCommit, expectedRemoteCommit: acceptedCommit, pushed: true,
    })])
    const acceptedRole = await gitRepo(seedRepo, [
      'show',
      `${acceptedCommit}:packs/matos-core/roles/compute/ROLE.md`,
    ])
    expect(acceptedRole).toContain('Prefer local idle GPUs')
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(gitAssetSourceAt(updatedConfig.assetSources, 0)?.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/matos-core-assets/stable',
      commit: acceptedCommit,
    })
  }, testTimeoutMs(15000))

  test('normalizes legacy dirty preflight failures as blocked when reading runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-legacy-dirty-'))
    const runId = 'direct-editor-legacy-dirty'
    const runDir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'failed',
          createdAt: '2026-06-17T01:26:29.815Z',
          updatedAt: '2026-06-17T01:26:29.815Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-17T01:25:31.964Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experiences: [],
            targetAssets: [],
          },
          editorOutput: {
            summary: 'Direct asset editor skipped because current assets are dirty.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
          roleExitCode: 1,
          stderr:
            'Refusing dirty direct asset editor run: current assets differ from the stable snapshot.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const run = await readMatOSDirectAssetEditorRun(root, runId)
    const runs = await listMatOSDirectAssetEditorRuns(root)

    expect(run?.status).toBe('blocked')
    expect(run?.rawStatus).toBe('failed')
    expect(run?.statusReason).toBe('legacy_dirty_preflight')
    expect(runs[0]?.status).toBe('blocked')
    expect(runs[0]?.rawStatus).toBe('failed')
    expect(runs[0]?.statusReason).toBe('legacy_dirty_preflight')
  })

  test('adds legacy dirty reason to already-blocked old preflight records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-legacy-blocked-dirty-'))
    const runId = 'direct-editor-legacy-blocked-dirty'
    const runDir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'blocked',
          createdAt: '2026-06-18T04:08:16.478Z',
          updatedAt: '2026-06-18T04:08:16.478Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-18T04:07:00.000Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experiences: [],
            targetAssets: [],
          },
          editorOutput: {
            summary: 'Direct asset editor skipped because current assets are dirty.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
          roleExitCode: 1,
          stderr:
            'Refusing dirty direct asset editor run: current assets differ from the stable snapshot.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const run = await readMatOSDirectAssetEditorRun(root, runId)

    expect(run?.status).toBe('blocked')
    expect(run?.rawStatus).toBeUndefined()
    expect(run?.statusReason).toBe('legacy_dirty_preflight')
  })

  test('normalizes legacy concurrent-import failures as blocked when reading runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-legacy-import-'))
    const runId = 'direct-editor-legacy-import'
    const runDir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'failed',
          createdAt: '2026-06-15T01:00:00.000Z',
          updatedAt: '2026-06-15T01:01:00.000Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-15T01:00:00.000Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experiences: [],
            targetAssets: [],
          },
          editorOutput: {
            summary: 'A valid edit was produced but could not be imported.',
            modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
            createdAssets: [],
            updatedAssets: ['role:compute@1.0.1'],
            disabledAssets: [],
            evidenceRefs: ['experience:compute@0.1.0'],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
          roleExitCode: 1,
          stderr:
            'Direct asset editor import skipped because editable assets changed during the isolated editor run.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const run = await readMatOSDirectAssetEditorRun(root, runId)
    const runs = await listMatOSDirectAssetEditorRuns(root)

    expect(run?.status).toBe('blocked')
    expect(run?.rawStatus).toBe('failed')
    expect(run?.statusReason).toBe('legacy_concurrent_import')
    expect(runs[0]?.status).toBe('blocked')
    expect(runs[0]?.rawStatus).toBe('failed')
    expect(runs[0]?.statusReason).toBe('legacy_concurrent_import')
  })

  test('normalizes empty pending-merge records as no-op when reading runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-empty-pending-'))
    const runId = 'direct-editor-empty-pending'
    const runDir = join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'pending_merge',
          createdAt: '2026-06-18T17:12:23.150Z',
          updatedAt: '2026-06-18T17:12:23.150Z',
          scope: 'core',
          input: {
            generatedAt: '2026-06-18T17:10:00.000Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experiences: [],
            targetAssets: [],
          },
          editorOutput: {
            summary: 'No direct edits performed; experience is sufficient.',
            modifiedFiles: [],
            createdAssets: [],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: ['experience:paper-database@0.1.0'],
          },
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:paper-database@0.1.0'],
          roleExitCode: 0,
          pendingMerge:
            '.matos/evolution/direct-editor/pending-merges/direct-editor-empty-pending/record.json',
          mergeMode: 'conflict',
          mergeConflicts: [],
        },
        null,
        2,
      )}\n`,
      'utf8',
    )

    const run = await readMatOSDirectAssetEditorRun(root, runId)
    const runs = await listMatOSDirectAssetEditorRuns(root)

    expect(run?.status).toBe('noop')
    expect(run?.rawStatus).toBe('pending_merge')
    expect(run?.statusReason).toBe('empty_pending_merge_no_asset_edits')
    expect(run?.pendingMerge).toBeUndefined()
    expect(run?.mergeConflicts).toBeUndefined()
    expect(runs[0]?.status).toBe('noop')
  })

  test('rebaselines current core assets after a normal asset update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-rebaseline-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await Bun.write(rolePath, '# Compute\n\nNormal committed asset update.\n')

    const rebaseline = await rebaselineMatOSDirectAssetEditorScope({
      cwd: root,
      scope: 'core',
      reason: 'test normal asset update',
    })
    expect(rebaseline.status).toBe('updated')
    expect(rebaseline.validation?.ok).toBe(true)
    if (!rebaseline.snapshot) {
      throw new Error('expected rebaseline snapshot')
    }
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(rebaseline.snapshot.commit)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\nNormal update plus direct edit.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute role after rebaseline.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const accepted = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-after-rebaseline',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(accepted?.status).toBe('accepted')
    expect(await readFile(rolePath, 'utf8')).toContain('Normal update plus direct edit')
  })

  test('rebaseline tolerates pre-existing asset-history validation errors without treating them as new breakage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-rebaseline-baseline-errors-'))
    await writeProjectConfig(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(
      coreComputeAssetPath(root),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          description: 'Compute role.',
          entry: 'ROLE.md',
          dependencies: ['data:missing-mounted-profile'],
          tags: ['compute'],
        },
        null,
        2,
      )}\n`,
    )
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])
    await Bun.write(rolePath, '# Compute\n\nNormal guidance update with same dependency set.\n')

    const rebaseline = await rebaselineMatOSDirectAssetEditorScope({
      cwd: root,
      scope: 'core',
      reason: 'test normal update with pre-existing validation errors',
    })

    expect(rebaseline.status).toBe('updated')
    expect(rebaseline.validation?.ok).toBe(false)
    if (!rebaseline.snapshot) {
      throw new Error('expected rebaseline snapshot')
    }
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(rebaseline.snapshot.commit)
  })

  test('rolls back core tool symlinks that would escape editable asset roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-symlink-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const toolDir = join(root, 'matos-assets', 'packs', 'matos-core', 'tools', 'files-core')
    const symlinkPath = join(toolDir, 'asset.json')
    const outsideTarget = join(root, 'outside-target.json')
    await mkdir(toolDir, { recursive: true })
    await Bun.write(outsideTarget, '{"id":"outside"}\n')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const isolatedSymlinkPath = join(
        input.cwd,
        'matos-assets',
        'packs',
        'matos-core',
        'tools',
        'files-core',
        'asset.json',
      )
      await mkdir(dirname(isolatedSymlinkPath), { recursive: true })
      await symlink(outsideTarget, isolatedSymlinkPath)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Created an escaping symlink by mistake.',
          modifiedFiles: ['matos-assets/packs/matos-core/tools/files-core/asset.json'],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-protected-symlink',
      roleRunner,
    })

    expect(run).toMatchObject({
      runId: 'direct-editor-protected-symlink',
      status: 'rolled_back',
      roleExitCode: 0,
    })
    expect(run?.rollback?.reason).toMatch(/symlink|validation/i)
    expect(await exists(symlinkPath)).toBe(false)
    expect(await readFile(outsideTarget, 'utf8')).toBe('{"id":"outside"}\n')
  })

  test('manual rollback moves the stable ref to the rollback snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-stable-rollback-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nValidated change for rollback.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Valid update.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-stable-rollback',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(run?.status).toBe('accepted')

    const rolledBack = await rollbackMatOSDirectAssetEditorRun({
      cwd: root,
      runId: 'direct-editor-stable-rollback',
    })
    const rollbackSnapshot = rolledBack?.rollbackSnapshot
      ? await readMatOSAssetHistorySnapshot(root, rolledBack.rollbackSnapshot)
      : undefined

    expect(rolledBack?.status).toBe('rolled_back')
    const rollbackCommit = rollbackSnapshot?.commit
    expect(rollbackCommit).toBeTruthy()
    if (!rollbackCommit) {
      throw new Error('expected rollback snapshot commit')
    }
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(rollbackCommit)
  })

  test('refuses manual rollback when stable has moved past the selected run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-stale-rollback-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\nFirst validated change.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'First valid update.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-stale-rollback',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(run?.status).toBe('accepted')

    await Bun.write(rolePath, '# Compute\n\nNewer stable change.\n')
    const newer = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
      parentCommit: run?.afterSnapshot
        ? (await readMatOSAssetHistorySnapshot(root, run.afterSnapshot))?.commit
        : undefined,
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', newer.commit])

    await expect(
      rollbackMatOSDirectAssetEditorRun({
        cwd: root,
        runId: 'direct-editor-stale-rollback',
      }),
    ).rejects.toThrow(/stale direct editor rollback/)
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\nNewer stable change.\n')
  })

  // Production container shape: the session cwd has no local matos-assets pack
  // and the editable core pack root resolves through env (e.g. baked or mounted
  // /app/matos-assets/packs/matos-core).
  test('edits core assets through MATOS_EDITABLE_CORE_ASSET_ROOT outside the cwd', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-prod-cwd-'))
    const external = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-prod-assets-'))
    const externalCoreRoot = join(external, 'matos-assets', 'packs', 'matos-core')
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', join(external, 'matos-assets')],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(external)
    await writeHiddenCoreRole(external)
    const originalRole = await readFile(rolePath, 'utf8')

    const previousEditableRoot = process.env.MATOS_EDITABLE_CORE_ASSET_ROOT
    process.env.MATOS_EDITABLE_CORE_ASSET_ROOT = externalCoreRoot
    try {
      const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
        // The hidden role always edits the literal cwd-relative isolation copy.
        expect(input.cwd).not.toBe(root)
        expect(await exists(coreComputeRolePath(input.cwd))).toBe(true)
        await Bun.write(
          coreComputeRolePath(input.cwd),
          [
            '# Compute',
            '',
            'Prefer local idle GPUs before remote queues.',
            'Reject DevInstance-only queues for CustomTask jobs.',
            '',
          ].join('\n'),
        )
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'Updated compute role queue selection policy.',
            modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
            updatedAssets: ['role:compute@0.1.0'],
            createdAssets: [],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
        }
      }

      const run = await runMatOSDirectAssetEditor({
        cwd: root,
        scope: 'core',
        runId: 'direct-editor-prod-root',
        evolutionContext: {
          experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
        roleRunner,
        semanticJudge: acceptSemanticJudge,
      })

      expect(run?.status).toBe('accepted')
      // The accepted edit lands in the external core root, not under the cwd.
      expect(await readFile(rolePath, 'utf8')).toContain(
        'Prefer local idle GPUs before remote queues.',
      )
      expect(await exists(join(root, 'matos-assets'))).toBe(false)
      // Prompt paths and snapshot records stay on the stable logical namespace.
      expect(run?.input.editableRoots).toEqual(['matos-assets/packs/matos-core'])
      const afterSnapshot = run?.afterSnapshot
        ? await readMatOSAssetHistorySnapshot(root, run.afterSnapshot)
        : undefined
      expect(afterSnapshot).toBeDefined()
      expect(
        afterSnapshot?.files.some(
          file => file.path === 'matos-assets/packs/matos-core/roles/compute/ROLE.md',
        ),
      ).toBe(true)
      // History state stays under the session cwd.
      expect(await exists(join(root, '.matos', 'asset-history.git'))).toBe(true)
      expect(
        (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
      ).toBe(afterSnapshot?.commit ?? '')

      // A later semantic rollback restores the external files from the cwd-local history.
      const rollbackJudge: MatOSSemanticAcceptanceJudge = async input => ({
        ...(await acceptSemanticJudge(input)),
        verdict: 'rollback',
        reason: 'Second edit is not supported by the evidence.',
      })
      const secondRunner: MatOSDirectAssetEditorRoleRunner = async input => {
        await Bun.write(
          coreComputeRolePath(input.cwd),
          '# Compute\n\nOverfit second change.\n',
        )
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'Second update.',
            modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
            updatedAssets: ['role:compute@0.1.0'],
            createdAssets: [],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
        }
      }
      const secondRun = await runMatOSDirectAssetEditor({
        cwd: root,
        scope: 'core',
        runId: 'direct-editor-prod-root-rollback',
        evolutionContext: {
          experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
        roleRunner: secondRunner,
        semanticJudge: rollbackJudge,
      })
      expect(secondRun?.status).toBe('rolled_back')
      expect(await readFile(rolePath, 'utf8')).toContain(
        'Prefer local idle GPUs before remote queues.',
      )
      expect(await readFile(rolePath, 'utf8')).not.toContain('Overfit second change.')
      expect(originalRole).toContain('Choose remote queues.')
    } finally {
      if (previousEditableRoot === undefined) {
        delete process.env.MATOS_EDITABLE_CORE_ASSET_ROOT
      } else {
        process.env.MATOS_EDITABLE_CORE_ASSET_ROOT = previousEditableRoot
      }
    }
  }, testTimeoutMs(15000))

  test('retries with rejection feedback and accepts the corrected second attempt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-retry-accept-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const prompts: string[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      prompts.push(input.prompt)
      const isRetry = input.prompt.includes('"previousAttempts"')
      if (!isRetry) {
        // First attempt corrupts the manifest -> Gate 1 introduces a new error.
        await Bun.write(coreComputeAssetPath(input.cwd), '{ not valid json')
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'First attempt broke the manifest.',
            modifiedFiles: [
              'matos-assets/packs/matos-core/roles/compute/asset.json',
            ],
            updatedAssets: ['role:compute@0.1.0'],
            createdAssets: [],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
        }
      }
      // Retry attempt makes a clean, valid edit that should be accepted.
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Second attempt corrected the edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'retry-accept',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '3' },
    })

    expect(run?.runId).toBe('retry-accept')
    expect(run?.status).toBe('accepted')
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toContain('"previousAttempts"')
    expect(prompts[1]).toContain('"previousAttempts"')
    expect(prompts[1]).toContain('"rejectionStage": "gate1-validation"')
    expect(prompts[1]).toContain('earlier attempts')
    expect(run?.attempts).toHaveLength(2)
    expect(run?.attempts?.[0]).toMatchObject({
      attempt: 1,
      status: 'rolled_back',
      rejectionStage: 'gate1-validation',
    })
    expect(run?.attempts?.[1]).toMatchObject({ attempt: 2, status: 'accepted' })
    expect(await readFile(rolePath, 'utf8')).toContain('Prefer local idle GPUs')
    // The decisive consolidated record is persisted under the base run id.
    const persisted = await readMatOSDirectAssetEditorRun(root, 'retry-accept')
    expect(persisted?.status).toBe('accepted')
    expect(persisted?.attempts).toHaveLength(2)
  })

  test('retries a phantom edit that reported changes but wrote nothing to disk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-phantom-edit-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const prompts: string[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      prompts.push(input.prompt)
      const isRetry = input.prompt.includes('"previousAttempts"')
      if (!isRetry) {
        // Phantom edit: report modifiedFiles but never write to disk (the real
        // "describes the edit instead of calling Edit/Write" failure mode).
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'Described the edit without performing it.',
            modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
            updatedAssets: ['role:compute@0.1.0'],
            createdAssets: [],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
        }
      }
      // Retry actually writes the file with the tools.
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Performed the real edit with the file tools.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'phantom-edit',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '3' },
    })

    expect(run?.runId).toBe('phantom-edit')
    expect(run?.status).toBe('accepted')
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('"rejectionStage": "no-op-no-edit"')
    expect(prompts[1]).toContain('did NOT change any file on disk')
    expect(run?.attempts).toHaveLength(2)
    expect(run?.attempts?.[0]).toMatchObject({
      attempt: 1,
      status: 'noop',
      rejectionStage: 'no-op-no-edit',
    })
    expect(run?.attempts?.[1]).toMatchObject({ attempt: 2, status: 'accepted' })
    expect(await readFile(rolePath, 'utf8')).toContain('Prefer local idle GPUs')
  })

  test('exhausts bounded attempts and records the full attempt chain on rollback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-retry-exhaust-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')
    const prompts: string[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      prompts.push(input.prompt)
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nAlways use remote queues even when local GPUs are idle.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Semantically wrong queue policy.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const rollbackJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      reason: 'Edit contradicts the user evidence preferring local idle GPUs.',
      resolvedUserProblem: false,
      overfitRisk: 'high',
      assetPollutionRisk: 'high',
      missingEvidence: ['concrete user-confirmed preference for remote queues'],
      recommendedFollowup: [
        'gather explicit confirmation before changing queue policy',
      ],
    })

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'retry-exhaust',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: rollbackJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '3' },
    })

    expect(run?.runId).toBe('retry-exhaust')
    expect(run?.status).toBe('rolled_back')
    expect(prompts).toHaveLength(3)
    // Later attempts are told why earlier attempts were rejected by the semantic gate.
    expect(prompts[1]).toContain('"rejectionStage": "gate2-semantic"')
    expect(prompts[1]).toContain('concrete user-confirmed preference')
    expect(prompts[2]).toContain('"rejectionStage": "gate2-semantic"')
    expect(run?.attempts).toHaveLength(3)
    expect(run?.attempts?.every(attempt => attempt.status === 'rolled_back')).toBe(
      true,
    )
    expect(run?.attempts?.[2]).toMatchObject({
      attempt: 3,
      judgeVerdict: 'rollback',
    })
    // The asset is restored after the final rollback.
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  }, testTimeoutMs(20000))

  test('does not retry when the semantic judge process itself fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-judge-failed-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')
    const calls: string[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input.prompt)
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Valid edit, but judge infra fails.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    // A judge process failure is infrastructure noise, not a bad edit. The loop
    // must not waste another expensive editor attempt on it.
    const judgeFailedJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      reason: 'judge process failed',
      judgeFailed: true,
      judgeRoleExitCode: 1,
    })

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'judge-failed-no-retry',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: judgeFailedJudge,
    })

    expect(run?.status).toBe('rolled_back')
    expect(calls).toHaveLength(1)
    expect(run?.attempts).toBeUndefined()
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  })

  test('defaults to three direct-editor attempts', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-direct-editor-max-attempts-default-'),
    )
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')
    const calls: string[] = []

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input.prompt)
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nAlways use remote queues even when local GPUs are idle.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Semantically wrong edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const rollbackJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      reason: 'not supported by evidence',
    })

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'max-attempts-default',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: rollbackJudge,
    })

    expect(run?.runId).toBe('max-attempts-default')
    expect(run?.status).toBe('rolled_back')
    expect(calls).toHaveLength(3)
    expect(run?.attempts).toHaveLength(3)
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  })

  test('commits accepted core edits into the Gitea accepted runtime ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-core-gitea-'))
    const seedRepo = join(root, 'seed-core-assets')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(seedRepo, { recursive: true })
    await writeGitCoreComputeRolePack({ repo: seedRepo })
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed core assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, [
      'branch',
      'accepted/matos-core-assets/stable',
      seedCommit,
    ])
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'matos-core-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/matos-core-assets/stable',
                commit: seedCommit,
              },
              scope: 'core',
              refresh: 'manual',
              provider: 'gitea',
              gitea: {
                owner: 'matos-core',
                repo: 'assets',
                visibility: 'internal',
                cloneUrl: seedRepo,
              },
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated core compute role.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/roles/compute/ROLE.md',
          ],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-core-gitea',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('accepted')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'matos-core-assets',
      action: 'committed',
      branch: 'evolution/direct-editor-core-gitea',
      pushed: true,
    })
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'matos-core-assets',
      acceptedBranch: 'accepted/matos-core-assets/stable',
      ok: true,
      pushed: true,
      validationOk: true,
    })
    expect(run?.sourceRollback?.[0]).toMatchObject({
      sourceId: 'matos-core-assets',
      acceptedBranch: 'accepted/matos-core-assets/stable',
      commit: seedCommit,
      pushed: true,
    })
    const checkoutRoot = join(root, '.matos', 'source-cache', 'git', 'matos-core-assets')
    const acceptedCommit = (
      await gitRepo(checkoutRoot, [
        'rev-parse',
        'accepted/matos-core-assets/stable',
      ])
    ).trim()
    expect(run?.sourceAcceptance?.[0]?.commit).toBe(acceptedCommit)
    const acceptedRole = await gitRepo(checkoutRoot, [
      'show',
      `${acceptedCommit}:packs/matos-core/roles/compute/ROLE.md`,
    ])
    expect(acceptedRole).toContain('Prefer local idle GPUs before remote queues.')
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(updatedConfig.assetSources?.[0]).toMatchObject({
      type: 'git',
      id: 'matos-core-assets',
      scope: 'core',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-core-assets/stable',
        commit: acceptedCommit,
      },
    })

    const rolledBack = await rollbackMatOSDirectAssetEditorRun({
      cwd: root,
      runId: 'direct-editor-core-gitea',
    })
    expect(rolledBack?.status).toBe('rolled_back')
    const rolledBackConfig = await readMatOSProjectConfig(root)
    expect(rolledBackConfig.assetSources?.[0]).toMatchObject({
      type: 'git',
      id: 'matos-core-assets',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/matos-core-assets/stable',
        commit: seedCommit,
      },
    })
    expect(
      (
        await gitRepo(checkoutRoot, [
          'rev-parse',
          'accepted/matos-core-assets/stable',
        ])
      ).trim(),
    ).toBe(seedCommit)
  })

  test('rolls back Gitea-backed accepted edits when source push is explicitly disabled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-core-gitea-unpushed-'))
    const seedRepo = join(root, 'seed-core-assets')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(seedRepo, { recursive: true })
    await writeGitCoreComputeRolePack({ repo: seedRepo })
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed core assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, [
      'branch',
      'accepted/matos-core-assets/stable',
      seedCommit,
    ])
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'matos-core-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/matos-core-assets/stable',
                commit: seedCommit,
              },
              scope: 'core',
              refresh: 'manual',
              provider: 'gitea',
              gitea: {
                owner: 'matos-core',
                repo: 'assets',
                visibility: 'internal',
                cloneUrl: seedRepo,
              },
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    const rolePath = await writeCoreComputeRole(root)
    const originalRole = await readFile(rolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nDo not mark unpushed accepted refs as accepted.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated core compute role without source push.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/roles/compute/ROLE.md',
          ],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-core-gitea-unpushed',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: { MATOS_DIRECT_EDITOR_GIT_SOURCE_PUSH: '0' },
    })

    expect(run?.status).toBe('rolled_back')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'matos-core-assets',
      pushed: false,
    })
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'matos-core-assets',
      ok: true,
      pushed: false,
    })
    expect(
      run?.sourceCommitErrors?.some(error =>
        error.error.includes('not pushed'),
      ),
    ).toBe(true)
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(gitAssetSourceAt(updatedConfig.assetSources, 0)?.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/matos-core-assets/stable',
      commit: seedCommit,
    })
  })

  test('restores previously pushed accepted refs when a later Gitea source fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-core-gitea-partial-'))
    const seedRepoA = join(root, 'seed-core-assets-a')
    const seedRepoB = join(root, 'seed-core-assets-b')
    await mkdir(join(root, '.matos'), { recursive: true })
    for (const repo of [seedRepoA, seedRepoB]) {
      await mkdir(repo, { recursive: true })
      await writeGitCoreComputeRolePack({ repo })
      await gitRepo(repo, ['init', '-b', 'main'])
      await gitRepo(repo, ['add', '.'])
      await gitRepo(repo, [
        '-c',
        'user.name=MatOS Test',
        '-c',
        'user.email=matos-test@localhost',
        'commit',
        '-m',
        'seed core assets',
      ])
    }
    const seedCommitA = (await gitRepo(seedRepoA, ['rev-parse', 'HEAD'])).trim()
    const seedCommitB = (await gitRepo(seedRepoB, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepoA, [
      'branch',
      'accepted/matos-core-assets-a/stable',
      seedCommitA,
    ])
    await gitRepo(seedRepoB, [
      'branch',
      'accepted/matos-core-assets-b/stable',
      seedCommitB,
    ])

    const sourceCacheRoot = join(root, '.matos', 'source-cache', 'git')
    const checkoutB = join(sourceCacheRoot, 'matos-core-assets-b')
    await mkdir(sourceCacheRoot, { recursive: true })
    await gitRepo(root, ['clone', seedRepoB, checkoutB])
    await gitRepo(checkoutB, ['checkout', '--detach', seedCommitB])
    await gitRepo(checkoutB, [
      'branch',
      'accepted/matos-core-assets-b/stable',
      seedCommitB,
    ])
    await gitRepo(checkoutB, [
      'remote',
      'set-url',
      'origin',
      join(root, 'missing-remote.git'),
    ])

    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'matos-core-assets-a',
              repo: seedRepoA,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/matos-core-assets-a/stable',
                commit: seedCommitA,
              },
              scope: 'core',
              refresh: 'manual',
              provider: 'gitea',
              gitea: {
                owner: 'matos-core',
                repo: 'assets-a',
                visibility: 'internal',
                cloneUrl: seedRepoA,
              },
            },
            {
              type: 'git',
              id: 'matos-core-assets-b',
              repo: seedRepoB,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/matos-core-assets-b/stable',
                commit: seedCommitB,
              },
              scope: 'core',
              refresh: 'manual',
              provider: 'gitea',
              gitea: {
                owner: 'matos-core',
                repo: 'assets-b',
                visibility: 'internal',
                cloneUrl: seedRepoB,
              },
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nDo not leave partially advanced Gitea accepted refs.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated core compute role across two sources.',
          modifiedFiles: [
            'matos-assets/packs/matos-core/roles/compute/ROLE.md',
          ],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-core-gitea-partial',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('rolled_back')
    expect(
      run?.sourceCommitErrors?.some(error =>
        error.sourceId === 'matos-core-assets-b',
      ),
    ).toBe(true)
    expect(
      (
        await gitRepo(seedRepoA, [
          'rev-parse',
          'accepted/matos-core-assets-a/stable',
        ])
      ).trim(),
    ).toBe(seedCommitA)
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(gitAssetSourceAt(updatedConfig.assetSources, 0)?.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/matos-core-assets-a/stable',
      commit: seedCommitA,
    })
    expect(gitAssetSourceAt(updatedConfig.assetSources, 1)?.runtimeRef).toMatchObject({
      mode: 'accepted-ref',
      ref: 'accepted/matos-core-assets-b/stable',
      commit: seedCommitB,
    })
  }, testTimeoutMs(15000))

  test('edits user scoped asset source without touching core assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-user-scope-'))
    const seedRepo = join(root, 'seed-user-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeUserComputeRole(join(seedRepo, 'matos-assets'))
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed user assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const userAssetRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'alice',
      'git',
      'alice-assets',
      'matos-assets',
    )
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'alice-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/alice-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    const coreRolePath = await writeCoreComputeRole(root)
    const originalCoreRole = await readFile(coreRolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      expect(input.cwd).not.toBe(root)
      expect(input.prompt).toContain(
        'For user, team, and project scopes, prefer bold scoped asset evolution',
      )
      expect(input.prompt).toContain(
        'Do not leave a reusable user-specific lesson only as an experience asset',
      )
      const isolatedUserRole = join(
        input.cwd,
        '.matos',
        'source-cache',
        'scopes',
        'users',
        'alice',
        'git',
        'alice-assets',
        'matos-assets',
        'packs',
        'user-alice',
        'roles',
        'compute',
        'ROLE.md',
      )
      expect(await exists(isolatedUserRole)).toBe(true)
      await Bun.write(
        isolatedUserRole,
        [
          '# User Compute',
          '',
          'Prefer this user workspace GPU policy before shared defaults.',
          '',
        ].join('\n'),
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated user scoped compute role.',
          modifiedFiles: [
            '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/roles/compute/ROLE.md',
          ],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      runId: 'direct-editor-user-scope',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: {
        MATOS_USER_ID: 'alice',
      },
    })

    expect(run?.status).toBe('accepted')
    expect(run?.scope).toBe('user')
    expect(run?.input.scopeRef).toBe('user:alice')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      action: 'committed',
      branch: 'evolution/direct-editor-user-scope',
      pushed: true,
    })
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      acceptedBranch: 'accepted/alice-assets/stable',
      ok: true,
      pushed: true,
      validationOk: true,
    })
    expect(run?.input.editableRoots).toEqual([
      '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
      '.matos/assets/generated/evolution/experiences',
      '.matos/assets/generated/scopes/users/alice',
    ])
    expect(run?.input.targetAssetCreationRoots).toEqual([
      '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
    ])
    expect(
      await readFile(
        join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'ROLE.md'),
        'utf8',
      ),
    ).toContain(
      'Prefer this user workspace GPU policy before shared defaults.',
    )
    expect(await gitRepo(dirname(userAssetRoot), ['log', '--oneline', '-1'])).toContain(
      'MatOS evolution direct-editor-user-scope',
    )
    const acceptedCommit = (
      await gitRepo(dirname(userAssetRoot), [
        'rev-parse',
        'accepted/alice-assets/stable',
      ])
    ).trim()
    expect(run?.sourceAcceptance?.[0]?.commit).toBe(acceptedCommit)
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(updatedConfig.assetSources?.[0]).toMatchObject({
      type: 'git',
      id: 'alice-assets',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: acceptedCommit,
      },
    })
    expect(await readFile(coreRolePath, 'utf8')).toBe(originalCoreRole)
    const afterSnapshot = run?.afterSnapshot
      ? await readMatOSAssetHistorySnapshot(root, run.afterSnapshot)
      : undefined
    expect(afterSnapshot?.scope).toBe('user')
    expect(
      afterSnapshot?.files.some(file =>
        file.path.endsWith(
          'matos-assets/packs/user-alice/roles/compute/ROLE.md',
        ),
      ),
    ).toBe(true)
  })

  test('edits team scoped asset source through Gitea acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-team-scope-'))
    const seedRepo = join(root, 'seed-team-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeScopedComputeRolePack(join(seedRepo, 'matos-assets'), 'team-alpha')
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed team assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/alpha-team-assets/stable', seedCommit])
    const teamAssetRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'teams',
      'alpha',
      'git',
      'alpha-team-assets',
      'matos-assets',
    )
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'alpha-team-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/alpha-team-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'team',
              scopeRef: 'team:alpha',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    const coreRolePath = await writeCoreComputeRole(root)
    const originalCoreRole = await readFile(coreRolePath, 'utf8')

    const teamRoleRelativePath =
      '.matos/source-cache/scopes/teams/alpha/git/alpha-team-assets/matos-assets/packs/team-alpha/roles/compute/ROLE.md'
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      expect(input.cwd).not.toBe(root)
      const isolatedTeamRole = join(input.cwd, teamRoleRelativePath)
      expect(await exists(isolatedTeamRole)).toBe(true)
      await Bun.write(
        isolatedTeamRole,
        '# Scoped Compute\n\nPrefer the team queue quota policy first.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated team scoped compute role.',
          modifiedFiles: [teamRoleRelativePath],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'team',
      scopeRef: 'team:alpha',
      runId: 'direct-editor-team-scope',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('accepted')
    expect(run?.scope).toBe('team')
    expect(run?.input.scopeRef).toBe('team:alpha')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'alpha-team-assets',
      action: 'committed',
      branch: 'evolution/direct-editor-team-scope',
      pushed: true,
    })
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'alpha-team-assets',
      acceptedBranch: 'accepted/alpha-team-assets/stable',
      ok: true,
      pushed: true,
      validationOk: true,
    })
    expect(
      await readFile(
        join(teamAssetRoot, 'packs', 'team-alpha', 'roles', 'compute', 'ROLE.md'),
        'utf8',
      ),
    ).toContain('Prefer the team queue quota policy first.')
    const acceptedCommit = (
      await gitRepo(dirname(teamAssetRoot), [
        'rev-parse',
        'accepted/alpha-team-assets/stable',
      ])
    ).trim()
    expect(run?.sourceAcceptance?.[0]?.commit).toBe(acceptedCommit)
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(updatedConfig.assetSources?.[0]).toMatchObject({
      id: 'alpha-team-assets',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alpha-team-assets/stable',
        commit: acceptedCommit,
      },
    })
    expect(await readFile(coreRolePath, 'utf8')).toBe(originalCoreRole)
    const afterSnapshot = run?.afterSnapshot
      ? await readMatOSAssetHistorySnapshot(root, run.afterSnapshot)
      : undefined
    expect(afterSnapshot?.scope).toBe('team')
  })

  test('edits project scoped asset source through Gitea acceptance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-project-scope-'))
    const seedRepo = join(root, 'seed-project-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeScopedComputeRolePack(join(seedRepo, 'matos-assets'), 'project-demo')
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed project assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/demo-project-assets/stable', seedCommit])
    const projectAssetRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'projects',
      'demo',
      'git',
      'demo-project-assets',
      'matos-assets',
    )
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'demo-project-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/demo-project-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'project',
              scopeRef: 'project:demo',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    const coreRolePath = await writeCoreComputeRole(root)
    const originalCoreRole = await readFile(coreRolePath, 'utf8')

    const projectRoleRelativePath =
      '.matos/source-cache/scopes/projects/demo/git/demo-project-assets/matos-assets/packs/project-demo/roles/compute/ROLE.md'
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      expect(input.cwd).not.toBe(root)
      const isolatedProjectRole = join(input.cwd, projectRoleRelativePath)
      expect(await exists(isolatedProjectRole)).toBe(true)
      await Bun.write(
        isolatedProjectRole,
        '# Scoped Compute\n\nPrefer the project convergence checklist first.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated project scoped compute role.',
          modifiedFiles: [projectRoleRelativePath],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'project',
      scopeRef: 'project:demo',
      runId: 'direct-editor-project-scope',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('accepted')
    expect(run?.scope).toBe('project')
    expect(run?.input.scopeRef).toBe('project:demo')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'demo-project-assets',
      action: 'committed',
      branch: 'evolution/direct-editor-project-scope',
      pushed: true,
    })
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'demo-project-assets',
      acceptedBranch: 'accepted/demo-project-assets/stable',
      ok: true,
      pushed: true,
      validationOk: true,
    })
    expect(
      await readFile(
        join(projectAssetRoot, 'packs', 'project-demo', 'roles', 'compute', 'ROLE.md'),
        'utf8',
      ),
    ).toContain('Prefer the project convergence checklist first.')
    const acceptedCommit = (
      await gitRepo(dirname(projectAssetRoot), [
        'rev-parse',
        'accepted/demo-project-assets/stable',
      ])
    ).trim()
    expect(run?.sourceAcceptance?.[0]?.commit).toBe(acceptedCommit)
    expect(await readFile(coreRolePath, 'utf8')).toBe(originalCoreRole)
    const afterSnapshot = run?.afterSnapshot
      ? await readMatOSAssetHistorySnapshot(root, run.afterSnapshot)
      : undefined
    expect(afterSnapshot?.scope).toBe('project')
  })

  test('blocks project scoped runs before editing when no project Gitea source is configured', async () => {
    // Regression for the production-shaped gap: project scope's `.matos/assets`
    // root always exists, so unlike user/team the writable-roots preflight
    // passes and the run previously burned the full editor/validation/judge
    // chain before the guaranteed acceptance rollback.
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-project-no-source-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')
    let roleRunnerInvoked = false
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async () => {
      roleRunnerInvoked = true
      throw new Error('editor must not run without an acceptable Gitea source')
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'project',
      scopeRef: 'project:demo',
      runId: 'direct-editor-project-no-source',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(roleRunnerInvoked).toBe(false)
    expect(run?.status).toBe('blocked')
    expect(run?.statusReason).toBe('direct_editor_scoped_source_unavailable')
    expect(run?.stderr).toContain(
      'Gitea source acceptance is required for scope project (project:demo)',
    )
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  })

  test('recovers interrupted user scoped direct edits through semantic acceptance and accepted Gitea ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-recover-user-source-'))
    const seedRepo = join(root, 'seed-user-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeUserComputeRole(join(seedRepo, 'matos-assets'))
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed user assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const userAssetRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'alice',
      'git',
      'alice-assets',
      'matos-assets',
    )
    const checkoutRoot = dirname(userAssetRoot)
    await mkdir(dirname(checkoutRoot), { recursive: true })
    await gitRepo(root, ['clone', seedRepo, checkoutRoot])
    await gitRepo(checkoutRoot, ['checkout', '--detach', seedCommit])
    await gitRepo(checkoutRoot, [
      'branch',
      'accepted/alice-assets/stable',
      seedCommit,
    ])
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'alice-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/alice-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    const coreRolePath = await writeCoreComputeRole(root)
    const originalCoreRole = await readFile(coreRolePath, 'utf8')
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'user',
    })
    const knowledgeDir = join(
      userAssetRoot,
      'packs',
      'user-alice',
      'knowledge',
      'vasp-pseudopotential-preflight',
    )
    await Bun.write(
      join(knowledgeDir, 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'vasp-pseudopotential-preflight',
          type: 'knowledge',
          name: 'VASP pseudopotential preflight',
          version: '0.1.0',
          description:
            'Check VASP pseudopotential family and folder layout before remote jobs.',
          entry: 'KNOWLEDGE.md',
          tags: ['vasp', 'pseudopotential', 'preflight'],
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(knowledgeDir, 'KNOWLEDGE.md'),
      [
        '# VASP pseudopotential preflight',
        '',
        'Before submitting remote VASP jobs, inspect the configured POTCAR family.',
        'Do not assume PBE_54 files live under an older PBE folder name.',
        '',
      ].join('\n'),
    )
    const runId = 'direct-editor-interrupted-user-source'
    await Bun.write(
      join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'validated',
          statusReason: 'semantic_acceptance_passed_pending_source_acceptance',
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:01.000Z',
          scope: 'user',
          beforeSnapshot: before.snapshotId,
          input: {
            generatedAt: '2026-06-05T00:00:00.000Z',
            scope: 'user',
            scopeRef: 'user:alice',
            editableRoots: [
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
              '.matos/assets/generated/evolution/experiences',
              '.matos/assets/generated/scopes/users/alice',
            ],
            targetAssetCreationRoots: [
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
            ],
            experiences: [],
            targetAssets: [],
            targetContract: {
              schemaVersion: 1,
              mode: 'advisory',
              expectedTypes: ['knowledge'],
              preferredRefs: [],
              roleFallbackAllowed: false,
              reason: 'Recover a VASP pseudopotential preflight lesson.',
              source: 'explicit',
            },
          },
          editorOutput: {
            summary: 'Created VASP pseudopotential preflight knowledge.',
            modifiedFiles: [
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/asset.json',
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/KNOWLEDGE.md',
            ],
            createdAssets: [
              'knowledge:vasp-pseudopotential-preflight@0.1.0',
            ],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [
              'experience:alice-vasp-pseudopotential-path-discovery@0.1.0',
            ],
          },
          modifiedFiles: [
            '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/asset.json',
            '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/KNOWLEDGE.md',
          ],
          createdAssets: ['knowledge:vasp-pseudopotential-preflight@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [
            'experience:alice-vasp-pseudopotential-path-discovery@0.1.0',
          ],
          roleExitCode: 0,
        },
        null,
        2,
      )}\n`,
    )

    const run = await recoverInterruptedMatOSDirectAssetEditorRun({
      cwd: root,
      runId,
      semanticJudge: acceptSemanticJudge,
      env: { MATOS_USER_ID: 'alice' },
    })

    expect(run?.status).toBe('accepted')
    expect(run?.statusReason).toBe('interrupted_finalize_recovered')
    expect(run?.semanticAcceptance?.verdict).toBe('accept')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      action: 'committed',
      branch: `evolution/${runId}`,
      pushed: true,
    })
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      acceptedBranch: 'accepted/alice-assets/stable',
      ok: true,
      pushed: true,
      validationOk: true,
    })
    const acceptedCommit = (
      await gitRepo(checkoutRoot, ['rev-parse', 'accepted/alice-assets/stable'])
    ).trim()
    expect(run?.sourceAcceptance?.[0]?.commit).toBe(acceptedCommit)
    expect(acceptedCommit).not.toBe(seedCommit)
    const acceptedKnowledge = await gitRepo(checkoutRoot, [
      'show',
      `${acceptedCommit}:matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/KNOWLEDGE.md`,
    ])
    expect(acceptedKnowledge).toContain('Do not assume PBE_54')
    const updatedConfig = await readMatOSProjectConfig(root)
    expect(updatedConfig.assetSources?.[0]).toMatchObject({
      type: 'git',
      id: 'alice-assets',
      runtimeRef: {
        mode: 'accepted-ref',
        ref: 'accepted/alice-assets/stable',
        commit: acceptedCommit,
      },
    })

    const alreadyAcceptedRunId =
      'direct-editor-interrupted-user-source-already-accepted'
    await Bun.write(
      join(
        root,
        '.matos',
        'evolution',
        'direct-editor',
        'runs',
        alreadyAcceptedRunId,
        'run.json',
      ),
      `${JSON.stringify(
        {
          runId: alreadyAcceptedRunId,
          status: 'validated',
          statusReason: 'semantic_acceptance_passed_pending_source_acceptance',
          createdAt: '2026-06-05T00:00:02.000Z',
          updatedAt: '2026-06-05T00:00:03.000Z',
          scope: 'user',
          beforeSnapshot: before.snapshotId,
          input: {
            generatedAt: '2026-06-05T00:00:02.000Z',
            scope: 'user',
            scopeRef: 'user:alice',
            editableRoots: [
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
            ],
            targetAssetCreationRoots: [
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets',
            ],
            experiences: [],
            targetAssets: [],
            targetContract: {
              schemaVersion: 1,
              mode: 'advisory',
              expectedTypes: ['knowledge'],
              preferredRefs: [],
              roleFallbackAllowed: false,
              reason:
                'Recover a direct-editor run after the Gitea accepted ref already advanced.',
              source: 'explicit',
            },
          },
          editorOutput: {
            summary:
              'Created VASP pseudopotential preflight knowledge before process shutdown.',
            modifiedFiles: [
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/asset.json',
              '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/KNOWLEDGE.md',
            ],
            createdAssets: [
              'knowledge:vasp-pseudopotential-preflight@0.1.0',
            ],
            updatedAssets: [],
            disabledAssets: [],
            evidenceRefs: [
              'experience:alice-vasp-pseudopotential-path-discovery@0.1.0',
            ],
          },
          modifiedFiles: [
            '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/asset.json',
            '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/knowledge/vasp-pseudopotential-preflight/KNOWLEDGE.md',
          ],
          createdAssets: ['knowledge:vasp-pseudopotential-preflight@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: [
            'experience:alice-vasp-pseudopotential-path-discovery@0.1.0',
          ],
          roleExitCode: 0,
        },
        null,
        2,
      )}\n`,
    )
    const alreadyAcceptedRun = await recoverInterruptedMatOSDirectAssetEditorRun({
      cwd: root,
      runId: alreadyAcceptedRunId,
      semanticJudge: acceptSemanticJudge,
      env: { MATOS_USER_ID: 'alice' },
    })
    expect(alreadyAcceptedRun?.status).toBe('accepted')
    expect(alreadyAcceptedRun?.sourceCommits).toBeUndefined()
    expect(alreadyAcceptedRun?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      acceptedBranch: 'accepted/alice-assets/stable',
      commit: acceptedCommit,
      ok: true,
      pushed: false,
      validationOk: true,
    })
    expect(
      (
        await gitRepo(checkoutRoot, [
          'rev-parse',
          'accepted/alice-assets/stable',
        ])
      ).trim(),
    ).toBe(acceptedCommit)
    expect(await readFile(coreRolePath, 'utf8')).toBe(originalCoreRole)
    // A crash journal must retain the original remote lease even when a
    // resumed validation rejects before it reaches the publishing function.
    const pushedRunId = 'direct-editor-interrupted-pushed-rejected'
    await Bun.write(join(root, '.matos/evolution/direct-editor/runs', pushedRunId, 'run.json'), JSON.stringify({
      ...run, runId: pushedRunId, status: 'validated',
      statusReason: 'accepted_ref_pushed_pending_runtime_confirmation', algorithmOutcomeRecorded: false,
    }))
    const rejected = await recoverInterruptedMatOSDirectAssetEditorRun({
      cwd: root, runId: pushedRunId, env: { MATOS_USER_ID: 'alice' },
      semanticJudge: async input => ({ ...await acceptSemanticJudge(input), verdict: 'rollback', reason: 'Recovery evidence no longer supports publication.' }),
    })
    expect(rejected?.status).toBe('rolled_back')
    expect((await gitRepo(seedRepo, ['rev-parse', 'accepted/alice-assets/stable'])).trim()).toBe(seedCommit)
    expect((await readMatOSProjectConfig(root)).assetSources?.[0]).toMatchObject({ runtimeRef: { commit: seedCommit } })
  }, testTimeoutMs(15000))

  test('blocks interrupted recovery when unrelated dirty asset files are present', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-editor-recover-dirty-'))
    await writeProjectConfig(root)
    await writeHiddenCoreRole(root)
    const rolePath = await writeCoreComputeRole(root)
    const assetPath = coreComputeAssetPath(root)
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'core',
    })
    await Bun.write(
      rolePath,
      '# Compute\n\nPrefer the tested local GPU before remote queues.\n',
    )
    await Bun.write(
      assetPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          description: 'Unrelated dirty description.',
          entry: 'ROLE.md',
          tags: ['compute'],
        },
        null,
        2,
      )}\n`,
    )
    const runId = 'direct-editor-interrupted-extra-dirty'
    await Bun.write(
      join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'validated',
          statusReason: 'semantic_acceptance_passed_pending_source_acceptance',
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:01.000Z',
          scope: 'core',
          beforeSnapshot: before.snapshotId,
          input: {
            generatedAt: '2026-06-05T00:00:00.000Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experiences: [],
            targetAssets: [],
            targetContract: {
              schemaVersion: 1,
              mode: 'advisory',
              expectedTypes: ['role'],
              preferredRefs: ['role:compute@0.1.0'],
              roleFallbackAllowed: true,
              reason: 'Recover only the declared compute role prompt edit.',
              source: 'explicit',
            },
          },
          editorOutput: {
            summary: 'Updated compute role queue guidance.',
            modifiedFiles: [
              'matos-assets/packs/matos-core/roles/compute/ROLE.md',
            ],
            createdAssets: [],
            updatedAssets: ['role:compute@0.1.0'],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          roleExitCode: 0,
        },
        null,
        2,
      )}\n`,
    )
    let judgeCalled = false
    const blocked = await recoverInterruptedMatOSDirectAssetEditorRun({
      cwd: root,
      runId,
      semanticJudge: async input => {
        judgeCalled = true
        return acceptSemanticJudge(input)
      },
    })

    expect(blocked?.status).toBe('blocked')
    expect(blocked?.statusReason).toBe(
      'interrupted_finalize_recovery_unexpected_dirty_files',
    )
    expect(judgeCalled).toBe(false)
    expect(blocked?.afterSnapshot).toBeUndefined()
    expect(blocked?.dirtyFilesAtStart).toContain(
      'matos-assets/packs/matos-core/roles/compute/ROLE.md',
    )
    expect(blocked?.dirtyFilesAtStart).toContain(
      'matos-assets/packs/matos-core/roles/compute/asset.json',
    )
    expect(blocked?.stderr).toContain('Unexpected changed files')
    expect(await readFile(assetPath, 'utf8')).toContain(
      'Unrelated dirty description',
    )
  })

  test('recovery rollback preserves concurrent third-party writes outside the persisted touched paths', async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'matos-direct-editor-recover-third-party-'),
    )
    await writeProjectConfig(root)
    await writeHiddenCoreRole(root)
    const rolePath = await writeCoreComputeRole(root)
    const assetPath = coreComputeAssetPath(root)
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'core',
    })
    // The interrupted run edited only ROLE.md before dying.
    await Bun.write(
      rolePath,
      '# Compute\n\nPrefer the tested local GPU before remote queues.\n',
    )
    const runId = 'direct-editor-interrupted-third-party'
    await Bun.write(
      join(root, '.matos', 'evolution', 'direct-editor', 'runs', runId, 'run.json'),
      `${JSON.stringify(
        {
          runId,
          status: 'validated',
          statusReason: 'semantic_acceptance_passed_pending_source_acceptance',
          createdAt: '2026-06-05T00:00:00.000Z',
          updatedAt: '2026-06-05T00:00:01.000Z',
          scope: 'core',
          beforeSnapshot: before.snapshotId,
          // Import machinery checkpoint: the only path this run actually wrote.
          importedTouchedPaths: [
            'matos-assets/packs/matos-core/roles/compute/ROLE.md',
          ],
          input: {
            generatedAt: '2026-06-05T00:00:00.000Z',
            scope: 'core',
            editableRoots: ['matos-assets/packs/matos-core'],
            experiences: [],
            targetAssets: [],
            targetContract: {
              schemaVersion: 1,
              mode: 'advisory',
              expectedTypes: ['role'],
              preferredRefs: ['role:compute@0.1.0'],
              roleFallbackAllowed: true,
              reason: 'Recover only the declared compute role prompt edit.',
              source: 'explicit',
            },
          },
          editorOutput: {
            summary: 'Updated compute role queue guidance.',
            modifiedFiles: [
              'matos-assets/packs/matos-core/roles/compute/ROLE.md',
            ],
            createdAssets: [],
            updatedAssets: ['role:compute@0.1.0'],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          roleExitCode: 0,
        },
        null,
        2,
      )}\n`,
    )
    const foreignDescription =
      'Concurrent workbench save landed while the recovery judge deliberated.'
    let sawJudge = false
    const recovered = await recoverInterruptedMatOSDirectAssetEditorRun({
      cwd: root,
      runId,
      semanticJudge: async input => {
        sawJudge = true
        // Simulate a concurrent third-party writer landing while the judge
        // runs (minutes in production): it edits a core file the interrupted
        // run never touched, after the unexpected-dirty-files gate already
        // passed.
        await Bun.write(
          assetPath,
          `${JSON.stringify(
            {
              schemaVersion: 1,
              id: 'compute',
              type: 'role',
              name: 'Compute',
              version: '0.1.0',
              description: foreignDescription,
              entry: 'ROLE.md',
              overlayOf: 'role:compute@0.1.0',
              tags: ['compute'],
            },
            null,
            2,
          )}\n`,
        )
        return {
          ...(await acceptSemanticJudge(input)),
          verdict: 'rollback',
          confidence: 0.9,
          reason: 'Not enough evidence that the queue guidance generalizes.',
          resolvedUserProblem: false,
        }
      },
    })

    expect(sawJudge).toBe(true)
    expect(recovered?.status).toBe('rolled_back')
    expect(recovered?.statusReason).toBe(
      'interrupted_finalize_recovered_semantic_rejected',
    )
    // The run's own edit was rolled back to the before snapshot...
    const restoredRole = await readFile(rolePath, 'utf8')
    expect(restoredRole).toContain('Choose remote queues.')
    expect(restoredRole).not.toContain('Prefer the tested local GPU')
    // ...but the concurrent foreign write outside the persisted touched set
    // survived. The legacy whole-tree restore reverted it to the before
    // snapshot, silently erasing the third party's work.
    expect(await readFile(assetPath, 'utf8')).toContain(foreignDescription)
  })

  test('re-applies accepted after snapshot before committing scoped git sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-user-source-reset-'))
    const seedRepo = join(root, 'seed-user-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeUserComputeRole(join(seedRepo, 'matos-assets'))
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed user assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const userAssetRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'alice',
      'git',
      'alice-assets',
      'matos-assets',
    )
    const checkoutRoot = dirname(userAssetRoot)
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'alice-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/alice-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const isolatedUserRole = join(
        input.cwd,
        '.matos',
        'source-cache',
        'scopes',
        'users',
        'alice',
        'git',
        'alice-assets',
        'matos-assets',
        'packs',
        'user-alice',
        'roles',
        'compute',
        'ROLE.md',
      )
      await Bun.write(
        isolatedUserRole,
        [
          '# User Compute',
          '',
          'Prefer local idle GPUs and record the remote preflight result.',
          '',
        ].join('\n'),
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated user scoped compute role.',
          modifiedFiles: [
            '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/roles/compute/ROLE.md',
          ],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => {
      expect(input.modifiedFiles).toContain(
        '.matos/source-cache/scopes/users/alice/git/alice-assets/matos-assets/packs/user-alice/roles/compute/ROLE.md',
      )
      // Simulate a real judge/runtime path that materializes accepted source
      // state while judging. The direct-editor must restore the accepted after
      // snapshot before source commit, otherwise the source commit becomes noop.
      await gitRepo(checkoutRoot, ['reset', '--hard', seedCommit])
      return acceptSemanticJudge(input)
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      runId: 'direct-editor-user-source-reset',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge,
      env: {
        MATOS_USER_ID: 'alice',
      },
    })

    expect(run?.status).toBe('accepted')
    expect(run?.sourceCommits?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      action: 'committed',
      branch: 'evolution/direct-editor-user-source-reset',
      pushed: true,
    })
    expect(run?.sourceCommits?.[0]?.commit).not.toBe(seedCommit)
    expect(run?.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'alice-assets',
      acceptedBranch: 'accepted/alice-assets/stable',
      ok: true,
      pushed: true,
      validationOk: true,
    })
    expect(
      await readFile(
        join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'ROLE.md'),
        'utf8',
      ),
    ).toContain('record the remote preflight result')
    const acceptedCommit = (
      await gitRepo(checkoutRoot, ['rev-parse', 'accepted/alice-assets/stable'])
    ).trim()
    expect(acceptedCommit).toBe(run?.sourceCommits?.[0]?.commit)
  })

  test('accepts generated-only experience edits without a scoped Gitea source commit', async () => {
    // Regression for real user runs (two user scopes, 2026-07):
    // a user-scope run whose accepted changes live entirely in the local
    // generated experience tree must not be rolled back by the
    // noop-source-checkout guard or the gitea-native acceptance requirement.
    const root = await mkdtemp(
      join(tmpdir(), 'matos-direct-asset-editor-generated-only-'),
    )
    const seedRepo = join(root, 'seed-user-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeUserComputeRole(join(seedRepo, 'matos-assets'))
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed user assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    const checkoutRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'users',
      'alice',
      'git',
      'alice-assets',
    )
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'alice-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/alice-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const experienceLogicalDir =
      '.matos/assets/generated/evolution/experiences/remote-queue-fallback'
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const isolatedDir = join(input.cwd, experienceLogicalDir)
      await Bun.write(
        join(isolatedDir, 'asset.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: 'remote-queue-fallback',
            type: 'experience',
            name: 'Remote queue fallback',
            version: '0.1.0',
            description: 'Fall back to remote queues when local GPUs are busy.',
            entry: 'EXPERIENCE.md',
            tags: ['generated', 'learning', 'draft', 'experience'],
            metadata: {
              sourceFormat: 'matos-experience-llm-v1',
              mergeKey: 'compute:queue-selection:remote-fallback',
              recommendedActions: [
                'Use remote queues when local GPUs stay busy for 10 minutes.',
              ],
              scenario: {
                domain: 'compute',
                taskType: 'resource-selection',
                failureMode: 'local-gpu-busy',
              },
              evidenceRefs: ['trace:remote-queue-fallback-test'],
            },
          },
          null,
          2,
        )}\n`,
      )
      await Bun.write(
        join(isolatedDir, 'EXPERIENCE.md'),
        [
          '# Remote queue fallback',
          '',
          'Fall back to remote queues when local GPUs stay busy.',
          '',
        ].join('\n'),
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Recorded remote queue fallback experience evidence.',
          modifiedFiles: [
            `${experienceLogicalDir}/asset.json`,
            `${experienceLogicalDir}/EXPERIENCE.md`,
          ],
          createdAssets: ['experience:remote-queue-fallback@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      runId: 'direct-editor-generated-only-experience',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: {
        MATOS_USER_ID: 'alice',
      },
    })

    expect(run?.status).toBe('accepted')
    expect(run?.sourceCommitErrors ?? []).toEqual([])
    expect(run?.sourceCommits ?? []).toEqual([])
    // The untouched user source checkout must stay on the accepted commit.
    expect((await gitRepo(checkoutRoot, ['rev-parse', 'HEAD'])).trim()).toBe(
      seedCommit,
    )
    expect(
      await readFile(join(root, experienceLogicalDir, 'EXPERIENCE.md'), 'utf8'),
    ).toContain('Fall back to remote queues')
  })

  test('scoped prompt treats low-risk experience-only feedback as edit-eligible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-scoped-prompt-'))
    const userAssetRoot = join(root, 'user-assets')
    await mkdir(join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute'), {
      recursive: true,
    })
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: '../user-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          entry: 'ROLE.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'ROLE.md'),
      '# User Compute\n\nChoose remote queues.\n',
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No edit in prompt-only test.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'direct-editor-scoped-experience-only-prompt',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        events: [
          {
            id: 'turn-owned-feedback',
            sessionId: 'session-owned-feedback',
            sourcePath: join(root, 'session-owned-feedback.jsonl'),
            timestamp: new Date(0).toISOString(),
            type: 'matos.turn.started',
            scopeRef: 'user:alice',
            data: {
              scopeRef: 'user:alice',
              prompt: '我自己的 compute 任务优先用本地 GPU',
            },
          },
        ],
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'User-scoped local GPU preference is low risk.',
          signals: [
            {
              id: 'scoped-experience-only',
              kind: 'preference',
              severity: 'medium',
              explicitness: 'implicit',
              claim: 'Prefer local GPUs for this user.',
              target: {
                assetTypes: ['role'],
                roleRefs: ['role:compute'],
                toolNames: [],
                workflowRefs: [],
              },
              evidenceExcerpt: '我自己的 compute 任务优先用本地 GPU',
              sourceEventRefs: ['event:turn-owned-feedback'],
              confidence: 0.9,
            },
          ],
          decisions: [
            {
              signalId: 'scoped-experience-only',
              reasonableness: 'plausible',
              evidenceSupport: 'supported',
              generalizability: 'one_off',
              risk: 'low',
              recommendedAction: 'experience_only',
              why: 'The critic was conservative, but this is scoped and low risk.',
              counterArguments: [],
              confidence: 0.75,
            },
          ],
        },
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      // Prompt-composition test over a local-only source: opt out of the
      // Gitea acceptance requirement so the editor actually runs.
      env: { MATOS_DIRECT_EDITOR_REQUIRE_GITEA_SOURCE_ACCEPTANCE: '0' },
    })

    expect(run?.status).toBe('noop')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).toContain(
      'For scoped assets, experience_only and one_off feedback are not automatic blockers',
    )
    expect(calls[0]?.prompt).toContain('targetAssetCreationRoots')
    const promptInput = JSON.parse(calls[0]?.prompt.split('Input JSON:\n')[1] ?? '{}')
    expect(promptInput.targetAssetCreationRoots).toEqual(['user-assets'])
    expect(promptInput.targetAssetCreationRoots).not.toContain(
      '.matos/assets/generated/scopes/users/alice',
    )
    expect(calls[0]?.prompt).toContain('Target contract:')
    expect(calls[0]?.prompt).toContain('"preferredRefs": [')
    expect(calls[0]?.prompt).toContain('"role:compute"')
    expect(calls[0]?.prompt).not.toContain(
      'Only directly encode user feedback when a critic decision recommends direct_edit',
    )
  })

  test('retries Gitea source acceptance failures with source-root guidance', () => {
    const feedback = buildPreviousAttemptFromRecord(
      {
        status: 'rolled_back',
        roleExitCode: 0,
        editorOutput: {
          summary: 'Created skill in generated root.',
          modifiedFiles: [
            '.matos/assets/generated/scopes/users/alice/evolution/skills/preflight/asset.json',
          ],
          createdAssets: ['skill:preflight@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:preflight@0.1.0'],
        },
        rollback: {
          reason:
            'Gitea-backed source acceptance failed: no matching Gitea asset source accepted ref was advanced.',
        },
      } as never,
      1,
    )

    expect(feedback).toMatchObject({
      attempt: 1,
      rejectionStage: 'unknown',
    })
    expect(feedback?.reason).toContain('targetAssetCreationRoots')
    expect(feedback?.reason).toContain('.matos/source-cache')
    expect(feedback?.reason).toContain('Do not create new target assets under .matos/assets/generated')
  })

  test('scoped prompt teaches overlayOf forks for read-only core assets', async () => {
    // Users own a per-scope fork path for core/shared/global assets: the
    // editor must be told to copy the full original from the read-only core
    // pack and mark the scoped copy with metadata.overlayOf so it wins
    // resolution only inside this scope.
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-overlay-prompt-'))
    const userAssetRoot = join(root, 'user-assets')
    await mkdir(join(userAssetRoot, 'packs', 'user-alice'), { recursive: true })
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: '../user-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeCoreComputeRole(root)

    const input = await buildPromptInput({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'direct-editor-overlay-prompt',
    })
    const prompt = directEditorPrompt(input)

    expect(prompt).toContain('metadata.overlayOf')
    expect(prompt).toContain('matos-assets/packs/matos-core')
    expect(prompt).toContain('wins resolution only inside this scope')
    expect(prompt).toContain('fail validation as a duplicate')

    // Core scope runs edit core directly; the fork guidance is scoped-only.
    const coreInput = await buildPromptInput({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-overlay-prompt-core',
    })
    expect(directEditorPrompt(coreInput)).not.toContain('metadata.overlayOf')
  })

  test('scoped prompt does not target implicit experience-only feedback from another owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-scoped-negative-prompt-'))
    const userAssetRoot = join(root, 'user-assets')
    await mkdir(join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute'), {
      recursive: true,
    })
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: '../user-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          entry: 'ROLE.md',
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'ROLE.md'),
      '# User Compute\n\nChoose remote queues.\n',
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const calls: EvolutionRoleInvocationInput[] = []
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      calls.push(input)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'No edit in negative prompt-only test.',
          modifiedFiles: [],
          createdAssets: [],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'direct-editor-scoped-experience-only-negative-prompt',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        events: [
          {
            id: 'turn-other-owner-feedback',
            sessionId: 'session-other-owner-feedback',
            sourcePath: join(root, 'session-other-owner-feedback.jsonl'),
            timestamp: new Date(0).toISOString(),
            type: 'matos.turn.started',
            scopeRef: 'user:bob',
            data: {
              scopeRef: 'user:bob',
              prompt: '这个聊天格式看起来怪怪的。',
            },
          },
        ],
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'Implicit feedback from another owner should not target Alice assets.',
          signals: [
            {
              id: 'other-owner-implicit-experience-only',
              kind: 'frustration',
              severity: 'medium',
              explicitness: 'implicit',
              claim: 'The user may dislike compute chat formatting.',
              target: {
                assetTypes: ['role'],
                roleRefs: ['role:compute'],
                toolNames: [],
                workflowRefs: [],
              },
              evidenceExcerpt: '这个聊天格式看起来怪怪的。',
              sourceEventRefs: ['event:turn-other-owner-feedback'],
              confidence: 0.7,
            },
          ],
          decisions: [
            {
              signalId: 'other-owner-implicit-experience-only',
              reasonableness: 'plausible',
              evidenceSupport: 'partially_supported',
              generalizability: 'one_off',
              risk: 'low',
              recommendedAction: 'experience_only',
              why: 'Implicit non-owner feedback is not enough to edit scoped assets.',
              counterArguments: [],
              confidence: 0.74,
            },
          ],
        },
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      // Prompt-composition test over a local-only source: opt out of the
      // Gitea acceptance requirement so the editor actually runs.
      env: { MATOS_DIRECT_EDITOR_REQUIRE_GITEA_SOURCE_ACCEPTANCE: '0' },
    })

    expect(run?.status).toBe('noop')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.prompt).not.toContain('Target contract:')
    const promptInput = JSON.parse(calls[0]?.prompt.split('Input JSON:\n')[1] ?? '{}')
    expect(promptInput.targetContract).toBeUndefined()
  })

  test('allows critic-routed scoped feedback to create the first user asset without a legacy experience', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-empty-user-source-'))
    const userAssetRoot = join(root, 'user-assets')
    await mkdir(userAssetRoot, { recursive: true })
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: '../user-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const assetDir = join(
        input.cwd,
        'user-assets',
        'packs',
        'user-alice',
        'knowledge',
        'local-gpu-preference',
      )
      await Bun.write(
        join(assetDir, 'asset.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: 'local-gpu-preference',
            type: 'knowledge',
            name: 'Local GPU Preference',
            version: '0.1.0',
            description: 'User scoped compute preference.',
            entry: 'KNOWLEDGE.md',
            lifecycle: {
              status: 'draft',
            },
            metadata: {
              lifecycle: 'draft',
              evidenceRefs: ['event:user-feedback-local-gpu'],
            },
          },
          null,
          2,
        )}\n`,
      )
      await Bun.write(
        join(assetDir, 'KNOWLEDGE.md'),
        '# Local GPU Preference\n\nPrefer local idle GPUs before remote queues for alice.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Created first user scoped compute preference knowledge asset.',
          modifiedFiles: [
            'user-assets/packs/user-alice/knowledge/local-gpu-preference/asset.json',
            'user-assets/packs/user-alice/knowledge/local-gpu-preference/KNOWLEDGE.md',
          ],
          createdAssets: ['knowledge:local-gpu-preference@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['event:user-feedback-local-gpu'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'direct-editor-empty-user-source',
      evolutionContext: {
        trigger: {
          kind: 'user-feedback',
          key: 'user-feedback:user-feedback-local-gpu',
          eventId: 'user-feedback-local-gpu',
          summary: 'Alice asked MatOS to preserve a reusable local GPU preference.',
        },
        events: [
          {
            id: 'user-feedback-local-gpu',
            sessionId: 'session-alice',
            sourcePath: join(root, 'session-alice.jsonl'),
            timestamp: new Date(0).toISOString(),
            type: 'matos.turn.started',
            scopeRef: 'user:alice',
            data: {
              scopeRef: 'user:alice',
              prompt: 'For my compute tasks, prefer an idle local GPU before remote queues.',
            },
          },
        ],
        feedbackAnalysis: {
          schemaVersion: 1,
          shouldUseFeedback: true,
          summary: 'The explicit user preference is reusable and low risk.',
          signals: [
            {
              id: 'feedback-local-gpu',
              kind: 'preference',
              severity: 'medium',
              explicitness: 'explicit',
              claim: 'Prefer an idle local GPU before remote queues.',
              target: {
                assetTypes: ['knowledge'],
                assetRefs: ['knowledge:local-gpu-preference'],
                roleRefs: ['role:compute'],
                toolNames: [],
                workflowRefs: [],
              },
              evidenceExcerpt:
                'For my compute tasks, prefer an idle local GPU before remote queues.',
              sourceEventRefs: ['event:user-feedback-local-gpu'],
              confidence: 0.95,
            },
          ],
          decisions: [
            {
              signalId: 'feedback-local-gpu',
              reasonableness: 'strong',
              evidenceSupport: 'supported',
              generalizability: 'role_specific',
              risk: 'low',
              recommendedAction: 'direct_edit',
              why: 'This belongs in a user-scoped knowledge asset.',
              counterArguments: [],
              confidence: 0.93,
            },
          ],
        },
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: { MATOS_DIRECT_EDITOR_REQUIRE_GITEA_SOURCE_ACCEPTANCE: '0' },
    })

    expect(run?.status).toBe('accepted')
    expect(run?.input.experiences).toEqual([])
    expect(run?.input.targetContract?.expectedTypes).toContain('knowledge')
    expect(run?.input.targetContract).toMatchObject({
      source: 'feedback',
      roleFallbackAllowed: false,
    })
    expect(run?.input.targetContract?.preferredRefs).toContain(
      'knowledge:local-gpu-preference',
    )
    expect(run?.input.targetAssets).toEqual([])
    expect(run?.createdAssets).toEqual(['knowledge:local-gpu-preference@0.1.0'])
    const promotedAsset = JSON.parse(
      await readFile(
        join(
          userAssetRoot,
          'packs',
          'user-alice',
          'knowledge',
          'local-gpu-preference',
          'asset.json',
        ),
        'utf8',
      ),
    ) as { lifecycle?: { status?: string }; metadata?: { lifecycle?: string } }
    expect(promotedAsset.lifecycle?.status).toBe('enabled')
    expect(promotedAsset.metadata?.lifecycle).toBe('enabled')
    expect(
      await readFile(
        join(
          userAssetRoot,
          'packs',
          'user-alice',
          'knowledge',
          'local-gpu-preference',
          'KNOWLEDGE.md',
        ),
        'utf8',
      ),
    ).toContain('Prefer local idle GPUs')
  })

  test('relocates scoped runtime assets created under generated evidence roots into the source root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-generated-runtime-block-'))
    const userAssetRoot = join(root, 'user-assets')
    await mkdir(userAssetRoot, { recursive: true })
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: '../user-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      const generatedSkillDir = join(
        input.cwd,
        '.matos',
        'assets',
        'generated',
        'scopes',
        'users',
        'alice',
        'evolution',
        'skills',
        'bad-preflight',
      )
      await mkdir(generatedSkillDir, { recursive: true })
      await Bun.write(
        join(generatedSkillDir, 'asset.json'),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            id: 'bad-preflight',
            type: 'skill',
            name: 'Bad Preflight',
            version: '0.1.0',
            entry: 'SKILL.md',
            lifecycle: { status: 'draft' },
          },
          null,
          2,
        )}\n`,
      )
      await Bun.write(
        join(generatedSkillDir, 'SKILL.md'),
        '# Bad Preflight\n\nThis should have been created in the user asset source.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Created a runtime skill in the generated evidence root.',
          modifiedFiles: [
            '.matos/assets/generated/scopes/users/alice/evolution/skills/bad-preflight/asset.json',
            '.matos/assets/generated/scopes/users/alice/evolution/skills/bad-preflight/SKILL.md',
          ],
          createdAssets: ['skill:bad-preflight@0.1.0'],
          updatedAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    let judgeCalls = 0
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => {
      judgeCalls += 1
      return acceptSemanticJudge(input)
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'direct-editor-generated-runtime-block',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge,
      env: {
        MATOS_DIRECT_EDITOR_REQUIRE_GITEA_SOURCE_ACCEPTANCE: '0',
        MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1',
      },
    })

    expect(judgeCalls).toBe(1)
    expect(run?.status).toBe('accepted')
    expect(run?.createdAssets).toEqual(['skill:bad-preflight@0.1.0'])
    expect(
      await exists(
        join(
          root,
          '.matos',
          'assets',
          'generated',
          'scopes',
          'users',
          'alice',
          'evolution',
          'skills',
          'bad-preflight',
          'asset.json',
        ),
      ),
    ).toBe(false)
    expect(
      await exists(join(userAssetRoot, 'skill', 'bad-preflight', 'asset.json')),
    ).toBe(true)
    expect(
      await readFile(join(userAssetRoot, 'skill', 'bad-preflight', 'SKILL.md'), 'utf8'),
    ).toContain('created in the user asset source')
  })

  test('blocks scoped user edits before editing without a Gitea accepted source by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-user-no-gitea-'))
    const userAssetRoot = join(root, 'user-assets')
    await mkdir(join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute'), {
      recursive: true,
    })
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'local',
              id: 'alice-assets',
              path: '../user-assets',
              scope: 'user',
              scopeRef: 'user:alice',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await Bun.write(
      join(userAssetRoot, 'packs', 'user-alice', 'roles', 'compute', 'asset.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          id: 'compute',
          type: 'role',
          name: 'Compute',
          version: '0.1.0',
          entry: 'ROLE.md',
        },
        null,
        2,
      )}\n`,
    )
    const userRolePath = join(
      userAssetRoot,
      'packs',
      'user-alice',
      'roles',
      'compute',
      'ROLE.md',
    )
    await Bun.write(userRolePath, '# User Compute\n\nChoose remote queues.\n')
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    // Only a LOCAL user source is configured; acceptance requires a git
    // source, so the run must block before the editor spends any tokens.
    let roleRunnerInvoked = false
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async () => {
      roleRunnerInvoked = true
      throw new Error('editor must not run without an acceptable Gitea source')
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'user',
      scopeRef: 'user:alice',
      runId: 'direct-editor-user-no-gitea',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(roleRunnerInvoked).toBe(false)
    expect(run?.status).toBe('blocked')
    expect(run?.statusReason).toBe('direct_editor_scoped_source_unavailable')
    expect(run?.stderr).toContain('Gitea source acceptance is required for scope user (user:alice)')
    expect(await readFile(userRolePath, 'utf8')).toBe(
      '# User Compute\n\nChoose remote queues.\n',
    )
  })

  test('preserves concurrent third-party writes when a gate rejection rolls back a direct edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-reject-preserve-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const bystanderSkillPath = await writeCoreQueueSkill(root)
    await writeFile(rolePath, '# Compute\n\nQueue policy:\nPrefer local GPUs.\n\nResource selection:\nKeep the existing allocation.\n\nSafety policy:\nKeep logs.\n')
    const originalRole = await readFile(rolePath, 'utf8')
    const concurrentRole = originalRole.replace('Keep logs.', 'Keep detailed logs.')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const concurrentSkillId = 'concurrent-third-party-skill'
    const concurrentBody =
      '# Concurrent Skill\n\nSaved by a third-party writer during the unlocked editor phase.\n'
    const concurrentBystanderBody =
      '# Compute Queue Policy\n\nThird-party revision written during the unlocked editor phase.\n'

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // The hidden editor edits only the compute role inside its isolation
      // workspace...
      await Bun.write(
        coreComputeRolePath(input.cwd),
        originalRole.replace('Prefer local GPUs.', 'Always use remote queues even when local GPUs are idle.'),
      )
      await writeFile(rolePath, concurrentRole)
      // ...while a third-party writer concurrently creates a new skill and
      // revises an unrelated existing skill in the REAL asset tree.
      const realConcurrent = coreSkillDir(root, concurrentSkillId)
      await Bun.write(
        join(realConcurrent, 'asset.json'),
        coreSkillAssetJson(concurrentSkillId, 'Concurrent Skill'),
      )
      await Bun.write(join(realConcurrent, 'SKILL.md'), concurrentBody)
      await Bun.write(bystanderSkillPath, concurrentBystanderBody)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Made a semantically wrong queue policy.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const semanticJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      reason: 'The edit contradicts the user evidence.',
      resolvedUserProblem: false,
    })

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-reject-preserve',
      roleRunner,
      semanticJudge,
      // One attempt: the snapshot assertions below describe a single rollback.
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1' },
    })

    expect(run?.status).toBe('rolled_back')
    // The run's own edit is reverted...
    expect(await readFile(rolePath, 'utf8')).toBe(concurrentRole)
    expect(run?.rollbackBaseSnapshot).toBeDefined()
    expect(run?.rollbackBaseSnapshot).not.toBe(run?.beforeSnapshot)
    // ...but concurrent third-party writes survive the rejection rollback.
    expect(
      await readFile(join(coreSkillDir(root, concurrentSkillId), 'SKILL.md'), 'utf8'),
    ).toBe(concurrentBody)
    expect(await exists(join(coreSkillDir(root, concurrentSkillId), 'asset.json'))).toBe(true)
    expect(await readFile(bystanderSkillPath, 'utf8')).toBe(concurrentBystanderBody)
  })

  test('does not enable third-party draft manifests saved concurrently during the editor run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-draft-preserve-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const draftSkillId = 'concurrent-draft-skill'
    const draftManifest = `${JSON.stringify(
      {
        schemaVersion: 1,
        id: draftSkillId,
        type: 'skill',
        name: 'Concurrent Draft Skill',
        version: '0.1.0',
        description: 'Deliberately kept as draft by a concurrent writer.',
        entry: 'SKILL.md',
        lifecycle: { status: 'draft' },
        tags: ['compute'],
      },
      null,
      2,
    )}\n`

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      // Concurrent third-party writer saves a deliberately-draft skill into
      // the REAL tree while the editor works in isolation.
      const realDraft = coreSkillDir(root, draftSkillId)
      await Bun.write(join(realDraft, 'asset.json'), draftManifest)
      await Bun.write(join(realDraft, 'SKILL.md'), '# Concurrent Draft Skill\n\nStill drafting.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated compute queue policy.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-draft-preserve',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status === 'accepted' || run?.status === 'accepted_merged').toBe(true)
    expect(await readFile(rolePath, 'utf8')).toBe(
      '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
    )
    // The run record persists the imported touched paths for recovery scoping.
    expect(run?.importedTouchedPaths).toContain(
      'matos-assets/packs/matos-core/roles/compute/ROLE.md',
    )
    const manifest = JSON.parse(
      await readFile(join(coreSkillDir(root, draftSkillId), 'asset.json'), 'utf8'),
    ) as { lifecycle?: { status?: string } }
    expect(manifest.lifecycle?.status).toBe('draft')
  })

  test('records a status reason when the editor role fails without asset changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-failed-reason-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async () => {
      throw new Error('editor role transport failed')
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-failed-reason',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })

    expect(run?.status).toBe('failed')
    expect(run?.statusReason).toBe('editor_role_failed')
    expect(run?.stderr).toContain('editor role transport failed')
  })

  test('distinguishes semantic judge unavailability from a semantic rejection in the status reason', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-judge-reason-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const originalRole = await readFile(rolePath, 'utf8')

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        coreComputeRolePath(input.cwd),
        '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Valid edit, but judge infra fails.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }
    const judgeFailedJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      reason: 'judge process failed',
      judgeFailed: true,
      judgeRoleExitCode: 1,
    })

    const unavailableRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-judge-unavailable-reason',
      roleRunner,
      semanticJudge: judgeFailedJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1' },
    })
    expect(unavailableRun?.status).toBe('rolled_back')
    expect(unavailableRun?.statusReason).toBe('semantic_judge_unavailable')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)

    const rejectJudge: MatOSSemanticAcceptanceJudge = async input => ({
      ...(await acceptSemanticJudge(input)),
      verdict: 'rollback',
      reason: 'The edit contradicts the user evidence.',
      resolvedUserProblem: false,
    })
    const rejectedRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-judge-rejected-reason',
      roleRunner,
      semanticJudge: rejectJudge,
      env: { MATOS_EVOLUTION_DIRECT_EDITOR_MAX_ATTEMPTS: '1' },
    })
    expect(rejectedRun?.status).toBe('rolled_back')
    expect(rejectedRun?.statusReason).toBe('semantic_acceptance_rejected')
    expect(await readFile(rolePath, 'utf8')).toBe(originalRole)
  })

  test('abandons interrupted-run recovery when the run is finalized while waiting for the lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-recover-toctou-'))
    await writeProjectConfig(root)
    await writeCoreComputeRole(root)
    const before = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'direct-editor-before',
      scope: 'core',
    })
    const runId = 'direct-editor-recover-toctou'
    const timestamp = new Date().toISOString()
    const promptInput: MatOSDirectAssetEditorPromptInput = {
      generatedAt: timestamp,
      scope: 'core',
      editableRoots: [],
      experiences: [],
      targetAssets: [],
    }
    const interrupted: MatOSDirectAssetEditorRunRecord = {
      runId,
      status: 'edited',
      statusReason: 'finalize_started',
      createdAt: timestamp,
      updatedAt: timestamp,
      scope: 'core',
      input: promptInput,
      editorOutput: {
        summary: 'Interrupted run.',
        modifiedFiles: [],
        createdAssets: [],
        updatedAssets: [],
        disabledAssets: [],
        evidenceRefs: [],
      },
      modifiedFiles: [],
      createdAssets: [],
      updatedAssets: [],
      disabledAssets: [],
      evidenceRefs: [],
      roleExitCode: 0,
      beforeSnapshot: before.snapshotId,
    }
    await writeMatOSDirectAssetEditorRunRecord(root, interrupted)

    let recoverPromise:
      | Promise<MatOSDirectAssetEditorRunRecord | undefined>
      | undefined
    await withMatOSAssetHistoryLock(
      { cwd: root, operation: 'test-concurrent-finalizer' },
      async () => {
        // The recover candidate is selected from a lock-free read; while this
        // "concurrent finalizer" still holds the lock, the run reaches a
        // terminal state.
        recoverPromise = recoverInterruptedMatOSDirectAssetEditorRun({
          cwd: root,
          runId,
        })
        await Bun.sleep(500)
        await writeMatOSDirectAssetEditorRunRecord(root, {
          ...interrupted,
          status: 'accepted',
          statusReason: 'accepted_by_concurrent_finalizer',
          updatedAt: new Date().toISOString(),
        })
      },
    )
    const recovered = await recoverPromise!

    expect(recovered).toBeUndefined()
    expect(await readMatOSDirectAssetEditorRun(root, runId)).toMatchObject({
      status: 'accepted',
      statusReason: 'accepted_by_concurrent_finalizer',
    })
  })

  test('refuses a stale pending merge apply when current assets changed after the conflict was recorded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-stale-apply-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\n- Prefer local idle GPUs.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Conflicting queue policy edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }
    const pendingRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-stale-apply',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(pendingRun?.status).toBe('pending_merge')

    // The conflicted file advances again after the conflict was recorded.
    await Bun.write(rolePath, '# Compute\n\n- Newest current policy.\n')

    await expect(
      applyMatOSDirectAssetEditorPendingMerge({
        cwd: root,
        runId: 'direct-editor-stale-apply',
        strategy: 'edit',
      }),
    ).rejects.toThrow(/changed since the conflict was recorded/)
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\n- Newest current policy.\n')
    expect(
      await readMatOSDirectAssetEditorPendingMerge(root, 'direct-editor-stale-apply'),
    ).toMatchObject({ status: 'pending' })
  })

  test('marks the judge-free edit strategy on applied pending merges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-apply-judge-skip-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\n- Prefer local idle GPUs.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Conflicting queue policy edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }
    const pendingRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-apply-judge-skip',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(pendingRun?.status).toBe('pending_merge')

    const applied = await applyMatOSDirectAssetEditorPendingMerge({
      cwd: root,
      runId: 'direct-editor-apply-judge-skip',
      strategy: 'edit',
    })
    expect(applied?.run.semanticJudgeSkipped).toBe(true)
    const resolvedRun = await readMatOSDirectAssetEditorRun(root, 'direct-editor-apply-judge-skip')
    expect(resolvedRun?.semanticJudgeSkipped).toBe(true)
  })

  test('aborts a pending merge, keeps current assets, and blocks later applies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-merge-abort-'))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    await Bun.write(rolePath, '# Compute\n\n- Choose remote queues.\n')
    const stable = await createMatOSAssetHistorySnapshot({
      cwd: root,
      kind: 'manual',
      scope: 'core',
    })
    await git(root, ['update-ref', 'refs/matos/assets/core/stable', stable.commit])

    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      // Another writer changes the live tree after the editor copied its input.
      await Bun.write(rolePath, '# Compute\n\n- Prefer Slurm queues.\n')
      await Bun.write(coreComputeRolePath(input.cwd), '# Compute\n\n- Prefer local idle GPUs.\n')
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Conflicting queue policy edit.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }
    // The attempt-suffixed run id simulates a bounded-retry attempt whose
    // consolidated record is re-keyed to the base id operators actually see.
    const pendingRun = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId: 'direct-editor-merge-abort-attempt-2',
      roleRunner,
      semanticJudge: acceptSemanticJudge,
    })
    expect(pendingRun?.status).toBe('pending_merge')

    // Abort resolves the base run id to the attempt-suffixed pending merge.
    const aborted = await abortMatOSDirectAssetEditorPendingMerge({
      cwd: root,
      runId: 'direct-editor-merge-abort',
    })
    expect(aborted?.pendingMerge).toMatchObject({
      runId: 'direct-editor-merge-abort-attempt-2',
      status: 'aborted',
    })
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\n- Prefer Slurm queues.\n')
    expect(
      await readMatOSDirectAssetEditorPendingMerge(root, 'direct-editor-merge-abort-attempt-2'),
    ).toBeUndefined()
    expect(
      await readMatOSDirectAssetEditorRun(root, 'direct-editor-merge-abort-attempt-2'),
    ).toMatchObject({
      status: 'noop',
      statusReason: 'pending_merge_aborted',
    })
    await expect(
      applyMatOSDirectAssetEditorPendingMerge({
        cwd: root,
        runId: 'direct-editor-merge-abort-attempt-2',
        strategy: 'edit',
      }),
    ).resolves.toBeUndefined()
  })

  test('restores the pushed remote accepted ref when acceptance finalization fails after push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-postpush-restore-'))
    const seedRepo = join(root, 'seed-core-assets')
    await mkdir(join(root, '.matos'), { recursive: true })
    await mkdir(seedRepo, { recursive: true })
    await writeGitCoreComputeRolePack({ repo: seedRepo })
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed core assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, [
      'branch',
      'accepted/matos-core-assets/stable',
      seedCommit,
    ])
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'matos-core-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/matos-core-assets/stable',
                commit: seedCommit,
              },
              scope: 'core',
              refresh: 'manual',
              provider: 'gitea',
              gitea: {
                owner: 'matos-core',
                repo: 'assets',
                visibility: 'internal',
                cloneUrl: seedRepo,
              },
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    // The Gitea commit-status endpoint is only called AFTER the accepted ref
    // has been pushed; sabotaging the project config there simulates a
    // post-push finalization failure (config write / runtime validation).
    let sabotaged = false
    const server = createServer((req, res) => {
      void (async () => {
        if (!sabotaged) {
          sabotaged = true
          await rm(join(root, '.matos', 'matos.json'), { force: true })
          await mkdir(join(root, '.matos', 'matos.json'), { recursive: true })
        }
        res.statusCode = 201
        res.setHeader('content-type', 'application/json')
        res.end('{}')
      })()
    })
    const port = await listen(server)

    try {
      const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
        await Bun.write(
          coreComputeRolePath(input.cwd),
          '# Compute\n\nPrefer local idle GPUs before remote queues.\n',
        )
        return {
          exitCode: 0,
          roleReference: 'role:direct-asset-editor',
          stdout: '',
          stderr: '',
          parsedResult: {
            summary: 'Updated core compute role.',
            modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
            updatedAssets: ['role:compute@0.1.0'],
            createdAssets: [],
            disabledAssets: [],
            evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
          },
        }
      }

      const run = await runMatOSDirectAssetEditor({
        cwd: root,
        scope: 'core',
        runId: 'direct-editor-postpush-restore',
        evolutionContext: {
          experienceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
        roleRunner,
        semanticJudge: acceptSemanticJudge,
        env: { MATOS_GITEA_API_URL: `http://127.0.0.1:${port}` },
      })

      expect(sabotaged).toBe(true)
      expect(run?.status === 'rolled_back' || run?.status === 'rollback_failed').toBe(true)
      expect(run?.statusReason).toBeDefined()
      // The remote accepted ref must be rolled back to the pre-run commit even
      // though the failure happened only after the push succeeded.
      expect(
        (
          await gitRepo(seedRepo, ['rev-parse', 'accepted/matos-core-assets/stable'])
        ).trim(),
      ).toBe(seedCommit)
    } finally {
      server.close()
    }
  }, testTimeoutMs(60000))
})

describe('MatOS direct asset editor approval modes', () => {
  const MANUAL_ENV = { MATOS_EVOLUTION_APPROVAL_MODE: 'manual' }

  function coreRoleEditor(content: string): MatOSDirectAssetEditorRoleRunner {
    return async input => {
      await Bun.write(coreComputeRolePath(input.cwd), content)
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Valid update.',
          modifiedFiles: ['matos-assets/packs/matos-core/roles/compute/ROLE.md'],
          createdAssets: [],
          updatedAssets: ['role:compute@0.1.0'],
          disabledAssets: [],
          evidenceRefs: [],
        },
      }
    }
  }

  async function proposeCoreEdit(prefix: string, runId: string, content: string) {
    const root = await mkdtemp(join(tmpdir(), prefix))
    await writeProjectConfig(root)
    await writeExperience(root)
    const rolePath = await writeCoreComputeRole(root)
    await writeHiddenCoreRole(root)
    const original = await readFile(rolePath, 'utf8')
    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'core',
      runId,
      roleRunner: coreRoleEditor(content),
      semanticJudge: acceptSemanticJudge,
      env: MANUAL_ENV,
    })
    return { root, rolePath, original, run }
  }

  test('manual mode parks a gate-passing edit as a proposal and approval applies it', async () => {
    const { root, rolePath, original, run } = await proposeCoreEdit(
      'matos-direct-asset-editor-proposal-approve-',
      'direct-editor-proposal-approve',
      '# Compute\n\nApproved proposal content.\n',
    )

    expect(run?.status).toBe('proposed')
    expect(run?.statusReason).toBe('awaiting_human_approval')
    expect(run?.proposal).toMatchObject({ approvalMode: 'manual' })
    expect(run?.afterSnapshot).toBeTruthy()
    expect(await readFile(rolePath, 'utf8')).toBe(original)
    expect(
      (await listMatOSDirectAssetEditorProposals(root)).map(record => record.runId),
    ).toEqual(['direct-editor-proposal-approve'])

    const approved = await approveMatOSDirectAssetEditorProposal({
      cwd: root,
      runId: 'direct-editor-proposal-approve',
      note: 'looks right',
      env: MANUAL_ENV,
    })

    expect(approved.status).toBe('accepted')
    expect(approved.statusReason).toBe('approved_by_user')
    expect(approved.proposal).toMatchObject({
      decision: 'approved',
      note: 'looks right',
      proposedAfterSnapshot: run?.afterSnapshot,
    })
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\nApproved proposal content.\n')
    const approvedSnapshot = await readMatOSAssetHistorySnapshot(root, approved.afterSnapshot!)
    expect(
      (await git(root, ['rev-parse', '--verify', 'refs/matos/assets/core/stable'])).trim(),
    ).toBe(approvedSnapshot?.commit)
    expect(await listMatOSDirectAssetEditorProposals(root)).toEqual([])
    await expect(
      approveMatOSDirectAssetEditorProposal({
        cwd: root,
        runId: 'direct-editor-proposal-approve',
        env: MANUAL_ENV,
      }),
    ).rejects.toThrow('not a pending proposal')
  }, testTimeoutMs(60000))

  test('rejecting a proposal records the decision and leaves assets untouched', async () => {
    const { root, rolePath, original, run } = await proposeCoreEdit(
      'matos-direct-asset-editor-proposal-reject-',
      'direct-editor-proposal-reject',
      '# Compute\n\nRejected proposal content.\n',
    )
    expect(run?.status).toBe('proposed')

    const rejected = await rejectMatOSDirectAssetEditorProposal({
      cwd: root,
      runId: 'direct-editor-proposal-reject',
      note: 'not general enough',
    })

    expect(rejected.status).toBe('rejected')
    expect(rejected.proposal).toMatchObject({ decision: 'rejected', note: 'not general enough' })
    expect(await readFile(rolePath, 'utf8')).toBe(original)
    expect((await readMatOSDirectAssetEditorRun(root, 'direct-editor-proposal-reject'))?.status).toBe(
      'rejected',
    )
  }, testTimeoutMs(60000))

  test('approval refuses a proposal whose files changed after it was made', async () => {
    const { root, rolePath, run } = await proposeCoreEdit(
      'matos-direct-asset-editor-proposal-conflict-',
      'direct-editor-proposal-conflict',
      '# Compute\n\nStale proposal content.\n',
    )
    expect(run?.status).toBe('proposed')
    await Bun.write(rolePath, '# Compute\n\nA human edited this afterwards.\n')

    await expect(
      approveMatOSDirectAssetEditorProposal({
        cwd: root,
        runId: 'direct-editor-proposal-conflict',
        env: MANUAL_ENV,
      }),
    ).rejects.toThrow('changed after it was proposed')
    expect(await readFile(rolePath, 'utf8')).toBe('# Compute\n\nA human edited this afterwards.\n')
    expect(
      (await readMatOSDirectAssetEditorRun(root, 'direct-editor-proposal-conflict'))?.status,
    ).toBe('proposed')
  }, testTimeoutMs(60000))

  test('approving a project scoped proposal publishes it through the accepted Gitea ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-direct-asset-editor-proposal-project-'))
    const seedRepo = join(root, 'seed-project-assets')
    await mkdir(seedRepo, { recursive: true })
    await writeScopedComputeRolePack(join(seedRepo, 'matos-assets'), 'project-demo')
    await gitRepo(seedRepo, ['init', '-b', 'main'])
    await gitRepo(seedRepo, ['add', '.'])
    await gitRepo(seedRepo, [
      '-c',
      'user.name=MatOS Test',
      '-c',
      'user.email=matos-test@localhost',
      'commit',
      '-m',
      'seed project assets',
    ])
    const seedCommit = (await gitRepo(seedRepo, ['rev-parse', 'HEAD'])).trim()
    await gitRepo(seedRepo, ['branch', 'accepted/demo-project-assets/stable', seedCommit])
    const projectAssetRoot = join(
      root,
      '.matos',
      'source-cache',
      'scopes',
      'projects',
      'demo',
      'git',
      'demo-project-assets',
      'matos-assets',
    )
    await Bun.write(
      join(root, '.matos', 'matos.json'),
      `${JSON.stringify(
        {
          version: 1,
          assetRoots: ['assets', '../matos-assets'],
          assetSources: [
            {
              type: 'git',
              id: 'demo-project-assets',
              repo: seedRepo,
              ref: 'main',
              runtimeRef: {
                mode: 'accepted-ref',
                ref: 'accepted/demo-project-assets/stable',
                commit: seedCommit,
              },
              subdir: 'matos-assets',
              scope: 'project',
              scopeRef: 'project:demo',
              refresh: 'manual',
            },
          ],
          includeDefaultAssetRoots: false,
        },
        null,
        2,
      )}\n`,
    )
    await writeExperience(root)
    await writeHiddenCoreRole(root)
    await writeCoreComputeRole(root)

    const projectRoleRelativePath =
      '.matos/source-cache/scopes/projects/demo/git/demo-project-assets/matos-assets/packs/project-demo/roles/compute/ROLE.md'
    const projectRolePath = join(root, projectRoleRelativePath)
    const roleRunner: MatOSDirectAssetEditorRoleRunner = async input => {
      await Bun.write(
        join(input.cwd, projectRoleRelativePath),
        '# Scoped Compute\n\nPrefer the project convergence checklist first.\n',
      )
      return {
        exitCode: 0,
        roleReference: 'role:direct-asset-editor',
        stdout: '',
        stderr: '',
        parsedResult: {
          summary: 'Updated project scoped compute role.',
          modifiedFiles: [projectRoleRelativePath],
          updatedAssets: ['role:compute@0.1.0'],
          createdAssets: [],
          disabledAssets: [],
          evidenceRefs: ['experience:compute-queue-selection@0.1.0'],
        },
      }
    }

    const run = await runMatOSDirectAssetEditor({
      cwd: root,
      scope: 'project',
      scopeRef: 'project:demo',
      runId: 'direct-editor-proposal-project',
      evolutionContext: {
        experienceRefs: ['experience:compute-queue-selection@0.1.0'],
      },
      roleRunner,
      semanticJudge: acceptSemanticJudge,
      env: MANUAL_ENV,
    })

    expect(run?.status).toBe('proposed')
    expect(run?.sourceAcceptance).toBeUndefined()
    expect(await readFile(projectRolePath, 'utf8')).not.toContain(
      'Prefer the project convergence checklist first.',
    )
    expect(
      (await gitRepo(seedRepo, ['rev-parse', 'accepted/demo-project-assets/stable'])).trim(),
    ).toBe(seedCommit)

    const approved = await approveMatOSDirectAssetEditorProposal({
      cwd: root,
      runId: 'direct-editor-proposal-project',
      env: MANUAL_ENV,
    })

    expect(approved.status).toBe('accepted')
    expect(approved.sourceAcceptance?.[0]).toMatchObject({
      sourceId: 'demo-project-assets',
      acceptedBranch: 'accepted/demo-project-assets/stable',
      ok: true,
      pushed: true,
    })
    expect(
      await readFile(
        join(projectAssetRoot, 'packs', 'project-demo', 'roles', 'compute', 'ROLE.md'),
        'utf8',
      ),
    ).toContain('Prefer the project convergence checklist first.')
    const acceptedCommit = (
      await gitRepo(dirname(projectAssetRoot), [
        'rev-parse',
        'accepted/demo-project-assets/stable',
      ])
    ).trim()
    expect(acceptedCommit).not.toBe(seedCommit)
    expect(approved.sourceAcceptance?.[0]?.commit).toBe(acceptedCommit)
  }, testTimeoutMs(90000))
})
