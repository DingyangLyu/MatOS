// MatOS self-evolution page (/evolution): how far self-evolution may go on its
// own, the edits waiting for a human decision, a per-asset evolution tree and
// the history of edits. Decisions go through the daemon to the MatOS CLI; this
// view renders the overview and posts approve / reject.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useT } from '../i18n';
import type { Dict } from '../i18n/types';
import { Icon } from './Icon';
import {
  decideEvolutionProposal,
  fetchEvolutionOverview,
  fetchEvolutionPolicy,
  fetchEvolutionRunDiff,
  saveEvolutionPolicy,
  type EvolutionApprovalMode,
  type EvolutionApprovalPolicy,
  type EvolutionLineage,
  type EvolutionLineageBranch,
  type EvolutionLineageNode,
  type EvolutionOverview,
  type EvolutionRunView,
} from './matos-evolution-client';

const POLL_MS = 15_000;
const MAX_DIFF_LINES = 1500;

const MODES: Array<{ mode: EvolutionApprovalMode; label: keyof Dict; hint: keyof Dict }> = [
  { mode: 'off', label: 'evolutionPage.modeOff', hint: 'evolutionPage.modeOffHint' },
  { mode: 'manual', label: 'evolutionPage.modeManual', hint: 'evolutionPage.modeManualHint' },
  { mode: 'auto', label: 'evolutionPage.modeAuto', hint: 'evolutionPage.modeAutoHint' },
];

const STATUS_LABEL: Record<string, keyof Dict> = {
  accepted: 'evolutionPage.statusAccepted',
  accepted_merged: 'evolutionPage.statusAccepted',
  proposed: 'evolutionPage.statusProposed',
  rejected: 'evolutionPage.statusRejected',
  rolled_back: 'evolutionPage.statusRolledBack',
  base: 'evolutionPage.statusBase',
};

type Translate = ReturnType<typeof useT>;

function statusTone(status: string): string {
  if (status === 'accepted' || status === 'accepted_merged') return 'done';
  if (status === 'proposed') return 'running';
  if (status === 'rejected') return 'failed';
  return 'muted';
}

function StatusChip({ status }: { status: string }) {
  const t = useT();
  const label = STATUS_LABEL[status];
  return (
    <span className={`repo-import__status repo-import__status--${statusTone(status)} matos-evo-status`}>
      {label ? t(label) : status}
    </span>
  );
}

function formatTime(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return date.toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' });
}

function ownerLabel(
  owner: { projectId: string | null; projectName: string | null },
  t: Translate,
): string {
  if (owner.projectName) return owner.projectName;
  if (owner.projectId) return owner.projectId;
  return t('evolutionPage.workspaceScope');
}

/** The approval-mode selector; also mounted in Settings. */
export function EvolutionPolicyControl() {
  const t = useT();
  const [policy, setPolicy] = useState<EvolutionApprovalPolicy | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEvolutionPolicy()
      .then((next) => {
        if (!cancelled) setPolicy(next);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const locked = policy?.source === 'env';
  const choose = async (mode: EvolutionApprovalMode) => {
    if (!policy || locked || saving || policy.mode === mode) return;
    setSaving(true);
    setError(null);
    try {
      setPolicy(await saveEvolutionPolicy(mode));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="matos-evo-policy" data-testid="evolution-policy">
      <div className="matos-evo-policy__options" role="radiogroup" aria-label={t('evolutionPage.policyTitle')}>
        {MODES.map(({ mode, label, hint }) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={policy?.mode === mode}
            className="matos-evo-policy__option"
            data-active={policy?.mode === mode ? 'true' : 'false'}
            data-testid={`evolution-policy-${mode}`}
            disabled={!policy || locked || saving}
            onClick={() => void choose(mode)}
          >
            <span className="matos-evo-policy__label">{t(label)}</span>
            <span className="matos-evo-policy__hint">{t(hint)}</span>
          </button>
        ))}
      </div>
      {locked ? <p className="assets-panel__hint">{t('evolutionPage.policyFromEnv')}</p> : null}
      {error ? (
        <p className="assets-view__error">{t('evolutionPage.policySaveFailed', { message: error })}</p>
      ) : null}
    </div>
  );
}

function diffLineKind(line: string): string {
  if (line.startsWith('diff --git') || line.startsWith('+++') || line.startsWith('---')) return 'file';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}

function DiffView({ diff }: { diff: { diff: string; truncated: boolean } | null | undefined }) {
  const t = useT();
  if (diff === undefined) return <p className="assets-panel__hint">{t('assets.loading')}</p>;
  if (diff === null) return <p className="assets-panel__hint">{t('evolutionPage.diffUnavailable')}</p>;
  const lines = diff.diff.split('\n');
  return (
    <>
      <pre className="matos-evo-diff" data-testid="evolution-diff">
        {lines.slice(0, MAX_DIFF_LINES).map((line, index) => (
          <span key={index} data-kind={diffLineKind(line)}>
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      {diff.truncated || lines.length > MAX_DIFF_LINES ? (
        <p className="assets-panel__hint">{t('evolutionPage.diffTruncated')}</p>
      ) : null}
    </>
  );
}

function RunFacts({ run }: { run: EvolutionRunView }) {
  const t = useT();
  return (
    <dl className="matos-evo-facts">
      {run.triggerSummary ? (
        <div>
          <dt>{t('evolutionPage.trigger')}</dt>
          <dd>{run.triggerSummary}</dd>
        </div>
      ) : null}
      {run.expectedBehaviorChange ? (
        <div>
          <dt>{t('evolutionPage.expectedChange')}</dt>
          <dd>{run.expectedBehaviorChange}</dd>
        </div>
      ) : null}
      {run.judge?.verdict ? (
        <div>
          <dt>{t('evolutionPage.judge')}</dt>
          <dd>
            {t('evolutionPage.judgeVerdict', {
              verdict: run.judge.verdict,
              confidence: run.judge.confidence != null ? run.judge.confidence.toFixed(2) : '—',
            })}
            {run.judge.reason ? ` — ${run.judge.reason}` : ''}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function ProposalCard({ run, onDecided }: { run: EvolutionRunView; onDecided: () => void }) {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [diff, setDiff] = useState<{ diff: string; truncated: boolean } | null | undefined>(undefined);

  const toggleDiff = () => {
    const next = !diffOpen;
    setDiffOpen(next);
    if (next && diff === undefined) {
      fetchEvolutionRunDiff(run.runId, run.projectId)
        .then(setDiff)
        .catch(() => setDiff(null));
    }
  };

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(decision);
    setError(null);
    try {
      await decideEvolutionProposal({
        runId: run.runId,
        projectId: run.projectId,
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDecided();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="matos-evo-proposal" data-testid={`evolution-proposal-${run.runId}`}>
      <header className="matos-evo-proposal__head">
        <div className="matos-evo-refs">
          {run.assetRefs.map((ref) => (
            <code key={ref} className="matos-evo-ref">{ref}</code>
          ))}
        </div>
        <span className="matos-evo-meta">
          {ownerLabel(run, t)} · {formatTime(run.proposal?.proposedAt ?? run.updatedAt)}
        </span>
      </header>
      {run.summary ? <p className="matos-evo-proposal__summary">{run.summary}</p> : null}
      <RunFacts run={run} />
      {run.proposal?.lastApprovalError ? (
        <p className="assets-view__error">
          {t('evolutionPage.lastError', { message: run.proposal.lastApprovalError })}
        </p>
      ) : null}
      <button type="button" className="matos-evo-link" onClick={toggleDiff}>
        <Icon name={diffOpen ? 'chevron-down' : 'chevron-right'} size={13} />
        {diffOpen ? t('evolutionPage.hideDiff') : t('evolutionPage.viewDiff')}
      </button>
      {diffOpen ? <DiffView diff={diff} /> : null}
      <div className="matos-evo-proposal__actions">
        <input
          className="matos-evo-note"
          value={note}
          maxLength={500}
          placeholder={t('evolutionPage.notePlaceholder')}
          aria-label={t('evolutionPage.notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
        <button
          type="button"
          className="matos-evo-btn"
          data-testid={`evolution-reject-${run.runId}`}
          disabled={busy !== null}
          onClick={() => void decide('reject')}
        >
          {busy === 'reject' ? t('evolutionPage.rejecting') : t('evolutionPage.reject')}
        </button>
        <button
          type="button"
          className="matos-evo-btn matos-evo-btn--primary"
          data-testid={`evolution-approve-${run.runId}`}
          disabled={busy !== null}
          onClick={() => void decide('approve')}
        >
          {busy === 'approve' ? t('evolutionPage.approving') : t('evolutionPage.approve')}
        </button>
      </div>
      {error ? (
        <p className="assets-view__error">{t('evolutionPage.decisionFailed', { message: error })}</p>
      ) : null}
    </article>
  );
}

function TreeNode({ node }: { node: EvolutionLineageNode }) {
  const t = useT();
  const label = STATUS_LABEL[node.status];
  return (
    <span
      className="matos-evo-tree__node"
      data-status={node.status}
      title={[node.summary, formatTime(node.at)].filter(Boolean).join('\n')}
    >
      <span className="matos-evo-tree__version">{node.version ? `v${node.version}` : '—'}</span>
      {node.status !== 'base' && node.version && node.version === node.parentVersion ? (
        // A scoped copy that keeps the version it overlays.
        <span className="matos-evo-tree__tag">{t('evolutionPage.overlayTag')}</span>
      ) : null}
      <span className="matos-evo-tree__state">{label ? t(label) : node.status}</span>
    </span>
  );
}

// Adopted versions form the trunk of a branch; pending and rejected
// proposals hang off the version they were made against.
function BranchChain({ branch }: { branch: EvolutionLineageBranch }) {
  const trunk = branch.nodes.filter((node) => node.status === 'base' || node.status.startsWith('accepted'));
  const offshoots = branch.nodes.filter((node) => !trunk.includes(node));
  const attached = new Map<EvolutionLineageNode, EvolutionLineageNode[]>();
  for (const node of offshoots) {
    const parent =
      [...trunk].reverse().find((candidate) => candidate.version === node.parentVersion) ??
      trunk[trunk.length - 1];
    if (!parent) continue;
    attached.set(parent, [...(attached.get(parent) ?? []), node]);
  }
  const rootless = trunk.length === 0 ? offshoots : [];
  return (
    <ol className="matos-evo-tree__chain">
      {[...trunk, ...rootless].map((node, index) => (
        <li key={`${node.runId ?? 'base'}-${index}`} className="matos-evo-tree__step">
          <TreeNode node={node} />
          {attached.get(node)?.length ? (
            <ul className="matos-evo-tree__offshoots">
              {attached.get(node)!.map((child, childIndex) => (
                <li key={`${child.runId ?? 'node'}-${childIndex}`}>
                  <TreeNode node={child} />
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function LineageTree({ lineage }: { lineage: EvolutionLineage }) {
  const t = useT();
  return (
    <div className="matos-evo-tree" data-testid={`evolution-tree-${lineage.assetKey}`}>
      <div className="matos-evo-tree__root">
        <Icon name="blocks" size={13} />
        <code>{lineage.assetKey}</code>
        <span className="matos-evo-meta">
          {t('evolutionPage.treeCounts', {
            accepted: lineage.acceptedCount,
            proposed: lineage.proposedCount,
          })}
        </span>
      </div>
      <ul className="matos-evo-tree__branches">
        {lineage.branches.map((branch) => (
          <li
            key={`${branch.projectId ?? ''}|${branch.scopeRef ?? ''}`}
            className="matos-evo-tree__branch"
          >
            <span className="matos-evo-tree__owner">{ownerLabel(branch, t)}</span>
            <BranchChain branch={branch} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function HistoryList({ runs }: { runs: EvolutionRunView[] }) {
  const t = useT();
  return (
    <ol className="matos-evo-history" data-testid="evolution-history">
      {runs.map((run) => (
        <li key={`${run.projectId ?? ''}/${run.runId}`} className="matos-evo-history__item">
          <StatusChip status={run.status} />
          <div className="matos-evo-history__body">
            <div className="matos-evo-history__line">
              <span className="matos-evo-refs">
                {run.assetRefs.map((ref) => (
                  <code key={ref} className="matos-evo-ref">{ref}</code>
                ))}
              </span>
              <time className="matos-evo-meta" dateTime={run.updatedAt ?? undefined}>
                {formatTime(run.updatedAt ?? run.createdAt)}
              </time>
            </div>
            {run.summary ? <p className="matos-evo-history__summary">{run.summary}</p> : null}
            <p className="matos-evo-meta">
              {ownerLabel(run, t)}
              {run.triggerKind ? ` · ${run.triggerKind}` : ''}
              {run.statusReason === 'approved_by_user' ? ` · ${t('evolutionPage.approvedBy')}` : ''}
              {run.proposal?.note ? ` · “${run.proposal.note}”` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function MatOSEvolutionView() {
  const t = useT();
  const [overview, setOverview] = useState<EvolutionOverview | null | undefined>(undefined);
  const [showDiscarded, setShowDiscarded] = useState(false);

  const refresh = useCallback(async (force = false) => {
    try {
      setOverview(await fetchEvolutionOverview({ refresh: force }));
    } catch {
      // Keep the last snapshot on a transient failure; show the error only
      // when nothing was ever loaded.
      setOverview((previous) => previous ?? null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const history = useMemo(
    () =>
      (overview?.history ?? []).filter(
        (run) => showDiscarded || run.status !== 'rolled_back',
      ),
    [overview, showDiscarded],
  );
  const proposals = overview?.proposals ?? [];

  return (
    <section className="matos-evo" aria-labelledby="matos-evo-title" data-testid="matos-evolution-view">
      <header className="integrations-view__hero">
        <div>
          <p className="integrations-view__kicker">{t('evolutionPage.kicker')}</p>
          <h1 id="matos-evo-title" className="entry-section__title">{t('evolutionPage.title')}</h1>
          <p className="integrations-view__lede">{t('evolutionPage.lede')}</p>
        </div>
        <div className="matos-ops__hero-side">
          <button
            type="button"
            className="matos-ops__refresh"
            onClick={() => void refresh(true)}
            aria-label={t('evolutionPage.refresh')}
            title={t('evolutionPage.refresh')}
          >
            <Icon name="refresh" size={14} />
          </button>
          <div className="integrations-view__badge" aria-hidden="true">
            <Icon name="history" size={15} />
            <span>
              {overview?.generatedAt
                ? t('evolutionPage.updatedAt', { time: formatTime(overview.generatedAt) })
                : t('assets.loading')}
            </span>
          </div>
        </div>
      </header>

      {overview === null ? <div className="assets-view__error">{t('evolutionPage.loadFailed')}</div> : null}

      <div className="assets-panel matos-ops__panel matos-evo__panel">
        <div className="assets-panel__head">
          <h2>{t('evolutionPage.policyTitle')}</h2>
        </div>
        <p className="assets-panel__hint">{t('evolutionPage.policyHint')}</p>
        <EvolutionPolicyControl />
      </div>

      <div className="assets-panel matos-ops__panel matos-evo__panel" data-testid="evolution-proposals">
        <div className="assets-panel__head">
          <h2>{t('evolutionPage.proposalsTitle')}</h2>
          {proposals.length > 0 ? (
            <span className="repo-import__status repo-import__status--running">
              {t('evolutionPage.pendingBadge', { count: proposals.length })}
            </span>
          ) : null}
        </div>
        {overview === undefined ? (
          <p className="assets-panel__hint">{t('assets.loading')}</p>
        ) : proposals.length === 0 ? (
          <p className="assets-panel__hint">{t('evolutionPage.proposalsEmpty')}</p>
        ) : (
          <div className="matos-evo-proposals">
            {proposals.map((run) => (
              <ProposalCard
                key={`${run.projectId ?? ''}/${run.runId}`}
                run={run}
                onDecided={() => void refresh(true)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="matos-evo__grid">
        <div className="assets-panel matos-ops__panel matos-evo__panel" data-testid="evolution-tree">
          <div className="assets-panel__head">
            <h2>{t('evolutionPage.treeTitle')}</h2>
          </div>
          <p className="assets-panel__hint">{t('evolutionPage.treeHint')}</p>
          {overview === undefined ? (
            <p className="assets-panel__hint">{t('assets.loading')}</p>
          ) : (overview?.lineage ?? []).length === 0 ? (
            <p className="assets-panel__hint">{t('evolutionPage.treeEmpty')}</p>
          ) : (
            <div className="matos-evo-trees">
              {overview!.lineage.map((lineage) => (
                <LineageTree key={lineage.assetKey} lineage={lineage} />
              ))}
            </div>
          )}
        </div>

        <div className="assets-panel matos-ops__panel matos-evo__panel">
          <div className="assets-panel__head">
            <h2>{t('evolutionPage.historyTitle')}</h2>
            <label className="matos-evo-toggle">
              <input
                type="checkbox"
                checked={showDiscarded}
                onChange={(event) => setShowDiscarded(event.target.checked)}
              />
              {t('evolutionPage.showDiscarded')}
            </label>
          </div>
          {overview === undefined ? (
            <p className="assets-panel__hint">{t('assets.loading')}</p>
          ) : history.length === 0 ? (
            <p className="assets-panel__hint">{t('evolutionPage.historyEmpty')}</p>
          ) : (
            <HistoryList runs={history} />
          )}
        </div>
      </div>
    </section>
  );
}
