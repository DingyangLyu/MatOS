import { resolve } from 'node:path'

export type MatOSStandaloneProfile = { scopeRef: string }

export function standaloneScopeRef(value: unknown): string {
  if (typeof value !== 'string' || !/^(user|team|project):[^\s/:\\\x00-\x1f\x7f]+$/.test(value)) {
    throw new Error('Standalone scope must be user:local or project:<id>.')
  }
  if (value !== 'user:local' && !value.startsWith('project:')) {
    throw new Error('The single-user edition accepts user:local or project:<id>.')
  }
  return value
}

export function standaloneEnvironmentDefaults(cwd: string, profile: unknown): Record<string, string> {
  if (profile === undefined) return {}
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid standalone profile')
  const scopeRef = standaloneScopeRef((profile as MatOSStandaloneProfile).scopeRef)
  const state = resolve(cwd, '.matos')
  return {
    MATOS_STANDALONE: '1', MATOS_SCOPE_REF: scopeRef, MATOS_USER_ID: 'local',
    MATOS_ALLOW_NON_VEPFS_DATA_ROOT: '1',
    MATOS_ASSETS_CWD: resolve(cwd),
    MATOS_DEPLOY_ROOT: resolve(state, 'deployment'),
    MATOS_RUNTIME_DATA_DIR: resolve(state, 'runtime'),
    MATOS_RUNTIME_MATERIALIZATION_DIR: resolve(state, 'materialization'),
    MATOS_GOVERNANCE_ROOT: resolve(state, 'governance'),
    MATOS_BACKUP_ROOT: resolve(state, 'backups'),
    MATOS_FEEDBACK_DIR: resolve(state, 'feedback'),
    MATOS_AGENT_HOME: resolve(state, 'native-agent'),
    DSH_HOME: resolve(state, 'dsh'), MATOS_DSH_HOME: resolve(state, 'dsh'),
  }
}
