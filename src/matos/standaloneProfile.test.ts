import { expect, test } from 'bun:test'
import { standaloneEnvironmentDefaults } from './standaloneProfile'
import { resolveMatOSDeploymentRoots } from './runtime/deploymentRoots'

test('standalone state follows the project outside the original server filesystem', () => {
  const env = standaloneEnvironmentDefaults('/home/scientist/research', { scopeRef: 'project:research' })
  expect(resolveMatOSDeploymentRoots(env).runtimeDataDir).toBe('/home/scientist/research/.matos/runtime')
  expect(env.DSH_HOME).toBe('/home/scientist/research/.matos/dsh')
  expect(env.MATOS_SCOPE_REF).toBe('project:research')
  expect(standaloneEnvironmentDefaults('/home/scientist/moved', { scopeRef: 'project:research' }).MATOS_DEPLOY_ROOT)
    .toBe('/home/scientist/moved/.matos/deployment')
})

test('ordinary projects are unchanged; malformed standalone scopes fail', () => {
  expect(standaloneEnvironmentDefaults('/workspace', undefined)).toEqual({})
  for (const scopeRef of ['', 'user:../other', 'user:local\nPATH=bad']) {
    expect(() => standaloneEnvironmentDefaults('/workspace', { scopeRef })).toThrow()
  }
})


test('standalone project scopes use the local user runtime and retain asset context', async () => {
  const { resolveMatOSRuntimeScope } = await import('./runtime/scopes')
  const env = standaloneEnvironmentDefaults('/home/scientist/research', { scopeRef: 'project:research' })
  const scope = resolveMatOSRuntimeScope('/home/scientist/research', { scopeRef: env.MATOS_SCOPE_REF, env })
  expect(scope.ref).toBe('user:local')
  expect(env.MATOS_SCOPE_REF).toBe('project:research')
  expect(() => resolveMatOSRuntimeScope('/workspace', { scopeRef: 'user:alice', env })).toThrow('single-user')
  expect(() => resolveMatOSRuntimeScope('/workspace', { scopeRef: 'project:research', env: {} })).toThrow()
})


test('standalone accepts one local owner plus independent project asset scopes', () => {
  expect(standaloneEnvironmentDefaults('/workspace', { scopeRef: 'user:local' }).MATOS_SCOPE_REF).toBe('user:local')
  for (const scopeRef of ['user:alice', 'team:lab']) {
    expect(() => standaloneEnvironmentDefaults('/workspace', { scopeRef })).toThrow('single-user')
  }
})
