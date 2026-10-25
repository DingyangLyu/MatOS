// Research-toolbox action catalogue + pure helpers shared between the composer
// (which owns the apply/staging engine) and the assistant "next step" card
// (which surfaces a curated couple of these actions as primary follow-up rows).
// Keep this module free of React and composer-internal state so both surfaces
// can import the same source of truth.
//
// MatOS note: the action ids, i18n key names, test ids, and analytics ids are
// upstream-stable, but the semantics are materials science. Each id maps to
// the nearest research task (`motion` = molecular dynamics, `transition-motion`
// = transition states / NEB, `reference-extract` = methods from a paper,
// `visual-polish` = verify & package results, `logo-gen` = material summary
// card, …); the user-visible copy lives in `chat.designToolbox.*` i18n keys.
import type { Dict } from '../i18n/types';
import type { IconName } from '../components/Icon';
import type { SkillSummary } from '../types';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;

export type DesignToolboxActionId =
  | 'auto-match'
  | 'asset-search'
  | 'icon-workflow'
  | 'image-replace'
  | 'reference-extract'
  | 'motion'
  | 'motion-polish'
  | 'transition-motion'
  | 'plan-outline'
  | 'threejs-scene'
  | 'anti-ai-polish'
  | 'visual-polish'
  | 'image-gen'
  | 'chart-gen'
  | 'logo-gen'
  | 'video-gen';

export interface DesignToolboxAction {
  id: DesignToolboxActionId;
  icon: IconName;
  preferredSkillIds: string[];
  categoryHints: string[];
  searchTerms: string[];
}

export const DESIGN_TOOLBOX_ACTIONS: DesignToolboxAction[] = [
  {
    id: 'auto-match',
    icon: 'sparkles',
    preferredSkillIds: ['compute', 'materials-compute', 'workflow-builder', 'intelligence', 'creative-director'],
    categoryHints: ['creative-direction', 'web-artifacts', 'image-generation', 'animation-motion'],
    searchTerms: ['match', 'recommend', 'next step', 'workflow', 'skills', 'mcp', 'tools', 'plan', 'method', 'dft', 'orchestrate', '匹配', '下一步', '推荐', '流程', '规划', '方法选择', '科研百宝箱'],
  },
  {
    id: 'asset-search',
    icon: 'search',
    preferredSkillIds: ['materials-databases', 'academic', 'materials-source-library', 'browser-use'],
    categoryHints: ['image-generation', 'web-artifacts', 'creative-direction'],
    searchTerms: ['find data', 'structure search', 'materials project', 'database', 'dataset', 'literature', 'paper search', 'reference data', 'cif', '找数据', '找结构', '查文献', '数据库', '数据集'],
  },
  {
    id: 'icon-workflow',
    icon: 'star',
    preferredSkillIds: ['structure-models', 'structure-tools', 'compute-structures', 'modeling'],
    categoryHints: ['image-generation', 'creative-direction', 'web-artifacts'],
    searchTerms: ['structure', 'build structure', 'supercell', 'slab', 'vacancy', 'interface', 'molecule', 'poscar', 'cif', '建模', '建结构', '超胞', '表面模型', '缺陷', '界面'],
  },
  {
    id: 'image-replace',
    icon: 'image',
    preferredSkillIds: ['compute-foundations', 'dft-corrections', 'qe-pseudopotentials', 'compute'],
    categoryHints: ['image-generation', 'web-artifacts'],
    searchTerms: ['settings', 'input', 'functional', 'cutoff', 'k-mesh', 'k-points', 'smearing', 'pseudopotential', 'incar', 'basis set', '参数', '截断能', 'k 点', '赝势', '收敛设置'],
  },
  {
    id: 'reference-extract',
    icon: 'eye',
    preferredSkillIds: ['academic', 'materials-source-library', 'browser-use'],
    categoryHints: ['creative-direction', 'web-artifacts'],
    searchTerms: ['paper', 'methods', 'reproduce', 'protocol', 'doi', 'supplementary', 'extract parameters', '文献', '方法提取', '复现', '参数提取', '补充材料'],
  },
  {
    id: 'motion',
    icon: 'play',
    preferredSkillIds: ['atomistic-simulation-tools', 'mlip-guide', 'compute-molecular', 'biomolecular-md', 'emilkowalski-motion'],
    categoryHints: ['animation-motion'],
    searchTerms: ['molecular dynamics', 'md', 'trajectory', 'thermostat', 'nvt', 'npt', 'lammps', 'mlip', 'diffusion', '分子动力学', '轨迹', '系综', '扩散'],
  },
  {
    id: 'motion-polish',
    icon: 'sliders',
    preferredSkillIds: ['atomistic-simulation-tools', 'mlip-guide', 'thermal-properties'],
    categoryHints: ['animation-motion'],
    searchTerms: ['equilibration', 'energy drift', 'timestep', 'sampling', 'msd', 'md quality', '平衡', '漂移', '采样', '质量检查', '时间步长'],
  },
  {
    id: 'transition-motion',
    icon: 'reload',
    preferredSkillIds: ['defects-reactions', 'compute-defects-surfaces', 'catalysis-electrochem'],
    categoryHints: ['animation-motion', 'video-generation'],
    searchTerms: ['neb', 'transition state', 'barrier', 'saddle point', 'cineb', 'reaction path', 'migration', '过渡态', '能垒', '反应路径', '迁移'],
  },
  {
    id: 'plan-outline',
    icon: 'file',
    preferredSkillIds: ['workflow-builder', 'compute', 'high-throughput'],
    categoryHints: ['creative-direction', 'web-artifacts'],
    searchTerms: ['plan', 'outline', 'protocol', 'compute plan', 'workflow plan', 'doc', 'brief', '规划', '大纲', '计算方案', '方案文档', '提纲'],
  },
  {
    id: 'threejs-scene',
    icon: 'orbit',
    preferredSkillIds: ['structure-tools', 'wavefunction-analysis', 'spin-texture', 'threejs'],
    categoryHints: ['web-artifacts', 'animation-motion'],
    searchTerms: ['visualize', '3d', 'structure viewer', 'trajectory view', 'charge density', 'isosurface', 'brillouin zone', '3D', '三维', '可视化', '结构查看', '等值面'],
  },
  {
    id: 'anti-ai-polish',
    icon: 'paint-bucket',
    preferredSkillIds: ['compute-foundations', 'materials-compute', 'intelligence'],
    categoryHints: ['creative-direction', 'web-artifacts'],
    searchTerms: ['sanity', 'check', 'validate', 'units', 'magnitude', 'physical', 'plausible', '合理性', '量级', '单位', '校验', '物理直觉'],
  },
  {
    id: 'visual-polish',
    icon: 'palette',
    preferredSkillIds: ['compute', 'handoff-templates', 'academic', 'materials-compute'],
    categoryHints: ['creative-direction', 'web-artifacts'],
    searchTerms: ['verify', 'report', 'convergence', 'deliver', 'summary', 'audit', 'package', '核验', '报告', '交付', '汇总', '收敛'],
  },
  {
    id: 'image-gen',
    icon: 'image',
    preferredSkillIds: ['structure-tools', 'academic', 'spectroscopy'],
    categoryHints: ['image-generation'],
    searchTerms: ['image', 'figure', 'render', 'structure image', 'publication figure', 'schematic', '出图', '图像', '示意图', '结构图'],
  },
  {
    id: 'chart-gen',
    icon: 'grid',
    preferredSkillIds: ['electronic-structure', 'band-advanced', 'phase-diagram', 'echarts'],
    categoryHints: ['web-artifacts', 'image-generation'],
    searchTerms: ['plot', 'chart', 'band structure', 'dos', 'convergence curve', 'msd plot', 'phase diagram', 'parity plot', 'matplotlib', '画图', '图表', '能带图', '态密度', '相图'],
  },
  {
    id: 'logo-gen',
    icon: 'palette',
    preferredSkillIds: ['materials-databases', 'handoff-templates', 'compute'],
    categoryHints: ['image-generation', 'creative-direction'],
    searchTerms: ['summary card', 'material card', 'identity', 'properties summary', 'provenance', '材料卡片', '材料档案', '汇总卡', '性质汇总'],
  },
  {
    id: 'video-gen',
    icon: 'play',
    preferredSkillIds: ['atomistic-simulation-tools', 'structure-tools', 'video-hyperframes'],
    categoryHints: ['video-generation'],
    searchTerms: ['animation', 'trajectory video', 'phonon mode', 'render animation', 'reaction path video', '动画', '轨迹动画', '声子振动', '生视频'],
  },
];

// The actions surfaced as primary next-step rows on the assistant card (the
// rest live behind "More"). Curated for the two most common iteration paths:
// auto-match (let the agent pick the method / skills / tools for the next
// research step) and visual-polish (verify the current results and package
// them into something deliverable).
export const FEATURED_DESIGN_TOOLBOX_ACTION_IDS: DesignToolboxActionId[] = [
  'auto-match',
  'visual-polish',
];

export function getDesignToolboxAction(id: DesignToolboxActionId): DesignToolboxAction | null {
  return DESIGN_TOOLBOX_ACTIONS.find((action) => action.id === id) ?? null;
}

export function designToolboxActionTitle(action: DesignToolboxAction, t: TranslateFn): string {
  return t(`chat.designToolbox.action.${action.id}.title` as keyof Dict);
}

export function designToolboxActionBadge(action: DesignToolboxAction, t: TranslateFn): string {
  return t(`chat.designToolbox.action.${action.id}.badge` as keyof Dict);
}

export function designToolboxActionDescription(action: DesignToolboxAction, t: TranslateFn): string {
  return t(`chat.designToolbox.action.${action.id}.description` as keyof Dict);
}

// Shared matcher for the Design toolbox action rows, used by both the composer
// panel and the next-step card so the two surfaces filter identically. `skill`
// is the action's matched skill (see findDesignToolboxSkill); threading it in
// means searching by a preferred skill's id/name/description/category keeps the
// action row visible alongside its resource row, instead of the two disagreeing.
export function designToolboxActionMatchesQuery(
  action: DesignToolboxAction,
  query: string,
  skill: SkillSummary | null,
  t: TranslateFn,
  extra: string[] = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    designToolboxActionTitle(action, t),
    designToolboxActionBadge(action, t),
    designToolboxActionDescription(action, t),
    ...action.searchTerms,
    skill?.id ?? '',
    skill?.name ?? '',
    skill?.description ?? '',
    skill?.category ?? '',
    ...extra,
  ]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

// `extra` carries any locale-resolved text (localized name / description) the
// caller wants indexed alongside the raw skill fields, so a localized query
// matches the same way the composer's localized resource index does. design-
// toolbox stays free of i18n/content — the caller resolves the strings.
export function skillMatchesQuery(
  skill: SkillSummary,
  query: string,
  extra: string[] = [],
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [skill.id, skill.name, skill.description, skill.mode, skill.surface ?? '', ...skill.triggers, ...extra]
    .join(' ')
    .toLowerCase()
    .includes(q);
}

export function findDesignToolboxSkill(
  action: DesignToolboxAction,
  skills: SkillSummary[],
): SkillSummary | null {
  for (const id of action.preferredSkillIds) {
    const exact = skills.find((skill) => skill.id === id || skill.name === id);
    if (exact) return exact;
  }
  const categoryHintSet = new Set(action.categoryHints);
  const categoryMatch = skills.find((skill) =>
    skill.category ? categoryHintSet.has(skill.category) : false,
  );
  if (categoryMatch) return categoryMatch;
  return (
    skills.find((skill) =>
      action.searchTerms.some((term) => skillMatchesQuery(skill, term)),
    ) ?? null
  );
}
