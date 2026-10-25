import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseWorkflowDefinition } from './schema.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import { loadMatOSAssetsFromRoot } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { composeMatOSRoleRuntime } from '../assets/runtimeComposition.js'
import { workflowAgentBudgetArgs } from './nodeAdapters/agentNode.js'

const pack = resolve(import.meta.dir, '../../../matos-assets/packs/matos-research-execution')
describe('native research execution assets', () => {
  test('explicit node budgets produce enforceable native CLI caps, ordinary workflow passthrough stays separate', () => {
    expect(workflowAgentBudgetArgs(undefined)).toEqual([])
    expect(workflowAgentBudgetArgs({ maxAgentTurns: 8 })).toEqual(['--max-turns', '8'])
    expect(() => workflowAgentBudgetArgs({ maxAgentTurns: -1 })).toThrow()
    expect(() => workflowAgentBudgetArgs({ maxAgentTurns: '{{ missing }}' })).toThrow()
  })
})
