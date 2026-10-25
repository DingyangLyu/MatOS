import {
  markMatOSProviderValidation,
  readMatOSProviderProfile,
  resetMatOSProviderProfile,
  resolveMatOSProviderEnv,
  validateMatOSProvider,
  writeMatOSProviderProfile,
} from '../provider/profile.js'

type LoginIO = {
  cwd: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  env?: NodeJS.ProcessEnv
}

export function matOSLoginHelpText(): string {
  return `MatOS DeepSeek provider settings

Usage:
  matos login status [--json]
  matos login set --api-key-env <env> [--base-url <url>] [--model <model>] [--json]
  matos login test [--json]
  matos login reset [--json]

The API key is read from the named environment variable and stored with
mode 0600 next to the MatOS state. Without a saved profile, DEEPSEEK_API_KEY,
DEEPSEEK_BASE_URL and MATOS_DSH_MODEL from the environment are used.
`
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  const inline = args.find(arg => arg.startsWith(`${name}=`))
  return inline?.slice(name.length + 1)
}

export async function runMatOSLoginCommand(args: string[], io: LoginIO): Promise<number> {
  const env = io.env ?? process.env
  const json = args.includes('--json')
  const subcommand = args[0] ?? 'status'
  const emit = (payload: Record<string, unknown>, text: string): void => {
    io.stdout(json ? `${JSON.stringify(payload)}\n` : `${text}\n`)
  }
  if (subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
    io.stdout(matOSLoginHelpText())
    return 0
  }
  if (subcommand === 'status') {
    const { status } = await resolveMatOSProviderEnv({ env })
    emit({ ok: true, status }, `${status.source}: ${status.model} at ${status.baseUrl} (${status.hasSecret ? 'key set' : 'no key'}, ${status.status})`)
    return 0
  }
  if (subcommand === 'set') {
    const keyEnv = optionValue(args, '--api-key-env')
    const apiKey = keyEnv ? env[keyEnv] : undefined
    if (!keyEnv || !apiKey?.trim()) {
      io.stderr('matos login set requires --api-key-env naming a non-empty environment variable\n')
      return 1
    }
    await writeMatOSProviderProfile({
      apiKey,
      ...(optionValue(args, '--base-url') ? { baseUrl: optionValue(args, '--base-url') } : {}),
      ...(optionValue(args, '--model') ? { model: optionValue(args, '--model') } : {}),
    }, env)
    const { status } = await resolveMatOSProviderEnv({ env })
    emit({ ok: true, status }, `Saved DeepSeek provider settings (${status.model}).`)
    return 0
  }
  if (subcommand === 'test') {
    const profile = await readMatOSProviderProfile(env)
    const { status } = await resolveMatOSProviderEnv({ env })
    const apiKey = profile?.apiKey ?? env.DEEPSEEK_API_KEY?.trim()
    if (!apiKey) {
      emit({ ok: false, status, message: 'No DeepSeek API key is configured' }, 'No DeepSeek API key is configured.')
      return 1
    }
    const result = await validateMatOSProvider({ apiKey, baseUrl: status.baseUrl, model: status.model })
    await markMatOSProviderValidation(result, env)
    const { status: after } = await resolveMatOSProviderEnv({ env })
    emit({ ok: result.ok, status: after, ...(result.error ? { message: result.error } : {}) },
      result.ok ? 'DeepSeek provider responded.' : `DeepSeek provider check failed: ${result.error}`)
    return result.ok ? 0 : 1
  }
  if (subcommand === 'reset') {
    const removed = await resetMatOSProviderProfile(env)
    emit({ ok: true, removed }, removed ? 'Removed the saved provider settings.' : 'No saved provider settings.')
    return 0
  }
  io.stderr(`Unknown matos login command: ${subcommand}\n${matOSLoginHelpText()}`)
  return 1
}
