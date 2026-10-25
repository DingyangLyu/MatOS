function hasOption(args: string[], option: string): boolean {
  return args.some(arg => arg === option || arg.startsWith(`${option}=`))
}

function lastOptionValue(args: string[], option: string): string | undefined {
  let value: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === option) {
      value = args[index + 1]
      index += 1
    } else if (arg?.startsWith(`${option}=`)) {
      value = arg.slice(option.length + 1)
    }
  }
  return value
}

export function buildAgentArgsForMatOS(args: string[]): string[] {
  const next = [...args]

  if (!hasOption(next, '--permission-mode')) {
    next.push('--permission-mode', 'bypassPermissions')
  }

  // Arm the bypass activation flag only when the effective permission mode
  // IS bypassPermissions, so the flag never accompanies an explicit safer
  // mode (plan / default / acceptEdits).
  if (
    lastOptionValue(next, '--permission-mode') === 'bypassPermissions' &&
    !hasOption(next, '--dangerously-skip-permissions')
  ) {
    next.push('--dangerously-skip-permissions')
  }

  return next
}

export function buildAgentArgsForMatOSRun(
  prompt: string,
  passthroughArgs: string[] = [],
): string[] {
  const defaultArgs = hasOption(passthroughArgs, '--permission-mode')
    ? []
    : buildAgentArgsForMatOS([])

  return [
    '--output-format',
    'stream-json',
    '--verbose',
    ...defaultArgs,
    ...passthroughArgs,
    '-p',
    prompt,
  ]
}
