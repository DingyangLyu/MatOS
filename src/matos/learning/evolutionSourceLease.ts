import {
  repairMatOSGitAssetSourceCachePermissions,
  withMatOSGitAssetSourceLock,
} from '../assets/sourceAdapters.js'
import { readMatOSProjectConfig } from '../project.js'
import { directEditorAssetSourceMatchesRunScope } from './directAssetEditorSourceAcceptance.js'
import type { MatOSDirectAssetEditorScope } from './directAssetEditorTypes.js'
import { resolvedDirectEditorScopeRef } from './directAssetEditorScope.js'

/** Acquire after the asset-history lock; never hold during the isolated editor. */
export async function withEvolutionSourceLease<T>(
  input: {
    cwd: string
    scope?: MatOSDirectAssetEditorScope
    scopeRef?: string
    env?: NodeJS.ProcessEnv
  },
  run: () => Promise<T>,
): Promise<T> {
  const config = await readMatOSProjectConfig(input.cwd, { strict: true })
  const scopeRef = resolvedDirectEditorScopeRef(input)
  const sources = (config.assetSources ?? [])
    .filter(
      (source) =>
        source.type === 'git' &&
        directEditorAssetSourceMatchesRunScope({
          source,
          scope: input.scope ?? 'core',
          scopeRef,
        }),
    )
    .sort((a, b) => a.id.localeCompare(b.id))
  const enter = async (index: number): Promise<T> => {
    const source = sources[index]
    if (!source) return run()
    return withMatOSGitAssetSourceLock(input.cwd, source, async () => {
      // The managed cache can have restrictive modes left by a host writer.
      // Use its native bounded repair, not chmod/chown of the user workspace.
      await repairMatOSGitAssetSourceCachePermissions(input.cwd, source)
      return enter(index + 1)
    })
  }
  return enter(0)
}
