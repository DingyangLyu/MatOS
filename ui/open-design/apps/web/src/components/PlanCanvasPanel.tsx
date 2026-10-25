/**
 * Plan canvas — the right-hand workspace projection of MatOS plan mode.
 *
 * A plan-mode turn (`/plan` or the 规划 session tier) runs the CLI read-only;
 * its answer IS the plan. This panel renders that answer as a reviewable
 * document next to the chat: title extracted from the first heading, live
 * step count, streaming shimmer while the model is still writing, and — once
 * ready — an approval bar that flips the conversation into execute mode and
 * sends the implementation turn. Mirrors the CLI's plan-review loop
 * (write plan → review → approve → execute) with the canvas as the review
 * surface.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon } from './Icon';
import { renderMarkdown } from '../runtime/markdown';

export interface PlanCanvasDoc {
  /** Plan body (markdown). While streaming this grows turn-over-turn. */
  markdown: string;
  status: 'streaming' | 'ready';
  /** Assistant message id the plan came from (remount/reveal key). */
  messageId: string;
}

interface Props {
  doc: PlanCanvasDoc;
  /** "Approve & execute" — omitted hides the approval bar entirely. */
  onApprove?: () => void;
  /** Disable approval while another run is streaming/queued. */
  approveDisabled?: boolean;
  /** "Refine the plan" — focus the composer to talk the plan over. */
  onRefine?: () => void;
}

/** First markdown heading, used as the document title. */
function planTitleOf(markdown: string): string | null {
  const match = /^#{1,3}\s+(.+)$/m.exec(markdown);
  return match ? match[1]!.trim() : null;
}

/**
 * Rough step count for the header badge: top-level ordered-list items plus
 * task-list checkboxes. Cosmetic only — zero simply hides the badge.
 */
function planStepCountOf(markdown: string): number {
  let count = 0;
  for (const line of markdown.split('\n')) {
    if (/^\s{0,3}\d+[.)]\s+\S/.test(line)) count += 1;
    else if (/^\s*[-*]\s+\[[ xX]\]\s+\S/.test(line)) count += 1;
  }
  return count;
}

export function PlanCanvasPanel({ doc, onApprove, approveDisabled = false, onRefine }: Props) {
  const t = useT();
  const streaming = doc.status === 'streaming';
  const title = useMemo(() => planTitleOf(doc.markdown), [doc.markdown]);
  const stepCount = useMemo(() => planStepCountOf(doc.markdown), [doc.markdown]);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [copied, setCopied] = useState(false);

  // Follow the document tail while the plan is still being written, the same
  // way the chat log follows a streaming answer. Stop once ready so review
  // reading position is stable.
  useEffect(() => {
    if (!streaming) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streaming, doc.markdown]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const body = doc.markdown.trim();

  return (
    <div className="plan-canvas" data-testid="plan-canvas">
      <div className="plan-canvas__header">
        <span className="plan-canvas__header-icon" aria-hidden>
          <Icon name="kanban" size={15} />
        </span>
        <div className="plan-canvas__heading">
          <div className="plan-canvas__title" data-testid="plan-canvas-title">
            {title ?? t('planCanvas.untitled')}
          </div>
          <div className="plan-canvas__meta">
            {streaming ? (
              <span className="plan-canvas__status plan-canvas__status--streaming">
                <Icon name="spinner" size={11} className="plan-canvas__spinner" />
                {t('planCanvas.streaming')}
              </span>
            ) : (
              <span className="plan-canvas__status plan-canvas__status--ready">
                <Icon name="check" size={11} />
                {t('planCanvas.ready')}
              </span>
            )}
            {stepCount > 0 ? (
              <span className="plan-canvas__steps">
                {t('planCanvas.steps', { count: String(stepCount) })}
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="plan-canvas__copy"
          data-testid="plan-canvas-copy"
          title={t('planCanvas.copy')}
          onClick={() => {
            void navigator.clipboard?.writeText(doc.markdown).then(() => setCopied(true));
          }}
        >
          <Icon name={copied ? 'check' : 'copy'} size={13} />
        </button>
      </div>
      <div className="plan-canvas__scroll" ref={scrollRef}>
        <article className="plan-canvas__doc" data-testid="plan-canvas-doc">
          {body ? (
            renderMarkdown(body)
          ) : (
            <p className="plan-canvas__empty">{t('planCanvas.empty')}</p>
          )}
          {streaming ? <div className="plan-canvas__cursor" aria-hidden /> : null}
        </article>
      </div>
      {!streaming && body && (onApprove || onRefine) ? (
        <div className="plan-canvas__actions" data-testid="plan-canvas-actions">
          <div className="plan-canvas__actions-hint">{t('planCanvas.approveHint')}</div>
          <div className="plan-canvas__actions-buttons">
            {onRefine ? (
              <button
                type="button"
                className="plan-canvas__refine"
                data-testid="plan-canvas-refine"
                onClick={onRefine}
              >
                {t('planCanvas.refine')}
              </button>
            ) : null}
            {onApprove ? (
              <button
                type="button"
                className="plan-canvas__approve"
                data-testid="plan-canvas-approve"
                disabled={approveDisabled}
                onClick={onApprove}
              >
                <Icon name="play" size={12} />
                {t('planCanvas.approve')}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
