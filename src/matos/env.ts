import { existsSync, readFileSync } from 'node:fs'

type Env = Record<string, string | undefined>
type ConfigureMatOSEnvironmentOptions = {
  computeProfile?: boolean
}

function configureComputeProfile(env: Env): void {
  if (env.MATOS_COMPUTE_PROFILE_JSON) return
  const path = env.MATOS_COMPUTE_PROFILE_PATH
  if (!path || !existsSync(path)) return
  try {
    env.MATOS_COMPUTE_PROFILE_JSON = readFileSync(path, 'utf8')
  } catch {
    // An unreadable optional profile leaves local compute defaults in place.
  }
}

/** Process-wide MatOS defaults; model provider settings live in provider/profile. */
export function configureMatOSEnvironment(
  env: Env = process.env,
  options: ConfigureMatOSEnvironmentOptions = {},
): void {
  env.MATOS_MODE = '1'
  if (options.computeProfile !== false) {
    configureComputeProfile(env)
  }
}
