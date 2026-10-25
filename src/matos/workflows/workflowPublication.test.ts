import { afterEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createWorkflowDraft,
  publishWorkflowDraft,
  readWorkflowDraft,
  readWorkflowDraftDefinition,
  recordWorkflowDraftPublicationFailure,
  replaceWorkflowDraftDefinition,
} from './workflowStore.js'
import { workflowIoDigest } from './workflowIo.js'
import { matOSWorkflowService } from './workflowService.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

test('publishes only the definition whose digest the caller validated', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-publish-race-'))
  roots.push(cwd)
  const draft = await createWorkflowDraft({ workflowsDir: join(cwd, 'workflows'), draftId: 'shared' })
  const first = await replaceWorkflowDraftDefinition({ draftDir: draft.dir, definition: {
    schemaVersion: 1, name: 'first', nodes: [{ id: 'a', type: 'exec', command: 'echo first', dependsOn: [] }],
    parameters: {}, outputs: {}, policy: { approvalMode: 'bypass', defaultRisk: 'low' },
  } })
  const expectedDefinition = workflowIoDigest(JSON.parse(JSON.stringify(first)))
  const second = await replaceWorkflowDraftDefinition({ draftDir: draft.dir, definition: { ...first, name: 'second' } })
  await expect(publishWorkflowDraft({ cwd, draftDir: draft.dir, id: 'published', expectedDefinition })).rejects.toThrow(/draft changed/i)
  await expect(readFile(join(cwd, '.matos/assets/workflows/published/asset.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const published = await publishWorkflowDraft({ cwd, draftDir: draft.dir, id: 'published',
    expectedDefinition: workflowIoDigest(JSON.parse(JSON.stringify(second))) })
  expect(JSON.parse(await readFile(published.workflowPath, 'utf8')).name).toBe('second')
})

test('one-call author rejects scoped publication failure and retains an editable draft', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-author-failure-'))
  roots.push(cwd)
  await mkdir(join(cwd, '.matos'))
  await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({
    version: 1, assetRoots: ['assets'], assetSources: [], includeDefaultAssetRoots: false,
    execution: { runtimeDataDir: join(cwd, 'runtime') },
  }))
  const context = { cwd, scopeRef: 'user:unprovisioned',
    env: { MATOS_GITEA_DISABLE_OPERATOR_ENV: '1', MATOS_GITEA_BASE_URL: 'http://127.0.0.1:9' } }
  await expect(matOSWorkflowService.author({
    ...context, id: 'author-sync-failure',
    definition: { schemaVersion: 1, name: 'author-sync-failure', parameters: {}, outputs: {}, policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [{ id: 'echo', type: 'exec', command: 'echo author', dependsOn: [] }] },
  })).rejects.toThrow('Workflow publication failed')
  const draft = await matOSWorkflowService.showDraft({ ...context, draftId: 'author-sync-failure' })
  expect(draft.definition.nodes[0]?.id).toBe('echo')
  expect(draft.draft.status).toBe('draft')
  expect(draft.draft.publishedAssetKey).toBeUndefined()
  expect(draft.provenance.at(-1)?.type).toBe('draft.publication.failed')
})

test('a delayed publication failure preserves newer edits and publications', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-publication-recovery-'))
  roots.push(cwd)
  const draft = await createWorkflowDraft({ workflowsDir: join(cwd, 'workflows'), draftId: 'shared' })
  const first = await replaceWorkflowDraftDefinition({ draftDir: draft.dir, definition: {
    schemaVersion: 1, name: 'first', nodes: [{ id: 'a', type: 'exec', command: 'echo first', dependsOn: [] }],
    parameters: {}, outputs: {}, policy: { approvalMode: 'bypass', defaultRisk: 'low' },
  } })
  const failed = await publishWorkflowDraft({ cwd, draftDir: draft.dir, id: 'published' })
  await replaceWorkflowDraftDefinition({ draftDir: draft.dir, definition: { ...first, name: 'newer' } })
  await recordWorkflowDraftPublicationFailure({ draftDir: draft.dir, published: failed, reason: 'source unavailable' })
  expect((await readWorkflowDraft(draft.dir)).status).toBe('draft')
  expect((await readWorkflowDraftDefinition(draft.dir)).name).toBe('newer')

  const newer = await publishWorkflowDraft({ cwd, draftDir: draft.dir, id: 'published' })
  expect(newer.definitionDigest).not.toBe(failed.definitionDigest)
  await recordWorkflowDraftPublicationFailure({ draftDir: draft.dir, published: failed, reason: 'late failure' })
  const current = await readWorkflowDraft(draft.dir)
  expect(current.status).toBe('published')
  expect(current.publishedAssetKey).toBe(newer.assetKey)
  expect((await readWorkflowDraftDefinition(draft.dir)).name).toBe('newer')
})

test('scoped staging failure cannot leave an enabled unaccepted local asset', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'workflow-staging-failure-'))
  roots.push(cwd)
  await mkdir(join(cwd, '.matos/assets'), { recursive: true })
  await writeFile(join(cwd, '.matos/assets/generated'), 'existing non-directory')
  await writeFile(join(cwd, '.matos/matos.json'), JSON.stringify({
    version: 1, assetRoots: ['assets'], assetSources: [], includeDefaultAssetRoots: false,
    execution: { runtimeDataDir: join(cwd, 'runtime') },
  }))
  const context = { cwd, scopeRef: 'user:unprovisioned',
    env: { MATOS_GITEA_DISABLE_OPERATOR_ENV: '1', MATOS_GITEA_BASE_URL: 'http://127.0.0.1:9' } }
  await expect(matOSWorkflowService.author({
    ...context, id: 'staging-failure', definition: {
      schemaVersion: 1, name: 'staging-failure', parameters: {}, outputs: {},
      policy: { approvalMode: 'bypass', defaultRisk: 'low' },
      nodes: [{ id: 'echo', type: 'exec', command: 'echo test', dependsOn: [] }],
    },
  })).rejects.toThrow('Workflow publication failed')
  await expect(readFile(join(cwd, '.matos/assets/workflows/staging-failure/asset.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(cwd, '.matos/assets/generated'), 'utf8')).toBe('existing non-directory')
  const draft = await matOSWorkflowService.showDraft({ ...context, draftId: 'staging-failure' })
  expect(draft.draft.status).toBe('draft')
  expect(draft.provenance.at(-1)?.type).toBe('draft.publication.failed')
})
