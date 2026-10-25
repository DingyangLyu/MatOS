import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, chown, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { expect, test } from 'bun:test'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { matOSGitAssetSourceCheckoutRoot, materializeAcceptedRuntimeSnapshot, refreshMatOSRuntimeToolDirectory, withMatOSGitAssetSourceLock } from './sourceAdapters.js'
import { acceptMatOSGiteaAssetSourceCommit } from './giteaAcceptance.js'
import { validateMatOSAssets } from './validateAssets.js'
import { loadServerToolsCached, resetServerToolsCacheForTest } from '../tools/matosToolMcpServer.js'
import { createMatOSAssetDiscoveryTools } from '../tools/assetDiscoveryTools.js'
import { runMatOSAssetsCommand } from '../cli/assets.js'
import { composeMatOSRoleRuntime } from './runtimeComposition.js'

const exec = promisify(execFile)
const git = async (cwd: string, args: string[]) => (await exec('git', args, { cwd })).stdout.trim()
const json = (path: string, value: unknown) => writeFile(path, JSON.stringify(value))
async function fixture(base = tmpdir()) {
  const root = await mkdtemp(join(base, 'accepted-runtime-'))
  const cwd = join(root, 'project')
  const repo = join(root, 'origin')
  const dir = join(repo, 'skills/procedure')
  await mkdir(dir, { recursive: true })
  await mkdir(join(cwd, '.matos'), { recursive: true })
  await json(join(repo, 'matos.pack.json'), { id: 'probe', name: 'Probe', version: '1.0.0' })
  await git(repo, ['init', '-b', 'main'])
  const version = async (value: string, text: string) => {
    await json(join(dir, 'asset.json'), { id: 'procedure', type: 'skill', name: 'Procedure', version: value, entry: 'SKILL.md' })
    await writeFile(join(dir, 'SKILL.md'), text)
    await git(repo, ['add', '.'])
    await git(repo, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-m', text])
    return git(repo, ['rev-parse', 'HEAD'])
  }
  const accepted = await version('0.1.0', 'accepted A')
  await git(repo, ['branch', 'accepted/probe/stable'])
  const source = { type: 'git' as const, id: 'probe', repo, ref: 'main', refresh: 'manual' as const, runtimeRef: { mode: 'accepted-ref' as const, ref: 'accepted/probe/stable', commit: accepted } }
  await json(join(cwd, '.matos/matos.json'), { version: 1, includeDefaultAssetRoots: false, assetRoots: [], assetSources: [source] })
  return { root, cwd, repo, source, version }
}
const runtime = async (cwd: string) => buildMatOSAssetRegistry(await loadMatOSAssets(cwd, { runtimeSnapshot: true, followAcceptedUpdates: true }))

test('mounted tools survive the same Gitea repository switching from host to container transport', async () => {
  const f = await fixture()
  const toolDir = join(f.repo, 'tools/queues')
  await mkdir(toolDir, { recursive: true })
  await json(join(toolDir, 'asset.json'), { id: 'queues', type: 'tool', name: 'Queues', version: '1.0.0',
    metadata: { kind: 'external-tool', executor: { entry: 'tool.py', runtime: 'python3' } } })
  await writeFile(join(toolDir, 'tool.py'), 'print(\'{"ok":true}\')\n')
  const commit = await f.version('0.1.0', 'queue tool')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', commit])
  const original = (await runtime(f.cwd)).resolve('tool:queues')!
  const hostRepo = 'http://127.0.0.1:3001/matos-users/test-assets.git'
  const containerRepo = 'http://matos-gitea:3000/matos-users/test-assets.git'
  const source = { ...f.source, provider: 'gitea' as const, repo: hostRepo,
    runtimeRef: { ...f.source.runtimeRef, commit } }
  const hash = createHash('sha256').update(JSON.stringify([
    source.id, source.repo, undefined, undefined, source.runtimeRef.mode, source.runtimeRef.ref,
  ])).digest('hex').slice(0, 24)
  const originalIdentity = dirname(dirname(dirname(dirname(original.manifestDir))))
  const hostIdentity = join(dirname(originalIdentity), `follow-${hash}`)
  await rename(originalIdentity, hostIdentity)
  const mounted = join(hostIdentity, relative(originalIdentity, original.manifestDir))
  const setSource = (repo: string, extra = {}) => json(join(f.cwd, '.matos/matos.json'), {
    version: 1, includeDefaultAssetRoots: false, assetRoots: [],
    assetSources: [{ ...source, repo, ...extra }],
  })
  await setSource(containerRepo)
  // The real Git checkout already contains the accepted commit. Deliberately
  // offline Gitea transport must not invalidate that accepted authorization.
  expect(await refreshMatOSRuntimeToolDirectory(f.cwd, mounted)).toContain('/tools/queues')
  await setSource('http://unrelated.invalid/matos-users/test-assets.git')
  await expect(refreshMatOSRuntimeToolDirectory(f.cwd, mounted)).rejects.toThrow('no longer available')
  await setSource('http://matos-gitea:3000/matos-users/another-user-assets.git')
  await expect(refreshMatOSRuntimeToolDirectory(f.cwd, mounted)).rejects.toThrow('no longer available')
  await setSource(containerRepo, { scope: 'user', scopeRef: 'user:someone-else' })
  await expect(refreshMatOSRuntimeToolDirectory(f.cwd, mounted)).rejects.toThrow('no longer available')
}, 30_000)

test('tool refresh skips unchanged snapshot scans and shares one registry for an accepted update', async () => {
  const f = await fixture()
  for (const id of ['queues', 'profile']) {
    const dir = join(f.repo, 'tools', id)
    await mkdir(dir, { recursive: true })
    await json(join(dir, 'asset.json'), { id, type: 'tool', name: id, version: '1.0.0',
      metadata: { kind: 'external-tool', executor: { entry: 'tool.py', runtime: 'python3' } } })
    await writeFile(join(dir, 'tool.py'), 'print(\'{"revision":"A"}\')\n')
  }
  const first = await f.version('0.1.0', 'two tools A')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', first])
  const registry = await runtime(f.cwd)
  const dirs = ['queues', 'profile'].map(id => registry.resolve(`tool:${id}`)!.manifestDir)
  const snapshots = new Map<string, Promise<{ root: string; commit: string }>>()
  const registries = new Map<string, Promise<import('./registry.js').MatOSAssetRegistry>>()
  for (const dir of dirs) expect(await refreshMatOSRuntimeToolDirectory(f.cwd, dir, snapshots, registries)).toBe(dir)
  expect(snapshots.size).toBe(1)
  expect(registries.size).toBe(0)
  for (const id of ['queues', 'profile']) await writeFile(join(f.repo, 'tools', id, 'tool.py'), 'print(\'{"revision":"B"}\')\n')
  const second = await f.version('0.1.0', 'two tools B')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', second])
  snapshots.clear()
  for (const dir of dirs) {
    const refreshed = await refreshMatOSRuntimeToolDirectory(f.cwd, dir, snapshots, registries)
    expect(refreshed).not.toBe(dir)
    expect(await readFile(join(refreshed, 'tool.py'), 'utf8')).toContain('"B"')
  }
  expect(snapshots.size).toBe(1)
  expect(registries.size).toBe(1)
}, 30_000)

test('an outage executes only the authorized accepted snapshot, then follows recovery and rejects revocation', async () => {
  const f = await fixture()
  const dir = join(f.repo, 'tools/probe')
  await mkdir(dir, { recursive: true })
  await json(join(dir, 'asset.json'), { id: 'probe', type: 'tool', name: 'Probe', version: '1.0.0',
    metadata: { kind: 'external-tool', executor: { entry: 'tool.py', runtime: 'python3' } } })
  await writeFile(join(dir, 'tool.py'), 'print(\'{"executed":true,"revision":"accepted-A"}\')\n')
  const commit = await f.version('0.1.0', 'tool before outage')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', commit])
  const original = (await runtime(f.cwd)).resolve('tool:probe')!
  // An unpublished authoring change must never replace the accepted executable.
  await writeFile(join(dir, 'tool.py'), 'print(\'{"executed":true,"revision":"unaccepted-draft"}\')\n')
  const checkout = matOSGitAssetSourceCheckoutRoot(f.cwd, f.source)
  const movedCheckout = join(f.root, 'offline-checkout')
  const movedOrigin = join(f.root, 'offline-origin')
  const previous = process.env.MATOS_PROJECT_CWD
  process.env.MATOS_PROJECT_CWD = f.cwd
  const input = { enableAssetDiscoveryTools: false, workflowToolMode: 'none' as const,
    toolDirs: [original.manifestDir], reportExternalToolDiagnostic: () => {} }
  resetServerToolsCacheForTest()
  await rename(checkout, movedCheckout)
  await rename(f.repo, movedOrigin)
  try {
    const tool = (await loadServerToolsCached(input)).find(tool => tool.name === 'probe')!
    expect(tool).toBeDefined()
    const result = await tool.call({})
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toMatchObject({ executed: true, revision: 'accepted-A' })
    // Local authorization changes take effect even while Git is unavailable.
    const configPath = join(f.cwd, '.matos/matos.json')
    const config = await readFile(configPath, 'utf8')
    try {
      await json(configPath, { ...JSON.parse(config), assetSources: [] })
      expect((await tool.call({})).isError).toBe(true)
    } finally { await writeFile(configPath, config) }
  } finally {
    await rename(movedOrigin, f.repo)
    await rename(movedCheckout, checkout)
    if (previous === undefined) delete process.env.MATOS_PROJECT_CWD
    else process.env.MATOS_PROJECT_CWD = previous
    resetServerToolsCacheForTest()
  }
  process.env.MATOS_PROJECT_CWD = f.cwd
  try {
    await writeFile(join(dir, 'tool.py'), 'print(\'{"executed":true,"revision":"accepted-B"}\')\n')
    const updated = await f.version('0.1.0', 'tool after recovery')
    await git(f.repo, ['branch', '-f', 'accepted/probe/stable', updated])
    const recovered = (await loadServerToolsCached(input)).find(tool => tool.name === 'probe')!
    expect((await recovered.call({})).structuredContent).toMatchObject({ executed: true, revision: 'accepted-B' })
  } finally {
    if (previous === undefined) delete process.env.MATOS_PROJECT_CWD
    else process.env.MATOS_PROJECT_CWD = previous
    resetServerToolsCacheForTest()
  }
}, 60_000)

test('runtime follows accepted upgrades and same-version content, never a candidate branch', async () => {
  const f = await fixture()
  const original = (await runtime(f.cwd)).resolve('skill:procedure')!
  const next = await f.version('0.1.1', 'accepted B')
  expect((await runtime(f.cwd)).resolve('skill:procedure')?.version).toBe('0.1.0')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', next])
  const updated = (await runtime(f.cwd)).resolve('skill:procedure')!
  expect(updated.version).toBe('0.1.1')
  expect(updated.entryAbsolutePath).not.toBe(original.entryAbsolutePath)
  expect(await readFile(original.entryAbsolutePath!, 'utf8')).toBe('accepted A')
  const content = await f.version('0.1.1', 'same version C')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', content])
  expect(await readFile((await runtime(f.cwd)).resolve('skill:procedure')!.entryAbsolutePath!, 'utf8')).toBe('same version C')
  const pinned = buildMatOSAssetRegistry(await loadMatOSAssets(f.cwd, { runtimeSnapshot: true, followAcceptedUpdates: false }))
  expect(pinned.resolve('skill:procedure')?.version).toBe('0.1.0')
}, 30_000)

test('runtime files remain available while the editable checkout is replaced', async () => {
  const f = await fixture()
  const original = (await runtime(f.cwd)).resolve('skill:procedure')!
  const checkout = matOSGitAssetSourceCheckoutRoot(f.cwd, f.source)
  await withMatOSGitAssetSourceLock(f.cwd, f.source, async () => {
    const dir = join(checkout, 'skills/procedure')
    await rename(dir, join(f.root, 'staged'))
    try {
      expect(await readFile(original.entryAbsolutePath!, 'utf8')).toBe('accepted A')
      const concurrent = (await runtime(f.cwd)).resolve('skill:procedure')!
      expect(await readFile(concurrent.entryAbsolutePath!, 'utf8')).toBe('accepted A')
    } finally { await rename(join(f.root, 'staged'), dir) }
  })
}, 30_000)

test('acceptance rejects a cross-source reverse dependency before advancing the accepted ref', async () => {
  const f = await fixture()
  await runtime(f.cwd)
  const consumer = join(f.root, 'consumer')
  await mkdir(join(consumer, 'roles/consumer'), { recursive: true })
  await json(join(consumer, 'matos.pack.json'), { id: 'consumer', name: 'Consumer', version: '1.0.0' })
  await json(join(consumer, 'roles/consumer/asset.json'), { id: 'consumer', type: 'role', name: 'Consumer', version: '1.0.0', dependencies: ['skill:procedure@0.1.0'] })
  await json(join(f.cwd, '.matos/matos.json'), { version: 1, includeDefaultAssetRoots: false, assetRoots: [consumer], assetSources: [f.source] })
  const next = await f.version('0.1.1', 'new candidate')
  const validationCwd = join(f.root, 'validation')
  await mkdir(join(validationCwd, '.matos'), { recursive: true })
  const result = await acceptMatOSGiteaAssetSourceCommit({ cwd: f.cwd, source: f.source, ref: next, push: true,
    validateRoot: async root => {
      await json(join(validationCwd, '.matos/matos.json'), { version: 1, includeDefaultAssetRoots: false, assetRoots: [root] })
      return validateMatOSAssets(await loadMatOSAssets(validationCwd))
    },
  })
  expect(result.ok).toBe(false)
  expect(result.pushed).toBe(false)
  expect(await git(f.repo, ['rev-parse', 'accepted/probe/stable'])).toBe(f.source.runtimeRef.commit)
}, 30_000)

test('strict publication rejects a missing canonical tool mount but permits explicitly optional tools', async () => {
  const f = await fixture()
  const asset = (await loadMatOSAssets(f.cwd)).find(a => a.id === 'procedure')!
  const role = { ...asset, type: 'role' as const, id: 'runner', canonicalKey: 'role:runner@1.0.0', mounts: { tools: ['tool:missing@1.0.0', 'Read'] } }
  expect((await validateMatOSAssets([role], { requireToolMounts: true })).ok).toBe(false)
  expect((await validateMatOSAssets([{ ...role, metadata: { optionalToolRefs: ['tool:missing@1.0.0'] } }], { requireToolMounts: true })).ok).toBe(true)
}, 30_000)

test('an existing MCP tool checks accepted updates on call, uses whole new code and respects explicit pins', async () => {
  const f = await fixture()
  const toolDir = join(f.repo, 'tools/predict')
  await mkdir(toolDir, { recursive: true })
  const publishTool = async (version: string, value: string) => {
    await json(join(toolDir, 'asset.json'), { id: 'predict', type: 'tool', name: 'Predict', version,
      metadata: { kind: 'external-tool', executor: { entry: 'tool.py', runtime: 'python3' } } })
    await writeFile(join(toolDir, 'tool.py'), `print('{"revision":"${value}"}')\n`)
    const commit = await f.version('0.1.0', `with tool ${value}`)
    await git(f.repo, ['branch', '-f', 'accepted/probe/stable', commit])
  }
  await publishTool('1.0.0', 'A')
  const first = (await runtime(f.cwd)).resolve('tool:predict')!
  const oldCwd = process.env.MATOS_PROJECT_CWD
  const oldPins = process.env.MATOS_PINNED_ASSET_REFS
  process.env.MATOS_PROJECT_CWD = f.cwd
  delete process.env.MATOS_PINNED_ASSET_REFS
  resetServerToolsCacheForTest()
  try {
    const tools = await loadServerToolsCached({ enableAssetDiscoveryTools: false, workflowToolMode: 'none', toolDirs: [first.manifestDir] })
    const tool = tools.find(t => t.name === 'predict')!
    expect((await tool.call({})).structuredContent?.revision).toBe('A')
    await publishTool('1.1.0', 'B')
    expect((await tool.call({})).structuredContent?.revision).toBe('B')
    process.env.MATOS_PINNED_ASSET_REFS = '["tool:predict@1.0.0"]'
    expect((await tool.call({})).structuredContent?.revision).toBe('A')
    delete process.env.MATOS_PINNED_ASSET_REFS
    await publishTool('1.1.0', 'C')
    expect((await tool.call({})).structuredContent?.revision).toBe('C')
  } finally {
    if (oldCwd === undefined) delete process.env.MATOS_PROJECT_CWD; else process.env.MATOS_PROJECT_CWD = oldCwd
    if (oldPins === undefined) delete process.env.MATOS_PINNED_ASSET_REFS; else process.env.MATOS_PINNED_ASSET_REFS = oldPins
    resetServerToolsCacheForTest()
  }
}, 60_000)

test('a partial MCP list does not cache a missing tool after its files recover', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-partial-cache-'))
  const input = { enableAssetDiscoveryTools: false, workflowToolMode: 'none' as const, toolDirs: [dir], reportExternalToolDiagnostic: () => {} }
  resetServerToolsCacheForTest()
  try {
    expect((await loadServerToolsCached(input)).some(t => t.name === 'recovered')).toBe(false)
    await json(join(dir, 'asset.json'), { id: 'recovered', type: 'tool', name: 'Recovered', version: '1.0.0', metadata: { kind: 'external-tool', executor: { entry: 'tool.py', runtime: 'python3' } } })
    await writeFile(join(dir, 'tool.py'), 'print("{}")\n')
    expect((await loadServerToolsCached(input)).some(t => t.name === 'recovered')).toBe(true)
  } finally { resetServerToolsCacheForTest() }
}, 30_000)

test('asset_read repairs a stale accepted display ref but preserves explicit pins', async () => {
  const f = await fixture()
  const next = await f.version('0.1.1', 'new accepted read content')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', next])
  const read = createMatOSAssetDiscoveryTools({ cwd: f.cwd }).find(tool => tool.name === 'asset_read')!
  const result = await read.call({ ref: 'skill:procedure@0.1.0' })
  expect(result.isError).not.toBe(true)
  expect(result.text).toContain('new accepted read content')
  expect((await read.call({ ref: 'skill:procedure@0.1.0', followUpdates: false })).isError).toBe(true)
  expect((await read.call({ id: 'procedure', type: 'skill', version: '0.1.0' })).isError).toBe(true)
}, 30_000)

test('runtime follows an accepted rollback and uses last known accepted data when origin is offline', async () => {
  const f = await fixture()
  await runtime(f.cwd)
  const next = await f.version('0.1.1', 'accepted B')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', next])
  expect((await runtime(f.cwd)).resolve('skill:procedure')?.version).toBe('0.1.1')
  await rename(f.repo, join(f.root, 'offline'))
  try {
    expect((await runtime(f.cwd)).resolve('skill:procedure')?.version).toBe('0.1.1')
  } finally { await rename(join(f.root, 'offline'), f.repo) }
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', f.source.runtimeRef.commit])
  expect((await runtime(f.cwd)).resolve('skill:procedure')?.version).toBe('0.1.0')
}, 30_000)

test('the last complete accepted snapshot survives loss of its checkout and registry', async () => {
  const f = await fixture()
  await runtime(f.cwd)
  const next = await f.version('0.1.1', 'accepted offline B')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', next])
  await runtime(f.cwd)
  await rename(matOSGitAssetSourceCheckoutRoot(f.cwd, f.source), join(f.root, 'lost-checkout'))
  await rename(f.repo, join(f.root, 'offline'))
  const current = (await runtime(f.cwd)).resolve('skill:procedure')!
  expect(current.version).toBe('0.1.1')
  expect(await readFile(current.entryAbsolutePath!, 'utf8')).toBe('accepted offline B')
}, 30_000)

test('credential loss retains the last accepted revision and never reads a reused source identity', async () => {
  const f = await fixture()
  const httpSource = { ...f.source, provider: 'gitea' as const, repo: 'http://127.0.0.1:1/users/private.git', scope: 'user' as const, scopeRef: 'user:alice' }
  const checkout = matOSGitAssetSourceCheckoutRoot(f.cwd, httpSource)
  await mkdir(dirname(checkout), { recursive: true })
  await git(f.root, ['clone', f.repo, checkout])
  const first = await materializeAcceptedRuntimeSnapshot(f.cwd, httpSource, true)
  await rename(checkout, join(f.root, 'lost-checkout'))
  const previous = process.env.MATOS_GITEA_TOKEN_FILE
  process.env.MATOS_GITEA_TOKEN_FILE = join(f.root, 'missing-token')
  try {
    expect(await materializeAcceptedRuntimeSnapshot(f.cwd, httpSource, true)).toEqual(first)
    await expect(materializeAcceptedRuntimeSnapshot(f.cwd, { ...httpSource, repo: 'http://127.0.0.1:1/users/different.git' }, true)).rejects.toThrow()
    await expect(materializeAcceptedRuntimeSnapshot(f.cwd, { ...httpSource, scopeRef: 'user:bob' }, true)).rejects.toThrow()
    await expect(materializeAcceptedRuntimeSnapshot(f.cwd, { ...httpSource, runtimeRef: { mode: 'commit', commit: 'f'.repeat(40) } }, false)).rejects.toThrow()
  } finally {
    if (previous === undefined) delete process.env.MATOS_GITEA_TOKEN_FILE; else process.env.MATOS_GITEA_TOKEN_FILE = previous
  }
}, 30_000)

test('a configured new accepted commit fetches missing objects without resetting drafts', async () => {
  const f = await fixture()
  await runtime(f.cwd)
  const checkout = matOSGitAssetSourceCheckoutRoot(f.cwd, f.source)
  const dirty = join(checkout, 'skills/procedure/SKILL.md')
  await writeFile(dirty, 'unpublished user edit')
  const next = await f.version('0.1.1', 'new configured commit')
  const snapshot = await materializeAcceptedRuntimeSnapshot(f.cwd, { ...f.source, runtimeRef: { mode: 'commit', commit: next } }, false)
  expect(await readFile(join(snapshot.root, 'skills/procedure/SKILL.md'), 'utf8')).toBe('new configured commit')
  expect(await readFile(dirty, 'utf8')).toBe('unpublished user edit')
  expect(await git(checkout, ['rev-parse', 'HEAD'])).toBe(f.source.runtimeRef.commit)
}, 30_000)

test('a corrupt snapshot marker is rebuilt from the exact accepted object', async () => {
  const f = await fixture()
  const snapshot = await materializeAcceptedRuntimeSnapshot(f.cwd, f.source, false)
  await writeFile(join(dirname(snapshot.root), 'complete.json'), JSON.stringify({ commit: 'f'.repeat(40) }))
  await writeFile(join(snapshot.root, 'skills/procedure/SKILL.md'), 'incomplete cache content')
  const rebuilt = await materializeAcceptedRuntimeSnapshot(f.cwd, f.source, false)
  expect(await readFile(join(rebuilt.root, 'skills/procedure/SKILL.md'), 'utf8')).toBe('accepted A')
}, 30_000)

test('cold accepted sources accept full branch refs and normalized commit hashes', async () => {
  const f = await fixture()
  const source = { ...f.source, runtimeRef: { mode: 'accepted-ref' as const, ref: 'refs/heads/accepted/probe/stable' } }
  const first = await materializeAcceptedRuntimeSnapshot(f.cwd, source, true)
  expect(first.commit).toBe(f.source.runtimeRef.commit)
  expect((await materializeAcceptedRuntimeSnapshot(f.cwd, { ...f.source, runtimeRef: { mode: 'commit', commit: first.commit.toUpperCase() } }, false)).commit).toBe(first.commit)
}, 30_000)

test('acceptance rejects payloads the runtime snapshot reader cannot load', async () => {
  const f = await fixture()
  await symlink('SKILL.md', join(f.repo, 'skills/procedure/unsafe-link'))
  const next = await f.version('0.1.1', 'non-self-contained candidate')
  const result = await acceptMatOSGiteaAssetSourceCommit({ cwd: f.cwd, source: f.source, ref: next, push: true,
    validateRoot: async () => ({ ok: true, errors: [] }),
  })
  expect(result.ok).toBe(false)
  expect(result.pushed).toBe(false)
  expect(result.validation.errors.some(error => error.message.includes('symlink'))).toBe(true)
  expect(await git(f.repo, ['rev-parse', 'accepted/probe/stable'])).toBe(f.source.runtimeRef.commit)
}, 30_000)

test('standalone run-tool follows accepted content while an explicit version keeps its configured snapshot', async () => {
  const f = await fixture()
  const dir = join(f.repo, 'tools/probe')
  await mkdir(dir, { recursive: true })
  await json(join(dir, 'asset.json'), { id: 'probe', type: 'tool', name: 'Probe', version: '1.0.0',
    metadata: { kind: 'external-tool', executor: { entry: 'tool.py', runtime: 'python3' } } })
  await writeFile(join(dir, 'tool.py'), 'print(\'{"revision":"A"}\')\n')
  const first = await f.version('0.1.0', 'tool A')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', first])
  await json(join(f.cwd, '.matos/matos.json'), { version: 1, includeDefaultAssetRoots: false, assetRoots: [],
    assetSources: [{ ...f.source, runtimeRef: { ...f.source.runtimeRef, commit: first } }] })
  const invoke = async (ref: string) => {
    const output: string[] = []
    const errors: string[] = []
    const code = await runMatOSAssetsCommand(['run-tool', ref, '--json'], { cwd: f.cwd, stdout: text => output.push(text), stderr: text => errors.push(text) })
    expect(errors).toEqual([])
    expect(code).toBe(0)
    return JSON.parse(output.join('')).result.revision
  }
  expect(await invoke('tool:probe')).toBe('A')
  await writeFile(join(dir, 'tool.py'), 'print(\'{"revision":"B"}\')\n')
  const next = await f.version('0.1.0', 'tool B same version')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', next])
  expect(await invoke('tool:probe')).toBe('B')
  expect(await invoke('tool:probe@1.0.0')).toBe('A')
}, 30_000)

test('dynamic MCP refresh preserves the original permission boundary even after a new tools/list', async () => {
  const f = await fixture()
  const dir = join(f.repo, 'tools/probe')
  await mkdir(dir, { recursive: true })
  const publish = async (destructive: boolean) => {
    await json(join(dir, 'asset.json'), { id: 'probe', type: 'tool', name: 'Probe', version: '1.0.0',
      metadata: { kind: 'external-tool', isReadOnly: !destructive, isDestructive: destructive,
        executor: { entry: 'tool.py', runtime: 'python3' } } })
    await writeFile(join(dir, 'tool.py'), 'print(\'{"executed":true}\')\n')
    const commit = await f.version('0.1.0', `destructive=${destructive}`)
    await git(f.repo, ['branch', '-f', 'accepted/probe/stable', commit])
  }
  await publish(false)
  const first = (await runtime(f.cwd)).resolve('tool:probe')!
  const previous = process.env.MATOS_PROJECT_CWD
  process.env.MATOS_PROJECT_CWD = f.cwd
  const input = { enableAssetDiscoveryTools: false, workflowToolMode: 'none' as const,
    toolDirs: [first.manifestDir], reportExternalToolDiagnostic: () => {} }
  resetServerToolsCacheForTest()
  try {
    const original = (await loadServerToolsCached(input)).find(tool => tool.name === 'probe')!
    await publish(true)
    expect((await original.call({})).isError).toBe(true)
    resetServerToolsCacheForTest()
    expect((await loadServerToolsCached(input)).some(tool => tool.name === 'probe')).toBe(false)
  } finally {
    if (previous === undefined) delete process.env.MATOS_PROJECT_CWD; else process.env.MATOS_PROJECT_CWD = previous
    resetServerToolsCacheForTest()
  }
}, 30_000)

test.skipIf(process.getuid?.() !== 0 || process.platform !== 'linux')('a workspace UID can read and extend its snapshot cache after a root reader', async () => {
  const f = await fixture()
  try {
    await chmod(f.cwd, 0o755)
    await chmod(join(f.cwd, '.matos'), 0o755)
    await loadMatOSAssets(f.cwd)
    const checkout = matOSGitAssetSourceCheckoutRoot(f.cwd, f.source)
    await chown(checkout, 65534, 65534)
    const asset = (await runtime(f.cwd)).resolve('skill:procedure')!
    const snapshots = dirname(dirname(dirname(dirname(asset.manifestDir))))
    // Enter the disposable fixture before dropping UID. Relative paths avoid
    // relaxing permissions on the shared/private MatOS test-root ancestors.
    const { stdout } = await exec('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, '-e', `
      if (process.getuid() !== 65534) throw new Error('UID isolation was not applied');
      const {mkdtemp, readFile} = await import('node:fs/promises');
      console.log(await readFile(${JSON.stringify(relative(f.cwd, asset.entryAbsolutePath!))}, 'utf8'));
      await mkdtemp(${JSON.stringify(relative(f.cwd, join(snapshots, '.building-')))});
    `], { cwd: f.cwd, timeout: 25_000 })
    expect(stdout.trim()).toBe('accepted A')
  } finally { await rm(f.root, { recursive: true, force: true }) }
}, 30_000)

test('role dependency pins are propagated to the dynamic MCP boundary', async () => {
  const f = await fixture()
  const dir = join(f.repo, 'roles/pinned')
  await mkdir(dir, { recursive: true })
  await json(join(dir, 'asset.json'), { id: 'pinned', name: 'Pinned', type: 'role', version: '1.0.0', dependencies: ['skill:procedure@0.1.0'] })
  const commit = await f.version('0.1.0', 'role with a dependency pin')
  await git(f.repo, ['branch', '-f', 'accepted/probe/stable', commit])
  const projection = await composeMatOSRoleRuntime(await runtime(f.cwd), 'role:pinned', { projectCwd: f.cwd })
  const env = JSON.parse(projection.mcpConfigJson[0]!).mcpServers.matos_asset.env
  expect(JSON.parse(env.MATOS_PINNED_ASSET_REFS)).toContain('skill:procedure@0.1.0')
}, 30_000)

test('changed schemas and withdrawn sources fail before execution; tool failures are never replayed', async () => {
  const f = await fixture()
  const dir = join(f.repo, 'tools/probe')
  await mkdir(dir, { recursive: true })
  const countFile = join(f.root, 'calls.txt')
  await writeFile(countFile, '')
  await json(join(dir, 'asset.json'), { id: 'probe', type: 'tool', name: 'Probe', version: '1.0.0',
    metadata: { kind: 'external-tool', inputSchemaPath: 'schema.json', executor: { entry: 'tool.py', runtime: 'python3' } } })
  await json(join(dir, 'schema.json'), { type: 'object', additionalProperties: true })
  await writeFile(join(dir, 'tool.py'), `with open(${JSON.stringify(countFile)}, 'a') as f: f.write('call\\n')\nprint('{"ok":false}')\nraise SystemExit(1)\n`)
  const publish = async (text: string) => {
    const commit = await f.version('0.1.0', text)
    await git(f.repo, ['branch', '-f', 'accepted/probe/stable', commit])
  }
  await publish('original schema')
  const asset = (await runtime(f.cwd)).resolve('tool:probe')!
  const previous = process.env.MATOS_PROJECT_CWD
  process.env.MATOS_PROJECT_CWD = f.cwd
  resetServerToolsCacheForTest()
  try {
    const tool = (await loadServerToolsCached({ enableAssetDiscoveryTools: false, workflowToolMode: 'none', toolDirs: [asset.manifestDir] })).find(t => t.name === 'probe')!
    await json(join(dir, 'schema.json'), { type: 'object', properties: { value: { type: 'number' } }, required: ['value'], additionalProperties: false })
    await publish('new required input')
    expect((await tool.call({})).isError).toBe(true)
    expect(await readFile(countFile, 'utf8')).toBe('')
    expect((await tool.call({ value: 1 })).isError).toBe(true)
    expect(await readFile(countFile, 'utf8')).toBe('call\n')
    await json(join(f.cwd, '.matos/matos.json'), { version: 1, includeDefaultAssetRoots: false, assetRoots: [], assetSources: [] })
    expect((await tool.call({ value: 1 })).isError).toBe(true)
    expect(await readFile(countFile, 'utf8')).toBe('call\n')
  } finally {
    if (previous === undefined) delete process.env.MATOS_PROJECT_CWD; else process.env.MATOS_PROJECT_CWD = previous
    resetServerToolsCacheForTest()
  }
}, 30_000)
