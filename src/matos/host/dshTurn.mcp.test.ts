import { expect, test } from 'bun:test'
import { planMatOSDshTurn } from './dshTurn'

const project = JSON.stringify({ mcpServers: { 'audit.calibration': { command: 'python3', args: ['calibration.py'] } } })
const base = {
  cwd: '/project', materializationDirs: [],
  roleTools: ['Read', 'mcp__matos_asset__role_query'],
  mcpConfigJson: [project], projectMcpConfigJson: [project],
}
test('explicit project MCP grants only that server without widening native role tools', () => {
  const plan = planMatOSDshTurn(base)
  expect(plan.toolSurface).toContain('mcp__audit_calibration__*')
  expect(plan.toolSurface).toContain('mcp__matos_asset__role_query')
  expect(plan.toolSurface).not.toContain('mcp__matos_asset__*')
  expect(plan.toolSurface).not.toContain('mcp__*')
})
test('CLI tool restrictions still constrain explicit project MCP', () => {
  const plan = planMatOSDshTurn({ ...base, tools: ['Read'] })
  expect(plan.toolSurface).toEqual(['Read'])
})
test('no-tools removes project MCP servers and their grants', () => {
  const plan = planMatOSDshTurn({ ...base, tools: [] })
  expect(plan.noTools).toBe(true)
  expect(plan.env.MATOS_DSH_MCP_CONFIG).toBeUndefined()
  expect(plan.toolSurface).toEqual([])
})
test('role MCP denials survive a user-configured server', () => {
  const plan = planMatOSDshTurn({ ...base, roleDisallowedTools: ['mcp__audit_calibration__*'] })
  expect(plan.denyRules).toContain('mcp__audit_calibration__*')
  expect(JSON.parse(plan.env.MATOS_DSH_DISALLOWED_TOOLS!)).toContain('mcp__audit_calibration__*')
})
test('project config cannot grant the internal asset server wildcard', () => {
  const internal = JSON.stringify({ mcpServers: { matos_asset: { command: 'node' } } })
  const plan = planMatOSDshTurn({ ...base, projectMcpConfigJson: [internal] })
  expect(plan.toolSurface).not.toContain('mcp__matos_asset__*')
})
