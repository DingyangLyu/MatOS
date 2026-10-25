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

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import { composeMatOSRoleRuntime } from '../assets/runtimeComposition.js'
import { getMatOSConfigPath } from '../project.js'
import {
  applyMatOSWorkbenchWorkflowRoleAttachment,
  previewMatOSWorkbenchWorkflowRoleAttachment,
} from '../workbench/workflows.js'
import { createMatOSWorkflowTools } from './tools/workflowTools.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const ORIGINAL_ENV = { ...process.env }
const TEMP_ROOTS: string[] = []

async function createTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'matos-workflow-tools-'))
  TEMP_ROOTS.push(root)
  return root
}

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV }
})

afterAll(async () => {
  await Promise.all(
    TEMP_ROOTS.splice(0).map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})),
  )
})

async function fixture(): Promise<string> {
  const root = await createTempRoot()
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'interactive')
  const componentDir = join(root, '.matos', 'assets', 'workflows', 'component')
  const backendDir = join(root, '.matos', 'assets', 'workflows', 'backend')
  const stateMachineDir = join(
    root,
    '.matos',
    'assets',
    'workflows',
    'state-machine',
  )
  const dynamicDir = join(root, '.matos', 'assets', 'workflows', 'dynamic-auto')
  const dynamicHighRiskDir = join(
    root,
    '.matos',
    'assets',
    'workflows',
    'dynamic-high-risk',
  )
  const backendWorkdir = join(root, 'workspace', 'attempt-01')
  await mkdir(workflowDir, { recursive: true })
  await mkdir(componentDir, { recursive: true })
  await mkdir(backendDir, { recursive: true })
  await mkdir(stateMachineDir, { recursive: true })
  await mkdir(dynamicDir, { recursive: true })
  await mkdir(dynamicHighRiskDir, { recursive: true })
  await mkdir(backendWorkdir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: true,
    execution: {
      runtimeDataDir: join(root, 'runtime-state'),
    },
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'interactive',
    type: 'workflow',
    name: 'Interactive',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeFile(
    join(workflowDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: interactive',
      'nodes:',
      '  make_file:',
      '    type: exec',
      '    command: "printf ok > result.txt"',
      '  review:',
      '    type: human',
      '    dependsOn: [make_file]',
      '    prompt: Review result',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(componentDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'component',
    type: 'workflow',
    name: 'Component',
    version: '0.1.0',
    entry: 'workflow.yaml',
    runtime: { workflow: { kind: 'component' } },
  })
  await writeFile(
    join(componentDir, 'workflow.yaml'),
    [
      'schemaVersion: 1',
      'name: component',
      'nodes:',
      '  prepare:',
      '    type: exec',
      '    command: "printf ready"',
    ].join('\n'),
    'utf8',
  )
  await writeJson(join(backendDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'backend',
    type: 'workflow',
    name: 'Backend',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(backendDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'backend',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {},
    nodes: [
      {
        id: 'prepare_marker',
        type: 'exec',
        dependsOn: [],
        command: 'printf ready > prepared.txt && printf ready',
      },
      {
        id: 'generate_yaml',
        type: 'backend',
        dependsOn: ['prepare_marker'],
        backend: 'hpc-queue',
        tool: 'tool:hpc-generate-yaml',
        policy: { approval: 'ask' },
        input: {
          taskName: 'workflow-tools-backend',
          workdir: backendWorkdir,
          entrypoint: 'echo ok',
          benchmarkCaseId: 'case-tools',
          attemptId: 'attempt-01',
          approvalDigest: 'workflow-tools-approval',
        },
      },
    ],
  })
  await writeJson(join(stateMachineDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'state-machine',
    type: 'workflow',
    name: 'State Machine',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(stateMachineDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'state-machine',
    parameters: {},
    policy: {
      approvalMode: 'bypass',
      defaultRisk: 'low',
      executionModel: 'state_machine',
      stateMachine: { initialNodeId: 'draft', maxTransitions: 2 },
    },
    outputs: { finalNodeId: { value: '{{ workflow.finalNodeId }}' } },
    nodes: [
      { id: 'draft', type: 'exec', dependsOn: [], command: 'printf draft' },
      { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
    ],
    transitions: [
      { id: 'draft_to_review', from: 'draft', to: 'review', route: 'success' },
    ],
  })
  await writeJson(join(dynamicDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'dynamic-auto',
    type: 'workflow',
    name: 'Dynamic Auto',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(dynamicDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'dynamic auto',
    parameters: {},
    // Auto-apply requires every patch-introduced shell command to be
    // declared on the workflow's dynamicCommandAllowlist; an undeclared
    // command rates 'medium' and parks the patch for human review.
    policy: {
      approvalMode: 'bypass',
      defaultRisk: 'low',
      dynamicCommandAllowlist: ['printf dynamic-review'],
    },
    outputs: {},
    nodes: [
      {
        id: 'plan',
        type: 'dynamic',
        dependsOn: [],
        candidate: {
          schemaVersion: 1,
          sourceNodeId: 'plan',
          reason: 'add bounded review node',
          operations: [
            {
              op: 'add_node',
              node: {
                id: 'review',
                type: 'exec',
                dependsOn: [],
                command: 'printf dynamic-review',
              },
            },
            { op: 'add_edge', from: 'plan', to: 'review' },
          ],
          budgetImpact: {
            addedNodes: 1,
            estimatedAgentCalls: 0,
            estimatedWallMinutes: 1,
          },
          risk: 'low',
        },
      },
    ],
  })
  await writeJson(join(dynamicHighRiskDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'dynamic-high-risk',
    type: 'workflow',
    name: 'Dynamic High Risk',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(dynamicHighRiskDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'dynamic high risk',
    parameters: {},
    policy: { approvalMode: 'bypass', defaultRisk: 'high' },
    outputs: {},
    nodes: [
      {
        id: 'plan',
        type: 'dynamic',
        dependsOn: [],
        candidate: {
          schemaVersion: 1,
          sourceNodeId: 'plan',
          reason: 'add bounded review node',
          operations: [
            {
              op: 'add_node',
              node: {
                id: 'review',
                type: 'exec',
                dependsOn: [],
                command: 'printf dynamic-review',
              },
            },
            { op: 'add_edge', from: 'plan', to: 'review' },
          ],
          budgetImpact: {
            addedNodes: 1,
            estimatedAgentCalls: 0,
            estimatedWallMinutes: 1,
          },
          risk: 'high',
        },
      },
    ],
  })
  return root
}

describe('MatOS agent-facing workflow tools', () => {
  test('exposes context, list, run, status, inspect, respond, and cancel tools', async () => {
    const cwd = await createTempRoot()
    const tools = createMatOSWorkflowTools({ cwd })
    const names = tools.map(tool => tool.name)

    expect(names).toContain('workflow_query')
    expect(names).toContain('workflow_edit')
    expect(names).toContain('workflow_context')
    expect(names).toContain('workflow_list')
    expect(names).toContain('workflow_compile')
    expect(names).toContain('workflow_compile_inspect')
    expect(names).toContain('workflow_contracts')
    expect(names).toContain('workflow_run')
    expect(names).toContain('workflow_status')
    expect(names).toContain('workflow_inspect')
    expect(names).toContain('workflow_artifacts')
    expect(names).toContain('workflow_respond')
    expect(names).toContain('workflow_approval_status')
    expect(names).toContain('workflow_patches')
    expect(names).toContain('workflow_patch_propose')
    expect(names).toContain('workflow_patch_inspect')
    expect(names).toContain('workflow_patch_approve')
    expect(names).toContain('workflow_patch_reject')
    expect(names).toContain('workflow_patch_apply')
    expect(names).toContain('workflow_approve')
    expect(names).toContain('workflow_deny')
    expect(names).toContain('workflow_cancel')
    expect(names).toContain('workflow_reconcile')
    expect(names).toContain('workflow_recover')
    expect(names).toContain('workflow_recover_apply')
    expect(names).toContain('workflow_recover_queue')
    expect(names).toContain('workflow_recover_drain')
    expect(names).toContain('workflow_create_draft')
    expect(names).toContain('workflow_add_node')
    expect(names).toContain('workflow_update_node')
    expect(names).toContain('workflow_delete_node')
    expect(names).toContain('workflow_connect')
    expect(names).toContain('workflow_disconnect')
    expect(names).toContain('workflow_set_outputs')
    expect(names).toContain('workflow_validate_draft')
    expect(names).toContain('workflow_import_component')
    expect(names).toContain('workflow_publish_draft')
    expect(names).toContain('workflow_fork_run')
    expect(
      tools.every(tool => tool.outputSchema?.required?.includes('ok')),
    ).toBe(true)

    const context = await tools.find(tool => tool.name === 'workflow_context')?.call({})
    expect(context?.structuredContent?.ok).toBe(true)
    expect(context?.structuredContent?.nodeTypes).toEqual(
      expect.arrayContaining([
        'agent',
        'exec',
        'guard',
        'human',
        'backend',
        'subworkflow',
        'map',
        'loop',
      ]),
    )
    expect(context?.structuredContent?.semanticNodeTypes).toEqual(
      expect.arrayContaining([
        'compute',
        'approval_gate',
        'validate',
        'supernode',
      ]),
    )
    expect(context?.structuredContent?.authoringGuidance).toEqual(
      expect.arrayContaining([
        expect.stringContaining('workflow_create_draft'),
        expect.stringContaining('workflow_compile'),
        expect.stringContaining('workflow_contracts'),
        expect.stringContaining('bounded loop'),
        expect.stringContaining('compute'),
        expect.stringContaining('file_size'),
        expect.stringContaining('repairHint'),
      ]),
    )
  })

  test('exposes three compact workflow facade tools for normal agents', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    expect(byName.get('workflow_edit')?.description).toContain('file_size')
    expect(byName.get('workflow_edit')?.description).toContain('repairHint')

    const context = await byName.get('workflow_query')?.call({
      action: 'context',
    })
    expect(context?.isError).not.toBe(true)
    expect(context?.structuredContent).toMatchObject({
      ok: true,
      workflowTools: ['workflow_query', 'workflow_run', 'workflow_edit'],
    })
    expect(context?.structuredContent?.nodeTypes).toEqual(
      expect.arrayContaining(['agent', 'exec', 'guard', 'human', 'backend']),
    )
    expect(context?.structuredContent?.nodeManifestTypes).toEqual(
      expect.arrayContaining(['agent', 'exec', 'guard', 'human', 'backend']),
    )
    expect(context?.structuredContent?.nodeManifests).toBeUndefined()
    expect(JSON.stringify(context?.structuredContent).length).toBeLessThan(15_000)

    const listed = await byName.get('workflow_query')?.call({
      action: 'list',
    })
    expect(listed?.isError).not.toBe(true)
    expect(listed?.structuredContent?.workflows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ canonicalKey: 'workflow:interactive@0.1.0' }),
      ]),
    )

    const shown = await byName.get('workflow_query')?.call({
      action: 'show',
      ref: 'workflow:interactive@0.1.0',
    })
    expect(shown?.isError).not.toBe(true)
    expect(shown?.structuredContent?.nodeManifests).toBeUndefined()
    expect(shown?.structuredContent?.nodeManifestReport).toBeUndefined()
    expect(shown?.structuredContent?.nodeManifestSummary).toMatchObject({
      inspectWith: 'workflow_query action=manifest nodeType=<type>',
    })
    expect(JSON.stringify(shown?.structuredContent).length).toBeLessThan(20_000)

    const compiled = await byName.get('workflow_query')?.call({
      action: 'compile',
      ref: 'workflow:interactive',
    })
    expect(compiled?.isError).not.toBe(true)
    expect(compiled?.structuredContent).toMatchObject({
      ok: true,
      workflowRef: 'workflow:interactive@0.1.0',
    })
  })

  test('lets agents discover node manifest fields through the compact query tool', async () => {
    const cwd = await fixture()
    const byName = new Map(createMatOSWorkflowTools({ cwd }).map(tool => [tool.name, tool]))

    const manifest = await byName.get('workflow_query')?.call({
      action: 'manifest',
      nodeType: 'loop',
    })

    expect(manifest?.isError).not.toBe(true)
    expect(manifest?.structuredContent?.manifest).toMatchObject({
      type: 'loop',
      runtimeType: 'loop',
      requiredFields: expect.arrayContaining(['type', 'workflow', 'maxIterations']),
    })
  })

  test('preflights a workflow without executing scripts', async () => {
    const cwd = await createTempRoot()
    const workflowDir = join(cwd, '.matos', 'assets', 'workflows', 'preflight')
    const scriptsDir = join(cwd, 'scripts')
    await mkdir(workflowDir, { recursive: true })
    await mkdir(scriptsDir, { recursive: true })
    await writeJson(getMatOSConfigPath(cwd), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: {
        runtimeDataDir: join(cwd, 'runtime-state'),
      },
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'preflight',
      type: 'workflow',
      name: 'Preflight',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeFile(
      join(scriptsDir, 'run.py'),
      [
        'from pathlib import Path',
        'Path("dry-run-ran.txt").write_text("ran")',
        'print("ran")',
      ].join('\n'),
      'utf8',
    )
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'preflight',
      parameters: {
        cRate: { type: 'number', required: true },
      },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'run_script',
          type: 'exec',
          dependsOn: [],
          command: 'python scripts/run.py',
        },
        {
          id: 'child',
          type: 'subworkflow',
          dependsOn: ['run_script'],
          workflow: 'workflow:missing-child',
        },
        {
          id: 'review',
          type: 'agent',
          dependsOn: ['child'],
          role: 'role:missing-reviewer',
          prompt: 'Review the dry run result.',
        },
      ],
      outputs: {
        stdout: { value: '{{ nodes.run_script.outputs.stdout }}' },
      },
    })

    const byName = new Map(createMatOSWorkflowTools({ cwd }).map(tool => [tool.name, tool]))
    const preflight = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:preflight@0.1.0',
      dryRun: true,
      params: { cRate: 'fast', inputPath: 'input.in' },
    })

    expect(preflight?.isError).not.toBe(true)
    expect(preflight?.structuredContent?.ok).toBe(false)
    const codes = (preflight?.structuredContent?.issues as Array<{ code: string }>).map(
      issue => issue.code,
    )
    expect(codes).toEqual(expect.arrayContaining([
      'unknown_workflow_parameter',
      'parameter_type_mismatch',
      'missing_child_workflow',
      'missing_agent_role',
    ]))
    expect(preflight?.structuredContent?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'unknown_workflow_parameter',
          message: expect.stringContaining('Accepted parameters: cRate.'),
        }),
      ]),
    )
    expect(preflight?.structuredContent?.sourceFingerprints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          nodeId: 'run_script',
          exists: true,
          path: join(cwd, 'scripts', 'run.py'),
        }),
      ]),
    )
    await expect(stat(join(cwd, 'dry-run-ran.txt'))).rejects.toThrow()
  }, 15000)

  test('fails closed on direct starts when a tracked CLI launcher owns execution', async () => {
    const cwd = await fixture()
    const byName = new Map(
      createMatOSWorkflowTools({
        cwd,
        workflowStartPolicy: 'tracked-cli-only',
      }).map(tool => [tool.name, tool]),
    )

    const preflight = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:interactive@0.1.0',
      dryRun: true,
      params: {},
    })
    expect(preflight?.isError).not.toBe(true)

    const denied = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:interactive@0.1.0',
      params: {},
      wait: true,
    })
    expect(denied?.isError).toBe(true)
    expect(denied?.structuredContent?.error).toContain(
      'RUN_WORKFLOW_TRACKED.sh',
    )
    expect(denied?.structuredContent?.error).toContain('end the Agent segment')
    expect(denied?.structuredContent?.error).not.toContain(
      'WAIT_WORKFLOW_TRACKED.sh',
    )

    for (const action of [
      'wait',
      'pause',
      'resume',
      'cancel',
      'retry_node',
      'skip_node',
      'reconcile',
      'recover_apply',
      'recover_drain',
      'patch_approve',
      'patch_reject',
      'patch_apply',
    ]) {
      const lifecycleDenied = await byName.get('workflow_run')?.call({
        action,
        runId: 'run-owned-by-harness',
      })
      expect(lifecycleDenied?.isError).toBe(true)
      expect(lifecycleDenied?.structuredContent?.error).toContain(
        'tracked CLI harness owns execution',
      )
      expect(lifecycleDenied?.structuredContent?.error).toContain(
        'End the Agent segment',
      )
    }

    const context = await byName.get('workflow_query')?.call({ action: 'context' })
    expect(context?.structuredContent?.guidance).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Do not call workflow_run start/wait'),
      ]),
    )
  }, 15000)

  test('denies workflow refs outside the selected role mounted workflow list', async () => {
    const cwd = await createTempRoot()
    const tools = createMatOSWorkflowTools({
      cwd,
      selectedRole: 'role:planner@0.1.0',
      allowedWorkflowRefs: ['workflow:allowed@0.1.0'],
    })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const deniedRun = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:other@0.1.0',
    })
    expect(deniedRun?.isError).toBe(true)
    expect(deniedRun?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )

    const deniedOtherVersion = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:allowed@0.2.0',
    })
    expect(deniedOtherVersion?.isError).toBe(true)
    expect(deniedOtherVersion?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )

    for (const [toolName, input] of [
      ['workflow_show', { ref: 'workflow:other@0.1.0' }],
      ['workflow_validate', { ref: 'workflow:other@0.1.0' }],
      ['workflow_compile', { ref: 'workflow:other@0.1.0' }],
      ['workflow_contracts', { ref: 'workflow:other@0.1.0' }],
      [
        'workflow_import_component',
        { draftId: 'draft-1', ref: 'workflow:other@0.1.0' },
      ],
    ] as const) {
      const denied = await byName.get(toolName)?.call(input)
      expect(denied?.isError).toBe(true)
      expect(denied?.structuredContent?.error).toContain(
        'not mounted on the selected role',
      )
    }

    const context = await byName.get('workflow_query')?.call({ action: 'context' })
    expect(context?.structuredContent?.allowedWorkflowRefs).toEqual([
      'workflow:allowed@0.1.0',
    ])
  })

  test('allows project-local workflow assets under role-mounted access', async () => {
    const cwd = await createTempRoot()
    await mkdir(join(cwd, '.matos'), { recursive: true })
    await writeJson(getMatOSConfigPath(cwd), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: true,
      execution: { runtimeDataDir: join(cwd, 'runtime-state') },
    })
    const workflowDir = join(cwd, '.matos', 'assets', 'workflows', 'project-local')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'project-local',
      type: 'workflow',
      name: 'Project Local',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'Project Local',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'echo',
          type: 'exec',
          dependsOn: [],
          command: 'printf project-local-ok',
        },
      ],
      outputs: {
        stdout: { value: '{{ nodes.echo.outputs.stdout }}' },
      },
    })

    const tools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:compute@1.0.0',
        workflowAccessMode: 'role-mounted',
        allowedWorkflowRefs: ['workflow:mounted@0.1.0'],
      }).map(tool => [tool.name, tool]),
    )

    const context = await tools.get('workflow_query')?.call({ action: 'context' })
    expect(context?.structuredContent?.allowedWorkflowRefs).toEqual([
      'workflow:mounted@0.1.0',
      'workflow:project-local@0.1.0',
    ])

    const run = await tools.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:project-local@0.1.0',
    })
    expect(run?.isError).not.toBe(true)
    expect(run?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'project-local-ok' },
    })

    const denied = await tools.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:not-project-local@0.1.0',
    })
    expect(denied?.isError).toBe(true)
    expect(String(denied?.structuredContent?.error ?? '')).toContain(
      'not mounted on the selected role',
    )
  }, 15000)

  test('allows a restricted role to run a workflow it published in the same tool session', async () => {
    const cwd = await createTempRoot()
    const context = {
      cwd,
      selectedRole: 'role:compute@1.0.0',
      allowedWorkflowRefs: ['workflow:mounted@0.1.0'],
    }
    const tools = createMatOSWorkflowTools(context)
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const deniedBeforePublish = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:agent-built@0.1.0',
    })
    expect(deniedBeforePublish?.isError).toBe(true)

    await byName.get('workflow_create_draft')?.call({
      id: 'agent-built',
      name: 'Agent Built',
      version: '0.1.0',
    })
    await byName.get('workflow_add_node')?.call({
      draftId: 'agent-built',
      node: {
        id: 'say_ok',
        type: 'exec',
        command: 'printf agent-built-ok',
      },
    })
    await byName.get('workflow_set_outputs')?.call({
      draftId: 'agent-built',
      outputs: {
        stdout: { value: '{{ nodes.say_ok.outputs.stdout }}' },
      },
    })
    const published = await byName.get('workflow_publish_draft')?.call({
      draftId: 'agent-built',
      version: '0.1.0',
    })
    expect(published?.isError).not.toBe(true)
    const assetKey = (
      published?.structuredContent?.published as { assetKey?: string }
    ).assetKey
    expect(assetKey).toBe('workflow:agent-built@0.1.0')

    const toolContext = await byName.get('workflow_context')?.call({})
    expect(toolContext?.structuredContent?.sessionWorkflowRefs).toEqual([
      'workflow:agent-built@0.1.0',
    ])

    const run = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: assetKey,
    })
    expect(run?.isError).not.toBe(true)
    expect(run?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'agent-built-ok' },
    })
  }, 15000)

  test('persists newly published workflow refs across recreated tool contexts', async () => {
    const cwd = await createTempRoot()
    const baseContext = {
      cwd,
      selectedRole: 'role:compute@1.0.0',
      allowedWorkflowRefs: ['workflow:mounted@0.1.0'],
    }
    const firstTools = new Map(
      createMatOSWorkflowTools(baseContext).map(tool => [tool.name, tool]),
    )

    await firstTools.get('workflow_create_draft')?.call({
      id: 'agent-built-persisted',
      name: 'Agent Built Persisted',
      version: '0.1.0',
    })
    await firstTools.get('workflow_add_node')?.call({
      draftId: 'agent-built-persisted',
      node: {
        id: 'say_ok',
        type: 'exec',
        command: 'printf persisted-ok',
      },
    })
    await firstTools.get('workflow_set_outputs')?.call({
      draftId: 'agent-built-persisted',
      outputs: {
        stdout: { value: '{{ nodes.say_ok.outputs.stdout }}' },
      },
    })
    const published = await firstTools.get('workflow_publish_draft')?.call({
      draftId: 'agent-built-persisted',
      id: 'agent-built-persisted',
      version: '0.1.0',
    })
    const assetKey = (
      published?.structuredContent?.published as { assetKey?: string }
    ).assetKey
    expect(assetKey).toBe('workflow:agent-built-persisted@0.1.0')

    const secondTools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:compute@1.0.0',
        allowedWorkflowRefs: ['workflow:mounted@0.1.0'],
      }).map(tool => [tool.name, tool]),
    )
    const toolContext = await secondTools.get('workflow_context')?.call({})
    expect(toolContext?.structuredContent?.sessionWorkflowRefs).toEqual([
      'workflow:agent-built-persisted@0.1.0',
    ])

    const run = await secondTools.get('workflow_run')?.call({
      action: 'start',
      ref: assetKey,
    })
    expect(run?.isError).not.toBe(true)
    expect(run?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'persisted-ok' },
    })
  }, 15000)

  test('shares newly published workflow refs across role tool contexts in the same project session', async () => {
    const cwd = await createTempRoot()
    const builderTools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:workflow-builder@1.0.0',
        workflowAccessMode: 'role-mounted',
        allowedWorkflowRefs: ['workflow:builder-mounted@0.1.0'],
      }).map(tool => [tool.name, tool]),
    )

    await builderTools.get('workflow_create_draft')?.call({
      id: 'agent-built-cross-role',
      name: 'Agent Built Cross Role',
      version: '0.1.0',
    })
    await builderTools.get('workflow_add_node')?.call({
      draftId: 'agent-built-cross-role',
      node: {
        id: 'say_ok',
        type: 'exec',
        command: 'printf cross-role-ok',
      },
    })
    await builderTools.get('workflow_set_outputs')?.call({
      draftId: 'agent-built-cross-role',
      outputs: {
        stdout: { value: '{{ nodes.say_ok.outputs.stdout }}' },
      },
    })
    const published = await builderTools.get('workflow_publish_draft')?.call({
      draftId: 'agent-built-cross-role',
      id: 'agent-built-cross-role',
      version: '0.1.0',
    })
    const assetKey = (
      published?.structuredContent?.published as { assetKey?: string }
    ).assetKey
    expect(assetKey).toBe('workflow:agent-built-cross-role@0.1.0')

    const computeTools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:compute@1.0.0',
        workflowAccessMode: 'role-mounted',
        allowedWorkflowRefs: ['workflow:compute-mounted@0.1.0'],
      }).map(tool => [tool.name, tool]),
    )
    const context = await computeTools.get('workflow_query')?.call({ action: 'context' })
    expect(context?.structuredContent?.sessionWorkflowRefs).toEqual([assetKey])
    expect(context?.structuredContent?.allowedWorkflowRefs).toEqual([
      'workflow:compute-mounted@0.1.0',
      assetKey,
    ])

    const run = await computeTools.get('workflow_run')?.call({
      action: 'start',
      ref: assetKey,
    })
    expect(run?.isError).not.toBe(true)
    expect(run?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'cross-role-ok' },
    })

    const denied = await computeTools.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:not-published-or-mounted@0.1.0',
    })
    expect(denied?.isError).toBe(true)
    expect(denied?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )
  }, 15000)

  test('reads legacy role-scoped published workflow refs as project session refs', async () => {
    const cwd = await createTempRoot()
    const workflowDir = join(cwd, '.matos', 'assets', 'workflows', 'legacy-cross-role')
    await mkdir(workflowDir, { recursive: true })
    await mkdir(join(cwd, '.matos', 'runtime'), { recursive: true })
    await writeJson(getMatOSConfigPath(cwd), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: {
        runtimeDataDir: join(cwd, 'runtime-state'),
      },
    })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'legacy-cross-role',
      type: 'workflow',
      name: 'Legacy Cross Role',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'legacy-cross-role',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        stdout: { value: '{{ nodes.say_ok.outputs.stdout }}' },
      },
      nodes: [
        {
          id: 'say_ok',
          type: 'exec',
          dependsOn: [],
          command: 'printf legacy-cross-role-ok',
        },
      ],
    })
    await writeJson(join(cwd, '.matos', 'runtime', 'workflow-session-refs.json'), {
      version: 1,
      roles: {
        'role:workflow-builder@1.0.0': ['workflow:legacy-cross-role@0.1.0'],
      },
    })

    const computeTools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:compute@1.0.0',
        workflowAccessMode: 'role-mounted',
        allowedWorkflowRefs: ['workflow:compute-mounted@0.1.0'],
      }).map(tool => [tool.name, tool]),
    )
    const context = await computeTools.get('workflow_query')?.call({ action: 'context' })
    expect(context?.structuredContent?.sessionWorkflowRefs).toEqual([
      'workflow:legacy-cross-role@0.1.0',
    ])

    const run = await computeTools.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:legacy-cross-role@0.1.0',
    })
    expect(run?.isError).not.toBe(true)
    expect(run?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'legacy-cross-role-ok' },
    })
  }, 15000)

  test('attaches a workflow to a role through the compact edit facade', async () => {
    const cwd = await createTempRoot()
    const roleDir = join(cwd, '.matos', 'assets', 'roles', 'compute')
    const workflowDir = join(cwd, '.matos', 'assets', 'workflows', 'facade-attach')
    await mkdir(roleDir, { recursive: true })
    await mkdir(workflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(cwd), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: {
        runtimeDataDir: join(cwd, 'runtime-state'),
      },
    })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '1.0.0',
      entry: 'ROLE.md',
      mounts: {},
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'Compute role.\n')
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'facade-attach',
      type: 'workflow',
      name: 'Facade Attach',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'facade-attach',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [
        {
          id: 'say_ok',
          type: 'exec',
          dependsOn: [],
          command: 'printf facade-attach-ok',
        },
      ],
      outputs: {
        stdout: { value: '{{ nodes.say_ok.outputs.stdout }}' },
      },
    })

    const tools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:compute@1.0.0',
      }).map(tool => [tool.name, tool]),
    )
    const preview = await tools.get('workflow_edit')?.call({
      action: 'attach_to_role',
      ref: 'workflow:facade-attach@0.1.0',
      request: { reason: 'test facade role attachment' },
    })
    expect(preview?.isError).not.toBe(true)
    const fingerprint = (
      preview?.structuredContent?.transaction as { confirmationFingerprint?: string }
    ).confirmationFingerprint
    if (!fingerprint) {
      throw new Error('Expected workflow role attachment fingerprint')
    }
    const applied = await tools.get('workflow_edit')?.call({
      action: 'attach_to_role',
      ref: 'workflow:facade-attach@0.1.0',
      fingerprint,
      reason: 'test facade role attachment',
    })
    expect(applied?.isError).not.toBe(true)

    const runtime = await composeMatOSRoleRuntime(
      buildMatOSAssetRegistry(await loadMatOSAssets(cwd)),
      'role:compute@1.0.0',
      { projectCwd: cwd },
    )
    expect(runtime.mountedWorkflowRefs).toEqual(['workflow:facade-attach@0.1.0'])
  }, 15000)

  test('runs the current draft definition without republishing', async () => {
    const cwd = await createTempRoot()
    const tools = new Map(createMatOSWorkflowTools({ cwd }).map(tool => [tool.name, tool]))

    await tools.get('workflow_edit')?.call({
      action: 'create_draft',
      id: 'draft-run',
      name: 'Draft Run',
      version: '0.1.0',
    })
    await tools.get('workflow_edit')?.call({
      action: 'add_node',
      draftId: 'draft-run',
      node: {
        id: 'say',
        type: 'exec',
        command: 'printf first-draft-run',
      },
    })
    await tools.get('workflow_edit')?.call({
      action: 'set_outputs',
      draftId: 'draft-run',
      outputs: {
        stdout: { value: '{{ nodes.say.outputs.stdout }}' },
      },
    })

    const first = await tools.get('workflow_run')?.call({
      action: 'start',
      draftId: 'draft-run',
    })
    expect(first?.isError).not.toBe(true)
    expect(first?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'first-draft-run' },
    })

    await tools.get('workflow_edit')?.call({
      action: 'update_node',
      draftId: 'draft-run',
      nodeId: 'say',
      patch: { command: 'printf second-draft-run' },
    })
    const second = await tools.get('workflow_run')?.call({
      action: 'start',
      draftId: 'draft-run',
    })
    expect(second?.isError).not.toBe(true)
    expect(second?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'second-draft-run' },
    })
  }, 15000)

  test('runs a published workflow through the role-mounted agent facade after native attach', async () => {
    const cwd = await createTempRoot()
    const roleDir = join(cwd, '.matos', 'assets', 'roles', 'compute')
    const unmountedWorkflowDir = join(
      cwd,
      '.matos',
      'assets',
      'workflows',
      'unmounted',
    )
    await mkdir(roleDir, { recursive: true })
    await mkdir(unmountedWorkflowDir, { recursive: true })
    await writeJson(getMatOSConfigPath(cwd), {
      version: 1,
      assetRoots: ['assets'],
      includeDefaultAssetRoots: false,
      execution: {
        runtimeDataDir: join(cwd, 'runtime-state'),
      },
    })
    await writeJson(join(roleDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'compute',
      type: 'role',
      name: 'Compute',
      version: '1.0.0',
      entry: 'ROLE.md',
      mounts: {},
    })
    await writeFile(join(roleDir, 'ROLE.md'), 'Compute with attached workflows.\n')
    await writeJson(join(unmountedWorkflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'unmounted',
      type: 'workflow',
      name: 'Unmounted',
      version: '0.1.0',
      entry: 'workflow.yaml',
    })
    await writeFile(
      join(unmountedWorkflowDir, 'workflow.yaml'),
      [
        'schemaVersion: 1',
        'name: unmounted',
        'parameters: {}',
        'policy:',
        '  approvalMode: bypass',
        '  defaultRisk: low',
        'nodes:',
        '  say_ok:',
        '    type: exec',
        '    command: printf unmounted-ok',
        'outputs:',
        '  stdout:',
        '    value: "{{ nodes.say_ok.outputs.stdout }}"',
      ].join('\n'),
    )

    const builderTools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:workflow-builder@1.0.0',
      }).map(tool => [tool.name, tool]),
    )
    await builderTools.get('workflow_create_draft')?.call({
      id: 'agent-attached',
      name: 'Agent Attached',
      version: '0.1.0',
    })
    await builderTools.get('workflow_add_node')?.call({
      draftId: 'agent-attached',
      node: {
        id: 'say_ok',
        type: 'exec',
        command: 'printf attached-ok',
      },
    })
    await builderTools.get('workflow_set_outputs')?.call({
      draftId: 'agent-attached',
      outputs: {
        stdout: { value: '{{ nodes.say_ok.outputs.stdout }}' },
      },
    })
    const published = await builderTools.get('workflow_publish_draft')?.call({
      draftId: 'agent-attached',
      id: 'agent-attached',
      version: '0.1.0',
    })
    const assetKey = (
      published?.structuredContent?.published as { assetKey?: string }
    ).assetKey
    if (!assetKey) {
      throw new Error('Expected published workflow asset key')
    }
    expect(assetKey).toBe('workflow:agent-attached@0.1.0')

    const preview = await previewMatOSWorkbenchWorkflowRoleAttachment({
      cwd,
      ref: assetKey,
      roleRef: 'role:compute@1.0.0',
      request: {
        matos_attachments: [
          {
            ref: assetKey,
            group: 'workflows',
            invocationPolicy: { mode: 'agent-discoverable' },
          },
        ],
      },
    })
    expect(preview.validation.ok).toBe(true)
    await applyMatOSWorkbenchWorkflowRoleAttachment({
      cwd,
      ref: assetKey,
      roleRef: 'role:compute@1.0.0',
      fingerprint: preview.transaction.confirmationFingerprint,
      reason: 'test role-mounted workflow reuse',
      request: {
        matos_attachments: [
          {
            ref: assetKey,
            group: 'workflows',
            invocationPolicy: { mode: 'agent-discoverable' },
          },
        ],
      },
    })

    const assets = await loadMatOSAssets(cwd)
    const registry = buildMatOSAssetRegistry(assets)
    const runtime = await composeMatOSRoleRuntime(
      registry,
      'role:compute@1.0.0',
      { projectCwd: cwd },
    )
    const mcpConfig = JSON.parse(runtime.mcpConfigJson[0] ?? '{}')
    expect(runtime.mountedWorkflowRefs).toEqual([assetKey])
    expect(runtime.appendSystemPrompt.join('\n')).toContain(
      'MatOS workflows enabled for this role runtime:',
    )
    expect(mcpConfig.mcpServers?.matos_asset?.env).toMatchObject({
      MATOS_WORKFLOW_ACCESS_MODE: 'role-mounted',
      MATOS_ALLOWED_WORKFLOW_REFS: JSON.stringify([assetKey]),
    })

    const roleTools = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:compute@1.0.0',
        workflowAccessMode: 'role-mounted',
        allowedWorkflowRefs: runtime.mountedWorkflowRefs,
      }).map(tool => [tool.name, tool]),
    )
    const listed = await roleTools.get('workflow_query')?.call({
      action: 'list',
    })
    expect(
      (listed?.structuredContent?.workflows as Array<{ canonicalKey: string }>).map(
        item => item.canonicalKey,
      ),
    ).toEqual([assetKey, 'workflow:unmounted@0.1.0'])

    const run = await roleTools.get('workflow_run')?.call({
      action: 'start',
      ref: assetKey,
    })
    expect(run?.isError).not.toBe(true)
    expect(run?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'attached-ok' },
    })

    const projectLocal = await roleTools.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:unmounted@0.1.0',
    })
    expect(projectLocal?.isError).not.toBe(true)
    expect(projectLocal?.structuredContent?.run).toMatchObject({
      status: 'completed',
      outputs: { stdout: 'unmounted-ok' },
    })

    const denied = await roleTools.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:missing@0.1.0',
    })
    expect(denied?.isError).toBe(true)
    expect(String(denied?.structuredContent?.error ?? '')).toContain(
      'not mounted on the selected role',
    )
  }, 15000)

  test('applies mounted workflow allowlists to existing runs and triggers', async () => {
    const cwd = await fixture()
    const unrestricted = new Map(
      createMatOSWorkflowTools({ cwd }).map(tool => [tool.name, tool]),
    )
    const restricted = new Map(
      createMatOSWorkflowTools({
        cwd,
        selectedRole: 'role:planner@0.1.0',
        allowedWorkflowRefs: ['workflow:interactive@0.1.0'],
      }).map(tool => [tool.name, tool]),
    )

    const listed = await restricted.get('workflow_query')?.call({ action: 'list' })
    expect(listed?.isError).not.toBe(true)
    expect(
      (listed?.structuredContent?.workflows as Array<{ canonicalKey: string }>).map(
        item => item.canonicalKey,
      ),
    ).toEqual(['workflow:interactive@0.1.0'])

    const mountedStart = await unrestricted.get('workflow_run')?.call({
      ref: 'workflow:interactive',
    })
    const unmountedStart = await unrestricted.get('workflow_run')?.call({
      ref: 'workflow:state-machine',
    })
    const mountedRunId = (mountedStart?.structuredContent?.run as { runId: string }).runId
    const unmountedRunId = (unmountedStart?.structuredContent?.run as { runId: string }).runId

    // action=runs returns compact flat rows by default (runId/workflowRef/
    // status); allowlist filtering is applied before row compaction.
    const runs = await restricted.get('workflow_query')?.call({ action: 'runs' })
    expect(runs?.isError).not.toBe(true)
    expect(
      (runs?.structuredContent?.runs as Array<{ runId: string }>).map(item => item.runId),
    ).toContain(mountedRunId)
    expect(
      (runs?.structuredContent?.runs as Array<{ runId: string }>).map(item => item.runId),
    ).not.toContain(unmountedRunId)

    const deniedStatus = await restricted.get('workflow_run')?.call({
      action: 'status',
      runId: unmountedRunId,
    })
    expect(deniedStatus?.isError).toBe(true)
    expect(deniedStatus?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )

    const deniedLowLevelStatus = await restricted.get('workflow_status')?.call({
      runId: unmountedRunId,
    })
    expect(deniedLowLevelStatus?.isError).toBe(true)
    expect(deniedLowLevelStatus?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )

    const allowedStatus = await restricted.get('workflow_run')?.call({
      action: 'status',
      runId: mountedRunId,
    })
    expect(allowedStatus?.isError).not.toBe(true)

    // A truncated/mistyped run id is a lookup miss, not a mount denial: the
    // error must say not-found (with close candidates) instead of sending the
    // agent into role-mount debugging (observed in AutoMat traces).
    const truncatedStatus = await restricted.get('workflow_run')?.call({
      action: 'status',
      runId: mountedRunId.slice(0, 12),
    })
    expect(truncatedStatus?.isError).toBe(true)
    expect(String(truncatedStatus?.structuredContent?.error)).toContain('was not found')
    expect(String(truncatedStatus?.structuredContent?.error)).not.toContain(
      'not mounted on the selected role',
    )
    expect(String(truncatedStatus?.structuredContent?.error)).toContain(mountedRunId)

    await unrestricted.get('workflow_edit')?.call({
      action: 'save_trigger',
      ref: 'workflow:interactive@0.1.0',
      trigger: {
        trigger_id: 'trg-mounted',
        event_id: 'matos.manual.run',
        config: {},
        status: 1,
      },
    })
    await unrestricted.get('workflow_edit')?.call({
      action: 'save_trigger',
      ref: 'workflow:state-machine@0.1.0',
      trigger: {
        trigger_id: 'trg-unmounted',
        event_id: 'matos.manual.run',
        config: {},
        status: 1,
      },
    })

    const triggers = await restricted.get('workflow_query')?.call({
      action: 'triggers',
    })
    expect(triggers?.isError).not.toBe(true)
    expect(
      (triggers?.structuredContent?.triggers as Array<{ triggerId: string }>).map(
        trigger => trigger.triggerId,
      ),
    ).toEqual(['trg-mounted'])

    const deniedTrigger = await restricted.get('workflow_query')?.call({
      action: 'trigger',
      triggerId: 'trg-unmounted',
    })
    expect(deniedTrigger?.isError).toBe(true)
    expect(deniedTrigger?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )

    const deniedTriggerDelete = await restricted.get('workflow_edit')?.call({
      action: 'delete_trigger',
      triggerId: 'trg-unmounted',
    })
    expect(deniedTriggerDelete?.isError).toBe(true)
    expect(deniedTriggerDelete?.structuredContent?.error).toContain(
      'not mounted on the selected role',
    )
  }, 15000)

  test('runs and responds to a workflow through tool calls', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const compiled = await byName.get('workflow_compile')?.call({
      ref: 'workflow:interactive',
    })
    expect(compiled?.isError).not.toBe(true)
    expect(compiled?.structuredContent).toMatchObject({
      ok: true,
      contracts: {
        nodes: {
          make_file: {
            outputs: {
              exitCode: { type: 'number' },
            },
          },
        },
      },
    })

    const started = await byName.get('workflow_run')?.call({
      ref: 'workflow:interactive',
    })
    expect(started?.isError).not.toBe(true)
    const run = started?.structuredContent?.run as {
      runId: string
      status: string
      waitingNodeId: string
    }
    expect(run.status).toBe('waiting_input')
    expect(run.waitingNodeId).toBe('review')

    const status = await byName.get('workflow_run')?.call({
      action: 'status',
      runId: run.runId,
    })
    expect(status?.isError).not.toBe(true)
    expect(status?.structuredContent).toMatchObject({
      ok: true,
      run: {
        runId: run.runId,
        status: 'waiting_input',
      },
    })

    const completed = await byName.get('workflow_run')?.call({
      action: 'respond',
      runId: run.runId,
      nodeId: 'review',
      response: { approved: true },
    })
    expect(completed?.isError).not.toBe(true)
    expect((completed?.structuredContent?.run as { status: string }).status).toBe(
      'completed',
    )

    const inspectedCompile = await byName.get('workflow_compile_inspect')?.call({
      runId: run.runId,
    })
    expect(inspectedCompile?.isError).not.toBe(true)
    expect(inspectedCompile?.structuredContent).toMatchObject({
      ok: true,
      contracts: {
        nodes: {
          make_file: expect.any(Object),
        },
      },
    })

    const contracts = await byName.get('workflow_contracts')?.call({
      runId: run.runId,
    })
    expect(contracts?.isError).not.toBe(true)
    expect(contracts?.structuredContent).toMatchObject({
      source: 'run',
      runId: run.runId,
      contracts: {
        nodes: {
          make_file: expect.any(Object),
        },
      },
    })
  })

  test('starts a workflow in the background with wait=false and resumes it later', async () => {
    const cwd = await fixture()
    // Neutralize the detached worker so the spawn path is exercised without
    // booting a real matos CLI: `true` ignores its args and exits 0. The run
    // stays in `created` until we advance it synchronously below, proving the
    // tool returned immediately instead of blocking on execution.
    process.env.MATOS_CLI_BIN = 'true'
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const started = await byName.get('workflow_run')?.call({
      action: 'start',
      ref: 'workflow:component',
      wait: false,
    })
    expect(started?.isError).not.toBe(true)
    const startBody = started?.structuredContent as {
      detached?: boolean
      note?: string
      run: { runId: string; status: string }
    }
    // Immediate return: created, not executed, and a detached worker was spawned.
    expect(startBody.run.status).toBe('created')
    expect(startBody.detached).toBe(true)
    expect(startBody.note).toContain('detached background worker')
    const runId = startBody.run.runId

    const status = await byName.get('workflow_run')?.call({
      action: 'status',
      runId,
    })
    expect((status?.structuredContent?.run as { status: string }).status).toBe(
      'created',
    )
    // status now carries a pulse: liveness + progress + next-step guidance.
    const statusPulse = status?.structuredContent?.pulse as {
      status: string
      guidance: string[]
    }
    expect(statusPulse.status).toBe('created')
    expect(statusPulse.guidance.length).toBeGreaterThan(0)

    // Detached starts register a push-notification watch for the session
    // watcher (terminal/waiting/stalled transitions get injected).
    const { listWorkflowRunWatches } = await import('./runPulse.js')
    expect((await listWorkflowRunWatches(cwd)).map(entry => entry.runId)).toContain(
      runId,
    )

    // The created run must be advanceable via resume (the detached worker path).
    const resumed = await byName.get('workflow_run')?.call({
      action: 'resume',
      runId,
    })
    expect(resumed?.isError).not.toBe(true)
    expect((resumed?.structuredContent?.run as { status: string }).status).toBe(
      'completed',
    )

    // wait on a settled run returns immediately with the terminal pulse,
    // recent events, and an event cursor for follow-up waits.
    const waited = await byName.get('workflow_run')?.call({
      action: 'wait',
      runId,
      timeoutSeconds: 5,
    })
    expect(waited?.isError).not.toBe(true)
    const waitBody = waited?.structuredContent as {
      pulse: { status: string; terminal: boolean; guidance: string[] }
      timedOut: boolean
      newEvents: Array<{ type: string }>
      nextSinceEventId: string | null
    }
    expect(waitBody.timedOut).toBe(false)
    expect(waitBody.pulse.status).toBe('completed')
    expect(waitBody.pulse.terminal).toBe(true)
    expect(waitBody.newEvents.map(event => event.type)).toContain(
      'workflow.run.completed',
    )
    expect(waitBody.nextSinceEventId).toBeTruthy()
  }, 20000)

  test('edits workflow drafts through a compact facade tool', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const created = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'create_draft',
      id: 'facade-demo',
      name: 'Facade Demo',
      description: 'Created through workflow_edit',
    })
    expect(created?.isError).not.toBe(true)
    expect(created?.structuredContent).toMatchObject({
      ok: true,
      draft: expect.objectContaining({ draftId: 'facade-demo' }),
    })

    const added = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_node',
      draftId: 'facade-demo',
      node: {
        id: 'hello',
        type: 'exec',
        command: 'printf hello',
      },
    })
    expect(added?.isError).not.toBe(true)
    expect(added?.structuredContent?.definition).toMatchObject({
      nodes: [expect.objectContaining({ id: 'hello', type: 'exec' })],
    })

    const rejectedManifestNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_manifest_node',
      draftId: 'facade-demo',
      nodeType: 'exec',
      nodeId: 'manifest_missing_command',
      fields: {},
    })
    expect(rejectedManifestNode?.isError).toBe(true)
    expect(rejectedManifestNode?.structuredContent?.error).toContain(
      'missing required fields: command',
    )

    const manifestNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_manifest_node',
      draftId: 'facade-demo',
      nodeType: 'exec',
      nodeId: 'manifest_hello',
      dependsOn: ['hello'],
      fields: {
        command: 'printf manifest',
      },
    })
    expect(manifestNode?.isError).not.toBe(true)
    expect(manifestNode?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'manifest_hello',
          type: 'exec',
          runtimeType: 'exec',
          targetType: 'exec',
          dependsOn: ['hello'],
          matosProduct: expect.objectContaining({
            manifestType: 'exec',
            source: 'workflow-tool-input',
          }),
        }),
      ]),
    })

    const rawGuardNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_node',
      draftId: 'facade-demo',
      node: {
        id: 'raw_stdout_guard',
        type: 'guard',
        dependsOn: ['hello'],
        checks: [
          {
            check: 'stdout_contains',
            expect: 'hello',
          },
        ],
      },
    })
    expect(rawGuardNode?.isError).not.toBe(true)
    expect(rawGuardNode?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'raw_stdout_guard',
          type: 'guard',
          checks: [
            expect.objectContaining({
              type: 'expression',
              value: '{{ nodes.hello.outputs.stdout }} contains "hello"',
            }),
          ],
        }),
      ]),
    })

    const mixedArtifactGuardNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_node',
      draftId: 'facade-demo',
      node: {
        id: 'mixed_artifact_guard',
        type: 'guard',
        dependsOn: ['hello'],
        checks: [
          { type: 'file_exists', path: 'result.txt' },
          {
            type: 'regex',
            path: 'result.txt',
            pattern: '(?:NaN|Inf)',
            negate: true,
            failureCode: 'non_finite_result',
            repairHint: 'Inspect the producing node.',
          },
          {
            type: 'file_size',
            path: 'result.txt',
            minBytes: 2,
            failureCode: 'empty_result',
          },
        ],
      },
    })
    expect(mixedArtifactGuardNode?.isError).not.toBe(true)
    expect(mixedArtifactGuardNode?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'mixed_artifact_guard',
          checks: [
            { type: 'file_exists', path: 'result.txt' },
            expect.objectContaining({
              type: 'regex',
              path: 'result.txt',
              negate: true,
              failureCode: 'non_finite_result',
            }),
            expect.objectContaining({
              type: 'file_size',
              path: 'result.txt',
              minBytes: 2,
              failureCode: 'empty_result',
            }),
          ],
        }),
      ]),
    })

    const manifestGuardNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_manifest_node',
      draftId: 'facade-demo',
      nodeType: 'guard',
      nodeId: 'manifest_stdout_guard',
      dependsOn: ['manifest_hello'],
      fields: {
        checks: [
          {
            check: 'stdout_contains',
            expect: 'manifest',
          },
        ],
      },
    })
    expect(manifestGuardNode?.isError).not.toBe(true)
    expect(manifestGuardNode?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'manifest_stdout_guard',
          type: 'guard',
          runtimeType: 'guard',
          targetType: 'guard',
          checks: [
            expect.objectContaining({
              type: 'expression',
              value: '{{ nodes.manifest_hello.outputs.stdout }} contains "manifest"',
            }),
          ],
        }),
      ]),
    })

    const manifestExpressionGuardNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_manifest_node',
      draftId: 'facade-demo',
      nodeType: 'guard',
      nodeId: 'manifest_expression_guard',
      dependsOn: ['manifest_hello'],
      fields: {
        checks: [
          {
            type: 'expression',
            expression: '{{ nodes.manifest_hello.outputs.stdout }} contains "manifest"',
          },
        ],
      },
    })
    expect(manifestExpressionGuardNode?.isError).not.toBe(true)
    expect(manifestExpressionGuardNode?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'manifest_expression_guard',
          type: 'guard',
          checks: [
            expect.objectContaining({
              type: 'expression',
              value: '{{ nodes.manifest_hello.outputs.stdout }} contains "manifest"',
            }),
          ],
        }),
      ]),
    })

    const workspaceAliasNode = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_manifest_node',
      draftId: 'facade-demo',
      nodeType: 'exec',
      nodeId: 'workspace_alias_exec',
      fields: {
        command: 'python3',
        args: ['${workspace}/analyze_claim.py'],
        cwd: '${workspace}',
      },
    })
    expect(workspaceAliasNode?.isError).not.toBe(true)
    expect(workspaceAliasNode?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'workspace_alias_exec',
          args: ['{{ workflow.workspaceDir }}/analyze_claim.py'],
          cwd: '{{ workflow.workspaceDir }}',
        }),
      ]),
    })

    const nodeAliasGuard = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'add_manifest_node',
      draftId: 'facade-demo',
      nodeType: 'guard',
      nodeId: 'node_alias_guard',
      dependsOn: ['workspace_alias_exec'],
      fields: {
        checks: [
          {
            type: 'expression',
            expression: '${ node.workspace_alias_exec.outputs.exitCode } == 0',
          },
        ],
      },
    })
    expect(nodeAliasGuard?.isError).not.toBe(true)
    expect(nodeAliasGuard?.structuredContent?.definition).toMatchObject({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: 'node_alias_guard',
          checks: [
            expect.objectContaining({
              type: 'expression',
              value: '{{ nodes.workspace_alias_exec.outputs.exitCode }} == 0',
            }),
          ],
        }),
      ]),
    })

    const parameters = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'set_parameters',
      draftId: 'facade-demo',
      parameters: {
        structurePath: {
          type: 'string',
          required: true,
          description: 'Input structure path.',
        },
        cutoff: {
          type: 'number',
          default: 520,
        },
      },
    })
    expect(parameters?.isError).not.toBe(true)
    expect(parameters?.structuredContent?.definition).toMatchObject({
      parameters: {
        structurePath: expect.objectContaining({ type: 'string' }),
        cutoff: expect.objectContaining({ default: 520 }),
      },
    })

    const patchedParameters = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'set_parameters',
      draftId: 'facade-demo',
      parameters: {
        cutoff: {
          type: 'number',
          default: 600,
        },
      },
      removeParameters: ['structurePath'],
    })
    expect(patchedParameters?.isError).not.toBe(true)
    expect(patchedParameters?.structuredContent?.definition).toMatchObject({
      parameters: {
        cutoff: expect.objectContaining({ default: 600 }),
      },
    })
    expect(
      (
        patchedParameters?.structuredContent?.definition as {
          parameters?: Record<string, unknown>
        }
      ).parameters?.structurePath,
    ).toBeUndefined()

    const outputs = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'set_outputs',
      draftId: 'facade-demo',
      outputs: {
        message: { value: '{{ nodes.hello.outputs.stdout }}' },
      },
    })
    expect(outputs?.isError).not.toBe(true)
    expect(outputs?.structuredContent?.validation).toMatchObject({ ok: true })

    const compiled = await byName.get('workflow_query')?.call({
      action: 'compile',
      draftId: 'facade-demo',
    })
    expect(compiled?.isError).not.toBe(true)
    expect(compiled?.structuredContent).toMatchObject({
      ok: true,
      workflowRef: 'draft:facade-demo',
    })

    const published = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'publish_draft',
      draftId: 'facade-demo',
      version: '0.1.0',
    })
    expect(published?.isError).not.toBe(true)
    expect(
      (published?.structuredContent?.published as { assetKey: string }).assetKey,
    ).toBe('workflow:facade-demo@0.1.0')

    const forked = await byName.get('workflow_edit')?.call({
      returnDefinition: true,
      action: 'fork_workflow',
      ref: 'workflow:facade-demo',
      id: 'facade-derived',
      name: 'Facade Derived',
      version: '0.2.0',
      description: 'Derived through workflow_edit',
    })
    expect(forked?.isError).not.toBe(true)
    const forkedContent = JSON.parse(String(forked?.text ?? '{}')) as {
      ok?: boolean
      draft: { draftId?: string; sourceWorkflowRef?: string }
      source: { canonicalKey?: string }
      definition: {
        name?: string
        version?: string
        nodes?: Array<{ id?: string }>
      }
      validation: { ok?: boolean }
    }
    const derivedNodes = forkedContent.definition.nodes
    expect(forkedContent).toMatchObject({
      ok: true,
      draft: expect.objectContaining({
        draftId: 'facade-derived',
        sourceWorkflowRef: 'workflow:facade-demo@0.1.0',
      }),
      source: expect.objectContaining({
        canonicalKey: 'workflow:facade-demo@0.1.0',
      }),
      definition: expect.objectContaining({
        name: 'Facade Derived',
        version: '0.2.0',
      }),
      validation: { ok: true },
    })
    expect(derivedNodes?.map(node => node.id)).toContain('hello')
  }, 45000)

  test('requires semantic ids when publishing generated workflow drafts', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const created = await byName.get('workflow_edit')?.call({
      action: 'create_draft',
      name: 'Generated Draft',
    })
    expect(created?.isError).not.toBe(true)
    const draftId = (created?.structuredContent?.draft as { draftId: string }).draftId

    const added = await byName.get('workflow_edit')?.call({
      action: 'add_manifest_node',
      draftId,
      nodeType: 'exec',
      nodeId: 'hello',
      fields: { command: 'printf hello' },
    })
    expect(added?.isError).not.toBe(true)

    const rejected = await byName.get('workflow_edit')?.call({
      action: 'publish_draft',
      draftId,
      version: '0.1.0',
    })
    expect(rejected?.isError).toBe(true)
    expect(rejected?.structuredContent?.error).toContain('requires a semantic id')

    const published = await byName.get('workflow_edit')?.call({
      action: 'publish_draft',
      draftId,
      id: 'semantic-generated',
      version: '0.1.0',
    })
    expect(published?.isError).not.toBe(true)
    expect(
      (published?.structuredContent?.published as { assetKey: string }).assetKey,
    ).toBe('workflow:semantic-generated@0.1.0')
  }, 15000)

  test('queries and edits workflow triggers through compact facade tools', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const events = await byName.get('workflow_query')?.call({
      action: 'trigger_events',
    })
    expect(events?.isError).not.toBe(true)
    expect(events?.structuredContent?.triggerApps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ appId: 'matos-schedule' }),
      ]),
    )

    const saved = await byName.get('workflow_edit')?.call({
      action: 'save_trigger',
      ref: 'workflow:interactive@0.1.0',
      trigger: {
        trigger_id: 'trg-facade',
        event_id: 'matos.manual.run',
        name: 'Facade trigger',
        config: {},
        payload: { parameters: { structure: 'si.cif' } },
        status: 1,
      },
    })
    expect(saved?.isError).not.toBe(true)
    expect(saved?.structuredContent?.trigger).toMatchObject({
      triggerId: 'trg-facade',
      eventId: 'matos.manual.run',
    })

    const listed = await byName.get('workflow_query')?.call({
      action: 'triggers',
      ref: 'workflow:interactive@0.1.0',
    })
    expect(listed?.isError).not.toBe(true)
    expect(listed?.structuredContent?.triggers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ triggerId: 'trg-facade' }),
      ]),
    )

    const detail = await byName.get('workflow_query')?.call({
      action: 'trigger',
      triggerId: 'trg-facade',
    })
    expect(detail?.isError).not.toBe(true)
    expect(detail?.structuredContent?.trigger).toMatchObject({
      triggerId: 'trg-facade',
      workflowRef: 'workflow:interactive@0.1.0',
    })
  })

  test('exposes state-machine frames through workflow tools', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const started = await byName.get('workflow_run')?.call({
      ref: 'workflow:state-machine',
    })
    expect(started?.isError).not.toBe(true)
    const run = started?.structuredContent?.run as {
      runId: string
      stateMachine?: {
        frames: Array<{ frameId: string; activeNodeId: string; status: string }>
      }
    }
    expect(run.stateMachine?.frames).toEqual([
      expect.objectContaining({
        frameId: 'frame-000001',
        activeNodeId: 'draft',
        status: 'completed',
      }),
      expect.objectContaining({
        frameId: 'frame-000002',
        activeNodeId: 'review',
        status: 'completed',
      }),
    ])

    const inspected = await byName.get('workflow_inspect')?.call({
      runId: run.runId,
    })
    expect(inspected?.isError).not.toBe(true)
    expect(
      (inspected?.structuredContent?.run as {
        stateMachine?: { frames: Array<{ activeNodeId: string }> }
      }).stateMachine?.frames.map(frame => frame.activeNodeId),
    ).toEqual(['draft', 'review'])
  })

  test('lets agents draft, compose, and publish reusable workflow assets', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const created = await byName.get('workflow_create_draft')?.call({
      id: 'agent-draft',
      name: 'Agent Draft',
    })
    expect(created?.isError).not.toBe(true)
    expect((created?.structuredContent?.draft as { draftId: string }).draftId).toBe(
      'agent-draft',
    )

    const imported = await byName.get('workflow_import_component')?.call({
      draftId: 'agent-draft',
      ref: 'workflow:component',
    })
    expect(imported?.isError).not.toBe(true)
    expect(
      (
        imported?.structuredContent?.definition as {
          nodes: Array<{ id: string }>
        }
      ).nodes.map(node => node.id),
    ).toEqual(['prepare'])

    const published = await byName.get('workflow_publish_draft')?.call({
      draftId: 'agent-draft',
      id: 'agent-generated',
      version: '0.1.0',
    })
    expect(published?.isError).not.toBe(true)
    expect(
      (published?.structuredContent?.published as { assetKey: string }).assetKey,
    ).toBe('workflow:agent-generated@0.1.0')

    const shown = await byName.get('workflow_show')?.call({
      ref: 'workflow:agent-generated',
    })
    expect(shown?.isError).not.toBe(true)
    expect(
      (
        shown?.structuredContent?.definition as {
          nodes: Array<{ id: string }>
        }
    ).nodes[0]?.id,
    ).toBe('prepare')
  }, 30000)

  test('lets agents fork a workflow run from the configured runs dir into a draft', async () => {
    const cwd = await fixture()
    process.env.MATOS_WORKFLOW_RUNS_DIR = join(cwd, 'custom-workflow-runs')
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const started = await byName.get('workflow_run')?.call({
      ref: 'workflow:interactive',
    })
    expect(started?.isError).not.toBe(true)
    const run = started?.structuredContent?.run as {
      runId: string
      runDir: string
      status: string
    }
    expect(run.runDir.startsWith(process.env.MATOS_WORKFLOW_RUNS_DIR)).toBe(true)

    const forked = await byName.get('workflow_fork_run')?.call({
      runId: run.runId,
      id: 'forked-from-run',
      name: 'Forked From Run',
    })

    expect(forked?.isError).not.toBe(true)
    expect(
      (forked?.structuredContent?.draft as { draftId: string; sourceRunId?: string })
        .draftId,
    ).toBe('forked-from-run')
    expect(
      (forked?.structuredContent?.draft as { draftId: string; sourceRunId?: string })
        .sourceRunId,
    ).toBe(run.runId)
    expect(
      (forked?.structuredContent?.definition as { nodes: Array<{ id: string }> })
        .nodes.map(node => node.id),
    ).toEqual(['make_file', 'review'])
  })

  test('lets agents list and inspect dynamic patch ledgers', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const run = await byName.get('workflow_run')?.call({
      ref: 'workflow:dynamic-auto',
    })
    expect(run?.isError).not.toBe(true)
    const runId = (run?.structuredContent?.run as { runId: string }).runId

    const patches = await byName.get('workflow_patches')?.call({ runId })
    expect(patches?.isError).not.toBe(true)
    expect(patches?.structuredContent?.patches).toEqual([
      expect.objectContaining({
        patchId: 'plan-add-bounded-review-node',
        decision: expect.objectContaining({ status: 'applied' }),
      }),
    ])

    const inspected = await byName.get('workflow_patch_inspect')?.call({
      runId,
      patchId: 'plan-add-bounded-review-node',
    })
    expect(inspected?.isError).not.toBe(true)
    expect(inspected?.structuredContent?.patch).toMatchObject({
      patchId: 'plan-add-bounded-review-node',
      candidate: {
        schemaVersion: 1,
        operations: [{ op: 'add_node' }, { op: 'add_edge' }],
      },
      decision: { status: 'applied' },
    })
  })

  test('lets agents propose graph patches and surfaces validation errors', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const run = await byName.get('workflow_run')?.call({
      ref: 'workflow:dynamic-auto',
    })
    expect(run?.isError).not.toBe(true)
    const runId = (run?.structuredContent?.run as { runId: string }).runId

    // delete_node is rejected for an active/recorded run, so the tool must
    // surface a validation error instead of silently writing a bad ledger.
    const invalid = await byName.get('workflow_patch_propose')?.call({
      runId,
      operations: [{ op: 'delete_node', nodeId: 'any-node' }],
      reason: 'invalid delete attempt',
    })
    expect(invalid?.isError).toBe(true)

    const afterInvalid = await byName.get('workflow_patches')?.call({ runId })
    const existingPatchIds = (
      (afterInvalid?.structuredContent?.patches as
        | { patchId: string }[]
        | undefined) ?? []
    ).map(patch => patch.patchId)
    expect(existingPatchIds).not.toContain('any-node')
  })

  test('lets agents reject proposed dynamic patch ledgers', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const run = await byName.get('workflow_run')?.call({
      ref: 'workflow:dynamic-high-risk',
    })
    expect(run?.isError).not.toBe(true)
    const started = run?.structuredContent?.run as {
      runId: string
      status: string
      waitingNodeId?: string
    }
    expect(started.status).toBe('waiting_input')
    expect(started.waitingNodeId).toBe('plan')

    const rejected = await byName.get('workflow_patch_reject')?.call({
      runId: started.runId,
      patchId: 'plan-add-bounded-review-node',
      reason: 'test rejection',
    })
    expect(rejected?.isError).not.toBe(true)
    expect(rejected?.structuredContent?.patch).toMatchObject({
      patchId: 'plan-add-bounded-review-node',
      decision: { status: 'rejected', reason: 'test rejection' },
    })
    expect(rejected?.structuredContent?.run).toMatchObject({
      status: 'failed',
      waitingNodeId: undefined,
    })
  })

  test('lets agents build workflow drafts node by node through native tools', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const created = await byName.get('workflow_create_draft')?.call({
      id: 'node-builder',
      name: 'Node Builder',
    })
    expect(created?.isError).not.toBe(true)

    const addedExec = await byName.get('workflow_add_node')?.call({
      draftId: 'node-builder',
      node: {
        id: 'write_file',
        type: 'exec',
        config: { command: 'printf ok > built.txt' },
      },
    })
    expect(addedExec?.isError).not.toBe(true)

    const addedGuard = await byName.get('workflow_add_node')?.call({
      draftId: 'node-builder',
      node: {
        id: 'check_file',
        type: 'guard',
        guardType: 'file_exists',
        path: 'built.txt',
      },
    })
    expect(addedGuard?.isError).not.toBe(true)
    expect(
      (
        addedGuard?.structuredContent?.definition as {
          nodes: Array<{
            id: string
            checks?: Array<{ type: string; path: string }>
          }>
        }
      ).nodes.find(node => node.id === 'check_file')?.checks,
    ).toEqual([{ type: 'file_exists', path: 'built.txt' }])

    const connected = await byName.get('workflow_connect')?.call({
      draftId: 'node-builder',
      from: 'write_file',
      to: 'check_file',
    })
    expect(connected?.isError).not.toBe(true)
    expect(
      (
        connected?.structuredContent?.definition as {
          nodes: Array<{ id: string; dependsOn: string[] }>
        }
      ).nodes.find(node => node.id === 'check_file')?.dependsOn,
    ).toEqual(['write_file'])

    const disconnected = await byName.get('workflow_disconnect')?.call({
      draftId: 'node-builder',
      from: 'write_file',
      to: 'check_file',
    })
    expect(disconnected?.isError).not.toBe(true)
    expect(
      (
        disconnected?.structuredContent?.definition as {
          nodes: Array<{ id: string; dependsOn: string[] }>
        }
      ).nodes.find(node => node.id === 'check_file')?.dependsOn,
    ).toEqual([])

    const reconnected = await byName.get('workflow_connect')?.call({
      draftId: 'node-builder',
      from: 'write_file',
      to: 'check_file',
    })
    expect(reconnected?.isError).not.toBe(true)

    const updated = await byName.get('workflow_update_node')?.call({
      draftId: 'node-builder',
      nodeId: 'write_file',
      patch: {
        command: 'printf updated > built.txt',
      },
    })
    expect(updated?.isError).not.toBe(true)
    expect(
      (
        updated?.structuredContent?.definition as {
          nodes: Array<{ id: string; command?: string }>
        }
      ).nodes.find(node => node.id === 'write_file')?.command,
    ).toContain('updated')

    const outputs = await byName.get('workflow_set_outputs')?.call({
      draftId: 'node-builder',
      outputs: {
        ok: { value: '{{ nodes.check_file.outputs.ok }}' },
      },
    })
    expect(outputs?.isError).not.toBe(true)

    const validation = await byName.get('workflow_validate_draft')?.call({
      draftId: 'node-builder',
    })
    expect(validation?.isError).not.toBe(true)
    expect(validation?.structuredContent?.validation).toMatchObject({ ok: true })

    const compiled = await byName.get('workflow_compile')?.call({
      draftId: 'node-builder',
    })
    expect(compiled?.isError).not.toBe(true)
    expect(compiled?.structuredContent).toMatchObject({
      ok: true,
      workflowRef: 'draft:node-builder',
      metadata: {
        compilerVersion: 'matos-workflow-compile-v1',
        nodeCount: 2,
      },
      contracts: {
        nodes: {
          write_file: {
            outputs: {
              stdout: { type: 'string' },
            },
          },
        },
      },
    })

    const published = await byName.get('workflow_publish_draft')?.call({
      draftId: 'node-builder',
      id: 'node-builder',
      version: '0.1.0',
    })
    expect(published?.isError).not.toBe(true)

    const run = await byName.get('workflow_run')?.call({
      ref: 'workflow:node-builder',
    })
    expect(run?.isError).not.toBe(true)
    expect((run?.structuredContent?.run as { status: string }).status).toBe(
      'completed',
    )

    const clearedOutputs = await byName.get('workflow_set_outputs')?.call({
      draftId: 'node-builder',
      outputs: {},
    })
    expect(clearedOutputs?.isError).not.toBe(true)

    const deleteResult = await byName.get('workflow_delete_node')?.call({
      draftId: 'node-builder',
      nodeId: 'check_file',
    })
    expect(deleteResult?.isError).not.toBe(true)
    expect(
      (
        deleteResult?.structuredContent?.definition as {
          nodes: Array<{ id: string }>
        }
      ).nodes.map(node => node.id),
    ).toEqual(['write_file'])
    // The long draft-editing tool chain measures ~25s alone on the shared dev
    // host; the previous 30s cap flaked under load.
  }, 45000)

  test('rejects unsupported workflow output template namespaces in draft validation', async () => {
    const cwd = await fixture()
    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    await byName.get('workflow_create_draft')?.call({
      id: 'bad-template',
      name: 'Bad Template',
    })
    await byName.get('workflow_add_node')?.call({
      draftId: 'bad-template',
      node: {
        id: 'check_file',
        type: 'guard',
        checks: [{ type: 'file_exists', path: 'built.txt' }],
      },
    })

    const outputs = await byName.get('workflow_set_outputs')?.call({
      draftId: 'bad-template',
      outputs: {
        ok: { value: '{{ steps.check_file.outputs.passed }}' },
      },
    })

    expect(outputs?.isError).toBe(true)
    expect(outputs?.structuredContent?.error).toContain(
      'unsupported template "steps.check_file.outputs.passed"',
    )
    const validation = await byName.get('workflow_validate_draft')?.call({
      draftId: 'bad-template',
    })
    expect(validation?.structuredContent?.validation).toMatchObject({ ok: true })
  }, 15000)

  test('lets agents pause, resume, retry, and skip workflow runs', async () => {
    const cwd = await fixture()
    const workflowDir = join(cwd, '.matos', 'assets', 'workflows', 'ops')
    await mkdir(workflowDir, { recursive: true })
    await writeJson(join(workflowDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'ops',
      type: 'workflow',
      name: 'Ops',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(workflowDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'ops',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        result: { value: '{{ nodes.flaky.outputs.stdout }}' },
      },
      nodes: [
        {
          id: 'review',
          type: 'human',
          dependsOn: [],
          prompt: 'Continue?',
        },
        {
          id: 'flaky',
          type: 'exec',
          dependsOn: ['review'],
          command:
            'if [ ! -f retry-marker ]; then touch retry-marker; exit 7; fi; printf tool-retry-ok',
        },
      ],
    })

    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))

    const started = await byName.get('workflow_run')?.call({ ref: 'workflow:ops' })
    const runId = (started?.structuredContent?.run as { runId: string }).runId

    const paused = await byName.get('workflow_pause')?.call({ runId })
    expect(paused?.isError).not.toBe(true)
    expect((paused?.structuredContent?.run as { status: string }).status).toBe(
      'paused',
    )

    const resumed = await byName.get('workflow_resume')?.call({ runId })
    expect(resumed?.isError).not.toBe(true)
    expect((resumed?.structuredContent?.run as { status: string }).status).toBe(
      'waiting_input',
    )

    const reconciled = await byName.get('workflow_reconcile')?.call({ runId })
    expect(reconciled?.isError).not.toBe(true)
    expect(reconciled?.structuredContent?.reconciled).toEqual([])
    expect((reconciled?.structuredContent?.run as { status: string }).status).toBe(
      'waiting_input',
    )

    const recovered = await byName.get('workflow_recover')?.call({ runId })
    expect(recovered?.isError).not.toBe(true)
    expect(recovered?.structuredContent?.recovery).toBeDefined()

    const recoverQueue = await byName.get('workflow_recover_queue')?.call({})
    expect(recoverQueue?.isError).not.toBe(true)
    expect(recoverQueue?.structuredContent?.ok).toBe(true)

    const failed = await byName.get('workflow_respond')?.call({
      runId,
      nodeId: 'review',
      response: { approved: true },
    })
    expect((failed?.structuredContent?.run as { status: string }).status).toBe(
      'failed',
    )

    const retried = await byName.get('workflow_retry_node')?.call({
      runId,
      nodeId: 'flaky',
    })
    expect(retried?.isError).not.toBe(true)
    expect((retried?.structuredContent?.run as { status: string }).status).toBe(
      'completed',
    )

    const skipped = await byName.get('workflow_skip_node')?.call({
      runId,
      nodeId: 'flaky',
      reason: 'already completed',
    })
    expect(skipped?.isError).toBe(true)
  })

  test('lets agents retry only failed aggregate map children', async () => {
    const cwd = await fixture()
    const childDir = join(cwd, '.matos', 'assets', 'workflows', 'retryable-tool-child')
    const parentDir = join(cwd, '.matos', 'assets', 'workflows', 'map-selective-tool')
    await mkdir(childDir, { recursive: true })
    await mkdir(parentDir, { recursive: true })
    await writeJson(join(childDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'retryable-tool-child',
      type: 'workflow',
      name: 'Retryable Tool Child',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(childDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'retryable-tool-child',
      parameters: {
        item: { type: 'string', default: 'none' },
        failItems: { type: 'string', default: 'bad' },
      },
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        item: { value: '{{ parameters.item }}' },
        done: { value: '{{ nodes.mark.outputs.stdout }}' },
      },
      nodes: [
        {
          id: 'mark',
          type: 'exec',
          dependsOn: [],
          command:
            'case ",{{ parameters.failItems }}," in *,"{{ parameters.item }}",*) if [ ! -f "retry-{{ parameters.item }}.marker" ]; then touch "retry-{{ parameters.item }}.marker"; echo "first failure {{ parameters.item }}" >&2; exit 7; fi;; esac; printf "{{ parameters.item }}," >> successful-items.log && printf "{{ parameters.item }}"',
        },
      ],
    })
    await writeJson(join(parentDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'map-selective-tool',
      type: 'workflow',
      name: 'Map Selective Tool',
      version: '0.1.0',
      entry: 'workflow.json',
      runtime: { workflow: { kind: 'executable' } },
    })
    await writeJson(join(parentDir, 'workflow.json'), {
      schemaVersion: 1,
      name: 'map-selective-tool',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {
        final: { value: '{{ nodes.report.outputs.stdout }}' },
        completed: { value: '{{ nodes.scan.outputs.completedCount }}' },
        failed: { value: '{{ nodes.scan.outputs.failedCount }}' },
      },
      nodes: [
        {
          id: 'scan',
          type: 'map',
          dependsOn: [],
          workflow: 'workflow:retryable-tool-child',
          items: ['si', 'bad', 'ge'],
          itemParameter: 'item',
          parameters: { failItems: 'bad' },
          outputKeys: ['item', 'done'],
          failureMode: 'aggregate',
        },
        {
          id: 'report',
          type: 'exec',
          dependsOn: ['scan'],
          command:
            'printf "{{ nodes.scan.outputs.completedCount }}/{{ nodes.scan.outputs.failedCount }}" > final-report.txt && cat final-report.txt',
        },
      ],
    })

    const tools = createMatOSWorkflowTools({ cwd })
    const byName = new Map(tools.map(tool => [tool.name, tool]))
    const started = await byName.get('workflow_run')?.call({
      ref: 'workflow:map-selective-tool',
    })
    const failedRun = started?.structuredContent?.run as {
      runId: string
      runDir: string
      status: string
    }
    expect(failedRun.status).toBe('failed')
    const runSnapshot = JSON.parse(
      await readFile(join(failedRun.runDir, 'run.json'), 'utf8'),
    ) as { workspaceDir: string }
    expect(await readFile(join(runSnapshot.workspaceDir, 'successful-items.log'), 'utf8')).toBe(
      'si,ge,',
    )

    const retried = await byName.get('workflow_retry_node')?.call({
      runId: failedRun.runId,
      nodeId: 'scan',
      failedChildrenOnly: true,
    })
    expect(retried?.isError).not.toBe(true)
    expect(
      (retried?.structuredContent?.run as {
        status: string
        outputs: { final: string; completed: number; failed: number }
      }).outputs,
    ).toMatchObject({
      final: '3/0',
      completed: 3,
      failed: 0,
    })
    expect(await readFile(join(runSnapshot.workspaceDir, 'successful-items.log'), 'utf8')).toBe(
      'si,ge,bad,',
    )
    expect(
      await stat(
        join(failedRun.runDir, 'rounds', 'scan', '0002', 'retry-02', 'summary.md'),
      ),
    ).toBeTruthy()
    // Two full parent runs with four subworkflow child runs measure ~14s alone
    // on the shared dev host; 15s left no headroom and flaked under load.
  }, 45000)
})
