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

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { getMatOSConfigPath } from '../project.js'
import {
  inspectWorkflowRun,
  retryWorkflowNode,
  startWorkflowRun,
} from './workflowRuntime.js'
import { normalizeWorkflowMapItems } from './nodeAdapters/mapNode.js'
import { resolvePinnedChildWorkflow } from './childWorkflowSnapshot.js'

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T
}

async function installChildWorkflow(root: string): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'child')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'child',
    type: 'workflow',
    name: 'Child',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'child',
    parameters: {
      item: { type: 'string', default: 'none' },
      iteration: { type: 'number', default: 0 },
    },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {
      item: { value: '{{ parameters.item }}' },
      iteration: { value: '{{ parameters.iteration }}' },
      done: { value: '{{ nodes.mark.outputs.stdout }}' },
    },
    nodes: [
      {
        id: 'mark',
        type: 'exec',
        dependsOn: [],
        command:
          'printf "{{ parameters.item }}:{{ parameters.iteration }}" >> iterations.log && printf "{{ parameters.item }}:{{ parameters.iteration }}"',
      },
    ],
  })
}

async function installSlowChildWorkflow(root: string): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'slow-child')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'slow-child',
    type: 'workflow',
    name: 'Slow Child',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'slow-child',
    parameters: {
      item: { type: 'string', default: 'none' },
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
          'mkdir -p slow-active; touch "slow-active/{{ parameters.item }}"; active_count=$(find slow-active -type f | wc -l | tr -d " "); printf "{{ parameters.item }}:%s\\n" "$active_count" >> slow-active.log; printf "{{ parameters.item }}\\n" >> slow-starts.log; sleep 0.4; rm -f "slow-active/{{ parameters.item }}"; printf "{{ parameters.item }}"',
      },
    ],
  })
}

async function installSelfRemovingChildWorkflow(root: string): Promise<void> {
  const workflowDir = join(
    root,
    '.matos',
    'assets',
    'workflows',
    'self-removing-child',
  )
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'self-removing-child',
    type: 'workflow',
    name: 'Self Removing Child',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'self-removing-child',
    parameters: { item: { type: 'string', default: 'none' } },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: { item: { value: '{{ parameters.item }}' } },
    nodes: [
      {
        id: 'remove_source',
        type: 'exec',
        dependsOn: [],
        command:
          'if [ "{{ parameters.item }}" = "first" ]; then rm -rf .matos/assets/workflows/self-removing-child; fi; printf "{{ parameters.item }}"',
      },
    ],
  })
}

async function installFailingChildWorkflow(root: string): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'maybe-fail')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'maybe-fail',
    type: 'workflow',
    name: 'Maybe Fail',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'maybe-fail',
    parameters: {
      item: { type: 'string', default: 'none' },
      failItem: { type: 'string', default: 'bad' },
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
          'if [ "{{ parameters.item }}" = "{{ parameters.failItem }}" ]; then echo "failed {{ parameters.item }}" >&2; exit 7; fi; printf "{{ parameters.item }}" >> successful-items.log && printf "{{ parameters.item }}"',
      },
    ],
  })
}

async function installRetryableFailingChildWorkflow(root: string): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'retryable-fail')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'retryable-fail',
    type: 'workflow',
    name: 'Retryable Fail',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'retryable-fail',
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
}

async function installStatefulChildWorkflow(root: string): Promise<void> {
  const workflowDir = join(root, '.matos', 'assets', 'workflows', 'stateful-child')
  await mkdir(workflowDir, { recursive: true })
  await writeJson(getMatOSConfigPath(root), {
    version: 1,
    assetRoots: ['assets'],
    includeDefaultAssetRoots: false,
  })
  await writeJson(join(workflowDir, 'asset.json'), {
    schemaVersion: 1,
    id: 'stateful-child',
    type: 'workflow',
    name: 'Stateful Child',
    version: '0.1.0',
    entry: 'workflow.json',
    runtime: { workflow: { kind: 'executable' } },
  })
  await writeJson(join(workflowDir, 'workflow.json'), {
    schemaVersion: 1,
    name: 'stateful-child',
    parameters: {
      x: { type: 'string', default: '0' },
      iteration: { type: 'number', default: 0 },
      loopState: { type: 'object', default: {} },
      previousRound: { type: 'object', default: {} },
    },
    policy: { approvalMode: 'bypass', defaultRisk: 'low' },
    outputs: {
      x: { value: '{{ parameters.x }}' },
      iteration: { value: '{{ parameters.iteration }}' },
      state: { value: '{{ parameters.loopState }}' },
      previous: { value: '{{ parameters.previousRound }}' },
      nextX: { value: '{{ nodes.bump.outputs.stdout }}' },
    },
    nodes: [
      {
        id: 'bump',
        type: 'exec',
        dependsOn: [],
        command:
          'next=$(({{ parameters.x }} + 1)); printf "%s:%s->%s\\n" "{{ parameters.iteration }}" "{{ parameters.x }}" "$next" >> stateful.log; printf "%s" "$next"',
      },
    ],
  })
}

describe('MatOS workflow bounded iteration nodes', () => {
  test('normalizes common agent-produced map item encodings', () => {
    expect(normalizeWorkflowMapItems('```json\n["a","b"]\n```')).toEqual([
      'a',
      'b',
    ])
    expect(normalizeWorkflowMapItems(JSON.stringify({ items: ['x', 'y'] }))).toEqual([
      'x',
      'y',
    ])
    expect(normalizeWorkflowMapItems(JSON.stringify(JSON.stringify(['p', 'q'])))).toEqual([
      'p',
      'q',
    ])
  })

  test('map runs a child workflow once per finite item and records iterations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-'))
    await installChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          count: { value: '{{ nodes.scan.outputs.count }}' },
        },
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:child',
            items: ['si', 'ge', 'gaas'],
            itemParameter: 'item',
            parameters: { iteration: 1 },
            outputKeys: ['item', 'done'],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.count).toBe(3)
    expect(await readFile(join(root, 'iterations.log'), 'utf8')).toBe(
      'si:1ge:1gaas:1',
    )
    const iteration = JSON.parse(
      await readFile(
        join(run.runDir, 'iterations', 'scan', '1', 'iteration.json'),
        'utf8',
      ),
    )
    expect(iteration).toMatchObject({
      index: 1,
      item: 'si',
      status: 'completed',
      outputs: { item: 'si', done: 'si:1' },
    })

    const roundInput = await readJson<{
      nodeId: string
      index: number
      item: string
      parameters: { item: string; iteration: number }
    }>(join(run.runDir, 'rounds', 'scan', '0001', 'inputs.json'))
    expect(roundInput).toEqual({
      nodeId: 'scan',
      index: 1,
      item: 'si',
      parameters: { item: 'si', iteration: 1 },
    })
    expect(
      await readJson(join(run.runDir, 'rounds', 'scan', '0003', 'validation.json')),
    ).toMatchObject({
      status: 'completed',
      ok: true,
    })
    expect(
      await readFile(join(run.runDir, 'rounds', 'scan', '0003', 'summary.md'), 'utf8'),
    ).toContain('status: completed')

    const inspected = await inspectWorkflowRun(run.runDir)
    expect(inspected.budget?.ownTotals.nodeAttempts).toBe(1)
    expect(inspected.budget?.childWorkflowTotals.nodeAttempts).toBe(3)
    expect(inspected.budget?.totals.nodeAttempts).toBe(4)
    expect(inspected.budget?.totals.toolCalls).toBe(4)
    expect(inspected.budget?.childWorkflowRuns.map(child => child.runId).sort()).toHaveLength(3)
  })

  test('map pins one child definition before the first item mutates the asset registry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-pinned-child-'))
    await installSelfRemovingChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:pinned-map-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'pinned-map-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          completed: { value: '{{ nodes.scan.outputs.completedCount }}' },
        },
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:self-removing-child',
            items: ['first', 'second'],
            itemParameter: 'item',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.completed).toBe(2)
    const snapshots = await readdir(join(run.runDir, 'child-workflow-snapshots'))
    expect(snapshots).toHaveLength(1)
    expect(
      await readJson<{ workflowRef: string }>(
        join(run.runDir, 'child-workflow-snapshots', snapshots[0]),
      ),
    ).toMatchObject({ workflowRef: 'workflow:self-removing-child@0.1.0' })
  })

  test('reuses a persisted child snapshot after its registry source disappears', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-child-snapshot-'))
    await installChildWorkflow(root)
    const runDir = join(root, 'workflows', 'runs', 'parent-run')
    await mkdir(runDir, { recursive: true })
    const node = {
      id: 'scan',
      type: 'map' as const,
      dependsOn: [],
      workflow: 'workflow:child',
    }

    const first = await resolvePinnedChildWorkflow({ cwd: root, runDir, node })
    await rm(join(root, '.matos', 'assets', 'workflows', 'child'), {
      recursive: true,
      force: true,
    })
    const recovered = await resolvePinnedChildWorkflow({ cwd: root, runDir, node })

    expect(recovered).toEqual(first)
    expect(recovered.workflowRef).toBe('workflow:child@0.1.0')
  })

  test('map accepts parameter-template item lists from JSON string input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-json-string-'))
    await installChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-json-string-parent@0.1.0',
      parameters: { itemList: '["0.5C","1C","2C"]' },
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-json-string-parent',
        parameters: {
          itemList: { type: 'string', default: '["0.5C","1C"]' },
        },
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          count: { value: '{{ nodes.scan.outputs.count }}' },
        },
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:child',
            items: '{{ parameters.itemList }}',
            itemParameter: 'item',
            parameters: { iteration: 1 },
            outputKeys: ['item', 'done'],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.count).toBe(3)
    expect(await readFile(join(root, 'iterations.log'), 'utf8')).toBe(
      '0.5C:11C:12C:1',
    )
  })

  test('map accepts parameter-template item lists from double-encoded JSON input', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-json-encoded-'))
    await installChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-json-encoded-parent@0.1.0',
      parameters: {
        itemList: JSON.stringify(JSON.stringify(['voltage', 'capacity', 'energy'])),
      },
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-json-encoded-parent',
        parameters: {
          itemList: {
            type: 'string',
            default: JSON.stringify(JSON.stringify(['voltage'])),
          },
        },
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          count: { value: '{{ nodes.scan.outputs.count }}' },
        },
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:child',
            items: '{{ parameters.itemList }}',
            itemParameter: 'item',
            parameters: { iteration: 1 },
            outputKeys: ['item', 'done'],
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.count).toBe(3)
    expect(await readFile(join(root, 'iterations.log'), 'utf8')).toBe(
      'voltage:1capacity:1energy:1',
    )
  })

  test('map honors explicit bounded parallel child workflow execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-parallel-'))
    await installSlowChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-parallel-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-parallel-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          count: { value: '{{ nodes.scan.outputs.count }}' },
        },
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:slow-child',
            items: ['a', 'b', 'c'],
            itemParameter: 'item',
            outputKeys: ['item', 'done'],
            maxParallel: 3,
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.count).toBe(3)
    const nodeRun = await readJson<{
      output: {
        summary: { maxParallel: number }
        iterations: Array<{ index: number; item: string }>
      }
    }>(join(run.runDir, 'node-runs', 'scan', 'node-run.json'))
    expect(nodeRun.output.summary.maxParallel).toBe(3)
    expect(nodeRun.output.iterations.map(iteration => iteration.item)).toEqual([
      'a',
      'b',
      'c',
    ])
    const starts = (await readFile(join(root, 'slow-starts.log'), 'utf8'))
      .trim()
      .split('\n')
      .sort()
    expect(starts).toEqual(['a', 'b', 'c'])
    const activeCounts = (await readFile(join(root, 'slow-active.log'), 'utf8'))
      .trim()
      .split('\n')
      .map(line => Number(line.split(':')[1]))
    expect(activeCounts).toHaveLength(3)
    expect(activeCounts.every(Number.isFinite)).toBe(true)
    expect(activeCounts.some(count => count > 1)).toBe(true)
  })

  test('map maxItems caps item fan-out independently of maxParallel', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-max-items-'))
    await installChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-max-items-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-max-items-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          count: { value: '{{ nodes.scan.outputs.count }}' },
        },
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:child',
            items: ['si', 'ge', 'gaas'],
            itemParameter: 'item',
            parameters: { iteration: 1 },
            outputKeys: ['item', 'done'],
            maxItems: 1,
            maxParallel: 3,
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.count).toBe(1)
    expect(await readFile(join(root, 'iterations.log'), 'utf8')).toBe('si:1')
    const nodeRun = await readJson<{
      output: {
        summary: {
          total: number
          sourceTotal: number
          maxItems: number
          maxParallel: number
          truncated: boolean
        }
        iterations: Array<{ index: number; item: string }>
      }
    }>(join(run.runDir, 'node-runs', 'scan', 'node-run.json'))
    expect(nodeRun.output.summary).toMatchObject({
      total: 1,
      sourceTotal: 3,
      maxItems: 1,
      maxParallel: 3,
      truncated: true,
    })
    expect(nodeRun.output.iterations.map(iteration => iteration.item)).toEqual([
      'si',
    ])
  })

  test('map aggregates child failures after running every item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-failure-'))
    await installFailingChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-failure-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-failure-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {},
        nodes: [
          {
            id: 'scan',
            type: 'map',
            dependsOn: [],
            workflow: 'workflow:maybe-fail',
            items: ['si', 'bad', 'ge'],
            itemParameter: 'item',
            parameters: { failItem: 'bad' },
            outputKeys: ['item', 'done'],
            failureMode: 'aggregate',
          },
        ],
      },
    })

    expect(run.status).toBe('failed')
    expect(await readFile(join(root, 'successful-items.log'), 'utf8')).toBe('sige')

    const nodeRun = await readJson<{
      status: string
      output: {
        count: number
        completedCount: number
        failedCount: number
        failures: Array<{ index: number; item: string; status: string }>
        summary: { total: number; completed: number; failed: number }
      }
    }>(join(run.runDir, 'node-runs', 'scan', 'node-run.json'))
    expect(nodeRun.status).toBe('failed')
    expect(nodeRun.output).toMatchObject({
      count: 3,
      completedCount: 2,
      failedCount: 1,
      summary: { total: 3, completed: 2, failed: 1 },
    })
    expect(nodeRun.output.failures).toEqual([
      expect.objectContaining({ index: 2, item: 'bad', status: 'failed' }),
    ])

    expect(
      await readJson(join(run.runDir, 'iterations', 'scan', '3', 'iteration.json')),
    ).toMatchObject({
      index: 3,
      item: 'ge',
      status: 'completed',
    })
    expect(
      await readJson(join(run.runDir, 'rounds', 'scan', '0002', 'validation.json')),
    ).toMatchObject({
      status: 'failed',
      ok: false,
    })
    expect(
      await readJson(join(run.runDir, 'rounds', 'scan', '0002', 'decision.json')),
    ).toMatchObject({
      decision: 'fail',
      reason: 'child_failed',
    })
  })

  test('map failed children can be retried without rerunning successful children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-map-selective-retry-'))
    await installRetryableFailingChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:map-selective-retry-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'map-selective-retry-parent',
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
            workflow: 'workflow:retryable-fail',
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
      },
    })

    expect(run.status).toBe('failed')
    expect(await readFile(join(root, 'successful-items.log'), 'utf8')).toBe('si,ge,')

    const retried = await retryWorkflowNode({
      runDir: run.runDir,
      nodeId: 'scan',
      failedChildrenOnly: true,
    })

    expect(retried.status).toBe('completed')
    expect(retried.outputs).toMatchObject({ final: '3/0', completed: 3, failed: 0 })
    expect(await readFile(join(root, 'successful-items.log'), 'utf8')).toBe(
      'si,ge,bad,',
    )
    expect(await readFile(join(root, 'final-report.txt'), 'utf8')).toBe('3/0')
    const repairedNodeRun = await readJson<{
      attempts: number
      output: { failedCount: number }
    }>(join(run.runDir, 'node-runs', 'scan', 'node-run.json'))
    expect(repairedNodeRun.attempts).toBe(2)
    expect(repairedNodeRun.output.failedCount).toBe(0)
    expect(
      await readJson(join(run.runDir, 'node-runs', 'scan', 'attempts', '2', 'output.json')),
    ).toMatchObject({ failedCount: 0 })
    expect(
      await readJson(join(run.runDir, 'rounds', 'scan', '0002', 'retry-02', 'validation.json')),
    ).toMatchObject({
      status: 'completed',
      ok: true,
    })
  })

  test('loop stops when the until condition is satisfied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-loop-'))
    await installChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:loop-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'loop-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          iterations: { value: '{{ nodes.relax.outputs.count }}' },
          stoppedBy: { value: '{{ nodes.relax.outputs.stoppedBy }}' },
        },
        nodes: [
          {
            id: 'relax',
            type: 'loop',
            dependsOn: [],
            workflow: 'workflow:child',
            maxIterations: 3,
            iterationParameter: 'iteration',
            parameters: { item: 'si' },
            until: '{{ nodes.current.outputs.iteration }} == 2',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.iterations).toBe(2)
    expect(run.outputs.stoppedBy).toBe('until')
  })

  test('loop resolves maxIterations from a workflow parameter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-loop-limit-'))
    await installChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:loop-limit-parent@0.1.0',
      parameters: { maxRounds: 1 },
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'loop-limit-parent',
        parameters: {
          maxRounds: { type: 'number', default: 4 },
        },
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          iterations: { value: '{{ nodes.relax.outputs.count }}' },
          stoppedBy: { value: '{{ nodes.relax.outputs.stoppedBy }}' },
        },
        nodes: [
          {
            id: 'relax',
            type: 'loop',
            dependsOn: [],
            workflow: 'workflow:child',
            maxIterations: '{{ parameters.maxRounds }}',
            iterationParameter: 'iteration',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs.iterations).toBe(1)
    expect(run.outputs.stoppedBy).toBe('maxIterations')
  })

  test('loop carries reducer state and next parameters across child workflow rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-loop-state-'))
    await installStatefulChildWorkflow(root)

    const run = await startWorkflowRun({
      cwd: root,
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:loop-state-parent@0.1.0',
      parameters: {},
      workspaceDir: root,
      definition: {
        schemaVersion: 1,
        name: 'loop-state-parent',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        outputs: {
          iterations: { value: '{{ nodes.relax.outputs.count }}' },
          stoppedBy: { value: '{{ nodes.relax.outputs.stoppedBy }}' },
          x: { value: '{{ nodes.relax.outputs.state.x }}' },
        },
        nodes: [
          {
            id: 'relax',
            type: 'loop',
            dependsOn: [],
            workflow: 'workflow:stateful-child',
            maxIterations: 4,
            iterationParameter: 'iteration',
            stateParameter: 'loopState',
            previousParameter: 'previousRound',
            parameters: { x: '0' },
            initialState: { x: '0' },
            nextParameters: {
              x: '{{ nodes.current.outputs.nextX }}',
            },
            nextState: {
              x: '{{ nodes.current.outputs.nextX }}',
              currentOutputX: '{{ loop.outputs.nextX }}',
              lastIteration: '{{ loop.iteration }}',
              previousX: '{{ loop.state.x }}',
            },
            until: '{{ loop.state.x }} == 2',
          },
        ],
      },
    })

    expect(run.status).toBe('completed')
    expect(run.outputs).toMatchObject({
      iterations: 2,
      stoppedBy: 'until',
      x: '2',
    })
    expect(await readFile(join(root, 'stateful.log'), 'utf8')).toBe(
      '1:0->1\n2:1->2\n',
    )
    const nodeRun = await readJson<{
      output: {
        state: Record<string, unknown>
        parameters: Record<string, unknown>
        iterations: Array<{
          index: number
          parameters: Record<string, unknown>
          stateBefore: Record<string, unknown>
          stateAfter: Record<string, unknown>
        }>
      }
    }>(join(run.runDir, 'node-runs', 'relax', 'node-run.json'))
    expect(nodeRun.output.state).toMatchObject({
      x: '2',
      currentOutputX: '2',
      lastIteration: 2,
      previousX: '1',
    })
    expect(nodeRun.output.parameters).toMatchObject({ x: '2' })
    expect(nodeRun.output.iterations[0]?.parameters).toMatchObject({
      x: '0',
      iteration: 1,
      loopState: { x: '0' },
      previousRound: null,
    })
    expect(nodeRun.output.iterations[1]?.parameters).toMatchObject({
      x: '1',
      iteration: 2,
      loopState: {
        x: '1',
        lastIteration: 1,
        previousX: '0',
      },
    })
    expect(nodeRun.output.iterations[1]?.stateAfter).toMatchObject({
      x: '2',
      lastIteration: 2,
      previousX: '1',
    })
    expect(
      await readJson(join(run.runDir, 'rounds', 'relax', '0002', 'decision.json')),
    ).toMatchObject({
      decision: 'stop',
      reason: 'until',
    })
  })
})
