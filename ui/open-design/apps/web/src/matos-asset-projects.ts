// MatOS asset-editing projects.
//
// The nav rail "+" spawns one project per asset draft, reusing the project
// conversation surface end to end: agent chat on the left, the seeded
// asset file as the live editable artifact on the right (workflow drafts
// open straight on the React Flow canvas; markdown drafts in the text
// viewer's edit mode). The project persists in the normal project list, so
// the user can always come back to the same conversation and draft —
// nothing about the flow is throwaway.

import { createProject } from './state/projects';
import { writeProjectTextFile, writeProjectTextFileDetailed } from './providers/registry';
import { navigate } from './router';
import type { useT } from './i18n';

export type MatOSAssetProjectType =
  | 'knowledge'
  | 'skill'
  | 'tool'
  | 'role'
  | 'workflow'
  | 'data';

const SEED_FILE: Record<MatOSAssetProjectType, string> = {
  knowledge: 'KNOWLEDGE.md',
  skill: 'SKILL.md',
  tool: 'TOOL.md',
  role: 'ROLE.md',
  workflow: 'workflow.json',
  data: 'DATA.md',
};

// Seed drafts are agent-facing skeletons: enough structure that the right
// pane shows a real artifact immediately, with placeholders the agent (or
// the user, via the text editor) fills in. The workflow seed is a valid
// empty definition so the canvas mounts straight away.
const SEED_CONTENT: Record<MatOSAssetProjectType, string> = {
  knowledge: [
    '# <title>',
    '',
    '<!-- Draft this knowledge asset with the agent on the left.',
    '     When it reads well, ask the agent to publish it into your scope. -->',
    '',
    '## Summary',
    '',
    '## Details',
    '',
  ].join('\n'),
  skill: [
    '---',
    'name: <skill-id>',
    'description: <one-line description>',
    '---',
    '',
    '# Steps',
    '',
    '1. ',
    '',
  ].join('\n'),
  tool: [
    '# <tool name>',
    '',
    '<!-- Describe what the tool wraps (CLI, script, MCP server), its inputs,',
    '     outputs, and safety constraints. The agent will turn this into a',
    '     tool asset with the right schema/config. -->',
    '',
  ].join('\n'),
  role: [
    '# <role name>',
    '',
    '<!-- The role prompt: who this agent is, how it works, its guardrails.',
    '     List the skills / tools / knowledge it should mount; the agent will',
    '     compose them when publishing. -->',
    '',
  ].join('\n'),
  workflow: `${JSON.stringify(
    {
      schemaVersion: 1,
      name: 'new-workflow',
      version: '0.1.0',
      description: '',
      parameters: {},
      policy: { approvalMode: 'bypass' },
      nodes: [],
      outputs: {},
      canvas: { nodes: {} },
    },
    null,
    2,
  )}\n`,
  data: [
    '# <dataset name>',
    '',
    '<!-- Record the dataset reference: source URL or mount path,',
    '     container-visible location, checksum, license, and provenance.',
    '     Payloads stay in mounted storage; the asset only references them. -->',
    '',
  ].join('\n'),
};

export interface MatOSAssetDraftProject {
  projectId: string;
  conversationId: string | null;
  seedName: string;
}

/**
 * Create an asset-draft project (project record + seeded entry file) WITHOUT
 * navigating. Callers that need to stage extra context first — e.g. the
 * resource library's "sediment into asset" flow, which copies selected
 * resources into the project before opening it — use this and own the
 * navigation themselves.
 */
export async function createMatOSAssetDraftProject(
  type: MatOSAssetProjectType,
  t: ReturnType<typeof useT>,
  options: { pendingPrompt?: string | null; workflowDefinition?: Record<string, unknown>; name?: string; sourceAssetRef?: string } = {},
): Promise<MatOSAssetDraftProject> {
  const name = options.name ?? t(`assetProject.name.${type}` as never);
  const pendingPrompt =
    options.pendingPrompt === undefined
      ? t(`createMenu.prompt.${type}` as never)
      : options.pendingPrompt;
  const { project, conversationId } = await createProject({
    name,
    skillId: null,
    metadata: { kind: 'other', matosAssetType: type, ...(options.sourceAssetRef ? { matosAssetSourceRef: options.sourceAssetRef } : {}) },
    // Pre-seeds the composer (not auto-sent) so the user completes the
    // placeholders before the agent starts drafting.
    ...(pendingPrompt ? { pendingPrompt } : {}),
  });
  const seedName = SEED_FILE[type];
  if (type === 'workflow') {
    // The canvas cannot open until its initial document has actually persisted.
    const content = options.workflowDefinition ? JSON.stringify(options.workflowDefinition, null, 2) : SEED_CONTENT[type];
    const result = await writeProjectTextFileDetailed(project.id, seedName, content, {
      expectedEtag: null,
    });
    if (!result.ok) throw new Error(result.message);
  } else {
    try {
      await writeProjectTextFile(project.id, seedName, SEED_CONTENT[type]);
    } catch {
      // The agent will create the file on its first turn instead.
    }
  }
  return { projectId: project.id, conversationId: conversationId ?? null, seedName };
}

export async function createMatOSAssetProject(
  type: MatOSAssetProjectType,
  t: ReturnType<typeof useT>,
): Promise<void> {
  const { projectId, conversationId, seedName } = await createMatOSAssetDraftProject(type, t);
  navigate({
    kind: 'project',
    projectId,
    conversationId,
    fileName: seedName,
  });
}
