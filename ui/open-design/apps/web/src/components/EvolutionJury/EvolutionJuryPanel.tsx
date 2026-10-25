import { useEffect, useMemo, useState } from 'react';

import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Icon, type IconName } from '../Icon';
import { EvolutionJuryCollapsed } from './EvolutionJuryCollapsed';
import {
  EVOLUTION_STAGE_ORDER,
  isTerminalEvolutionPhase,
  type EvolutionCasePhase,
  type EvolutionReviewCase,
  type EvolutionReviewStage,
  type EvolutionStageRole,
} from '../matos-evolution-client';

interface Props {
  cases: EvolutionReviewCase[];
}

const PHASE_LABEL_KEY: Record<EvolutionCasePhase, keyof Dict> = {
  reviewing: 'evolutionJury.phaseReviewing',
  accepted: 'evolutionJury.phaseAccepted',
  proposed: 'evolutionJury.phaseProposed',
  noop: 'evolutionJury.phaseNoop',
  blocked: 'evolutionJury.phaseBlocked',
  skipped: 'evolutionJury.phaseSkipped',
  failed: 'evolutionJury.phaseFailed',
};

const ROLE_LABEL_KEY: Record<EvolutionStageRole, keyof Dict> = {
  scout: 'evolutionJury.roleScout',
  critic: 'evolutionJury.roleCritic',
  refiner: 'evolutionJury.roleRefiner',
  editor: 'evolutionJury.roleEditor',
  judge: 'evolutionJury.roleJudge',
};

const ROLE_ICON: Record<EvolutionStageRole, IconName> = {
  scout: 'search',
  critic: 'comment',
  refiner: 'flask',
  editor: 'pencil',
  judge: 'shield',
};

const TRIGGER_LABEL_KEY: Record<string, keyof Dict> = {
  'user-feedback': 'evolutionJury.triggerUserFeedback',
  'tool-failure': 'evolutionJury.triggerToolFailure',
  'workflow-failure': 'evolutionJury.triggerWorkflowFailure',
  'agent-repeated-action': 'evolutionJury.triggerRepeatedAction',
  'manual-evolve': 'evolutionJury.triggerManual',
  'session-end': 'evolutionJury.triggerSessionEnd',
};

function orderedStages(stages: EvolutionReviewStage[]): EvolutionReviewStage[] {
  const byRole = new Map(stages.map((stage) => [stage.role, stage]));
  return EVOLUTION_STAGE_ORDER.map(
    (role) => byRole.get(role) ?? { role, state: 'pending' as const },
  );
}

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

function stepIcon(stage: EvolutionReviewStage): IconName {
  if (stage.state === 'done') return 'check';
  if (stage.state === 'failed') return 'close';
  if (stage.state === 'skipped') return 'minus';
  return ROLE_ICON[stage.role];
}

function stageChip(
  role: EvolutionStageRole,
  state: EvolutionReviewStage['state'],
  review: EvolutionReviewCase,
  t: Translate,
): string | null {
  switch (role) {
    case 'critic': {
      if (review.critic?.shouldUseFeedback === true) return t('evolutionJury.criticAdopt');
      if (review.critic?.shouldUseFeedback === false) return t('evolutionJury.criticReject');
      if (state === 'skipped') return t('evolutionJury.criticSkipped');
      return null;
    }
    case 'refiner':
      return review.experienceRefs.length > 0
        ? t('evolutionJury.refinerCount', { count: review.experienceRefs.length })
        : null;
    case 'editor': {
      if (review.editor) {
        const changed =
          review.editor.updatedAssets.length
          + review.editor.createdAssets.length
          + review.editor.disabledAssets.length;
        if (changed > 0) return t('evolutionJury.editorChanged', { count: changed });
      }
      if (state === 'skipped') return t('evolutionJury.editorNoChange');
      return null;
    }
    case 'judge': {
      const judge = review.judge;
      if (!judge) return null;
      const verdictLabel =
        judge.verdict === 'accept'
          ? t('evolutionJury.judgeAccept')
          : judge.verdict === 'rollback'
            ? t('evolutionJury.judgeRollback')
            : judge.verdict;
      if (judge.confidence != null && verdictLabel) {
        return `${verdictLabel} · ${Math.round(judge.confidence * 100)}%`;
      }
      return verdictLabel;
    }
    default:
      return null;
  }
}

function focusNarrative(
  review: EvolutionReviewCase,
): { role: EvolutionStageRole; text: string } | null {
  if (review.judge?.reason) return { role: 'judge', text: review.judge.reason };
  if (review.critic?.summary) return { role: 'critic', text: review.critic.summary };
  if (review.summary) return { role: 'scout', text: review.summary };
  return null;
}

function stageProgress(stages: EvolutionReviewStage[]): { done: number; total: number } {
  const total = stages.length;
  const done = stages.filter((stage) => stage.state !== 'pending').length;
  return { done, total };
}

function assetRefs(review: EvolutionReviewCase): string[] {
  const editor = review.editor;
  if (!editor) return [];
  return [
    ...editor.updatedAssets,
    ...editor.createdAssets,
    ...editor.disabledAssets,
  ].slice(0, 5);
}

function shortAssetRef(ref: string): string {
  const at = ref.indexOf('@');
  if (at > 0) return ref.slice(0, at);
  const slash = ref.lastIndexOf('/');
  if (slash >= 0) return ref.slice(slash + 1);
  return ref.length > 28 ? `${ref.slice(0, 27)}…` : ref;
}

function connectorFlow(
  stages: EvolutionReviewStage[],
  index: number,
): boolean {
  const current = stages[index];
  if (!current || current.state !== 'active') return false;
  return stages.slice(0, index).some((stage) => stage.state === 'done');
}

function feedbackCaseLineage(review: EvolutionReviewCase): string | null {
  if (review.triggerKind !== 'user-feedback') return null;
  const prefix = 'user-feedback:';
  if (!review.caseId.startsWith(prefix)) return null;
  const eventId = review.caseId.slice(prefix.length).split(':', 1)[0]?.trim();
  return eventId ? `${prefix}${eventId}` : null;
}

function recentCases(
  active: EvolutionReviewCase,
  rest: EvolutionReviewCase[],
): EvolutionReviewCase[] {
  // A successful retry resolves earlier attempts for the same feedback event.
  // Keep unrelated history visible, but do not leave a misleading "Failed"
  // badge directly beneath the accepted outcome that superseded it.
  if (active.phase !== 'accepted') return rest;
  const acceptedLineage = feedbackCaseLineage(active);
  if (!acceptedLineage) return rest;
  return rest.filter((entry) => feedbackCaseLineage(entry) !== acceptedLineage);
}

/**
 * Live self-evolution review surface, styled after the Design Jury. Settled
 * reviews collapse into a compact pill (like `TheaterCollapsed`); in-flight
 * reviews render the full five-step pipeline with flowing connectors, a live
 * focus bubble, outcome chips, asset refs, and the judge confidence meter.
 */
export function EvolutionJuryPanel({ cases }: Props) {
  const t = useT();
  const [active, ...rest] = cases;
  const visibleRest = active ? recentCases(active, rest) : rest;
  const [expanded, setExpanded] = useState(() => active?.phase === 'reviewing');

  useEffect(() => {
    if (active?.phase === 'reviewing') setExpanded(true);
  }, [active?.caseId, active?.phase]);

  const stages = useMemo(
    () => (active ? orderedStages(active.stages) : []),
    [active],
  );

  if (cases.length === 0 || !active) return null;

  const terminal = isTerminalEvolutionPhase(active.phase);
  if (terminal && !expanded) {
    return (
      <div className="evo-jury-stack" data-expanded="false">
        <EvolutionJuryCollapsed review={active} onExpand={() => setExpanded(true)} />
        {visibleRest.length > 0 ? (
          <ul className="evo-jury-recent evo-jury-recent--compact" aria-label={t('evolutionJury.recentTitle')}>
            {visibleRest.map((entry) => (
              <li
                key={entry.caseId}
                className="evo-jury-recent-item"
                data-phase={entry.phase}
                title={entry.summary ?? undefined}
              >
                <span className="evo-jury-recent-dot" aria-hidden />
                <span className="evo-jury-recent-trigger">
                  {TRIGGER_LABEL_KEY[entry.triggerKind]
                    ? t(TRIGGER_LABEL_KEY[entry.triggerKind]!)
                    : entry.triggerKind}
                </span>
                <span className="evo-jury-recent-phase">{t(PHASE_LABEL_KEY[entry.phase])}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    );
  }

  const triggerKey = TRIGGER_LABEL_KEY[active.triggerKind];
  const activeStage = stages.find((stage) => stage.state === 'active') ?? null;
  const narrative = focusNarrative(active);
  const focusRole = narrative?.role ?? activeStage?.role ?? null;
  const deliberating = active.phase === 'reviewing';
  const confidence = active.judge?.confidence ?? null;
  const progress = stageProgress(stages);
  const assets = assetRefs(active);
  const chips = stages
    .map((stage) => ({
      role: stage.role,
      text: stageChip(stage.role, stage.state, active, t),
    }))
    .filter((chip): chip is { role: EvolutionStageRole; text: string } => Boolean(chip.text));

  return (
    <div className="evo-jury-stack" data-expanded="true">
      <section
        className="evo-jury"
        role="region"
        aria-label={t('evolutionJury.userFacingName')}
        data-phase={active.phase}
        data-deliberating={deliberating ? 'true' : 'false'}
      >
        <header className="evo-jury-head">
          <div className="evo-jury-heading">
            <span className="evo-jury-mark" aria-hidden>
              <Icon name="sparkles" size={12} />
            </span>
            <h3 className="evo-jury-title">{t('evolutionJury.userFacingName')}</h3>
            {triggerKey ? (
              <span className="evo-jury-trigger-chip">{t(triggerKey)}</span>
            ) : null}
            {active.updatedAt ? (
              <time className="evo-jury-time" dateTime={active.updatedAt}>
                {new Date(active.updatedAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            ) : null}
          </div>
          <div className="evo-jury-head-actions">
            {deliberating ? (
              <span className="evo-jury-progress-pill">
                {t('evolutionJury.stagesProgress', {
                  done: progress.done,
                  total: progress.total,
                })}
              </span>
            ) : null}
            <span className="evo-jury-phase" data-phase={active.phase}>
              {deliberating ? (
                <span className="evo-jury-phase-dot" aria-hidden />
              ) : null}
              {t(PHASE_LABEL_KEY[active.phase])}
            </span>
            {terminal ? (
              <button
                type="button"
                className="evo-jury-collapse-btn"
                onClick={() => setExpanded(false)}
                aria-label={t('evolutionJury.collapseDetails')}
                title={t('evolutionJury.collapseDetails')}
              >
                <Icon name="chevron-down" size={14} />
              </button>
            ) : null}
          </div>
        </header>

        <div className="evo-jury-track">
          <div
            className="evo-jury-track-fill"
            style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }}
            aria-hidden
          />
          <ol className="evo-jury-steps" aria-label={t('evolutionJury.userFacingName')}>
            {stages.map((stage, index) => {
              const chip = stageChip(stage.role, stage.state, active, t);
              const flow = connectorFlow(stages, index);
              return (
                <li
                  key={stage.role}
                  className="evo-jury-step"
                  data-role={stage.role}
                  data-state={stage.state}
                  data-reached={stage.state !== 'pending' ? 'true' : 'false'}
                  data-flow={flow ? 'true' : 'false'}
                  data-active={stage.state === 'active' ? 'true' : 'false'}
                  title={chip ?? undefined}
                  style={{ animationDelay: `${index * 45}ms` }}
                >
                  <span className="evo-jury-step-node" aria-hidden>
                    <Icon name={stepIcon(stage)} size={12} />
                  </span>
                  <span className="evo-jury-step-label">{t(ROLE_LABEL_KEY[stage.role])}</span>
                </li>
              );
            })}
          </ol>
        </div>

        {focusRole ? (
          <div className="evo-jury-focus" data-role={focusRole}>
            <span className="evo-jury-focus-head">
              <Icon name={ROLE_ICON[focusRole]} size={11} />
              <span className="evo-jury-focus-role">{t(ROLE_LABEL_KEY[focusRole])}</span>
              {deliberating ? (
                <span className="evo-jury-typing" aria-hidden>
                  <i />
                  <i />
                  <i />
                </span>
              ) : null}
            </span>
            {narrative ? (
              <p className="evo-jury-focus-text" title={narrative.text}>
                {narrative.text}
              </p>
            ) : null}
          </div>
        ) : null}

        {chips.length > 0 ? (
          <ul className="evo-jury-chips">
            {chips.map((chip) => (
              <li key={chip.role} className="evo-jury-chip" data-role={chip.role}>
                <span className="evo-jury-chip-dot" aria-hidden />
                {chip.text}
              </li>
            ))}
          </ul>
        ) : null}

        {assets.length > 0 ? (
          <ul className="evo-jury-assets" aria-label={t('evolutionJury.editorChanged', { count: assets.length })}>
            {assets.map((ref) => (
              <li key={ref} className="evo-jury-asset" title={ref}>
                {shortAssetRef(ref)}
              </li>
            ))}
          </ul>
        ) : null}

        {confidence != null ? (
          <div
            className="evo-jury-confidence"
            role="status"
            aria-label={t('evolutionJury.confidence')}
            data-verdict={active.judge?.verdict ?? 'unknown'}
          >
            <span className="evo-jury-confidence-label">{t('evolutionJury.confidence')}</span>
            <span className="evo-jury-confidence-track" aria-hidden>
              <span
                className="evo-jury-confidence-fill"
                style={{ width: `${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%` }}
              />
            </span>
            <span className="evo-jury-confidence-value">
              {`${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`}
            </span>
          </div>
        ) : null}

        {visibleRest.length > 0 ? (
          <ul className="evo-jury-recent" aria-label={t('evolutionJury.recentTitle')}>
            {visibleRest.map((entry) => (
              <li
                key={entry.caseId}
                className="evo-jury-recent-item"
                data-phase={entry.phase}
                title={entry.summary ?? undefined}
              >
                <span className="evo-jury-recent-dot" aria-hidden />
                <span className="evo-jury-recent-trigger">
                  {TRIGGER_LABEL_KEY[entry.triggerKind]
                    ? t(TRIGGER_LABEL_KEY[entry.triggerKind]!)
                    : entry.triggerKind}
                </span>
                <span className="evo-jury-recent-phase">{t(PHASE_LABEL_KEY[entry.phase])}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
