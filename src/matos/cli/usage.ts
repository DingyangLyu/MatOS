import {
  collectMatOSUsageTokens,
  collectMatOSUsageProfile,
  parseUsageBucket,
  parseUsageSourceFilter,
} from '../usage/usageLedger.js'

type MatOSUsageIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
}

type ParsedUsageArgs = {
  subcommand: string
  json: boolean
  scope?: string
  from?: string
  to?: string
  bucket?: string
  source?: string
  cacheDbPath?: string
}

function valueAfter(args: string[], index: number): string | undefined {
  const value = args[index + 1]
  return value && !value.startsWith('-') ? value : undefined
}

function parseArgs(args: string[]): ParsedUsageArgs {
  const parsed: ParsedUsageArgs = {
    subcommand: args[0] && !args[0].startsWith('-') ? args[0] : 'tokens',
    json: false,
  }
  const startIndex = parsed.subcommand === args[0] ? 1 : 0
  for (let index = startIndex; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--json') {
      parsed.json = true
      continue
    }
    if (arg === '--scope') {
      parsed.scope = valueAfter(args, index)
      index += parsed.scope ? 1 : 0
      continue
    }
    if (arg?.startsWith('--scope=')) {
      parsed.scope = arg.slice('--scope='.length)
      continue
    }
    if (arg === '--from') {
      parsed.from = valueAfter(args, index)
      index += parsed.from ? 1 : 0
      continue
    }
    if (arg?.startsWith('--from=')) {
      parsed.from = arg.slice('--from='.length)
      continue
    }
    if (arg === '--to') {
      parsed.to = valueAfter(args, index)
      index += parsed.to ? 1 : 0
      continue
    }
    if (arg?.startsWith('--to=')) {
      parsed.to = arg.slice('--to='.length)
      continue
    }
    if (arg === '--bucket') {
      parsed.bucket = valueAfter(args, index)
      index += parsed.bucket ? 1 : 0
      continue
    }
    if (arg?.startsWith('--bucket=')) {
      parsed.bucket = arg.slice('--bucket='.length)
      continue
    }
    if (arg === '--source') {
      parsed.source = valueAfter(args, index)
      index += parsed.source ? 1 : 0
      continue
    }
    if (arg?.startsWith('--source=')) {
      parsed.source = arg.slice('--source='.length)
      continue
    }
    if (arg === '--cache-db') {
      parsed.cacheDbPath = valueAfter(args, index)
      index += parsed.cacheDbPath ? 1 : 0
      continue
    }
    if (arg?.startsWith('--cache-db=')) {
      parsed.cacheDbPath = arg.slice('--cache-db='.length)
      continue
    }
  }
  return parsed
}

function printHelp(io: MatOSUsageIO): void {
  io.stdout(`Usage:
  matos usage tokens [--scope <scope-ref>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--bucket day|week|month|year] [--source transcript|session|evolution|combined|all] [--json]
  matos usage profile [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]

Defaults:
  --bucket day
  --source transcript
`)
}

export async function runMatOSUsageCommand(
  args: string[],
  io: MatOSUsageIO,
): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h' || args[0] === 'help') {
    printHelp(io)
    return 0
  }
  const parsed = parseArgs(args)
  if (parsed.subcommand === 'profile') {
    const profile = await collectMatOSUsageProfile({ cwd: io.cwd, scopeRef: parsed.scope, from: parsed.from, to: parsed.to, cacheDbPath: parsed.cacheDbPath })
    io.stdout(`${JSON.stringify(profile, null, 2)}\n`)
    return 0
  }
  if (parsed.subcommand !== 'tokens') {
    io.stderr(`Unknown matos usage command: ${parsed.subcommand}\n`)
    printHelp(io)
    return 1
  }

  const result = await collectMatOSUsageTokens({
    cwd: io.cwd,
    scopeRef: parsed.scope,
    from: parsed.from,
    to: parsed.to,
    bucket: parseUsageBucket(parsed.bucket),
    source: parseUsageSourceFilter(parsed.source),
    cacheDbPath: parsed.cacheDbPath,
  })

  if (parsed.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`)
    return 0
  }

  io.stdout(
    [
      `scope\t${result.scopeRef}`,
      `range\t${result.from}..${result.to}`,
      `bucket\t${result.bucket}`,
      `source\t${result.source}`,
      `total_tokens\t${result.totals.totalTokens}`,
      `input_tokens\t${result.totals.inputTokens}`,
      `output_tokens\t${result.totals.outputTokens}`,
      `cache_read_input_tokens\t${result.totals.cacheReadInputTokens}`,
      `cache_creation_input_tokens\t${result.totals.cacheCreationInputTokens}`,
      `events\t${result.totals.eventCount}`,
      '',
    ].join('\n'),
  )
  return 0
}
