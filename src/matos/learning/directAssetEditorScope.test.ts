import { expect, test } from 'bun:test'
import { resolvedDirectEditorScopeRef } from './directAssetEditorScope.js'

test('operation identity precedes every ambient alias and rejects mixed scopes', () => {
  const saved = process.env.MATOS_SCOPE_REF
  process.env.MATOS_SCOPE_REF = 'user:ambient'
  try {
    expect(resolvedDirectEditorScopeRef({ scope: 'user', env: { MATOS_SCOPE_ID: 'user:requested' } })).toBe('user:requested')
    expect(resolvedDirectEditorScopeRef({ scope: 'user', env: { MATOS_USER_ID: 'requested' } })).toBe('user:requested')
    expect(resolvedDirectEditorScopeRef({ scope: 'user', env: { MATOS_USER_ID: 'user:requested' } })).toBe('user:requested')
    expect(resolvedDirectEditorScopeRef({ scope: 'project', env: { MATOS_PROJECT_ID: 'science' } })).toBe('project:science')
    expect(() => resolvedDirectEditorScopeRef({ scope: 'user', scopeRef: 'team:other' })).toThrow('do not match')
  } finally {
    if (saved === undefined) delete process.env.MATOS_SCOPE_REF
    else process.env.MATOS_SCOPE_REF = saved
  }
})
