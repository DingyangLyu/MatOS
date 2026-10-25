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
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import { createMatOSAssetBuilderTools } from '../tools/assetBuilderTools.js'
import { runMatOSAssetsCommand } from './assets.js'

const execFileAsync = promisify(execFile)

const AMBIENT_ENV_KEYS = [
  'MATOS_DEPLOY_ROOT',
  'MATOS_DATA_DIR',
  'MATOS_SHARED_ASSET_ROOT',
  'MATOS_GLOBAL_ASSET_ROOT',
  'MATOS_BUNDLED_ASSET_ROOT',
  'MATOS_ASSET_ROOTS',
  'MATOS_SCOPE_REF',
  'MATOS_WORKSPACE_DIR',
  'MATOS_ASSET_GOVERNANCE_CWD',
]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of AMBIENT_ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  process.env.MATOS_BUNDLED_ASSET_ROOT = '/nonexistent-matos-bundled-assets'
})

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function makeIo(cwd: string) {
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

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false)
}

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'MatOS Test',
      GIT_AUTHOR_EMAIL: 'matos-test@example.invalid',
      GIT_COMMITTER_NAME: 'MatOS Test',
      GIT_COMMITTER_EMAIL: 'matos-test@example.invalid',
    },
  })
  return stdout.trim()
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('matos assets adapt-path', () => {
  test('previews CSV data, schema, checksum, and reusable assets without copying payloads', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-adapt-path-'))
    const dataDir = join(cwd, 'shared', 'datasets')
    const dataPath = join(dataDir, 'alloys.csv')
    await mkdir(dataDir, { recursive: true })
    await writeFile(
      dataPath,
      'formula,temperature,stable\nFeNi,1200,true\nCoCr,900,false\n',
      'utf8',
    )
    const { io, out, err } = makeIo(cwd)
    const code = await runMatOSAssetsCommand([
      'adapt-path',
      '--path', dataPath,
      '--scope-ref', 'user:alice',
      '--id', 'alloy-observations',
      '--name', 'Alloy Observations',
      '--dry-run',
      '--json',
    ], io)

    expect(code).toBe(0)
    expect(err).toEqual([])
    const result = JSON.parse(out.join('')) as {
      ok: boolean
      dryRun: boolean
      formats: string[]
      checksum: { algorithm: string; coverage: string }
      schema: Array<{ schema?: { columns?: Array<{ name: string; inferredType: string }> } }>
      assets: Array<{ ref: string; files: string[] }>
      smoke: { status: string }
    }
    expect(result.ok).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.formats).toEqual(['csv'])
    expect(result.checksum).toMatchObject({
      algorithm: 'sha256-file-v1',
      coverage: 'full-content',
    })
    expect(result.schema[0]?.schema?.columns).toEqual([
      { name: 'formula', inferredType: 'string' },
      { name: 'temperature', inferredType: 'integer' },
      { name: 'stable', inferredType: 'boolean' },
    ])
    expect(result.assets.map(asset => asset.ref)).toEqual([
      'data:alloy-observations@0.1.0',
      'tool:alloy-observations-query@0.1.0',
      'knowledge:alloy-observations-guide@0.1.0',
      'skill:alloy-observations-usage@0.1.0',
    ])
    expect(result.smoke.status).toBe('passed')
    expect(await pathExists(join(cwd, '.matos', 'assets', 'generated'))).toBe(false)
    expect(await stat(dataPath).then(info => info.size)).toBeGreaterThan(0)
  })

  test('exposes the same operation as an Agent tool and requires scoped publication', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-adapt-path-tool-'))
    const dataPath = join(cwd, 'records.jsonl')
    await writeFile(dataPath, '{"id":1,"value":2.5}\n{"id":2,"value":3.5}\n', 'utf8')
    const tools = createMatOSAssetBuilderTools({ cwd })
    const adaptPath = tools.find(tool => tool.name === 'adapt_path')
    expect(adaptPath).toBeDefined()

    const result = await adaptPath!.call({
      path: dataPath,
      scopeRef: 'user:alice',
      id: 'records',
      dryRun: true,
    })
    const structured = result.structuredContent as {
      ok: boolean
      formats: string[]
      assets: Array<{ ref: string }>
    }
    expect(structured.ok).toBe(true)
    expect(structured.formats).toEqual(['jsonl'])
    expect(structured.assets.map(asset => asset.ref)).toContain('tool:records-query@0.1.0')

    const missingScope = await adaptPath!.call({ path: dataPath, dryRun: true })
    expect(missingScope.isError).toBe(true)
    expect(missingScope.text).toContain('requires scopeRef')
  })

  test('probes and smoke-queries SQLite without creating write sidecars', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-adapt-path-sqlite-'))
    const dataPath = join(cwd, 'materials.sqlite')
    await execFileAsync('python3', [
      '-c',
      'import sqlite3,sys; db=sqlite3.connect(sys.argv[1]); db.execute("create table materials(id integer primary key, formula text)"); db.execute("insert into materials(formula) values (?)", ("Si",)); db.commit(); db.close()',
      dataPath,
    ])
    const { io, out } = makeIo(cwd)
    const code = await runMatOSAssetsCommand([
      'adapt-path',
      '--path', dataPath,
      '--scope-ref', 'user:alice',
      '--id', 'materials-db',
      '--dry-run',
      '--json',
    ], io)
    expect(code).toBe(0)
    const result = JSON.parse(out.join('')) as {
      formats: string[]
      schema: Array<{ schema?: { tables?: Array<{ name: string }> } }>
      smoke: { status: string; checks: Array<{ action: string; status: string }> }
    }
    expect(result.formats).toEqual(['sqlite'])
    expect(result.schema[0]?.schema?.tables?.[0]?.name).toBe('materials')
    expect(result.smoke).toMatchObject({
      status: 'passed',
      checks: [
        { action: 'info', status: 'passed' },
        { action: 'sample', status: 'passed' },
      ],
    })
    expect(await pathExists(`${dataPath}-wal`)).toBe(false)
    expect(await pathExists(`${dataPath}-journal`)).toBe(false)
  })

  test('publishes the complete asset bundle through the user accepted ref', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'matos-adapt-path-publish-'))
    const repo = await mkdtemp(join(tmpdir(), 'matos-adapt-path-repo-'))
    await mkdir(join(cwd, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'seed'])
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-assets/stable', seedCommit])
    await writeJson(getMatOSConfigPath(cwd), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [{
        type: 'git',
        id: 'alice-assets',
        repo,
        ref: 'main',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/alice-assets/stable',
          commit: seedCommit,
        },
        scope: 'user',
        scopeRef: 'user:alice',
        refresh: 'manual',
      }],
    })
    const dataPath = join(cwd, 'shared', 'database.csv')
    await mkdir(join(cwd, 'shared'), { recursive: true })
    await writeFile(dataPath, 'id,value\n1,alpha\n2,beta\n', 'utf8')

    const { io, out, err } = makeIo(cwd)
    const code = await runMatOSAssetsCommand([
      'adapt-path',
      '--path', dataPath,
      '--scope-ref', 'user:alice',
      '--id', 'user-database',
      '--name', 'User Database',
      '--json',
    ], io)
    expect(code).toBe(0)
    expect(err).toEqual([])
    const result = JSON.parse(out.join('')) as {
      ok: boolean
      resolvedRefs: string[]
      validation: { ok: boolean }
      publish: { copiedAssets: Array<{ canonicalRef: string }> }
    }
    expect(result.ok).toBe(true)
    expect(result.validation.ok).toBe(true)
    expect(result.resolvedRefs).toHaveLength(4)
    expect(result.publish.copiedAssets.map(asset => asset.canonicalRef).sort()).toEqual([
      'data:user-database@0.1.0',
      'knowledge:user-database-guide@0.1.0',
      'skill:user-database-usage@0.1.0',
      'tool:user-database-query@0.1.0',
    ])
    const acceptedCommit = await git(repo, ['rev-parse', 'accepted/alice-assets/stable'])
    expect(acceptedCommit).not.toBe(seedCommit)
    expect(await git(repo, [
      'show',
      'accepted/alice-assets/stable:data/user-database/asset.json',
    ])).toContain('reference-only')
    expect(await git(repo, [
      'show',
      'accepted/alice-assets/stable:tool/user-database-query/tool.py',
    ])).toContain('mode=ro&immutable=1')
  })

  test('publishes from a project subdirectory through the workspace scoped asset registry', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'matos-adapt-path-workspace-'))
    const project = join(workspace, 'projects', 'alloy-kb')
    const repo = await mkdtemp(join(tmpdir(), 'matos-adapt-path-workspace-repo-'))
    await mkdir(join(workspace, '.matos'), { recursive: true })
    await mkdir(join(project, '.matos'), { recursive: true })
    await writeFile(join(repo, 'README.md'), 'alice workspace assets\n', 'utf8')
    await git(repo, ['init', '-b', 'main'])
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'seed workspace assets'])
    const seedCommit = await git(repo, ['rev-parse', 'HEAD'])
    await git(repo, ['branch', 'accepted/alice-workspace-assets/stable', seedCommit])
    await writeJson(getMatOSConfigPath(workspace), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      assetSources: [{
        type: 'git',
        id: 'alice-workspace-assets',
        repo,
        ref: 'main',
        runtimeRef: {
          mode: 'accepted-ref',
          ref: 'accepted/alice-workspace-assets/stable',
          commit: seedCommit,
        },
        scope: 'user',
        scopeRef: 'user:alice',
        refresh: 'manual',
      }],
    })
    await writeJson(getMatOSConfigPath(project), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: true,
      assetSources: [],
      assetMounts: [],
    })
    const dataPath = join(project, 'records.csv')
    await writeFile(dataPath, 'id,value\n1,alpha\n2,beta\n', 'utf8')
    process.env.MATOS_WORKSPACE_DIR = workspace

    const adaptPath = createMatOSAssetBuilderTools({ cwd: project })
      .find(tool => tool.name === 'adapt_path')
    const result = await adaptPath!.call({
      path: dataPath,
      scopeRef: 'user:alice',
      id: 'workspace-records',
      name: 'Workspace Records',
    })
    const structured = result.structuredContent as {
      ok: boolean
      resolvedRefs: string[]
      validation: { ok: boolean }
    }

    expect(result.isError).toBe(false)
    expect(structured.ok).toBe(true)
    expect(structured.validation.ok).toBe(true)
    expect(structured.resolvedRefs).toHaveLength(4)
    expect(await git(repo, [
      'show',
      'accepted/alice-workspace-assets/stable:data/workspace-records/asset.json',
    ])).toContain('reference-only')
    expect(await pathExists(join(project, '.matos', 'assets', 'generated'))).toBe(false)
    expect(await pathExists(join(workspace, '.matos', 'assets', 'generated'))).toBe(true)
  })
})
