import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatSessionMode } from '@open-design/contracts';
import { useI18n } from '../i18n';
import { localizeSkillDescription, localizeSkillName } from '../i18n/content';
import type { Dict } from '../i18n/types';
import { Icon, type IconName } from './Icon';
import {
  DESIGN_TOOLBOX_ACTIONS,
  FEATURED_DESIGN_TOOLBOX_ACTION_IDS,
  designToolboxActionBadge,
  designToolboxActionDescription,
  designToolboxActionMatchesQuery,
  designToolboxActionTitle,
  findDesignToolboxSkill,
  getDesignToolboxAction,
  skillMatchesQuery,
  type DesignToolboxAction,
  type DesignToolboxActionId,
} from '../runtime/design-toolbox';
import type { SkillSummary } from '../types';
import styles from './NextStepActions.module.css';

type TranslateFn = (key: keyof Dict, vars?: Record<string, string | number>) => string;
export type NextStepActionsVariant = 'default' | 'project-incomplete' | 'plan';

export const PROJECT_CONTINUE_PROMPT =
  'Continue from the stopped or incomplete turn. Read the conversation, current project files, and any visible errors, then take the next concrete step. If a primary artifact already exists, update it in place; otherwise create the missing primary artifact and summarize what changed.';

export const PROJECT_GENERATE_ARTIFACT_PROMPT =
  'Generate the missing project artifact now. Use the current conversation and project context to create the primary previewable deliverable, usually index.html unless another file type is clearly requested. Save it into this project and include a concise summary of the files created.';

export const PROJECT_INCOMPLETE_NEXT_STEP_ACTIONS = [
  {
    id: 'project-continue',
    icon: 'refresh' as IconName,
    titleKey: 'nextStep.projectContinueTitle' as keyof Dict,
    prompt: PROJECT_CONTINUE_PROMPT,
  },
  {
    id: 'project-generate-artifact',
    icon: 'plus' as IconName,
    titleKey: 'nextStep.projectGenerateArtifactTitle' as keyof Dict,
    prompt: PROJECT_GENERATE_ARTIFACT_PROMPT,
  },
] as const;

const PLAN_NEXT_STEP_ACTIONS = [
  {
    id: 'plan-generate-from-doc',
    icon: 'sparkles' as IconName,
    titleKey: 'nextStep.planGenerateTitle' as keyof Dict,
    descriptionKey: 'nextStep.planGenerateBody' as keyof Dict,
    promptKey: 'nextStep.planGeneratePrompt' as keyof Dict,
    sessionMode: 'design' as ChatSessionMode,
    requires: 'plan' as const,
  },
  {
    id: 'plan-improve-doc',
    icon: 'file' as IconName,
    titleKey: 'nextStep.planImproveTitle' as keyof Dict,
    descriptionKey: 'nextStep.planImproveBody' as keyof Dict,
    promptKey: 'nextStep.planImprovePrompt' as keyof Dict,
    sessionMode: 'plan' as ChatSessionMode,
    requires: 'plan' as const,
  },
  {
    id: 'plan-improve-artifact',
    icon: 'sparkles' as IconName,
    titleKey: 'nextStep.planImproveArtifactTitle' as keyof Dict,
    descriptionKey: 'nextStep.planImproveArtifactBody' as keyof Dict,
    promptKey: 'nextStep.planImproveArtifactPrompt' as keyof Dict,
    sessionMode: 'design' as ChatSessionMode,
    requires: 'artifact' as const,
  },
  {
    id: 'plan-merge-doc-artifact',
    icon: 'blocks' as IconName,
    titleKey: 'nextStep.planMergeTitle' as keyof Dict,
    descriptionKey: 'nextStep.planMergeBody' as keyof Dict,
    promptKey: 'nextStep.planMergePrompt' as keyof Dict,
    sessionMode: 'design' as ChatSessionMode,
    requires: 'both' as const,
  },
] as const;
const PLAN_GENERATE_ACTION = PLAN_NEXT_STEP_ACTIONS[0];
const PLAN_IMPROVE_DOC_ACTION = PLAN_NEXT_STEP_ACTIONS[1];
const PLAN_IMPROVE_ARTIFACT_ACTION = PLAN_NEXT_STEP_ACTIONS[2];
const PLAN_MERGE_DOC_ARTIFACT_ACTION = PLAN_NEXT_STEP_ACTIONS[3];

// Surfaced under More → Design toolbox. The two featured ids already have their
// own rows at the top of the card, so we drop them here to avoid duplicating
// the same action one level down.
const NON_FEATURED_TOOLBOX_ACTIONS = DESIGN_TOOLBOX_ACTIONS.filter(
  (action) => !FEATURED_DESIGN_TOOLBOX_ACTION_IDS.includes(action.id),
);

interface Props {
  // The previewable artifact this affordance is anchored to. Passed back to
  // share/download so the parent can act on the right file.
  fileName?: string | null;
  // Plan-mode actions need both sides of the handoff when available: the
  // editable Markdown plan and the generated artifact it should govern.
  planFileName?: string | null;
  artifactFileName?: string | null;
  // Download the previewable artifact.
  onDownload?: (fileName: string) => void;
  // Seed the composer with a featured design-toolbox action (matched skill +
  // prompt). Does NOT auto-send — the composer draft waits for the user.
  onToolboxAction?: (id: DesignToolboxActionId) => void;
  // Seed the composer with a custom prompt. Used by the project-incomplete and
  // plan action rows.
  onPromptAction?: (
    prompt: string,
    options?: { sessionMode?: ChatSessionMode },
  ) => void;
  // Seed the composer with a specific global skill resource picked from the toolbox.
  onPickSkill?: (skillId: string) => void;
  // Available global skill resources. The full composer toolbox also includes
  // MCP/skills/files; this next-step flyout keeps the same shape
  // while using the resource data already owned by the chat pane.
  skills?: SkillSummary[];
  // Resolved `@skill` names per featured action, shown in the hover detail.
  toolboxSkillNames?: Partial<Record<DesignToolboxActionId, string | null>>;
  variant?: NextStepActionsVariant;
}

const FLYOUT_GAP = 8;
const VIEWPORT_MARGIN = 8;
const DETAIL_WIDTH = 240;
const MENU_WIDTH = 200;
// Conservative heights used to keep a flyout on-screen vertically (over-estimating
// only shifts it further up, which is always safe).
const DETAIL_HEIGHT = 180;
const MENU_HEIGHT = 180;
// The Design toolbox submenu mirrors the plus-menu panel: title/search,
// follow-up actions, and global resources.
const TOOLBOX_SUB_WIDTH = 300;
const TOOLBOX_SUB_HEIGHT = 500;
// Give users enough time to cross the small gap between flyout levels without
// making dismissal feel sticky once the pointer leaves the whole affordance.
const FLYOUT_CLOSE_DELAY_MS = 240;

// Place a flyout next to an anchor rect: flip to the left when the right edge
// would overflow, and clamp vertically so a tall flyout under a row near the
// bottom of the viewport keeps its bottom edge on-screen. Returns viewport-fixed
// coordinates.
function place(
  anchor: DOMRect,
  width: number,
  height: number,
): { left: number; top: number } {
  const toRight = anchor.right + FLYOUT_GAP;
  const left =
    toRight + width > window.innerWidth - VIEWPORT_MARGIN
      ? anchor.left - FLYOUT_GAP - width
      : toRight;
  const maxTop = window.innerHeight - VIEWPORT_MARGIN - height;
  const top = Math.max(VIEWPORT_MARGIN, Math.min(anchor.top, maxTop));
  return { left: Math.max(VIEWPORT_MARGIN, left), top };
}

type Anchor = { left: number; top: number };
type SubKind = 'toolbox' | 'share';
type PlanAction = (typeof PLAN_NEXT_STEP_ACTIONS)[number];
type PromptNextStepAction = (typeof PROJECT_INCOMPLETE_NEXT_STEP_ACTIONS)[number];
type Detail = { kind: 'toolbox'; id: DesignToolboxActionId } & Anchor;

function isPlanFileName(fileName: string | null | undefined): boolean {
  return !!fileName && /\.mdx?$/i.test(fileName);
}

function isArtifactFileName(fileName: string | null | undefined): boolean {
  return !!fileName && /\.html?$/i.test(fileName);
}

function promptActionTitle(action: PromptNextStepAction, t: TranslateFn): string {
  return t(action.titleKey);
}

function promptActionPrompt(action: PromptNextStepAction, locale: string): string {
  if (locale !== 'zh-CN') return action.prompt;
  const zhPrompts: Record<PromptNextStepAction['id'], string> = {
    'project-continue':
      '从已停止或未完成的回合继续处理。先阅读当前对话、项目文件和可见错误，再执行下一个具体步骤。如果主产物已经存在，就在原文件上更新；否则创建缺失的主产物，并简要总结改了什么。',
    'project-generate-artifact':
      '现在生成缺失的项目产物。基于当前对话和项目上下文创建主要的可预览交付物；除非明确要求其他文件类型，通常保存为 index.html。把文件保存到当前项目中，并简要说明创建了哪些文件。',
  };
  return zhPrompts[action.id];
}

export function NextStepActions({
  fileName,
  planFileName,
  artifactFileName,
  onDownload,
  onToolboxAction,
  onPromptAction,
  onPickSkill,
  skills = [],
  toolboxSkillNames,
  variant = 'default',
}: Props) {
  const { t, locale } = useI18n();
  // Three-level cascading hover menu, all portaled to <body> with fixed
  // positioning so the narrow chat column never clips or occludes them:
  //   featured row  → detail card (skill summary)
  //   More          → [Design toolbox, Share]   (level 2)
  //   Design toolbox → search + non-featured actions + global resources (level 3)
  //   Share          → Share / Download / Contribute (level 3)
  // A single close timer with hover-intent keeps the whole path open while the
  // cursor travels between levels; entering any panel cancels the pending close.
  const [detail, setDetail] = useState<Detail | null>(null);
  const [more, setMore] = useState<Anchor | null>(null);
  const [sub, setSub] = useState<({ kind: SubKind } & Anchor) | null>(null);
  const [toolboxQuery, setToolboxQuery] = useState('');

  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const closeAll = useCallback(() => {
    setDetail(null);
    setMore(null);
    setSub(null);
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeAll();
      closeTimer.current = null;
    }, FLYOUT_CLOSE_DELAY_MS);
  }, [cancelClose, closeAll]);
  useEffect(() => () => cancelClose(), [cancelClose]);

  const openDetail = useCallback(
    (id: DesignToolboxActionId, rect: DOMRect) => {
      cancelClose();
      setMore(null);
      setSub(null);
      setDetail({ kind: 'toolbox', id, ...place(rect, DETAIL_WIDTH, DETAIL_HEIGHT) });
    },
    [cancelClose],
  );
  const openMore = useCallback(
    (rect: DOMRect) => {
      cancelClose();
      setDetail(null);
      setSub(null);
      setMore(place(rect, MENU_WIDTH, MENU_HEIGHT));
    },
    [cancelClose],
  );
  const openSub = useCallback(
    (kind: SubKind, rect: DOMRect) => {
      cancelClose();
      if (kind === 'toolbox') setToolboxQuery('');
      setSub({
        kind,
        ...place(
          rect,
          kind === 'toolbox' ? TOOLBOX_SUB_WIDTH : MENU_WIDTH,
          kind === 'toolbox' ? TOOLBOX_SUB_HEIGHT : MENU_HEIGHT,
        ),
      });
    },
    [cancelClose],
  );

  const handleDownload = useCallback(() => {
    if (!fileName || !onDownload) return;
    onDownload(fileName);
    closeAll();
  }, [closeAll, fileName, onDownload]);

  const handleToolboxAction = useCallback(
    (id: DesignToolboxActionId) => {
      onToolboxAction?.(id);
      closeAll();
    },
    [closeAll, onToolboxAction],
  );
  const handlePromptAction = useCallback(
    (action: PromptNextStepAction) => {
      onPromptAction?.(promptActionPrompt(action, locale));
      closeAll();
    },
    [closeAll, locale, onPromptAction],
  );
  const resolvedPlanFileName =
    planFileName ?? (variant === 'plan' && isPlanFileName(fileName) ? fileName : null);
  const resolvedArtifactFileName =
    artifactFileName ?? (variant === 'plan' && isArtifactFileName(fileName) ? fileName : null);
  const handlePlanPromptAction = useCallback(
    (action: PlanAction) => {
      if (action.requires === 'plan' && !resolvedPlanFileName) return;
      if (action.requires === 'artifact' && !resolvedArtifactFileName) return;
      if (action.requires === 'both' && (!resolvedPlanFileName || !resolvedArtifactFileName)) return;
      const primaryFile =
        action.requires === 'artifact'
          ? resolvedArtifactFileName
          : resolvedPlanFileName ?? resolvedArtifactFileName;
      if (!primaryFile) return;
      onPromptAction?.(
        t(action.promptKey, {
          file: primaryFile,
          document: resolvedPlanFileName ?? primaryFile,
          artifact: resolvedArtifactFileName ?? primaryFile,
        }),
        {
          sessionMode: action.sessionMode,
        },
      );
      closeAll();
    },
    [closeAll, onPromptAction, resolvedArtifactFileName, resolvedPlanFileName, t],
  );

  const handlePickSkill = useCallback(
    (skillId: string) => {
      onPickSkill?.(skillId);
      closeAll();
    },
    [closeAll, onPickSkill],
  );

  const visibleToolboxActions = useMemo(
    () =>
      NON_FEATURED_TOOLBOX_ACTIONS.filter((action) => {
        const skill = findDesignToolboxSkill(action, skills);
        return designToolboxActionMatchesQuery(
          action,
          toolboxQuery,
          skill,
          t,
          skill ? [localizeSkillName(locale, skill), localizeSkillDescription(locale, skill)] : [],
        );
      }),
    [toolboxQuery, skills, locale, t],
  );

  const visibleToolboxResources = useMemo(() => {
    const source = toolboxQuery
      ? skills.filter((skill) =>
          skillMatchesQuery(skill, toolboxQuery, [
            localizeSkillName(locale, skill),
            localizeSkillDescription(locale, skill),
          ]),
        )
      : defaultToolboxSkillResources(NON_FEATURED_TOOLBOX_ACTIONS, skills);
    return source.slice(0, toolboxQuery ? 14 : 8);
  }, [skills, toolboxQuery, locale]);

  const visiblePlanActions = useMemo(() => {
    if (resolvedPlanFileName && resolvedArtifactFileName) {
      return [PLAN_MERGE_DOC_ARTIFACT_ACTION, PLAN_IMPROVE_ARTIFACT_ACTION];
    }
    if (resolvedPlanFileName) {
      return [PLAN_GENERATE_ACTION, PLAN_IMPROVE_DOC_ACTION];
    }
    if (resolvedArtifactFileName) {
      return [PLAN_IMPROVE_ARTIFACT_ACTION];
    }
    return [];
  }, [resolvedArtifactFileName, resolvedPlanFileName]);

  // Share group is available whenever any of its actions can fire. The
  // upstream "contribute to Open Design" submission entry is intentionally
  // removed in the MatOS product — generated work stays in the user's own
  // asset library instead of being packaged for the upstream registry.
  const canDownload = !!(fileName && onDownload);
  const hasShareGroup = canDownload;
  const hasMore = !!onToolboxAction || hasShareGroup;
  const showToolbox = !!onToolboxAction;
  const showPlanRows = variant === 'plan' && visiblePlanActions.length > 0 && !!onPromptAction;
  const showProjectIncompleteRows = variant === 'project-incomplete' && !!onPromptAction;

  // Hover handlers shared by every flyout surface: stay open while hovered.
  const keepOpen = { onMouseEnter: cancelClose, onMouseLeave: scheduleClose };

  return (
    <div className={styles.root} data-testid="next-step-actions">
      <div className={styles.label}>{t('nextStep.title')}</div>
      {showPlanRows || showProjectIncompleteRows || showToolbox || hasMore ? (
        <div className={styles.toolboxList} data-testid="next-step-toolbox">
          {showPlanRows
            ? visiblePlanActions.map((action) => {
                const title = t(action.titleKey);
                const description = t(action.descriptionKey);
                return (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.toolboxRow}
                    data-testid={`next-step-plan-action-${action.id}`}
                    aria-label={`${title}. ${description}`}
                    title={description}
                    onClick={() => handlePlanPromptAction(action)}
                  >
                    <Icon name={action.icon} size={14} className={styles.toolboxRowIcon} />
                    <span className={styles.toolboxRowText}>
                      <span className={styles.toolboxRowTitle}>{title}</span>
                      <span className={styles.toolboxRowDescription}>{description}</span>
                    </span>
                    <Icon name="chevron-right" size={13} className={styles.toolboxRowArrow} />
                  </button>
                );
              })
            : null}
          {showProjectIncompleteRows
            ? PROJECT_INCOMPLETE_NEXT_STEP_ACTIONS.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={styles.toolboxRow}
                  data-testid={`next-step-project-action-${action.id}`}
                  onClick={() => handlePromptAction(action)}
                >
                  <Icon name={action.icon} size={14} className={styles.toolboxRowIcon} />
                  <span className={styles.toolboxRowTitle}>{promptActionTitle(action, t)}</span>
                  <Icon name="chevron-right" size={13} className={styles.toolboxRowArrow} />
                </button>
              ))
            : null}
          {showToolbox && !showProjectIncompleteRows
            && !showPlanRows
            ? FEATURED_DESIGN_TOOLBOX_ACTION_IDS.map((id) => {
                const action = getDesignToolboxAction(id);
                if (!action) return null;
                return (
                  <button
                    key={id}
                    type="button"
                    className={styles.toolboxRow}
                    data-testid={`next-step-toolbox-action-${id}`}
                    onClick={() => handleToolboxAction(id)}
                    onMouseEnter={(e) => openDetail(id, e.currentTarget.getBoundingClientRect())}
                    onMouseLeave={scheduleClose}
                  >
                    <Icon name={action.icon} size={14} className={styles.toolboxRowIcon} />
                    <span className={styles.toolboxRowTitle}>
                      {designToolboxActionTitle(action, t)}
                    </span>
                    <Icon name="chevron-right" size={13} className={styles.toolboxRowArrow} />
                  </button>
                );
              })
            : null}
          {hasMore ? (
            <button
              type="button"
              className={styles.moreRow}
              data-testid="next-step-toolbox-more"
              aria-expanded={!!more}
              onMouseEnter={(e) => openMore(e.currentTarget.getBoundingClientRect())}
              onMouseLeave={scheduleClose}
              onClick={(e) => openMore(e.currentTarget.getBoundingClientRect())}
            >
              <Icon name="more-horizontal" size={14} className={styles.toolboxRowIcon} />
              <span className={styles.toolboxRowTitle}>{t('nextStep.more')}</span>
              <Icon name="chevron-right" size={13} className={styles.toolboxRowArrow} />
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Level: featured-row detail card */}
      {detail && typeof document !== 'undefined'
        ? createPortal(
            (() => {
              const action = getDesignToolboxAction(detail.id);
              if (!action) return null;
              const skillName = toolboxSkillNames?.[detail.id] ?? null;
              return (
                <div
                  className={styles.detail}
                  role="tooltip"
                  style={{ left: detail.left, top: detail.top }}
                  {...keepOpen}
                >
                  <div className={styles.detailTitle}>{designToolboxActionTitle(action, t)}</div>
                  <div className={styles.detailDesc}>
                    {designToolboxActionDescription(action, t)}
                  </div>
                  {skillName ? <div className={styles.detailSkill}>@{skillName}</div> : null}
                  <div className={styles.detailBadge}>{designToolboxActionBadge(action, t)}</div>
                </div>
              );
            })(),
            document.body,
          )
        : null}

      {/* Level 2: More → [Design toolbox, Share] */}
      {more && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={`${styles.flyout} ${styles.flyoutMenu}`}
              role="menu"
              data-testid="next-step-more-menu"
              style={{ left: more.left, top: more.top }}
              {...keepOpen}
            >
              {showToolbox ? (
                <button
                  type="button"
                  className={styles.flyoutRow}
                  data-testid="next-step-more-toolbox"
                  aria-expanded={sub?.kind === 'toolbox'}
                  onMouseEnter={(e) => openSub('toolbox', e.currentTarget.getBoundingClientRect())}
                  onClick={(e) => openSub('toolbox', e.currentTarget.getBoundingClientRect())}
                >
                  <Icon name="lightbulb" size={14} className={styles.toolboxRowIcon} />
                  <span className={styles.toolboxRowTitle}>{t('chat.designToolbox.title')}</span>
                  <Icon name="chevron-right" size={13} className={styles.toolboxRowArrow} />
                </button>
              ) : null}
              {hasShareGroup ? (
                <button
                  type="button"
                  className={styles.flyoutRow}
                  data-testid="next-step-more-share"
                  aria-expanded={sub?.kind === 'share'}
                  onMouseEnter={(e) => openSub('share', e.currentTarget.getBoundingClientRect())}
                  onClick={(e) => openSub('share', e.currentTarget.getBoundingClientRect())}
                >
                  <Icon name="share" size={14} className={styles.toolboxRowIcon} />
                  <span className={styles.toolboxRowTitle}>{t('nextStep.share')}</span>
                  <Icon name="chevron-right" size={13} className={styles.toolboxRowArrow} />
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}

      {/* Level 3a: search + non-featured toolbox actions + global resources */}
      {sub?.kind === 'toolbox' && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={`${styles.flyout} ${styles.flyoutToolbox}`}
              role="menu"
              data-testid="next-step-toolbox-actions"
              style={{ left: sub.left, top: sub.top }}
              {...keepOpen}
            >
              <div className={styles.toolboxFlyoutTitle}>
                <Icon name="lightbulb" size={14} />
                <span>{t('chat.designToolbox.title')}</span>
              </div>
              <div className={styles.flyoutSearch}>
                <Icon name="search" size={13} />
                <input
                  value={toolboxQuery}
                  onChange={(e) => setToolboxQuery(e.currentTarget.value)}
                  placeholder={t('chat.designToolbox.searchPlaceholder')}
                  aria-label={t('chat.designToolbox.searchAria')}
                />
              </div>
              <div className={styles.flyoutScroll}>
                {visibleToolboxActions.length > 0 ? (
                  <div className={styles.flyoutSectionLabel}>
                    {t('chat.designToolbox.followupSection')}
                  </div>
                ) : null}
                {visibleToolboxActions.map((action) => (
                  <button
                    key={action.id}
                    type="button"
                    className={styles.flyoutRow}
                    data-testid={`next-step-toolbox-sub-action-${action.id}`}
                    onClick={() => handleToolboxAction(action.id)}
                  >
                    <Icon name={action.icon} size={14} className={styles.toolboxRowIcon} />
                    <span className={styles.toolboxRowTitle}>
                      {designToolboxActionTitle(action, t)}
                    </span>
                  </button>
                ))}
                {visibleToolboxResources.length > 0 ? (
                  <div className={styles.flyoutSectionLabel}>
                    {t('chat.designToolbox.resourcesSection')}
                  </div>
                ) : null}
                {visibleToolboxResources.map((skill) => (
                  <button
                    key={skill.id}
                    type="button"
                    className={styles.flyoutRow}
                    data-testid={`next-step-toolbox-resource-${skill.id}`}
                    onClick={() => handlePickSkill(skill.id)}
                  >
                    <Icon name={designToolboxSkillIcon(skill)} size={14} className={styles.toolboxRowIcon} />
                    <span className={styles.toolboxRowTitle}>{localizeSkillName(locale, skill)}</span>
                  </button>
                ))}
                {visibleToolboxActions.length === 0 && visibleToolboxResources.length === 0 ? (
                  <div className={styles.flyoutEmpty}>
                    {t('chat.designToolbox.noResources', { query: toolboxQuery })}
                  </div>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}

      {/* Level 3b: Share / Download / Contribute */}
      {sub?.kind === 'share' && typeof document !== 'undefined'
        ? createPortal(
            <div
              className={`${styles.flyout} ${styles.flyoutMenu}`}
              role="menu"
              data-testid="next-step-share-menu"
              style={{ left: sub.left, top: sub.top }}
              {...keepOpen}
            >
              {canDownload ? (
                <button
                  type="button"
                  className={styles.flyoutRow}
                  data-testid="next-step-share-download"
                  onClick={handleDownload}
                >
                  <Icon name="download" size={14} className={styles.toolboxRowIcon} />
                  <span className={styles.toolboxRowTitle}>{t('nextStep.download')}</span>
                </button>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

function defaultToolboxSkillResources(
  actions: DesignToolboxAction[],
  skills: SkillSummary[],
): SkillSummary[] {
  const out: SkillSummary[] = [];
  const seen = new Set<string>();
  const add = (skill: SkillSummary | null | undefined) => {
    if (!skill || seen.has(skill.id)) return;
    seen.add(skill.id);
    out.push(skill);
  };

  // Materials-first defaults, with the upstream design orchestrator kept as a
  // legacy fallback for deployments that still ship the design skill set.
  add(skills.find((skill) => skill.id === 'materials-compute'));
  add(skills.find((skill) => skill.id === 'compute'));
  add(skills.find((skill) => skill.id === 'creative-director'));
  for (const action of actions) {
    add(
      skills.find((skill) =>
        action.preferredSkillIds.some((id) => skill.id === id || skill.name === id),
      ),
    );
  }
  for (const term of ['dft', 'molecular dynamics', 'workflow', 'structure', 'analysis', 'materials']) {
    for (const skill of skills) {
      if (out.length >= 8) return out;
      if (skillMatchesQuery(skill, term)) add(skill);
    }
  }
  return out;
}

function designToolboxSkillIcon(skill: SkillSummary): IconName {
  if (skill.mode === 'video' || skill.category === 'video-generation') return 'play';
  if (skill.mode === 'image' || skill.category === 'image-generation') return 'image';
  if (skill.category === 'animation-motion') return 'sliders';
  if (skill.category === 'creative-direction') return 'sparkles';
  return 'file';
}
