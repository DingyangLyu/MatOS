import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadMatOSAssets } from '../assets/loadAssets.js'
import { buildMatOSAssetRegistry } from '../assets/registry.js'
import type { MatOSAssetRegistry } from '../assets/registry.js'
import { loadWorkflowAsset } from './loadWorkflow.js'
import { validateWorkflowDefinition } from './validateWorkflow.js'
import {
  appendWorkflowEvent,
  addWorkflowDraftNode,
  connectWorkflowDraftNodes,
  createWorkflowRun,
  createWorkflowDraft,
  deleteWorkflowDraftNode,
  disconnectWorkflowDraftNodes,
  forkWorkflowRunToDraft,
  importWorkflowComponent,
  listWorkflowDrafts,
  publishWorkflowDraft,
  readWorkflowDraft,
  readWorkflowDraftDefinition,
  readWorkflowDraftProvenance,
  readWorkflowRun,
  readWorkflowRunEvents,
  resolveWorkflowDraftDir,
  updateWorkflowDraftNode,
} from './workflowStore.js'
import type { MatOSWorkflowDefinition } from './types.js'

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

describe('MatOS workflow run store', () => {
  test('suggests the current canonical ref when an exact workflow version is stale', async () => {
    const registry = {
      assets: [
        {
          type: 'workflow',
          id: 'qe-neb-evidence',
          canonicalKey: 'workflow:qe-neb-evidence@0.4.0',
        },
      ],
      resolve: () => undefined,
    } as unknown as MatOSAssetRegistry

    await expect(
      loadWorkflowAsset(registry, 'workflow:qe-neb-evidence@0.3.0'),
    ).rejects.toThrow(
      'Available matching refs: workflow:qe-neb-evidence@0.4.0',
    )
  })

  test('creates scoped run files and appends replayable events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-store-'))
    const run = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:relax@0.1.0',
      parameters: { structure_path: 'POSCAR' },
      graphSnapshot: { nodes: [{ id: 'prepare', type: 'exec' }] },
    })

    await appendWorkflowEvent(run.dir, {
      type: 'workflow.run.started',
      data: { runId: run.runId },
    })
    await appendWorkflowEvent(run.dir, {
      type: 'workflow.node.completed',
      data: { nodeId: 'prepare' },
    })

    expect(await readWorkflowRun(run.dir)).toMatchObject({
      runId: run.runId,
      workflowRef: 'workflow:relax@0.1.0',
      status: 'created',
    })
    expect((await readWorkflowRunEvents(run.dir)).map(event => event.type)).toEqual([
      'workflow.run.created',
      'workflow.run.started',
      'workflow.node.completed',
    ])
    expect(await readFile(join(run.dir, 'graph.snapshot.json'), 'utf8')).toContain(
      '"prepare"',
    )
    const receipt = JSON.parse(
      await readFile(join(run.dir, 'runtime-receipt.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      runSchemaVersion: 2,
      runtime: 'cmatos-native-workflow',
      runId: run.runId,
      workflowRef: 'workflow:relax@0.1.0',
    })
    expect(String(receipt.receiptId)).toMatch(/^workflow-runtime-receipt:[0-9a-f]{64}$/)
  })

  test('attaches inherited MatOS trace context to workflow events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-trace-'))
    const run = await createWorkflowRun({
      workflowsDir: join(root, 'workflows'),
      workflowRef: 'workflow:trace@0.1.0',
      graphSnapshot: {},
    })
    process.env.MATOS_TRACE_ID = 'trace-workflow-store-1'
    process.env.MATOS_PARENT_SESSION_ID = 'session-parent'
    process.env.MATOS_USER_ID = 'alice'
    process.env.MATOS_SCOPE_ID = 'user:alice'

    await appendWorkflowEvent(run.dir, {
      type: 'workflow.node.completed',
      data: { nodeId: 'step-1' },
    })

    expect((await readWorkflowRunEvents(run.dir)).at(-1)).toMatchObject({
      type: 'workflow.node.completed',
      trace: {
        schemaVersion: 1,
        traceId: 'trace-workflow-store-1',
        parentSessionId: 'session-parent',
        userId: 'alice',
        scopeRef: 'user:alice',
      },
    })
  })

  test('creates, composes, publishes, and forks workflow drafts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-drafts-'))
    const workflowsDir = join(root, 'workflows')
    const component: MatOSWorkflowDefinition = {
      schemaVersion: 1,
      name: 'relax component',
      parameters: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      outputs: {},
      nodes: [
        { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ready' },
        {
          id: 'check',
          type: 'guard',
          dependsOn: ['prepare'],
          checks: [{ type: 'file_exists', path: 'ready.txt' }],
        },
      ],
    }

    const draft = await createWorkflowDraft({
      workflowsDir,
      draftId: 'draft_relax',
      name: 'Generated Relax',
    })
    await importWorkflowComponent({
      draftDir: draft.dir,
      componentRef: 'workflow:relax-component@0.1.0',
      definition: component,
    })

    const snapshot = await readWorkflowDraft(draft.dir)
    const definition = await readWorkflowDraftDefinition(draft.dir)
    const provenance = await readWorkflowDraftProvenance(draft.dir)

    expect(snapshot.status).toBe('draft')
    expect(definition.nodes.map(node => node.id)).toEqual(['prepare', 'check'])
    expect(definition.nodes[1]?.dependsOn).toEqual(['prepare'])
    expect(provenance.map(entry => entry.type)).toEqual([
      'draft.created',
      'draft.component.imported',
    ])

    const published = await publishWorkflowDraft({
      cwd: root,
      draftDir: draft.dir,
      id: 'generated-relax',
      name: 'Generated Relax',
      version: '0.1.0',
    })

    expect(published.assetKey).toBe('workflow:generated-relax@0.1.0')
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const loaded = await loadWorkflowAsset(registry, 'workflow:generated-relax')
    expect(validateWorkflowDefinition(loaded.definition).ok).toBe(true)
    expect(loaded.definition.nodes.map(node => node.id)).toEqual(['prepare', 'check'])

    const run = await createWorkflowRun({
      workflowsDir,
      workflowRef: loaded.asset.canonicalKey,
      graphSnapshot: loaded.definition,
    })
    const fork = await forkWorkflowRunToDraft({
      workflowsDir,
      runDir: run.dir,
      draftId: 'draft_from_run',
      name: 'Forked Generated Relax',
    })

    expect((await readWorkflowDraftDefinition(fork.dir)).nodes[0]?.id).toBe(
      'prepare',
    )
    expect((await readWorkflowDraftProvenance(fork.dir)).map(entry => entry.type)).toContain(
      'draft.run.forked',
    )
  })

  test('keeps draft dependency edges in sync with node dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-draft-edges-'))
    const draft = await createWorkflowDraft({
      workflowsDir: join(root, 'workflows'),
      draftId: 'edge-sync',
      name: 'Edge Sync',
      definition: {
        schemaVersion: 1,
        name: 'Edge Sync',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [
          { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf prepare' },
          { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
        ],
        edges: [],
        outputs: {},
      },
    })

    const connected = await connectWorkflowDraftNodes({
      draftDir: draft.dir,
      from: 'prepare',
      to: 'review',
    })

    expect(connected.nodes.find(node => node.id === 'review')?.dependsOn).toEqual([
      'prepare',
    ])
    expect(connected.edges).toEqual([{ from: 'prepare', to: 'review' }])

    const renamed = await updateWorkflowDraftNode({
      draftDir: draft.dir,
      nodeId: 'prepare',
      patch: { id: 'setup' },
    })

    expect(renamed.nodes.find(node => node.id === 'review')?.dependsOn).toEqual([
      'setup',
    ])
    expect(renamed.edges).toEqual([{ from: 'setup', to: 'review' }])

    const disconnected = await disconnectWorkflowDraftNodes({
      draftDir: draft.dir,
      from: 'setup',
      to: 'review',
    })

    expect(disconnected.nodes.find(node => node.id === 'review')?.dependsOn).toEqual(
      [],
    )
    expect(disconnected.edges).toEqual([])

    await connectWorkflowDraftNodes({
      draftDir: draft.dir,
      from: 'setup',
      to: 'review',
    })
    const deleted = await deleteWorkflowDraftNode({
      draftDir: draft.dir,
      nodeId: 'setup',
    })

    expect(deleted.nodes.find(node => node.id === 'review')?.dependsOn).toEqual([])
    expect(deleted.edges).toEqual([])
  })

  test('materializes explicit dependsOn fields as draft dependency edges', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-draft-depends-'))
    const draft = await createWorkflowDraft({
      workflowsDir: join(root, 'workflows'),
      draftId: 'depends-sync',
      name: 'Depends Sync',
      definition: {
        schemaVersion: 1,
        name: 'Depends Sync',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [
          { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf prepare' },
          { id: 'review', type: 'exec', dependsOn: [], command: 'printf review' },
        ],
        edges: [],
        outputs: {},
      },
    })

    const added = await addWorkflowDraftNode({
      draftDir: draft.dir,
      node: {
        id: 'publish',
        type: 'exec',
        dependsOn: ['prepare', 'review'],
        command: 'printf publish',
      },
    })

    expect(added.edges).toEqual([
      { from: 'prepare', to: 'publish' },
      { from: 'review', to: 'publish' },
    ])

    const updated = await updateWorkflowDraftNode({
      draftDir: draft.dir,
      nodeId: 'publish',
      patch: { dependsOn: ['review'] },
    })

    expect(updated.edges).toEqual([{ from: 'review', to: 'publish' }])
  })

  test('publishes workflow drafts with type-qualified ids as canonical workflow refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-prefixed-'))
    const draft = await createWorkflowDraft({
      workflowsDir: join(root, 'workflows'),
      draftId: 'prefixed-draft',
      name: 'Prefixed Draft',
      definition: {
        schemaVersion: 1,
        name: 'Prefixed Draft',
        parameters: {},
        policy: { approvalMode: 'bypass', defaultRisk: 'low' },
        nodes: [{ id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ok' }],
        outputs: {},
      },
    })

    const published = await publishWorkflowDraft({
      cwd: root,
      draftDir: draft.dir,
      id: 'workflow:prefixed-generated',
      version: '0.1.0',
    })

    expect(published.assetKey).toBe('workflow:prefixed-generated@0.1.0')
    const registry = buildMatOSAssetRegistry(await loadMatOSAssets(root))
    const loaded = await loadWorkflowAsset(registry, 'workflow:prefixed-generated')
    expect(loaded.asset.id).toBe('prefixed-generated')
  })

  test('lists workflow drafts ordered by update time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-drafts-list-'))
    const workflowsDir = join(root, 'workflows')
    const first = await createWorkflowDraft({ workflowsDir, draftId: 'first' })
    await createWorkflowDraft({ workflowsDir, draftId: 'second' })

    const drafts = await listWorkflowDrafts(workflowsDir)

    expect(drafts.map(draft => draft.draftId)).toEqual(['second', 'first'])
    expect(drafts.find(draft => draft.draftId === 'first')?.draftDir).toBe(
      first.dir,
    )
  })

  test('rejects draft ids that would escape the draft root', async () => {
    const workflowsDir = join('/workspace/workflows', 'project')

    expect(resolveWorkflowDraftDir(workflowsDir, 'safe-draft')).toBe(
      join(workflowsDir, 'drafts', 'safe-draft'),
    )
    expect(() => resolveWorkflowDraftDir(workflowsDir, '../other')).toThrow(
      'Workflow draft id must be a simple id',
    )
    expect(() => resolveWorkflowDraftDir(workflowsDir, 'nested/draft')).toThrow(
      'Workflow draft id must be a simple id',
    )
  })

  test('rejects invalid draft node mutations without changing persisted definitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-workflow-drafts-invalid-'))
    const draft = await createWorkflowDraft({
      workflowsDir: join(root, 'workflows'),
      draftId: 'invalid-mutation',
      name: 'Invalid Mutation',
    })

    await addWorkflowDraftNode({
      draftDir: draft.dir,
      node: { id: 'prepare', type: 'exec', dependsOn: [], command: 'printf ok' },
    })

    await expect(
      addWorkflowDraftNode({
        draftDir: draft.dir,
        node: {
          id: 'bad',
          type: 'not-a-real-type',
          dependsOn: [],
        } as never,
      }),
    ).rejects.toThrow('Invalid workflow draft mutation')
    expect((await readWorkflowDraftDefinition(draft.dir)).nodes).toEqual([
      expect.objectContaining({ id: 'prepare', type: 'exec' }),
    ])

    await expect(
      updateWorkflowDraftNode({
        draftDir: draft.dir,
        nodeId: 'prepare',
        patch: { type: 'not-a-real-type' } as never,
      }),
    ).rejects.toThrow('Invalid workflow draft mutation')
    expect((await readWorkflowDraftDefinition(draft.dir)).nodes).toEqual([
      expect.objectContaining({ id: 'prepare', type: 'exec' }),
    ])
  })
})
