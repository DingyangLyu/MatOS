// MatOS operations — the runtime's real operational surfaces: a stat band
// with the headline numbers (CPU / memory / GPU / self-evolution), per-GPU
// utilization meters, self-evolution health, and
// workflow run history from the user's scope. Visuals reuse the Integrations
// hero + panel family; every block renders (or degrades) independently from
// `/api/matos/ops`.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { navigate } from '../router';
import { Icon, type IconName } from './Icon';

interface OpsPayload {
  system: {
    cpuCount: number;
    load1: number;
    load5: number;
    load15: number;
    totalMemBytes: number;
    freeMemBytes: number;
  };
  gpu: {
    ok: boolean;
    samples: Array<{ index: number; memoryUsedMib: number | null; util: number | null }>;
  } | null;
  evolve: Record<string, unknown> | null;
  workflowRuns: Array<{
    runId: string;
    workflowRef: string | null;
    status: string;
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  generatedAt: string;
}

function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.max(0, Math.round((part / total) * 100)));
}

function runStatusTone(status: string): string {
  if (status === 'completed' || status === 'succeeded') return 'done';
  if (status === 'failed' || status === 'error' || status === 'cancelled') return 'failed';
  return 'running';
}

// Self-evolution direct-editor outcome → chip tone. Mirrors the product
// meaning: accepted work is good, pending merges are informational,
// rollbacks are cautionary, and blocked/failed outcomes need attention.
function evolveChipTone(status: string): 'good' | 'info' | 'warn' | 'bad' | 'neutral' {
  if (status === 'accepted' || status === 'accepted_merged') return 'good';
  if (status === 'pending_merge') return 'info';
  if (status === 'rolled_back') return 'warn';
  if (status === 'blocked' || status === 'rollback_failed' || status === 'failed') return 'bad';
  return 'neutral';
}

function meterTone(value: number): 'cool' | 'warm' | 'hot' {
  return value >= 85 ? 'hot' : value >= 60 ? 'warm' : 'cool';
}

function relativeTime(iso: string | null, locale: string): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (abs < hour) return rtf.format(Math.round(diffMs / minute), 'minute');
    if (abs < day) return rtf.format(Math.round(diffMs / hour), 'hour');
    if (abs < day * 30) return rtf.format(Math.round(diffMs / day), 'day');
  } catch {
    // Very old runtimes without Intl.RelativeTimeFormat fall through.
  }
  return new Date(then).toLocaleDateString(locale);
}

export function MatOSOpsView() {
  const t = useT();
  const [data, setData] = useState<OpsPayload | null | undefined>(undefined);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/matos/ops', { headers: { accept: 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData((await resp.json()) as OpsPayload);
    } catch {
      setData((current) => current ?? null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = window.setInterval(() => {
      void refresh();
    }, 30_000);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [refresh]);

  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en';
  const evolve = data?.evolve ?? null;
  const evolveEnabled = evolve?.enabled === true;
  const editorRunCount = Number(evolve?.directEditorRunCount ?? 0) || 0;
  const acceptedCount = Number(evolve?.directEditorAcceptedCount ?? 0) || 0;
  const acceptPct = editorRunCount > 0 ? pct(acceptedCount, editorRunCount) : 0;
  const statusCounts =
    evolve && typeof evolve.directEditorActiveStatusCounts === 'object' && evolve.directEditorActiveStatusCounts !== null
      ? (evolve.directEditorActiveStatusCounts as Record<string, number>)
      : {};

  const memUsed = data ? data.system.totalMemBytes - data.system.freeMemBytes : 0;
  const memPct = data ? pct(memUsed, data.system.totalMemBytes) : 0;
  const cpuPct = data
    ? Math.min(100, Math.max(0, Math.round((data.system.load1 / Math.max(1, data.system.cpuCount)) * 100)))
    : 0;
  const gpuSamples = data?.gpu?.samples ?? [];
  const gpuUtils = gpuSamples.map((gpu) => gpu.util ?? 0);
  const gpuAvg = gpuUtils.length > 0 ? Math.round(gpuUtils.reduce((a, b) => a + b, 0) / gpuUtils.length) : 0;

  const runs = data?.workflowRuns ?? [];
  const runsDone = runs.filter((run) => runStatusTone(run.status) === 'done').length;
  const runsFailed = runs.filter((run) => runStatusTone(run.status) === 'failed').length;
  const runsActive = runs.length - runsDone - runsFailed;

  return (
    <section className="matos-ops" aria-labelledby="matos-ops-title" data-testid="matos-ops-view">
      <header className="integrations-view__hero">
        <div>
          <p className="integrations-view__kicker">{t('ops.kicker')}</p>
          <h1 id="matos-ops-title" className="entry-section__title">{t('ops.title')}</h1>
          <p className="integrations-view__lede">{t('ops.lede')}</p>
        </div>
        <div className="matos-ops__hero-side">
          <button
            type="button"
            className="matos-ops__schedlink"
            onClick={() => navigate({ kind: 'home', view: 'schedules' })}
            title={t('ops.viewSchedules')}
          >
            <Icon name="clock" size={14} />
            <span>{t('ops.viewSchedules')}</span>
          </button>
          <button
            type="button"
            className="matos-ops__refresh"
            onClick={() => void refresh()}
            aria-label={t('ops.refresh')}
            title={t('ops.refresh')}
          >
            <Icon name="refresh" size={14} />
          </button>
          <div className="integrations-view__badge" aria-hidden="true">
            <Icon name="history" size={15} />
            <span>
              {data?.generatedAt
                ? t('ops.updatedAt', { time: new Date(data.generatedAt).toLocaleTimeString(locale) })
                : t('assets.loading')}
            </span>
          </div>
        </div>
      </header>

      {data === null ? <div className="assets-view__error">{t('ops.loadFailed')}</div> : null}

      {/* ---- headline stat band ---- */}
      <div className="matos-ops__stats" data-testid="matos-ops-stats">
        <StatTile
          icon="gauge"
          label={t('ops.cpuLoad')}
          value={data ? data.system.load1.toFixed(1) : '—'}
          unit={data ? `/ ${data.system.cpuCount}` : ''}
          meter={cpuPct}
        />
        <StatTile
          icon="database"
          label={t('ops.memory')}
          value={data ? (memUsed / 1024 ** 3).toFixed(0) : '—'}
          unit={data ? `/ ${(data.system.totalMemBytes / 1024 ** 3).toFixed(0)} GiB` : ''}
          meter={memPct}
        />
        <StatTile
          icon="server"
          label={t('ops.statGpus')}
          value={gpuSamples.length > 0 ? `${gpuAvg}%` : '—'}
          unit={gpuSamples.length > 0 ? `${gpuSamples.length}× GPU` : ''}
          meter={gpuSamples.length > 0 ? gpuAvg : 0}
        />
        <StatTile
          icon="sparkles"
          label={t('ops.evolutionTitle')}
          value={evolve ? `${acceptedCount}` : '—'}
          unit={evolve ? `/ ${editorRunCount}` : ''}
          meter={evolve ? acceptPct : 0}
          meterToneOverride={evolve ? 'accent' : undefined}
        />
      </div>

      <div className="matos-ops__grid">
        {/* ---- resources ---- */}
        <div className="assets-panel matos-ops__panel">
          <div className="assets-panel__head">
            <h2>{t('ops.resourcesTitle')}</h2>
          </div>
          {data === undefined ? (
            <p className="assets-panel__hint">{t('assets.loading')}</p>
          ) : (
            <>
              <div className={`matos-ops__meters${gpuSamples.length > 1 ? ' matos-ops__meters--gpu' : ''}`}>
                {gpuSamples.map((gpu) => (
                  <Meter
                    key={gpu.index}
                    label={`GPU ${gpu.index}`}
                    value={gpu.util ?? 0}
                    detail={
                      gpu.memoryUsedMib != null
                        ? `${(gpu.memoryUsedMib / 1024).toFixed(1)} GiB · ${gpu.util ?? 0}%`
                        : `${gpu.util ?? 0}%`
                    }
                  />
                ))}
              </div>
              {data && !data.gpu ? (
                <p className="assets-panel__hint">{t('ops.gpuUnavailable')}</p>
              ) : null}
              {data ? (
                <div className="matos-ops__loads" aria-hidden="true">
                  <span>load1 <strong>{data.system.load1.toFixed(1)}</strong></span>
                  <span>load5 <strong>{data.system.load5.toFixed(1)}</strong></span>
                  <span>load15 <strong>{data.system.load15.toFixed(1)}</strong></span>
                </div>
              ) : null}
            </>
          )}
        </div>

        {/* ---- self-evolution ---- */}
        <div className="assets-panel matos-ops__panel">
          <div className="assets-panel__head">
            <h2>{t('ops.evolutionTitle')}</h2>
            <span className={`repo-import__status repo-import__status--${evolveEnabled ? 'done' : 'failed'}`}>
              {evolveEnabled ? t('ops.evolutionOn') : t('ops.evolutionOff')}
            </span>
          </div>
          {data === undefined ? (
            <p className="assets-panel__hint">{t('assets.loading')}</p>
          ) : evolve ? (
            <>
              <dl className="user-profile__facts">
                <div className="user-profile__fact">
                  <dt>{t('ops.evolutionScope')}</dt>
                  <dd><code>{String(evolve.directEditScope ?? '—')}</code></dd>
                </div>
                <div className="user-profile__fact">
                  <dt>{t('ops.evolutionRuns')}</dt>
                  <dd>{editorRunCount}</dd>
                </div>
                <div className="user-profile__fact">
                  <dt>{t('ops.evolutionAccepted')}</dt>
                  <dd>{acceptedCount}</dd>
                </div>
              </dl>
              {editorRunCount > 0 ? (
                <div className="matos-ops__accept" title={t('ops.acceptRate', { pct: String(acceptPct) })}>
                  <div className="matos-ops__meter-head">
                    <span>{t('ops.acceptRate', { pct: String(acceptPct) })}</span>
                    <em>{acceptedCount} / {editorRunCount}</em>
                  </div>
                  <div className="matos-ops__meter-track">
                    <span
                      className="matos-ops__meter-fill"
                      data-tone="accent"
                      style={{ width: `${acceptPct}%` }}
                    />
                  </div>
                </div>
              ) : null}
              {Object.keys(statusCounts).length > 0 ? (
                <div className="matos-ops__chips">
                  {Object.entries(statusCounts).map(([status, count]) => (
                    <span key={status} className="matos-ops__chip" data-tone={evolveChipTone(status)}>
                      {status}: <strong>{count}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="assets-panel__hint">{t('ops.evolutionHint')}</p>
            </>
          ) : (
            <p className="assets-panel__hint">{t('ops.evolveUnavailable')}</p>
          )}
        </div>
      </div>

      {/* ---- workflow runs ---- */}
      <div className="assets-panel matos-ops__panel">
        <div className="assets-panel__head">
          <h2>{t('ops.runsTitle')}</h2>
          <div className="matos-ops__run-summary" aria-hidden="true">
            {runsDone > 0 ? (
              <span className="matos-ops__chip" data-tone="good">{t('ops.runsCompleted')}: <strong>{runsDone}</strong></span>
            ) : null}
            {runsActive > 0 ? (
              <span className="matos-ops__chip" data-tone="info">{t('ops.runsActive')}: <strong>{runsActive}</strong></span>
            ) : null}
            {runsFailed > 0 ? (
              <span className="matos-ops__chip" data-tone="bad">{t('ops.runsFailed')}: <strong>{runsFailed}</strong></span>
            ) : null}
          </div>
          <button
            type="button"
            className="plugins-home__linkbtn"
            onClick={() => navigate({ kind: 'home', view: 'assets', assetRef: 'workflow' })}
          >
            {t('ops.openWorkflows')}
          </button>
        </div>
        {data === undefined ? (
          <p className="assets-panel__hint">{t('assets.loading')}</p>
        ) : !data || runs.length === 0 ? (
          <p className="assets-panel__hint">{t('ops.noRuns')}</p>
        ) : (
          <ul className="matos-ops__runs">
            {runs.map((run) => (
              <li key={run.runId} className="matos-ops__run">
                <span className={`repo-import__dot repo-import__dot--${runStatusTone(run.status)}`} aria-hidden />
                <code className="matos-ops__run-ref" title={run.workflowRef ?? run.runId}>
                  {(run.workflowRef ?? run.runId).replace(/^workflow:/, '')}
                </code>
                <span className={`repo-import__status repo-import__status--${runStatusTone(run.status)}`}>
                  {run.status}
                </span>
                <span
                  className="matos-ops__run-time"
                  title={run.updatedAt ? new Date(run.updatedAt).toLocaleString(locale) : undefined}
                >
                  {relativeTime(run.updatedAt, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function StatTile({
  icon,
  label,
  value,
  unit,
  meter,
  meterToneOverride,
}: {
  icon: IconName;
  label: string;
  value: string;
  unit: string;
  meter: number;
  meterToneOverride?: 'accent';
}) {
  const clamped = Math.min(100, Math.max(0, meter));
  const tone = meterToneOverride ?? meterTone(clamped);
  return (
    <div className="matos-ops__stat" data-tone={tone}>
      <div className="matos-ops__stat-head">
        <Icon name={icon} size={14} />
        <span>{label}</span>
      </div>
      <div className="matos-ops__stat-value">
        {value}
        {unit ? <em>{unit}</em> : null}
      </div>
      <div className="matos-ops__meter-track matos-ops__stat-meter">
        <span className="matos-ops__meter-fill" data-tone={tone} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}

function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div className="matos-ops__meter">
      <div className="matos-ops__meter-head">
        <span>{label}</span>
        <em>{detail}</em>
      </div>
      <div className="matos-ops__meter-track">
        <span className="matos-ops__meter-fill" data-tone={meterTone(clamped)} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
