import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { MatOSAssetsIO } from './assetsCliShared.js'
import { redactMatOSAssetOutput } from '../assets/outputRedaction.js'
import { createMatOSAssetBuilderTools } from '../tools/assetBuilderTools.js'

const USAGE =
  'Usage: matos assets edit --type knowledge|data|tool|skill|mcp --id <id> [--name <name>] [--description <text>] [--version <version>] [--content-file <path>] [--entry <file>] [--tag <tag>]... [--action create|update|upsert] [--ref <asset-ref>] [--scope <scope-ref>] [--reason <text>] [--dry-run] --json'

const VALUE_OPTIONS: Record<string, string> = {
  '--type': 'type',
  '--id': 'id',
  '--name': 'name',
  '--description': 'description',
  '--version': 'version',
  '--entry': 'entry',
  '--action': 'action',
  '--ref': 'ref',
  '--scope': 'scopeRef',
  '--reason': 'reason',
}

// Native CLI face of the asset_edit builder tool: creates or updates a
// knowledge/data/tool/skill/mcp asset in a user, team or project scope
// through the same accepted-ref governance agents use.
export async function runAssetEditCommand(io: MatOSAssetsIO, args: string[]): Promise<number> {
  try {
    const input: Record<string, unknown> = {}
    const tags: string[] = []
    let contentFile: string | undefined
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (arg === '--json') continue
      if (arg === '--dry-run') {
        input.dryRun = true
        continue
      }
      if (arg === '--tag' || arg === '--content-file' || VALUE_OPTIONS[arg]) {
        const value = args[++i]
        if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`)
        if (arg === '--tag') tags.push(value)
        else if (arg === '--content-file') contentFile = value
        else input[VALUE_OPTIONS[arg]!] = value
        continue
      }
      throw new Error(`Unknown asset edit option: ${arg}\n${USAGE}`)
    }
    if (!input.ref && (!input.type || !input.id)) throw new Error(USAGE)
    if (tags.length > 0) input.tags = tags
    if (contentFile !== undefined) {
      input.content = await readFile(resolve(io.cwd, contentFile), 'utf8')
    }
    const tool = createMatOSAssetBuilderTools({ cwd: io.cwd, assetCwd: io.cwd }).find(
      candidate => candidate.name === 'asset_edit',
    )
    if (!tool) throw new Error('asset_edit is unavailable')
    const result = await tool.call(input)
    io.stdout(`${JSON.stringify(redactMatOSAssetOutput(result.structuredContent ?? JSON.parse(result.text)))}\n`)
    return result.isError ? 1 : 0
  } catch (error) {
    io.stderr(`${redactMatOSAssetOutput(error instanceof Error ? error.message : String(error))}\n`)
    return 1
  }
}
