import { useT } from '../../i18n';
import type { Dict } from '../../i18n/types';
import { Icon } from '../Icon';
import type { EvolutionCasePhase, EvolutionReviewCase } from '../matos-evolution-client';

interface Props {
  review: EvolutionReviewCase;
  onExpand: () => void;
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

const TRIGGER_LABEL_KEY: Record<string, keyof Dict> = {
  'user-feedback': 'evolutionJury.triggerUserFeedback',
  'tool-failure': 'evolutionJury.triggerToolFailure',
  'workflow-failure': 'evolutionJury.triggerWorkflowFailure',
  'agent-repeated-action': 'evolutionJury.triggerRepeatedAction',
  'manual-evolve': 'evolutionJury.triggerManual',
  'session-end': 'evolutionJury.triggerSessionEnd',
};

function summaryLine(review: EvolutionReviewCase): string | null {
  return review.judge?.reason ?? review.critic?.summary ?? review.summary;
}

/**
 * Compact post-review pill — mirrors `TheaterCollapsed`. Sits in the chat
 * surface without dominating it once the pipeline has settled.
 */
export function EvolutionJuryCollapsed({ review, onExpand }: Props) {
  const t = useT();
  const triggerKey = TRIGGER_LABEL_KEY[review.triggerKind];
  const line = summaryLine(review);
  const confidence = review.judge?.confidence ?? null;

  return (
    <div
      className="evo-jury-collapsed"
      role="status"
      data-phase={review.phase}
      aria-label={t('evolutionJury.userFacingName')}
    >
      <span className="evo-jury-collapsed-mark" aria-hidden>
        <Icon name="sparkles" size={11} />
      </span>
      <span className="evo-jury-collapsed-badge">{t(PHASE_LABEL_KEY[review.phase])}</span>
      <span className="evo-jury-collapsed-body">
        {triggerKey ? (
          <span className="evo-jury-collapsed-trigger">{t(triggerKey)}</span>
        ) : null}
        {line ? (
          <span className="evo-jury-collapsed-summary" title={line}>
            {line}
          </span>
        ) : null}
      </span>
      {confidence != null ? (
        <span className="evo-jury-collapsed-confidence" data-verdict={review.judge?.verdict ?? 'unknown'}>
          {`${Math.round(Math.min(1, Math.max(0, confidence)) * 100)}%`}
        </span>
      ) : null}
      <button
        type="button"
        className="evo-jury-expand-btn"
        onClick={onExpand}
        aria-label={t('evolutionJury.expandDetails')}
        title={t('evolutionJury.expandDetails')}
      >
        <Icon name="chevron-down" size={14} />
      </button>
    </div>
  );
}
