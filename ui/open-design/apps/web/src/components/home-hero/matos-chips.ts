// MatOS Home "start from a template" catalog.
//
// Replaces the upstream Open Design create rail (deck / prototype /
// wireframe / …) with MatOS-native starters: project kick-off templates
// (compute task) plus one draft template per MatOS
// asset type. Rendered with the exact same illustrated scenario-card
// markup/CSS as the upstream rail (see RailGroup in HomeHero.tsx), so the
// visual language is unchanged — only the semantics are MatOS.
//
// Kept as a pure data table like `chips.ts`: id (stable key/test selector),
// Dict keys for label/description, an Icon fallback, and a discriminated
// action union that HomeHero's MatOS dispatcher matches on.

import type { Dict } from '../../i18n/types';
import type { IconName } from '../Icon';
import type { MatOSAssetProjectType } from '../../matos-asset-projects';

export type MatOSTemplateAction =
  // Spawn an asset-editing project (agent chat + seeded draft artifact).
  | { kind: 'asset'; assetType: MatOSAssetProjectType }
  // Pre-fill the Home composer with a task scaffold the user completes.
  | { kind: 'prompt'; promptKey: keyof Dict };

export interface MatOSTemplateChip {
  id: string;
  labelKey: keyof Dict;
  descKey: keyof Dict;
  icon: IconName;
  action: MatOSTemplateAction;
}

export const MATOS_TEMPLATE_CHIPS: ReadonlyArray<MatOSTemplateChip> = [
  {
    id: 'matos-compute',
    labelKey: 'homeHero.matos.computeTask',
    descKey: 'homeHero.matos.computeTaskDesc',
    icon: 'sparkles',
    action: { kind: 'prompt', promptKey: 'homeHero.matos.computeTaskPrompt' },
  },
  {
    id: 'matos-workflow',
    labelKey: 'homeHero.matos.workflow',
    descKey: 'homeHero.matos.workflowDesc',
    icon: 'fork',
    action: { kind: 'asset', assetType: 'workflow' },
  },
  {
    id: 'matos-role',
    labelKey: 'homeHero.matos.role',
    descKey: 'homeHero.matos.roleDesc',
    icon: 'orbit',
    action: { kind: 'asset', assetType: 'role' },
  },
  {
    id: 'matos-skill',
    labelKey: 'homeHero.matos.skill',
    descKey: 'homeHero.matos.skillDesc',
    icon: 'lightbulb',
    action: { kind: 'asset', assetType: 'skill' },
  },
  {
    id: 'matos-tool',
    labelKey: 'homeHero.matos.tool',
    descKey: 'homeHero.matos.toolDesc',
    icon: 'hammer',
    action: { kind: 'asset', assetType: 'tool' },
  },
  {
    id: 'matos-knowledge',
    labelKey: 'homeHero.matos.knowledge',
    descKey: 'homeHero.matos.knowledgeDesc',
    icon: 'file-text',
    action: { kind: 'asset', assetType: 'knowledge' },
  },
  {
    id: 'matos-data',
    labelKey: 'homeHero.matos.data',
    descKey: 'homeHero.matos.dataDesc',
    icon: 'layers-filled',
    action: { kind: 'asset', assetType: 'data' },
  },
];
