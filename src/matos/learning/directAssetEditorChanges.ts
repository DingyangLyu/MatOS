import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { gitBuffer } from '../assets/history/gitBackend.js'
import { readMatOSAssetHistorySnapshot } from '../assets/history/records.js'
import { snapshotsShareRestoreOwner } from '../assets/history/restore.js'

export type MatOSObservedAssetChanges = {
  changedPaths: string[]
  actualRefs: string[]
  createdAssets: string[]
  updatedAssets: string[]
  disabledAssets: string[]
}

/** Derive target evidence from committed bytes, never the editor's claims. */
export async function observeDirectEditorAssetChanges(input: {
  cwd: string
  beforeSnapshot: string
  afterSnapshot: string
  onlyPaths?: string[]
}): Promise<MatOSObservedAssetChanges> {
  const before = await readMatOSAssetHistorySnapshot(
    input.cwd,
    input.beforeSnapshot,
  )
  const after = await readMatOSAssetHistorySnapshot(
    input.cwd,
    input.afterSnapshot,
  )
  if (
    !before ||
    !after ||
    before.scope !== after.scope ||
    !snapshotsShareRestoreOwner(input.cwd, before, after)
  )
    throw new Error('Asset change evidence requires matching owner snapshots.')
  const beforeFiles = new Map(before.files.map((file) => [file.path, file]))
  const afterFiles = new Map(after.files.map((file) => [file.path, file]))
  const changedPaths = [
    ...new Set([...beforeFiles.keys(), ...afterFiles.keys()]),
  ]
    .filter(
      (path) =>
        beforeFiles.get(path)?.sha256 !== afterFiles.get(path)?.sha256 &&
        (!input.onlyPaths ||
          input.onlyPaths.some(
            (root) => path === root || path.startsWith(`${root}/`),
          )),
    )
    .sort()
  const refs = new Map<
    string,
    { before: boolean; after: boolean; disabled: boolean }
  >()
  const manifestPaths = [
    ...new Set([...beforeFiles.keys(), ...afterFiles.keys()]),
  ]
    .filter((path) => path.endsWith('/asset.json'))
    .sort((a, b) => b.length - a.length)
  const owners = new Set(
    changedPaths.map((path) =>
      manifestPaths.find((manifest) =>
        path.startsWith(`${dirname(manifest)}/`),
      ),
    ),
  )
  for (const snapshot of [before, after]) {
    for (const file of snapshot.files) {
      if (!owners.has(file.path)) continue
      if (file.sizeBytes > 1024 * 1024)
        throw new Error('Asset manifest too large for target evidence.')
      const bytes = await gitBuffer(input.cwd, [
        'show',
        `${snapshot.commit}:${file.path}`,
      ])
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256)
        throw new Error('Asset manifest evidence hash mismatch.')
      const manifest = JSON.parse(bytes.toString('utf8'))
      if (
        ![manifest.type, manifest.id, manifest.version].every(
          (value) => typeof value === 'string' && value.length > 0,
        )
      )
        continue
      const ref = `${manifest.type}:${manifest.id}@${manifest.version}`
      const state = refs.get(ref) ?? {
        before: false,
        after: false,
        disabled: false,
      }
      if (snapshot === before) state.before = true
      else {
        state.after = true
        state.disabled =
          manifest.enabled === false ||
          manifest.lifecycle?.status === 'disabled'
      }
      refs.set(ref, state)
    }
  }
  const alias = (ref: string) => ref.replace(/@[^@]+$/, '')
  const beforeAliases = new Set(
    [...refs].filter(([, state]) => state.before).map(([ref]) => alias(ref)),
  )
  const afterAliases = new Set(
    [...refs].filter(([, state]) => state.after).map(([ref]) => alias(ref)),
  )
  return {
    changedPaths,
    actualRefs: [...refs.keys()].sort(),
    createdAssets: [...refs]
      .filter(([ref, state]) => !beforeAliases.has(alias(ref)) && state.after)
      .map(([ref]) => ref)
      .sort(),
    updatedAssets: [...refs]
      .filter(([ref, state]) => beforeAliases.has(alias(ref)) && state.after)
      .map(([ref]) => ref)
      .sort(),
    disabledAssets: [...refs]
      .filter(([ref, state]) => !afterAliases.has(alias(ref)) || state.disabled)
      .map(([ref]) => ref)
      .sort(),
  }
}
