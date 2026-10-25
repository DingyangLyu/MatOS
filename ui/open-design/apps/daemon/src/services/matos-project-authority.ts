import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execMatOSJson, isRecord, stringOrNull } from './matos-cli.js';

type JsonRecord = Record<string, unknown>;

export interface MatOSProjectAuthorityProjection {
  projectId: string;
  name?: string;
  revision: number;
  members: string[];
  team: MatOSProjectAuthorityMember[];
  assetRefs: string[];
  assetVersionPolicy?: 'follow-accepted' | 'pinned';
  conversationIds: string[];
  conversations: MatOSProjectAuthorityConversation[];
  goal?: string;
  memberBriefs: Record<string, string>;
  memberNames: Record<string, string>;
  roleResolutionWarnings?: MatOSProjectRoleResolutionWarning[];
}

export interface MatOSProjectAuthorityMember {
  memberId: string;
  roleRef?: string;
  label?: string;
  displayName?: string;
  kind?: string;
  userId?: string;
  source?: string;
  defaultTools?: string[];
  runtimeRef?: string;
}

export interface MatOSProjectRoleResolutionWarning {
  code: string;
  requestedRoleRef: string;
  fallbackRoleRef: string;
  message: string;
}

export interface MatOSProjectAuthorityConversation {
  id: string;
  title?: string | null;
  roleRef?: string | null;
  memberRefs: string[];
  createdAt?: number;
  updatedAt?: number;
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(value)) {
    if (typeof text !== 'string') continue;
    const trimmed = text.trim();
    if (trimmed) result[key] = trimmed;
  }
  return result;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.flatMap(item =>
        typeof item === 'string' && item.trim() ? [item.trim()] : []))]
    : [];
}

function roleResolutionWarnings(value: unknown): MatOSProjectRoleResolutionWarning[] {
  if (!Array.isArray(value)) return [];
  return value
    .flatMap(item => {
      if (!isRecord(item)) return [];
      const requestedRoleRef = stringOrNull(item.requestedRoleRef);
      const fallbackRoleRef = stringOrNull(item.fallbackRoleRef);
      const message = stringOrNull(item.message);
      if (!requestedRoleRef || !fallbackRoleRef || !message) return [];
      return [{
        code: stringOrNull(item.code) ?? 'role_asset_fallback',
        requestedRoleRef,
        fallbackRoleRef,
        message,
      }];
    });
}

function roleIdentity(value: string): string {
  return value.trim().split('@')[0] ?? value.trim();
}

function authorityTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function authorityConversations(value: unknown): MatOSProjectAuthorityConversation[] {
  if (!Array.isArray(value)) return [];
  if (value.length > 5_000) {
    throw new Error('MatOS project metadata exceeds 5 000 conversations');
  }
  const conversations = new Map<string, MatOSProjectAuthorityConversation>();
  for (const item of value) {
    if (!isRecord(item)) throw new Error('Invalid MatOS project conversation record');
    const record = item;
    const id = stringOrNull(record.id);
    if (!id || id.length > 200 || /[\u0000-\u001f\u007f/\\]/u.test(id)) {
      throw new Error(`Invalid MatOS project conversation id: ${id ?? '<missing>'}`);
    }
    if (conversations.has(id)) {
      throw new Error(`Duplicate MatOS project conversation id: ${id}`);
    }
    const createdAt = authorityTimestamp(record.createdAt);
    const updatedAt = authorityTimestamp(record.updatedAt);
    if (record.createdAt !== undefined && createdAt === undefined) {
      throw new Error(`Invalid MatOS project conversation createdAt: ${id}`);
    }
    if (record.updatedAt !== undefined && updatedAt === undefined) {
      throw new Error(`Invalid MatOS project conversation updatedAt: ${id}`);
    }
    const title = stringOrNull(record.title);
    if (title && title.length > 500) {
      throw new Error(`MatOS project conversation title exceeds 500 characters: ${id}`);
    }
    const memberRefs = stringList(record.memberRefs);
    if (memberRefs.length > 64) {
      throw new Error(`MatOS project conversation roster exceeds 64 members: ${id}`);
    }
    conversations.set(id, {
      id,
      ...(Object.prototype.hasOwnProperty.call(record, 'title')
        ? { title }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(record, 'roleRef')
        ? { roleRef: stringOrNull(record.roleRef) }
        : {}),
      memberRefs,
      ...(createdAt !== undefined ? { createdAt } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
    });
  }
  return [...conversations.values()];
}

function defaultMemberId(roleRef: string): string {
  const tail = roleIdentity(roleRef).split(':').pop() ?? 'agent';
  const slug = tail.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `agent-${slug || 'agent'}`;
}

const PROJECT_ROLE_FALLBACK_REF = 'role:compute';

function missingRoleAssetRef(error: unknown): string | null {
  const message = String(error instanceof Error ? error.message : error ?? '');
  const match = message.match(/MatOS role asset not found:\s*([^\s,;.)\]}\n]+)/i);
  return match?.[1]?.trim() || null;
}

function applyMissingRoleFallback(
  team: MatOSProjectAuthorityMember[],
  requestedRoleRef: string,
): { team: MatOSProjectAuthorityMember[]; warning: MatOSProjectRoleResolutionWarning } | null {
  const requestedIdentity = roleIdentity(requestedRoleRef);
  const fallbackIdentity = roleIdentity(PROJECT_ROLE_FALLBACK_REF);
  if (!requestedIdentity || requestedIdentity === fallbackIdentity) return null;
  if (!team.some(member => member.roleRef && roleIdentity(member.roleRef) === requestedIdentity)) return null;

  const retained = team.filter(member =>
    !member.roleRef || roleIdentity(member.roleRef) !== requestedIdentity);
  const fallbackAlreadyPresent = retained.some(member =>
    member.roleRef && roleIdentity(member.roleRef) === fallbackIdentity);
  const warning: MatOSProjectRoleResolutionWarning = {
    code: fallbackAlreadyPresent ? 'role_asset_fallback_skipped' : 'role_asset_fallback',
    requestedRoleRef,
    fallbackRoleRef: PROJECT_ROLE_FALLBACK_REF,
    message: fallbackAlreadyPresent
      ? `MatOS role asset not found: ${requestedRoleRef}; fallback ${PROJECT_ROLE_FALLBACK_REF} was already assigned, so this duplicate team entry was skipped.`
      : `MatOS role asset not found: ${requestedRoleRef}; fell back to ${PROJECT_ROLE_FALLBACK_REF}.`,
  };
  if (fallbackAlreadyPresent) return { team: retained, warning };

  const fallbackMemberId = defaultMemberId(PROJECT_ROLE_FALLBACK_REF);
  const retainedMemberIds = new Set(retained.map(member => member.memberId));
  const sourceMember = team.find(member =>
    member.roleRef && roleIdentity(member.roleRef) === requestedIdentity);
  if (!sourceMember) return null;
  const fallbackMember: MatOSProjectAuthorityMember = {
    ...sourceMember,
    memberId: retainedMemberIds.has(fallbackMemberId) ? sourceMember.memberId : fallbackMemberId,
    roleRef: PROJECT_ROLE_FALLBACK_REF,
    label: 'Compute',
    kind: sourceMember.kind ?? 'agent',
    source: 'role-fallback',
  };
  return { team: [...retained, fallbackMember], warning };
}

function withRoleResolutionWarnings(
  authority: MatOSProjectAuthorityProjection,
  warnings: MatOSProjectRoleResolutionWarning[],
): MatOSProjectAuthorityProjection {
  const combined = [...(authority.roleResolutionWarnings ?? []), ...warnings];
  const deduped = new Map<string, MatOSProjectRoleResolutionWarning>();
  for (const warning of combined) {
    deduped.set(
      `${warning.code}\u0000${warning.requestedRoleRef}\u0000${warning.fallbackRoleRef}`,
      warning,
    );
  }
  // A full authority sync owns warning lifecycle. Keep an explicit empty
  // array as a clear signal so merging the fresh projection removes stale
  // fallback warnings from the web metadata after the requested role starts
  // resolving successfully. Read-only/conversation projections that omit the
  // field still preserve existing warnings for compatibility.
  return { ...authority, roleResolutionWarnings: [...deduped.values()] };
}

function authorityTeam(value: unknown): MatOSProjectAuthorityMember[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid MatOS project team: expected an array');
  if (value.length > 256) throw new Error('Invalid MatOS project team: exceeds 256 members');
  const members = new Map<string, MatOSProjectAuthorityMember>();
  const roles = new Map<string, string>();
  for (const [index, raw] of value.entries()) {
    const record = typeof raw === 'string' ? { roleRef: raw } : isRecord(raw) ? raw : null;
    if (!record) throw new Error(`Invalid MatOS project team member at index ${index}`);
    const kind = stringOrNull(record.kind);
    const roleRef = stringOrNull(record.roleRef) ?? stringOrNull(record.role_ref);
    const userId = stringOrNull(record.userId) ?? stringOrNull(record.user_id);
    // Cross-user project shares are represented by role-less human members.
    // They identify the acting account for timeline attribution, but they are
    // not runnable agents and therefore must not be forced through role
    // resolution. Other role-less records remain invalid.
    if (!roleRef && (kind !== 'human' || !userId)) {
      throw new Error(`Invalid MatOS project team member at index ${index}`);
    }
    const memberId = stringOrNull(record.memberId) ?? stringOrNull(record.member_id) ??
      (roleRef ? defaultMemberId(roleRef) : null);
    if (!memberId) throw new Error(`Invalid MatOS project team member at index ${index}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(memberId)) {
      throw new Error(`Invalid MatOS project member id: ${memberId}`);
    }
    const identity = roleRef ? roleIdentity(roleRef) : null;
    const existingMember = members.get(memberId);
    if (
      existingMember &&
      (existingMember.roleRef ? roleIdentity(existingMember.roleRef) : null) !== identity
    ) {
      throw new Error(`MatOS project member '${memberId}' is assigned to multiple roles`);
    }
    if (identity) {
      const existingRoleMember = roles.get(identity);
      if (existingRoleMember && existingRoleMember !== memberId) {
        throw new Error(`MatOS project role '${identity}' is assigned to multiple members`);
      }
      roles.set(identity, memberId);
    }
    members.set(memberId, {
      memberId,
      ...(roleRef ? { roleRef } : {}),
      ...(stringOrNull(record.label) ? { label: stringOrNull(record.label)! } : {}),
      ...(stringOrNull(record.displayName) ? { displayName: stringOrNull(record.displayName)! } : {}),
      ...(kind ? { kind } : {}),
      ...(userId ? { userId } : {}),
      ...(stringOrNull(record.source) ? { source: stringOrNull(record.source)! } : {}),
      ...(Array.isArray(record.defaultTools) ? { defaultTools: stringList(record.defaultTools) } : {}),
      ...(stringOrNull(record.runtimeRef) ?? stringOrNull(record.runtime_ref)
        ? { runtimeRef: (stringOrNull(record.runtimeRef) ?? stringOrNull(record.runtime_ref))! }
        : {}),
    });
  }
  return [...members.values()];
}

function assertConversationRoster(
  team: MatOSProjectAuthorityMember[],
  conversations: MatOSProjectAuthorityConversation[],
): void {
  const roles = new Set(team.flatMap(member =>
    member.roleRef ? [roleIdentity(member.roleRef)] : []));
  for (const conversation of conversations) {
    if (conversation.roleRef && !roles.has(roleIdentity(conversation.roleRef))) {
      throw new Error(
        `MatOS project conversation role is not a project member: ${conversation.roleRef}`,
      );
    }
    for (const memberRef of conversation.memberRefs) {
      if (!roles.has(roleIdentity(memberRef))) {
        throw new Error(`MatOS project conversation member is not in the project: ${memberRef}`);
      }
    }
  }
}

function reconcileAuthorityTeam(
  existing: MatOSProjectAuthorityMember[],
  requestedRoles: string[],
  rolesExplicit: boolean,
): MatOSProjectAuthorityMember[] {
  if (!rolesExplicit) return existing;
  const humanMembers = existing.filter(member => !member.roleRef && member.kind === 'human');
  if (requestedRoles.length === 0) return humanMembers;
  const requested = new Set(requestedRoles.map(roleIdentity));
  const next = existing.filter(member =>
    !member.roleRef || requested.has(roleIdentity(member.roleRef)));
  const represented = new Set(next.flatMap(member =>
    member.roleRef ? [roleIdentity(member.roleRef)] : []));
  for (const roleRef of requestedRoles) {
    const identity = roleIdentity(roleRef);
    if (represented.has(identity)) continue;
    next.push({ memberId: defaultMemberId(roleRef), roleRef, label: roleRef, kind: 'agent', source: 'explicit' });
    represented.add(identity);
  }
  return next;
}

function isHumanCollaborator(
  member: MatOSProjectAuthorityMember,
): boolean {
  return !member.roleRef && member.kind === 'human' && Boolean(member.userId);
}

// Human collaborators are gateway-managed access grants stored in the native
// project authority. Every user's SQLite catalog is only a projection and may
// lag behind a just-completed share or unshare. Once native authority exists,
// never let one of those stale projections remove a current collaborator or
// resurrect a revoked one; web metadata remains authoritative only for the
// runnable agent portion of the team.
function teamWithNativeHumanAuthority(
  projected: MatOSProjectAuthorityMember[],
  native: MatOSProjectAuthorityMember[],
): MatOSProjectAuthorityMember[] {
  const nativeHumans = native.filter(isHumanCollaborator);
  const projectedAgents = projected.filter(member => !isHumanCollaborator(member));
  const projectedIds = new Set(projectedAgents.map(member => member.memberId));
  for (const human of nativeHumans) {
    if (projectedIds.has(human.memberId)) {
      throw new Error(
        `MatOS project member '${human.memberId}' collides with a native human collaborator`,
      );
    }
  }
  return [...projectedAgents, ...nativeHumans];
}

function projectionFromGroup(value: unknown): MatOSProjectAuthorityProjection {
  if (!isRecord(value) || value.mode !== 'matos-project-group-sync') {
    throw new Error('MatOS project sync returned an unexpected payload');
  }
  const group = isRecord(value.project) ? value.project : {};
  const project = isRecord(group.project) ? group.project : group;
  const projectId = stringOrNull(project.id);
  if (!projectId) throw new Error('MatOS project sync returned no project id');
  const name = stringOrNull(project.name);
  const profile = isRecord(group.profile) ? group.profile : {};
  const team = authorityTeam(group.members);
  const members = team.flatMap(member => member.roleRef ? [member.roleRef] : []);
  const conversations = authorityConversations(group.conversations);
  assertConversationRoster(team, conversations);
  const conversationIds = conversations.map(conversation => conversation.id);
  const goal = stringOrNull(profile.goal);
  const warnings = roleResolutionWarnings(profile.roleResolutionWarnings);
  return {
    projectId,
    ...(name ? { name } : {}),
    revision: Number.isInteger(Number(profile.revision)) ? Number(profile.revision) : 0,
    members: [...new Set(members)],
    team,
    assetRefs: stringList(group.assetRefs).slice(0, 64),
    assetVersionPolicy: group.assetVersionPolicy === 'pinned' ? 'pinned' : 'follow-accepted',
    conversationIds,
    conversations,
    ...(goal ? { goal } : {}),
    memberBriefs: stringRecord(profile.memberBriefs),
    memberNames: stringRecord(profile.memberNames),
    ...(warnings.length ? { roleResolutionWarnings: warnings } : {}),
  };
}

export function mergeMatOSProjectAuthorityMetadata(
  metadata: unknown,
  authority: MatOSProjectAuthorityProjection,
): JsonRecord {
  const current = isRecord(metadata) ? metadata : {};
  const warnings = Object.prototype.hasOwnProperty.call(
    authority,
    'roleResolutionWarnings',
  )
    ? roleResolutionWarnings(authority.roleResolutionWarnings)
    : roleResolutionWarnings(current.roleResolutionWarnings);
  const requestedActiveRoleRef = stringOrNull(current.matosActiveRoleRef);
  const activeRoleRef = requestedActiveRoleRef
    ? authority.members.find(roleRef =>
        roleIdentity(roleRef) === roleIdentity(requestedActiveRoleRef)) ?? authority.members[0] ?? null
    : authority.members[0] ?? null;
  return {
    ...current,
    members: authority.members,
    matosActiveRoleRef: activeRoleRef,
    matosProjectMembers: authority.team,
    matosAssetRefs: authority.assetRefs,
    matosAssetVersionPolicy: authority.assetVersionPolicy ?? 'follow-accepted',
    ...(authority.goal ? { goal: authority.goal } : { goal: undefined }),
    memberBriefs: authority.memberBriefs,
    memberNames: authority.memberNames,
    ...(warnings.length
      ? { roleResolutionWarnings: warnings }
      : { roleResolutionWarnings: undefined }),
    matosProjectRevision: authority.revision,
    matosProjectAuthority: '.matos/project.json',
  };
}

export async function syncMatOSProjectAuthority(input: {
  cwd: string;
  id: string;
  name: string;
  description?: string | null;
  metadata?: unknown;
  expectedRevision?: number;
}): Promise<MatOSProjectAuthorityProjection> {
  const metadata = isRecord(input.metadata) ? input.metadata : {};
  const description = stringOrNull(input.description) ?? stringOrNull(metadata.description);
  const existingAuthority = await readMatOSProjectAuthority(input.cwd, input.id).catch((error: any) => {
    if (
      error?.code === 'ENOENT' ||
      /MatOS project metadata has no id|MatOS project conversation (?:role is not a project member|member is not in the project)/i
        .test(String(error?.message ?? error))
    ) return null;
    throw error;
  });
  const metadataTeam = authorityTeam(metadata.matosProjectMembers);
  const requestedRoles = stringList(metadata.members);
  const rolesExplicit = Object.prototype.hasOwnProperty.call(metadata, 'members');
  const projectedTeam = metadataTeam.length > 0
    ? metadataTeam
    : existingAuthority?.team ?? [];
  const existingTeam = existingAuthority
    ? teamWithNativeHumanAuthority(projectedTeam, existingAuthority.team)
    : projectedTeam;
  const seededTeam = !rolesExplicit && existingTeam.length === 0
    ? [{
        memberId: defaultMemberId('role:compute'),
        roleRef: 'role:compute',
        label: 'Compute',
        kind: 'agent',
        source: 'default',
      }]
    : existingTeam;
  const team = reconcileAuthorityTeam(
    seededTeam,
    requestedRoles,
    rolesExplicit,
  );
  let payload = {
    id: input.id,
    name: input.name,
    ...(description ? { description } : {}),
    ...(Object.prototype.hasOwnProperty.call(metadata, 'goal')
      ? {
          // JSON PATCH clients conventionally use null to clear an optional
          // field. The native Workbench API represents the cleared value as
          // an empty string and projects it back as an omitted goal.
          goal: metadata.goal === null
            ? ''
            : typeof metadata.goal === 'string'
              ? metadata.goal
              : existingAuthority?.goal ?? '',
        }
      : {}),
    team,
    memberBriefs: stringRecord(metadata.memberBriefs),
    memberNames: stringRecord(metadata.memberNames),
    ...(Object.prototype.hasOwnProperty.call(metadata, 'matosAssetRefs')
      ? { assetRefs: stringList(metadata.matosAssetRefs).slice(0, 64) }
      : {}),
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
  };
  const localWarnings: MatOSProjectRoleResolutionWarning[] = [];
  const requiredRoleAssetIdentities = new Set(
    stringList(metadata.matosAssetRefs)
      .filter(ref => ref.startsWith('role:'))
      .map(roleIdentity),
  );
  let projected: MatOSProjectAuthorityProjection;
  for (let attempt = 0; ; attempt += 1) {
    try {
      projected = projectionFromGroup(await execMatOSJson(
        [
          'workbench',
          'projects',
          'sync',
          '--payload-json',
          JSON.stringify(payload),
          '--json',
        ],
        {
          cwd: input.cwd,
          env: {
            ...process.env,
            MATOS_WORKSPACE_DIR: input.cwd,
          },
        },
      ));
      break;
    } catch (error) {
      const missingRef = missingRoleAssetRef(error);
      const fallback = missingRef &&
        !requiredRoleAssetIdentities.has(roleIdentity(missingRef)) &&
        attempt < 8
        ? applyMissingRoleFallback(payload.team, missingRef)
        : null;
      if (!fallback) throw error;
      payload = { ...payload, team: fallback.team };
      localWarnings.push(fallback.warning);
    }
  }
  // The Workbench group view intentionally synthesizes a legacy `main`
  // conversation when none is stored. The daemon authority must reflect the
  // persisted file instead, otherwise importing two legacy projects attempts
  // to insert the same synthetic conversation id into SQLite.
  return withRoleResolutionWarnings(
    await readMatOSProjectAuthority(input.cwd, input.id) ?? projected,
    localWarnings,
  );
}

export async function readMatOSProjectAuthority(
  cwd: string,
  expectedProjectId?: string,
): Promise<MatOSProjectAuthorityProjection | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(cwd, '.matos', 'project.json'), 'utf8'));
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!isRecord(parsed)) throw new Error(`Invalid MatOS project metadata in ${cwd}`);
  const projectId = stringOrNull(parsed.id);
  if (!projectId) throw new Error(`MatOS project metadata has no id in ${cwd}`);
  if (expectedProjectId && projectId !== expectedProjectId) {
    throw new Error(
      `MatOS project folder identity mismatch: expected ${expectedProjectId}, found ${projectId}`,
    );
  }
  const team = authorityTeam(parsed.team);
  const name = stringOrNull(parsed.name);
  const members = team.flatMap(entry => entry.roleRef ? [entry.roleRef] : []);
  const conversations = authorityConversations(parsed.conversations);
  assertConversationRoster(team, conversations);
  const conversationIds = conversations.map(conversation => conversation.id);
  const goal = stringOrNull(parsed.goal);
  const warnings = roleResolutionWarnings(parsed.roleResolutionWarnings);
  return {
    projectId,
    ...(name ? { name } : {}),
    revision: Number.isInteger(Number(parsed.revision)) ? Number(parsed.revision) : 0,
    members: [...new Set(members)],
    team,
    assetRefs: stringList(parsed.assetRefs).slice(0, 64),
    assetVersionPolicy: parsed.assetVersionPolicy === 'pinned' ? 'pinned' : 'follow-accepted',
    conversationIds,
    conversations,
    ...(goal ? { goal } : {}),
    memberBriefs: stringRecord(parsed.memberBriefs),
    memberNames: stringRecord(parsed.memberNames),
    ...(warnings.length ? { roleResolutionWarnings: warnings } : {}),
  };
}

export async function createMatOSProjectTaskAuthority(
  cwd: string,
  task: {
    taskId: string;
    conversationId: string;
    roleRef: string;
    memberId?: string;
    prompt: string;
    sourceMessageId?: string;
    relayHop?: number;
  },
): Promise<void> {
  await execMatOSJson([
    'workbench',
    'projects',
    'task-create',
    '--payload-json',
    JSON.stringify(task),
    '--json',
  ], { cwd });
}

export async function updateMatOSProjectTaskAuthority(
  cwd: string,
  taskId: string,
  patch: { status: string; runId?: string | null; error?: string | null },
): Promise<void> {
  await execMatOSJson([
    'workbench',
    'projects',
    'task-update',
    taskId,
    '--payload-json',
    JSON.stringify(patch),
    '--json',
  ], { cwd });
}

export interface MatOSProjectTimelineAuthorityEvent {
  eventId: string;
  createdAt: string;
  projectId: string;
  conversationId: string;
  sender: {
    kind: 'human' | 'agent' | 'system';
    id: string;
    memberId?: string;
    roleRef?: string;
  };
  eventType: string;
  text: string;
  refs?: Record<string, unknown>;
}

export async function sendMatOSProjectMessageAuthority(input: {
  cwd: string;
  projectId: string;
  conversationId: string;
  eventId: string;
  createdAt: string;
  senderKind: 'human' | 'agent' | 'system';
  senderId: string;
  memberId?: string;
  roleRef?: string;
  text: string;
  refs?: Record<string, unknown>;
}): Promise<void> {
  const args = [
    'workbench', 'projects', 'send', input.projectId,
    '--conversation', input.conversationId,
    '--kind', input.senderKind,
    '--target-id', input.senderId,
    '--message', input.text,
    '--payload-json', JSON.stringify({
      eventId: input.eventId,
      createdAt: input.createdAt,
      refs: input.refs ?? {},
    }),
    '--json',
  ];
  if (input.memberId) args.push('--member-id', input.memberId);
  if (input.roleRef) args.push('--role', input.roleRef);
  await execMatOSJson(args, { cwd: input.cwd });
}

export async function listMatOSProjectTimelineAuthority(input: {
  cwd: string;
  projectId: string;
  conversationId: string;
}): Promise<MatOSProjectTimelineAuthorityEvent[]> {
  const events = new Map<string, MatOSProjectTimelineAuthorityEvent>();
  let offset = 0;
  while (true) {
    const value = await execMatOSJson([
      'workbench', 'projects', 'timeline', input.projectId,
      '--conversation', input.conversationId,
      '--limit', '500',
      '--offset', String(offset),
      '--json',
    ], { cwd: input.cwd });
    if (!isRecord(value) || !Array.isArray(value.events)) {
      throw new Error('MatOS project timeline returned an unexpected payload');
    }
    const rawCount = value.events.length;
    for (const event of value.events) {
      if (
        !isRecord(event) ||
        typeof event.eventId !== 'string' || !event.eventId ||
        typeof event.createdAt !== 'string' || !Number.isFinite(Date.parse(event.createdAt)) ||
        event.projectId !== input.projectId ||
        event.conversationId !== input.conversationId ||
        typeof event.text !== 'string' ||
        !isRecord(event.sender) ||
        !['human', 'agent', 'system'].includes(String(event.sender.kind)) ||
        typeof event.sender.id !== 'string'
      ) {
        throw new Error('MatOS project timeline returned an invalid event');
      }
      if (events.has(event.eventId)) {
        throw new Error(`MatOS project timeline returned duplicate event id: ${event.eventId}`);
      }
      events.set(event.eventId, event as unknown as MatOSProjectTimelineAuthorityEvent);
    }
    offset += rawCount;
    if (offset > 100_000) {
      throw new Error('MatOS project timeline exceeds the 100 000 event import limit');
    }
    const summary = isRecord(value.summary) ? value.summary : {};
    const total = Number(summary.total);
    if (rawCount < 500 || (Number.isFinite(total) && offset >= total)) break;
  }
  return [...events.values()];
}

export async function syncMatOSProjectConversationsAuthority(input: {
  cwd: string;
  expectedRevision?: number;
  roleResolutionWarnings?: MatOSProjectRoleResolutionWarning[];
  conversations: Array<{
    id: string;
    title?: string | null;
    roleRef?: string | null;
    memberRefs?: string[];
    createdAt?: number;
    updatedAt?: number;
  }>;
}): Promise<MatOSProjectAuthorityProjection> {
  const existingAuthority = await readMatOSProjectAuthority(input.cwd).catch(() => null);
  await execMatOSJson([
    'workbench', 'projects', 'conversation-sync',
    '--payload-json', JSON.stringify({
      conversations: input.conversations,
      ...(input.expectedRevision !== undefined
        ? { expectedRevision: input.expectedRevision }
        : {}),
    }),
    '--json',
  ], { cwd: input.cwd });
  const authority = await readMatOSProjectAuthority(input.cwd);
  if (!authority) {
    throw new Error('MatOS project conversation sync produced no project authority');
  }
  return withRoleResolutionWarnings(authority, [
    ...(existingAuthority?.roleResolutionWarnings ?? []),
    ...(input.roleResolutionWarnings ?? []),
  ]);
}
