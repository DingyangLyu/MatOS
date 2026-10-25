import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, test } from 'bun:test'
import { withMatOSGitAssetSourceLock } from '../assets/sourceAdapters.js'
import { mkdtempInMatOSTmp } from '../runtime/tempDirs.js'
import { withEvolutionSourceLease } from './evolutionSourceLease.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true })
})

test('a detached descendant cannot reuse an expired native source lease', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-source-expired-' })
  roots.push(cwd)
  const source = {
    type: 'git' as const,
    id: 'core',
    scope: 'core' as const,
    repo: join(cwd, 'repo.git'),
  }
  let resumeDetached!: () => void
  let releaseOwner!: () => void
  let enteredOwner!: () => void
  const detachedGate = new Promise<void>((resolve) => {
    resumeDetached = resolve
  })
  const ownerGate = new Promise<void>((resolve) => {
    releaseOwner = resolve
  })
  const ownerEntered = new Promise<void>((resolve) => {
    enteredOwner = resolve
  })
  const order: string[] = []
  let detached!: Promise<void>
  await withMatOSGitAssetSourceLock(cwd, source, async () => {
    detached = detachedGate.then(() =>
      withMatOSGitAssetSourceLock(cwd, source, async () => {
        order.push('detached')
      }),
    )
  })
  const owner = withMatOSGitAssetSourceLock(cwd, source, async () => {
    order.push('owner-entered')
    enteredOwner()
    await ownerGate
    order.push('owner-done')
  })
  await ownerEntered
  resumeDetached()
  try {
    await delay(120)
    expect(order).toEqual(['owner-entered'])
  } finally {
    releaseOwner()
    await owner
    await detached
  }
  expect(order).toEqual(['owner-entered', 'owner-done', 'detached'])
})

test('evolution leases serialize with native source refresh and remain scope-local', async () => {
  const cwd = await mkdtempInMatOSTmp({ prefix: 'evolution-source-lease-' })
  roots.push(cwd)
  const source = {
    id: 'alice',
    type: 'git' as const,
    repo: join(cwd, 'repo.git'),
    scope: 'user' as const,
    scopeRef: 'user:alice',
  }
  await mkdir(join(cwd, '.matos'))
  await writeFile(
    join(cwd, '.matos', 'matos.json'),
    JSON.stringify({
      version: 1,
      assetRoots: [],
      assetSources: [source, { ...source, id: 'bob', scopeRef: 'user:bob' }],
    }),
  )
  const order: string[] = []
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  const evolution = withEvolutionSourceLease(
    { cwd, scope: 'user', env: { MATOS_SCOPE_ID: 'user:alice' } },
    async () => {
      await withMatOSGitAssetSourceLock(cwd, source, async () => {
        order.push('reentrant')
      })
      await writeFile(join(cwd, 'lease-entered'), 'yes')
      enter()
      await released
      order.push('evolution')
    },
  )
  await entered
  const refresh = withMatOSGitAssetSourceLock(cwd, source, async () => {
    order.push('refresh')
  })
  try {
    await delay(100)
    expect(order).toEqual(['reentrant'])
  } finally {
    release()
  }
  await evolution
  await refresh
  expect(await readFile(join(cwd, 'lease-entered'), 'utf8')).toBe('yes')
  expect(order).toEqual(['reentrant', 'evolution', 'refresh'])
  const bobLock = join(cwd, '.matos/source-cache/scopes/users/bob/git/.locks')
  expect(
    await import('node:fs/promises').then((fs) =>
      fs.stat(bobLock).then(
        () => true,
        () => false,
      ),
    ),
  ).toBe(false)
})
