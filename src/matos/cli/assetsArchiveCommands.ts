import type { MatOSAssetsIO } from './assetsCliShared.js'
import { listMatOSAssetRevisions, showMatOSAssetRevision, diffMatOSAssetRevisions, retainMatOSAssetHistoryArchive } from '../assets/history/archive.js'
import { restoreMatOSAssetRevision } from '../assets/history/archiveRestore.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { matOSAssetHistoryView } from '../assets/history/historyView.js'
import { backfillMatOSAssetArchive } from '../assets/history/backfill.js'

export async function runAssetArchiveCommand(io: MatOSAssetsIO, args: string[]): Promise<number> {
  try {
    const command = args[0] ?? 'list'
    const positionals: string[] = []
    const options: Record<string, string> = {}
    let apply = false
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!
      if (arg === '--json') continue
      if (arg === '--apply') { apply = true; continue }
      if (['--asset', '--offset', '--limit', '--expected', '--source'].includes(arg)) {
        const value = args[++i]
        if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
        options[arg] = value
      } else if (arg.startsWith('-')) throw new Error(`Unknown archive option: ${arg}`)
      else positionals.push(arg)
    }
    for (const option of ['--offset', '--limit']) if (options[option] && !/^\d{1,8}$/.test(options[option]!)) throw new Error(`Invalid ${option}`)
    let result: unknown
    if (command === 'list') result = await listMatOSAssetRevisions({ cwd: io.cwd, assetRef: options['--asset'], offset: Number(options['--offset'] ?? 0), limit: Number(options['--limit'] ?? 50) })
    else if (command === 'history' && positionals[0]) result = await matOSAssetHistoryView(io.cwd, positionals[0], positionals[1])
    else if (command === 'show' && positionals[0]) result = await showMatOSAssetRevision({ cwd: io.cwd, revisionId: positionals[0] })
    else if (command === 'diff' && positionals[0] && positionals[1]) result = await diffMatOSAssetRevisions({ cwd: io.cwd, from: positionals[0], to: positionals[1] })
    else if (command === 'restore' && positionals[0]) result = await restoreMatOSAssetRevision({ cwd: io.cwd, revisionId: positionals[0], apply, expectedCurrent: options['--expected'] })
    else if (command === 'retain') result = await retainMatOSAssetHistoryArchive(io.cwd)
    else if (command === 'backfill') result = await backfillMatOSAssetArchive({ cwd: io.cwd, sourceId: options['--source'], limit: Number(options['--limit'] ?? 100) })
    else throw new Error('Usage: matos assets archive list|show <revision>|diff <from> <to>|restore <revision> [--apply --expected <digest>]|retain|backfill [--source <id> --limit <count>] --json')
    io.stdout(`${JSON.stringify(redactMatOSAssetOutput(result))}\n`)
    return result && typeof result === 'object' && 'ok' in result && result.ok === false ? 1 : 0
  } catch (error) {
    io.stderr(`${redactMatOSAssetOutput(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }
}
