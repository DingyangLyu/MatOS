import { afterEach, describe, expect, test } from 'bun:test'
import type { MatOSAsset } from '../assets/types.js'
import {
  decideMatOSToolSelection,
  matOSToolSelectionSurface,
} from './surfaces/toolSelection.js'
import {
  clearMatOSAlgorithmDecisionLog,
  recentMatOSAlgorithmDecisions,
} from './telemetry.js'

const MOUNTED = ['Read', 'Bash', 'mcp__matos_asset__asset_read', 'Skill']

function fakeRole(algorithms?: Record<string, string>): MatOSAsset {
  return {
    id: 'compute',
    type: 'role',
    name: 'compute',
    version: '1.0.0',
    description: 'test role',
    canonicalKey: 'role:compute@1.0.0',
    relativePath: 'roles/compute',
    absolutePath: '/tmp/fake/roles/compute',
    entryRelativePath: undefined,
    entryAbsolutePath: undefined,
    manifestPath: '/tmp/fake/roles/compute/asset.json',
    manifestDir: '/tmp/fake/roles/compute',
    source: 'project',
    sourcePath: '/tmp/fake',
    packId: undefined,
    packName: undefined,
    packVersion: undefined,
    tags: [],
    permissions: [],
    dependencies: [],
    mounts: {},
    runtime: algorithms ? { algorithms } : {},
    lifecycle: { status: 'enabled' },
    metadata: {},
  }
}

afterEach(() => {
  clearMatOSAlgorithmDecisionLog()
})

describe('tool-selection surface', () => {
  test('golden: baseline keeps the composed allowlist order unchanged', () => {
    const { decision, providerId, fallback } = decideMatOSToolSelection({
      roleRef: 'role:compute@1.0.0',
      allowedTools: MOUNTED,
      env: {},
    })
    expect(providerId).toBe('baseline')
    expect(fallback).toBeUndefined()
    expect(decision.allowedTools).toEqual(MOUNTED)
  })

  test('telemetry stores a fixed hash instead of the tool allowlist', () => {
    decideMatOSToolSelection({
      roleRef: 'role:compute@1.0.0',
      allowedTools: MOUNTED,
      env: {},
    })
    const digest = recentMatOSAlgorithmDecisions(1)[0]?.inputDigest
    expect(digest).toMatch(/^[a-f0-9]{16}$/)
    expect(digest).not.toContain('mcp__matos_asset__asset_read')
  })

  test('strategies can only narrow/reorder within the mounted set', () => {
    matOSToolSelectionSurface.register({
      id: 'test-narrow',
      decide: () => ({
        allowedTools: [
          'Skill',
          'Skill',
          'NotMounted',
          'Read',
        ],
      }),
    })
    const { decision } = decideMatOSToolSelection({
      roleRef: 'role:compute@1.0.0',
      allowedTools: MOUNTED,
      env: { MATOS_ALGO_TOOL_SELECTION: 'test-narrow' },
    })
    expect(decision.allowedTools).toEqual(['Skill', 'Read'])
  })

  test('an empty strategy result falls back to the full mounted list', () => {
    matOSToolSelectionSurface.register({
      id: 'test-empty',
      decide: () => ({ allowedTools: ['NotMounted'] }),
    })
    const { decision } = decideMatOSToolSelection({
      roleRef: 'role:compute@1.0.0',
      allowedTools: MOUNTED,
      env: { MATOS_ALGO_TOOL_SELECTION: 'test-empty' },
    })
    expect(decision.allowedTools).toEqual(MOUNTED)
  })

  test('role.runtime.algorithms selects the provider', () => {
    matOSToolSelectionSurface.register({
      id: 'test-role-pick',
      decide: input => ({
        allowedTools: [...input.allowedTools].reverse(),
      }),
    })
    const { decision, source } = decideMatOSToolSelection({
      roleRef: 'role:compute@1.0.0',
      allowedTools: MOUNTED,
      role: fakeRole({ 'tool-selection': 'test-role-pick' }),
      env: {},
    })
    expect(source).toBe('role')
    expect(decision.allowedTools).toEqual([...MOUNTED].reverse())
  })

  test('strategy errors fall back to the baseline list', () => {
    matOSToolSelectionSurface.register({
      id: 'test-crash',
      decide: () => {
        throw new Error('selector crashed')
      },
    })
    const { decision, fallback } = decideMatOSToolSelection({
      roleRef: 'role:compute@1.0.0',
      allowedTools: MOUNTED,
      env: { MATOS_ALGO_TOOL_SELECTION: 'test-crash' },
    })
    expect(fallback).toBe('provider-error')
    expect(decision.allowedTools).toEqual(MOUNTED)
  })
})
