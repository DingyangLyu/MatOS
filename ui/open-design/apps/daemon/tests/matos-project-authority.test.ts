import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  mergeMatOSProjectAuthorityMetadata,
  readMatOSProjectAuthority,
} from '../src/services/matos-project-authority.js';

describe('MatOS project authority projection', () => {
  const roots: string[] = [];
  const previousMatosBin = process.env.MATOS_BIN;

  afterEach(async () => {
    if (previousMatosBin === undefined) delete process.env.MATOS_BIN;
    else process.env.MATOS_BIN = previousMatosBin;
    vi.resetModules();
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
  });

  it('fails closed when a folder belongs to a different project id', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-matos-project-authority-'));
    roots.push(root);
    await mkdir(path.join(root, '.matos'), { recursive: true });
    await writeFile(path.join(root, '.matos', 'project.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 3,
      id: 'project-a',
      name: 'Project A',
      team: [{ roleRef: 'role:compute@1.0.0' }],
      assetRefs: ['knowledge:shared-runbook', 'tool:project-helper'],
      conversations: [{
        id: 'native-conversation',
        title: 'Native conversation',
        roleRef: 'role:compute@1.0.0',
        memberRefs: ['role:compute@1.0.0'],
        createdAt: '2026-07-10T00:00:00.000Z',
      }],
    }));

    await expect(readMatOSProjectAuthority(root, 'project-b'))
      .rejects.toThrow('folder identity mismatch');
    const authority = await readMatOSProjectAuthority(root, 'project-a');
    expect(authority).toMatchObject({
      projectId: 'project-a',
      revision: 3,
      members: ['role:compute@1.0.0'],
      team: [{ memberId: 'agent-compute', roleRef: 'role:compute@1.0.0' }],
      assetRefs: ['knowledge:shared-runbook', 'tool:project-helper'],
      conversationIds: ['native-conversation'],
      conversations: [{
        id: 'native-conversation',
        title: 'Native conversation',
        roleRef: 'role:compute@1.0.0',
        memberRefs: ['role:compute@1.0.0'],
        createdAt: Date.parse('2026-07-10T00:00:00.000Z'),
      }],
    });
    expect(mergeMatOSProjectAuthorityMetadata({ members: ['role:stale'] }, authority!))
      .toMatchObject({
        members: ['role:compute@1.0.0'],
        matosActiveRoleRef: 'role:compute@1.0.0',
        matosAssetRefs: ['knowledge:shared-runbook', 'tool:project-helper'],
        matosProjectRevision: 3,
      });
    expect(mergeMatOSProjectAuthorityMetadata({
      matosActiveRoleRef: 'role:compute@0.1.0',
    }, authority!)).toMatchObject({
      matosActiveRoleRef: 'role:compute@1.0.0',
    });
  });

  it('keeps a custom member id instead of reducing project identity to a role', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-matos-project-authority-'));
    roots.push(root);
    await mkdir(path.join(root, '.matos'), { recursive: true });
    await writeFile(path.join(root, '.matos', 'project.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      id: 'custom-members',
      name: 'Custom members',
      team: [{ memberId: 'compute-lead', roleRef: 'role:compute@1.0.0', label: 'Lead' }],
    }));
    const authority = await readMatOSProjectAuthority(root, 'custom-members');
    expect(authority?.team).toEqual([{
      memberId: 'compute-lead',
      roleRef: 'role:compute@1.0.0',
      label: 'Lead',
    }]);
    expect(mergeMatOSProjectAuthorityMetadata({}, authority!)).toMatchObject({
      matosProjectMembers: [{ memberId: 'compute-lead', roleRef: 'role:compute@1.0.0' }],
    });
  });

  it('preserves role-less human collaborators alongside runnable agents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-matos-project-authority-'));
    roots.push(root);
    await mkdir(path.join(root, '.matos'), { recursive: true });
    await writeFile(path.join(root, '.matos', 'project.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 4,
      id: 'shared-project',
      name: 'Shared project',
      team: [
        { memberId: 'agent-compute', roleRef: 'role:compute@1.0.0', kind: 'agent' },
        {
          memberId: 'user-bob',
          kind: 'human',
          userId: 'user:bob-test-local',
          label: 'bob@test.local',
        },
      ],
    }));
    const authority = await readMatOSProjectAuthority(root, 'shared-project');
    expect(authority?.members).toEqual(['role:compute@1.0.0']);
    expect(authority?.team).toEqual([
      expect.objectContaining({
        memberId: 'agent-compute',
        roleRef: 'role:compute@1.0.0',
        kind: 'agent',
      }),
      expect.objectContaining({
        memberId: 'user-bob',
        kind: 'human',
        userId: 'user:bob-test-local',
      }),
    ]);
  });

  it('rejects one member id bound to multiple roles', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-matos-project-authority-'));
    roots.push(root);
    await mkdir(path.join(root, '.matos'), { recursive: true });
    await writeFile(path.join(root, '.matos', 'project.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      id: 'duplicate-member',
      name: 'Duplicate member',
      team: [
        { memberId: 'member-a', roleRef: 'role:compute' },
        { memberId: 'member-a', roleRef: 'role:academic' },
      ],
    }));
    await expect(readMatOSProjectAuthority(root, 'duplicate-member'))
      .rejects.toThrow('assigned to multiple roles');
  });

  it('fails closed for duplicate or malformed native conversations', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-matos-project-authority-'));
    roots.push(root);
    await mkdir(path.join(root, '.matos'), { recursive: true });
    const metadataPath = path.join(root, '.matos', 'project.json');
    await writeFile(metadataPath, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      id: 'invalid-conversations',
      name: 'Invalid conversations',
      team: [{ roleRef: 'role:compute' }],
      conversations: [{ id: 'duplicate' }, { id: 'duplicate' }],
    }));
    await expect(readMatOSProjectAuthority(root, 'invalid-conversations'))
      .rejects.toThrow('Duplicate MatOS project conversation id');

    await writeFile(metadataPath, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      id: 'invalid-conversations',
      name: 'Invalid conversations',
      team: [{ roleRef: 'role:compute' }],
      conversations: [{ id: '../escape' }],
    }));
    await expect(readMatOSProjectAuthority(root, 'invalid-conversations'))
      .rejects.toThrow('Invalid MatOS project conversation id');

    await writeFile(metadataPath, JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      id: 'invalid-conversations',
      name: 'Invalid conversations',
      team: [{ roleRef: 'role:compute' }],
      conversations: [{ id: 'foreign', memberRefs: ['role:academic'] }],
    }));
    await expect(readMatOSProjectAuthority(root, 'invalid-conversations'))
      .rejects.toThrow('conversation member is not in the project');
  });

  it('falls back to compute when an older CLI rejects a missing role during sync', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'od-matos-project-authority-'));
    roots.push(root);
    const fakeMatos = path.join(root, 'matos-fake.cjs');
    await writeFile(fakeMatos, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const payloadIndex = process.argv.indexOf('--payload-json');
const payload = JSON.parse(process.argv[payloadIndex + 1]);
if (process.argv.includes('conversation-sync')) {
  const projectPath = path.join(process.cwd(), '.matos', 'project.json');
  const project = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
  project.revision = Number(project.revision || 0) + 1;
  project.conversations = payload.conversations || [];
  fs.writeFileSync(projectPath, JSON.stringify(project));
  console.log(JSON.stringify({ mode: 'matos-project-conversation-sync', project }));
  process.exit(0);
}
if (payload.team.some((member) => member.roleRef === 'role:deep-research')) {
  console.error('MatOS role asset not found: role:deep-research');
  process.exit(1);
}
const team = payload.team.map((member) => ({
  memberId: member.memberId,
  roleRef: member.roleRef,
  label: member.label,
  kind: member.kind,
  userId: member.userId,
  source: member.source,
}));
const project = {
  schemaVersion: 1,
  revision: 1,
  id: payload.id,
  name: payload.name,
  team,
  conversations: [],
  memberBriefs: payload.memberBriefs || {},
  memberNames: payload.memberNames || {},
};
fs.mkdirSync(path.join(process.cwd(), '.matos'), { recursive: true });
fs.writeFileSync(path.join(process.cwd(), '.matos', 'project.json'), JSON.stringify(project));
console.log(JSON.stringify({
  mode: 'matos-project-group-sync',
  project: {
    project: { id: payload.id, name: payload.name },
    profile: { revision: 1, memberBriefs: {}, memberNames: {} },
    members: team,
    conversations: [],
  },
}));
`);
    await chmod(fakeMatos, 0o755);

    process.env.MATOS_BIN = fakeMatos;
    vi.resetModules();
    const {
      mergeMatOSProjectAuthorityMetadata: mergeMetadata,
      syncMatOSProjectConversationsAuthority: syncConversations,
      syncMatOSProjectAuthority: syncAuthority,
    } = await import('../src/services/matos-project-authority.js');

    const authority = await syncAuthority({
      cwd: root,
      id: 'fallback-sync',
      name: 'Fallback sync',
      metadata: { members: ['role:deep-research'] },
    });

    expect(authority.members).toEqual(['role:compute']);
    expect(authority.team).toMatchObject([{
      memberId: 'agent-compute',
      roleRef: 'role:compute',
      label: 'Compute',
      source: 'role-fallback',
    }]);
    const warnings = authority.roleResolutionWarnings;
    expect(warnings).toEqual([{
      code: 'role_asset_fallback',
      requestedRoleRef: 'role:deep-research',
      fallbackRoleRef: 'role:compute',
      message: 'MatOS role asset not found: role:deep-research; fell back to role:compute.',
    }]);
    if (!warnings) throw new Error('expected role fallback warnings');
    expect(mergeMetadata({}, authority).roleResolutionWarnings)
      .toEqual(warnings);
    const { roleResolutionWarnings: _warnings, ...authorityWithoutWarnings } = authority;
    expect(mergeMetadata(
      { roleResolutionWarnings: warnings },
      authorityWithoutWarnings,
    ).roleResolutionWarnings).toEqual(warnings);

    const recoveredAuthority = await syncAuthority({
      cwd: root,
      id: 'fallback-sync',
      name: 'Fallback sync',
      metadata: {
        members: ['role:compute'],
        roleResolutionWarnings: warnings,
      },
    });
    expect(recoveredAuthority.roleResolutionWarnings).toEqual([]);
    expect(mergeMetadata(
      { roleResolutionWarnings: warnings },
      recoveredAuthority,
    ).roleResolutionWarnings).toBeUndefined();

    await expect(syncAuthority({
      cwd: root,
      id: 'fallback-sync',
      name: 'Fallback sync',
      metadata: {
        members: ['role:deep-research'],
        matosAssetRefs: ['role:deep-research'],
      },
    })).rejects.toThrow('MatOS role asset not found: role:deep-research');

    const conversationAuthority = await syncConversations({
      cwd: root,
      expectedRevision: authority.revision,
      roleResolutionWarnings: warnings,
      conversations: [{
        id: 'fallback-conversation',
        roleRef: null,
        memberRefs: [],
        createdAt: 1,
        updatedAt: 2,
      }],
    });
    expect(conversationAuthority.roleResolutionWarnings)
      .toEqual(warnings);

    // A recipient daemon may still hold the SQLite projection from before a
    // gateway share completed. Syncing an unrelated web edit must keep the
    // native human grant instead of replacing the whole team with that stale
    // projection.
    const projectPath = path.join(root, '.matos', 'project.json');
    const nativeProject = JSON.parse(await readFile(projectPath, 'utf8')) as {
      revision: number;
      team: Array<Record<string, unknown>>;
    };
    nativeProject.revision += 1;
    nativeProject.team.push({
      memberId: 'user-new-collaborator',
      kind: 'human',
      userId: 'user:new-collaborator',
      label: 'new-collaborator@test.local',
      source: 'explicit',
    });
    await writeFile(projectPath, JSON.stringify(nativeProject), 'utf8');

    const afterStaleProjection = await syncAuthority({
      cwd: root,
      id: 'fallback-sync',
      name: 'Fallback sync',
      metadata: {
        members: ['role:compute'],
        matosProjectMembers: [{
          memberId: 'agent-compute',
          roleRef: 'role:compute',
          kind: 'agent',
        }],
      },
    });
    expect(afterStaleProjection.team).toContainEqual(
      expect.objectContaining({
        memberId: 'user-new-collaborator',
        kind: 'human',
        userId: 'user:new-collaborator',
      }),
    );
  });
});
