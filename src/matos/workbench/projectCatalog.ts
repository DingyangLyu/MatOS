import { createHash,randomUUID } from 'node:crypto'
import { mkdir,readFile,readdir,rename,rm,writeFile } from 'node:fs/promises'
import { basename,dirname,join,relative,resolve } from 'node:path'
import {
getDefaultMatOSConfig,
getMatOSConfigPath,
getMatOSDir,
getMatOSSessionsDir,
} from '../project.js'
import {
MATOS_PROJECT_METADATA_RELATIVE_PATH,
ensureMatOSProjectInternalGitignore,
writeMatOSProjectMetadataAtomic,
type MatOSProjectMetadata as ProjectMetadata,
} from '../projectMetadata.js'
import {
listMatOSSessionsFromDir,
summarizeMatOSTraces,
} from '../sessions/sessionIndex.js'
import {
assertNoSymlinkPathComponent,
pathExists,
slugSegment,
} from './projectShared.js'
import type {
MatOSWorkbenchAction,
MatOSWorkbenchContext,
MatOSWorkbenchProjectCreateResult,
MatOSWorkbenchProjectList,
MatOSWorkbenchProjectListItem,
} from './types.js'

const PROJECT_METADATA_RELATIVE_PATH = MATOS_PROJECT_METADATA_RELATIVE_PATH
const PROJECT_SCAN_LIMIT = 200
const ASSET_SCAN_LIMIT = 2000

type ProjectCandidate = {
  cwd: string
  metadata?: ProjectMetadata
  metadataPath?: string
  source: 'matos-project-file' | 'matos-workspace-folder' | 'workspace-folder-fallback'
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function stableFolderProjectId(cwd: string, metadata?: ProjectMetadata): string {
  const explicit = slugSegment(stringValue(metadata?.id), '')
  if (explicit) {
    return explicit
  }
  const name = slugSegment(stringValue(metadata?.name) ?? basename(cwd), 'project')
  const digest = createHash('sha256').update(resolve(cwd)).digest('hex').slice(0, 10)
  return `folder-${name}-${digest}`
}

function projectDisplayName(cwd: string, metadata?: ProjectMetadata): string {
  return (stringValue(metadata?.name) ?? basename(cwd)) || 'Workspace Project'
}

async function readProjectMetadata(cwd: string): Promise<{
  metadata?: ProjectMetadata
  path?: string
}> {
  const path = join(cwd, PROJECT_METADATA_RELATIVE_PATH)
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as ProjectMetadata
    return {
      metadata: parsed && typeof parsed === 'object' ? parsed : undefined,
      path,
    }
  } catch {
    return {}
  }
}

async function projectCandidateForDir(
  cwd: string,
  source: ProjectCandidate['source'] = 'matos-workspace-folder',
): Promise<ProjectCandidate | undefined> {
  const metadata = await readProjectMetadata(cwd)
  if (metadata.metadata) {
    return {
      cwd,
      metadata: metadata.metadata,
      metadataPath: metadata.path,
      source: 'matos-project-file',
    }
  }
  if (await pathExists(getMatOSConfigPath(cwd))) {
    return {
      cwd,
      source,
    }
  }
  if (await pathExists(getMatOSSessionsDir(cwd))) {
    return {
      cwd,
      source,
    }
  }
  return undefined
}

function metadataTeamAgents(metadata?: ProjectMetadata): Array<{
  roleRef: string
  label: string
  source: 'metadata'
}> {
  const team = Array.isArray(metadata?.team) ? metadata?.team : []
  return team
    .map(item => {
      if (typeof item === 'string') {
        const roleRef = item.trim()
        return roleRef ? { roleRef, label: roleRef, source: 'metadata' as const } : undefined
      }
      if (!item || typeof item !== 'object') {
        return undefined
      }
      const record = item as Record<string, unknown>
      const roleRef =
        stringValue(record.roleRef) ??
        stringValue(record.role_ref) ??
        stringValue(record.ref) ??
        stringValue(record.role)
      if (!roleRef) {
        return undefined
      }
      return {
        roleRef,
        label: stringValue(record.label) ?? stringValue(record.name) ?? roleRef,
        source: 'metadata' as const,
      }
    })
    .filter((item): item is { roleRef: string; label: string; source: 'metadata' } => Boolean(item))
}

async function localAssetTypeCounts(cwd: string): Promise<{
  total: number
  byType: Record<string, number>
}> {
  const assetsRoot = join(getMatOSDir(cwd), 'assets')
  const byType: Record<string, number> = {}
  let total = 0

  async function walk(dir: string): Promise<void> {
    if (total >= ASSET_SCAN_LIMIT) {
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (total >= ASSET_SCAN_LIMIT) {
        return
      }
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || entry.name !== 'asset.json') {
        continue
      }
      try {
        const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
        const type = stringValue(parsed.type) ?? 'asset'
        byType[type] = (byType[type] ?? 0) + 1
        total += 1
      } catch {
        byType.asset = (byType.asset ?? 0) + 1
        total += 1
      }
    }
  }

  await walk(assetsRoot)
  return { total, byType }
}

function projectActions(project: {
  id: string
  cwd: string
}): MatOSWorkbenchAction[] {
  return [
    {
      key: 'open',
      label: 'Open project',
      enabled: true,
      maturity: 'route-only',
      command: {
        command: 'matos.openProject',
        argv: ['workbench', 'projects', 'summary', '--project-id', project.id],
      },
      contract: {
        source: 'matos-action-contract',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string' },
            cwd: { type: 'string' },
          },
        },
        effects: ['read'],
        permission: {
          maturity: 'route-only',
          enabled: true,
          requiresConfirmation: false,
          danger: false,
        },
        native: {
          route: {
            command: 'matos.openProject',
            argv: ['workbench', 'projects', 'summary', '--project-id', project.id],
          },
        },
      },
    },
  ]
}

async function projectListItemFromCandidate(
  input: MatOSWorkbenchContext,
  candidate: ProjectCandidate,
): Promise<MatOSWorkbenchProjectListItem> {
  const sessions = (await listMatOSSessionsFromDir(getMatOSSessionsDir(candidate.cwd)))
    .filter(session => !session.hidden)
  const traces = summarizeMatOSTraces(sessions).filter(trace => !trace.hidden)
  const assetCounts = await localAssetTypeCounts(candidate.cwd)
  const id = stableFolderProjectId(candidate.cwd, candidate.metadata)
  const name = projectDisplayName(candidate.cwd, candidate.metadata)
  const relativePath = relative(input.cwd, candidate.cwd) || '.'
  const metadataAgents = metadataTeamAgents(candidate.metadata)
  const sessionRoleRefs = new Set(
    sessions
      .map(session => session.roleRef)
      .filter((roleRef): roleRef is string => Boolean(roleRef)),
  )
  const agentsByRef = new Map<string, {
    roleRef: string
    label: string
    source: 'metadata' | 'session'
  }>()
  for (const agent of metadataAgents) {
    agentsByRef.set(agent.roleRef, agent)
  }
  for (const roleRef of sessionRoleRefs) {
    if (!agentsByRef.has(roleRef)) {
      agentsByRef.set(roleRef, {
        roleRef,
        label: roleRef,
        source: 'session',
      })
    }
  }
  const agents = [...agentsByRef.values()]
  const lastAt =
    [
      stringValue(candidate.metadata?.updatedAt),
      ...sessions.map(session => session.lastEventAt),
      ...traces.map(trace => trace.lastEventAt),
    ]
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1) ?? stringValue(candidate.metadata?.createdAt)
  const workflowCount = assetCounts.byType.workflow ?? 0
  const knowledgeCount = assetCounts.byType.knowledge ?? 0
  const dataCount = assetCounts.byType.data ?? 0
  const description = stringValue(candidate.metadata?.description) ??
    `${relativePath === '.' ? '当前文件夹项目' : `文件夹项目: ${relativePath}`} · ${traces.length} 个对话 · ${agents.length} 个 team agent`

  return {
    id,
    name,
    cwd: candidate.cwd,
    relativePath,
    description,
    ...(candidate.metadata?.createdAt ? { createdAt: candidate.metadata.createdAt } : {}),
    ...(lastAt ? { updatedAt: lastAt } : {}),
    source: candidate.source,
    ...(candidate.metadataPath
      ? { metadataPath: relative(input.cwd, candidate.metadataPath) }
      : {}),
    conversations: {
      count: traces.length,
      totalSessions: sessions.length,
      totalTraces: traces.length,
      runningCount: traces.filter(trace => trace.status === 'running').length,
      failedCount: traces.filter(trace => trace.status === 'failed').length,
      completedCount: traces.filter(trace => trace.status === 'completed').length,
      ...(lastAt ? { lastAt } : {}),
    },
    team: {
      mode: agents.length
        ? metadataAgents.length ? 'metadata-and-session-derived' : 'session-derived'
        : 'empty',
      roleRefs: agents.map(agent => agent.roleRef),
      agents,
    },
    sharedContext: {
      assetCount: assetCounts.total,
      typeCounts: assetCounts.byType,
      workflowCount,
      knowledgeCount,
      dataCount,
    },
    actions: projectActions({ id, cwd: candidate.cwd }),
    raw: {
      metadata: candidate.metadata ?? null,
      sessionIds: sessions.map(session => session.sessionId),
      traceIds: traces.map(trace => trace.traceId),
    },
  }
}

async function discoverProjectCandidates(input: MatOSWorkbenchContext): Promise<ProjectCandidate[]> {
  const root = resolve(input.cwd)
  const rootCandidate = await projectCandidateForDir(root, 'workspace-folder-fallback')
  const candidates: ProjectCandidate[] = []
  let childCount = 0
  try {
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (childCount >= PROJECT_SCAN_LIMIT) {
        break
      }
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue
      }
      if (['node_modules', '__pycache__', 'caches', 'cache', 'tmp'].includes(entry.name)) {
        continue
      }
      const cwd = join(root, entry.name)
      const candidate = await projectCandidateForDir(cwd, 'matos-workspace-folder')
      if (candidate) {
        candidates.push(candidate)
        childCount += 1
      }
    }
  } catch {
    // A non-readable workspace root still degrades to the root fallback below.
  }

  // Cross-user shared projects mount as siblings of the shared workspace dir
  // (/workspace/group/workspaces/<slug> next to /workspace/group/shared, and
  // the same layout on the host-side scope tree). Without scanning that root,
  // a member can never select a project shared with them from the workbench.
  const sharedWorkspacesRoot = join(dirname(root), 'workspaces')
  if (sharedWorkspacesRoot !== root) {
    try {
      const entries = await readdir(sharedWorkspacesRoot, { withFileTypes: true })
      let sharedCount = 0
      for (const entry of entries) {
        if (sharedCount >= PROJECT_SCAN_LIMIT) {
          break
        }
        if (!entry.isDirectory() || entry.name.startsWith('.')) {
          continue
        }
        const cwd = join(sharedWorkspacesRoot, entry.name)
        if (candidates.some(candidate => candidate.cwd === cwd)) {
          continue
        }
        const candidate = await projectCandidateForDir(cwd, 'matos-workspace-folder')
        if (candidate) {
          candidates.push(candidate)
          sharedCount += 1
        }
      }
    } catch {
      // No shared-workspaces sibling (plain project checkouts): nothing to add.
    }
  }

  if (candidates.length === 0 && rootCandidate) {
    candidates.push(rootCandidate)
  }
  if (candidates.length === 0) {
    candidates.push({
      cwd: root,
      source: 'workspace-folder-fallback',
    })
  }
  return candidates
}

function projectMatchesQuery(project: MatOSWorkbenchProjectListItem, query: string | undefined): boolean {
  const normalized = query?.trim().toLowerCase()
  if (!normalized) {
    return true
  }
  const haystack = [
    project.id,
    project.name,
    project.description,
    project.cwd,
    project.relativePath,
    ...project.team.roleRefs,
  ].join(' ').toLowerCase()
  return haystack.includes(normalized)
}

export async function listMatOSWorkbenchProjects(
  input: MatOSWorkbenchContext & {
    query?: string
    limit?: number
    offset?: number
  },
): Promise<MatOSWorkbenchProjectList> {
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200))
  const offset = Math.max(0, input.offset ?? 0)
  const candidates = await discoverProjectCandidates(input)
  const projects = await Promise.all(
    candidates.map(candidate => projectListItemFromCandidate(input, candidate)),
  )
  // Disambiguate duplicate human-supplied metadata ids so IDE actions cannot
  // route to an arbitrary project when shared/local projects reuse an id.
  const seenProjectIds = new Set<string>()
  for (const project of projects) {
    if (!seenProjectIds.has(project.id)) {
      seenProjectIds.add(project.id)
      continue
    }
    const digest = createHash('sha256')
      .update(resolve(project.cwd))
      .digest('hex')
      .slice(0, 10)
    let candidateId = `${project.id}-${digest}`
    let suffix = 2
    while (seenProjectIds.has(candidateId)) {
      candidateId = `${project.id}-${digest}-${suffix}`
      suffix += 1
    }
    project.id = candidateId
    project.actions = projectActions({ id: candidateId, cwd: project.cwd })
    seenProjectIds.add(candidateId)
  }
  const filtered = projects
    .filter(project => projectMatchesQuery(project, input.query))
    .sort((left, right) =>
      (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') ||
      left.name.localeCompare(right.name),
    )
  const page = filtered.slice(offset, offset + limit)
  return {
    projects: page,
    summary: {
      count: page.length,
      total: filtered.length,
      offset,
      limit,
      query: input.query?.trim() ?? '',
      source: 'matos-folder-project-catalog',
      scannedRoot: resolve(input.cwd),
      createSupported: true,
    },
    createAction: {
      key: 'create',
      label: 'New project',
      enabled: true,
      route: {
        command: 'matos.workbench.projects.create',
        argv: ['workbench', 'projects', 'create', '<name>', '--json'],
      },
      targetRoot: resolve(input.cwd),
      metadataPath: PROJECT_METADATA_RELATIVE_PATH,
    },
  }
}

export async function createMatOSWorkbenchProject(
  input: MatOSWorkbenchContext & {
    name?: string
    description?: string
  },
): Promise<MatOSWorkbenchProjectCreateResult> {
  const name = stringValue(input.name) ?? 'New Project'
  const slug = slugSegment(name, 'project')
  const targetPath = resolve(input.cwd, slug)
  const root = resolve(input.cwd)
  if (relative(root, targetPath).startsWith('..')) {
    throw new Error(`MatOS project target escapes workspace root: ${targetPath}`)
  }
  await assertNoSymlinkPathComponent({ cwd: root, absolutePath: targetPath })
  if (await pathExists(targetPath)) {
    throw new Error(`MatOS project folder already exists: ${targetPath}`)
  }
  const now = new Date().toISOString()
  const stagingPath = resolve(
    root,
    `.${slug}.matos-create.${process.pid}.${randomUUID()}`,
  )
  await mkdir(stagingPath, { recursive: false })
  try {
    const matosDir = getMatOSDir(stagingPath)
    await mkdir(join(matosDir, 'assets'), { recursive: true })
    await mkdir(join(matosDir, 'private'), { recursive: true })
    await mkdir(join(matosDir, 'workbench'), { recursive: true })
    await mkdir(getMatOSSessionsDir(stagingPath), { recursive: true })
    await mkdir(join(stagingPath, 'artifacts'), { recursive: true })
    await ensureMatOSProjectInternalGitignore(stagingPath)
    await writeFile(
      getMatOSConfigPath(stagingPath),
      `${JSON.stringify(getDefaultMatOSConfig(), null, 2)}\n`,
      'utf8',
    )
    await writeMatOSProjectMetadataAtomic(
      stagingPath,
      {
        schemaVersion: 1,
        revision: 1,
        id: slug,
        name,
        ...(input.description ? { description: input.description } : {}),
        createdAt: now,
        updatedAt: now,
        team: [],
        memberBriefs: {},
        memberNames: {},
        visibilityPolicy: {
          shared: 'project-root',
          private: '.matos/private/<member-id>',
        },
      },
    )
    if ((input.env?.MATOS_STANDALONE ?? process.env.MATOS_STANDALONE) === '1') {
      const { ensureMatOSStandaloneAssets } = await import('../standaloneAssets.js')
      await ensureMatOSStandaloneAssets(stagingPath, { scopeRef: `project:${slug}`, env: input.env })
    }
    await rename(stagingPath, targetPath)
  } catch (error: any) {
    await rm(stagingPath, { recursive: true, force: true }).catch(() => {})
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
      throw new Error(`MatOS project folder already exists: ${targetPath}`)
    }
    throw error
  }
  const created = await projectListItemFromCandidate(input, {
    cwd: targetPath,
    metadata: {
      schemaVersion: 1,
      id: slug,
      name,
      ...(input.description ? { description: input.description } : {}),
      createdAt: now,
      updatedAt: now,
      team: [],
    },
    metadataPath: join(targetPath, PROJECT_METADATA_RELATIVE_PATH),
    source: 'matos-project-file',
  })
  return {
    mode: 'matos-project-create',
    created: true,
    project: created,
    targetRoot: root,
  }
}
