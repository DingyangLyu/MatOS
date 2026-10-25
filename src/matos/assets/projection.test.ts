/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { projectMatOSRoleToRuntime } from './projectRuntime.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

describe('MatOS runtime projection', () => {
  test('projects a role into agent, prompt, tool, plugin, and MCP inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-projection-'))
    const assetsDir = join(root, '.matos', 'assets')
    const roleDir = join(assetsDir, 'roles', 'planner')
    const knowledgeDir = join(assetsDir, 'knowledges', 'matbench')
    const skillDir = join(assetsDir, 'skills', 'literature')
    const pluginDir = join(assetsDir, 'plugins', 'analysis')
    const mcpDir = join(assetsDir, 'mcp', 'materials-db')
    const toolDir = join(assetsDir, 'tools', 'custom-analysis')
    const workflowToolDir = join(assetsDir, 'tools', 'mcp-workflow-tools')
    const workflowBuilderDir = join(assetsDir, 'roles', 'workflow-builder')

    await mkdir(roleDir, { recursive: true })
    await mkdir(knowledgeDir, { recursive: true })
    await mkdir(skillDir, { recursive: true })
    await mkdir(join(pluginDir, '.claude-plugin'), { recursive: true })
    await mkdir(mcpDir, { recursive: true })
    await mkdir(toolDir, { recursive: true })
    await mkdir(workflowToolDir, { recursive: true })
    await mkdir(workflowBuilderDir, { recursive: true })

    await writeJson(join(roleDir, 'asset.json'), {
      id: 'planner',
      type: 'role',
      name: 'Materials Planner',
      version: '0.1.0',
      description: 'Plans materials experiments',
      entry: 'prompt.md',
      mounts: {
        knowledge: ['knowledge:matbench'],
        skills: ['skill:literature'],
        tools: ['Read', 'Bash', 'tool:custom-analysis'],
        roles: ['role:workflow-builder'],
        plugins: ['plugin:analysis'],
        mcp: ['mcp:materials-db'],
      },
      runtime: {
        model: 'inherit',
        effort: 'max',
        permissionMode: 'bypassPermissions',
        maxTurns: 3,
        initialPrompt: 'Start from a concise plan.',
        memory: 'project',
      },
    })
    await writeFile(join(roleDir, 'prompt.md'), 'You plan materials work.\n')
    await writeJson(join(knowledgeDir, 'asset.json'), {
      id: 'matbench',
      type: 'knowledge',
      name: 'Matbench',
      version: '0.1.0',
      entry: 'README.md',
      metadata: {
        summary: 'Benchmark datasets for materials ML.',
      },
    })
    await writeFile(join(knowledgeDir, 'README.md'), 'Matbench details.\n')
    await writeJson(join(skillDir, 'asset.json'), {
      id: 'literature',
      type: 'skill',
      name: 'Literature Skill',
      version: '0.1.0',
      entry: 'SKILL.md',
    })
    await writeFile(join(skillDir, 'SKILL.md'), '# Literature Skill\n')
    await writeJson(join(pluginDir, 'asset.json'), {
      id: 'analysis',
      type: 'plugin',
      name: 'Analysis Plugin',
      version: '0.1.0',
      path: '.',
    })
    await writeJson(join(pluginDir, '.claude-plugin', 'plugin.json'), {
      name: 'analysis',
      version: '0.1.0',
    })
    await writeJson(join(mcpDir, 'asset.json'), {
      id: 'materials-db',
      type: 'mcp',
      name: 'Materials DB',
      version: '0.1.0',
      entry: 'mcp.json',
      metadata: {
        mcpServerName: 'materialsDb',
        knownTools: ['search', 'read_file'],
      },
    })
    await writeJson(join(mcpDir, 'mcp.json'), {
      mcpServers: {
        materialsDb: {
          command: 'node',
          args: ['server.js'],
        },
      },
    })
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'custom-analysis',
      type: 'tool',
      name: 'Custom Analysis',
      version: '0.1.0',
      metadata: {
        binding: 'mcp__materialsDb__analyze',
      },
    })
    await writeJson(join(workflowToolDir, 'asset.json'), {
      id: 'mcp-workflow-tools',
      type: 'tool',
      name: 'Workflow Tools',
      version: '0.1.0',
      metadata: {
        mcpServers: ['workflow-tools'],
      },
    })
    await writeJson(join(workflowBuilderDir, 'asset.json'), {
      id: 'workflow-builder',
      type: 'role',
      name: 'Workflow Builder',
      version: '0.1.0',
      description: 'Builds MatOS workflows',
      entry: 'prompt.md',
      mounts: {
        tools: ['tool:mcp-workflow-tools'],
      },
    })
    await writeFile(
      join(workflowBuilderDir, 'prompt.md'),
      'You build MatOS workflows.\n',
    )

    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const projection = await projectMatOSRoleToRuntime(registry, 'role:planner')

    expect(projection.selectedAgent).toBe('planner')
    const plannerAgent = projection.agents.planner
    expect(plannerAgent).toMatchObject({
      description: 'Plans materials experiments',
      skills: ['literature'],
      model: 'inherit',
      effort: 'max',
      permissionMode: 'bypassPermissions',
      maxTurns: 3,
      initialPrompt: 'Start from a concise plan.',
      memory: 'project',
    })
    expect(plannerAgent?.prompt).toContain('MatOS product identity')
    expect(plannerAgent?.prompt).toContain('You plan materials work.')
    expect(projection.agents.planner?.tools).toEqual(
      expect.arrayContaining([
        'Read',
        'Bash',
        'mcp__materialsDb__analyze',
        'mcp__materialsDb__search',
        'mcp__materialsDb__read_file',
        'mcp__matos_asset__asset_context',
        'mcp__matos_asset__asset_graph',
        'mcp__matos_asset__asset_list',
        'mcp__matos_asset__asset_read',
        'mcp__matos_asset__asset_search',
        'mcp__matos_asset__asset_show',
      ]),
    )
    expect(projection.agents.planner?.tools).not.toContain(
      'mcp__matos_asset__workflow_add_node',
    )
    expect(projection.appendSystemPrompt.join('\n')).toContain(
      'Benchmark datasets for materials ML.',
    )
    expect(projection.skillDirs).toContain(skillDir)
    expect(projection.pluginDirs).toEqual([pluginDir])
    expect(projection.mcpConfigPaths).toEqual([join(mcpDir, 'mcp.json')])
    expect(projection.allowedTools).toEqual(
      expect.arrayContaining([
        'Read',
        'Bash',
        'mcp__materialsDb__analyze',
        'mcp__materialsDb__search',
        'mcp__materialsDb__read_file',
        'mcp__matos_asset__asset_context',
        'mcp__matos_asset__asset_graph',
        'mcp__matos_asset__asset_list',
        'mcp__matos_asset__asset_read',
        'mcp__matos_asset__asset_search',
        'mcp__matos_asset__asset_show',
      ]),
    )
    expect(projection.allowedTools).not.toContain(
      'mcp__matos_asset__workflow_add_node',
    )
    expect(projection.agents['workflow-builder']?.tools).toContain(
      'mcp__matos_asset__workflow_add_node',
    )
    expect(projection.agents['workflow-builder']?.prompt).toContain(
      'MatOS workflow runtime tools are available in this role runtime',
    )
    expect(projection.readablePaths).toContain(join(knowledgeDir, 'README.md'))
    expect(projection.assetEvents.map(event => event.assetKey)).toContain(
      'knowledge:matbench@0.1.0',
    )
    expect(projection.assetEvents.map(event => event.assetKey)).toContain(
      'plugin:analysis@0.1.0',
    )
    expect(projection.assetEvents.map(event => event.assetKey)).toContain(
      'mcp:materials-db@0.1.0',
    )
  })
})
