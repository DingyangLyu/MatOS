import { getMatOSSessionsDir } from '../project.js'

export function resolveMatOSSessionsDir(cwd: string): string {
  const configured = process.env.MATOS_SESSION_DIR?.trim()
  return configured || getMatOSSessionsDir(cwd)
}
