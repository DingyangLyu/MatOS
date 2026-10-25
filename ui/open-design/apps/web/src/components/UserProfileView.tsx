// User profile & activity statistics.
//
// GitHub-profile-style page over the real MatOS session transcripts, dressed
// in the app's own hero/panel language: an identity card with an accent
// banner, icon stat cards, a contribution-graph token heatmap tinted with the
// product accent (not GitHub green/blue), and two insight panels (activity
// insights + most-used assets/tools). Data comes from the daemon's
// `/api/matos/user-stats` aggregation; identity comes from the gateway's
// `/api/me` when present.

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useT, useI18n } from '../i18n';
import { Button } from '@open-design/components';
import type { MatOSUserStats as UserStats } from '@open-design/contracts';
import { usageRange, cacheHitShare, isUsageProfile } from './user-profile-usage';
import styles from './user-profile-usage.module.css';
import { Icon, type IconName } from './Icon';

// Muted, warm-leaning hues that sit comfortably next to the terracotta
// accent tokens (the old palette's saturated #c0392b/#0b63a8 clashed).
const SEED_COLORS = ['#b4593d', '#3d7a68', '#5c6ac4', '#8a63b8', '#a08137', '#3f7fa8'];

function seedColor(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return SEED_COLORS[Math.abs(hash) % SEED_COLORS.length] ?? SEED_COLORS[0]!;
}

function compactNumber(value: number, locale: string): string {
  if (!Number.isFinite(value)) return '0';
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function formatDuration(ms: number, t: ReturnType<typeof useT>): string {
  if (ms <= 0) return '—';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return t('profile.durationHm', { h: String(hours), m: String(minutes % 60) });
  const seconds = Math.floor(ms / 1000);
  if (minutes > 0) return t('profile.durationMs', { m: String(minutes), s: String(seconds % 60) });
  return t('profile.durationS', { s: String(Math.max(1, seconds)) });
}

interface HeatmapWeek {
  days: Array<{ date: string; tokens: number; level: number } | null>;
}

/** Selected UTC range, Sunday-first; out-of-range days stay blank. */
function buildHeatmap(daily: Record<string, number>, range: { from: string; to: string }): {
  weeks: HeatmapWeek[];
  monthLabels: Array<{ index: number; label: number }>;
} {
  const end = Date.parse(range.to + 'T00:00:00Z');
  const start = Date.parse(range.from + 'T00:00:00Z');
  // Align the first column to Sunday.
  const startDate = new Date(start);
  const alignedStart = start - startDate.getUTCDay() * 86_400_000;
  const values = Object.values(daily).filter((v) => v > 0).sort((a, b) => a - b);
  const q = (p: number): number =>
    values.length === 0 ? Infinity : values[Math.min(values.length - 1, Math.floor(p * values.length))]!;
  const thresholds = [q(0.25), q(0.5), q(0.75)];
  const weeks: HeatmapWeek[] = [];
  const monthLabels: Array<{ index: number; label: number }> = [];
  let lastMonth = -1;
  for (let ts = alignedStart; ts <= end; ts += 7 * 86_400_000) {
    const week: HeatmapWeek = { days: [] };
    for (let d = 0; d < 7; d += 1) {
      const dayTs = ts + d * 86_400_000;
      if (dayTs > end || dayTs < start) {
        week.days.push(null);
        continue;
      }
      const date = new Date(dayTs).toISOString().slice(0, 10);
      const tokens = daily[date] ?? 0;
      const level = tokens <= 0 ? 0 : tokens <= thresholds[0]! ? 1 : tokens <= thresholds[1]! ? 2 : tokens <= thresholds[2]! ? 3 : 4;
      week.days.push({ date, tokens, level });
    }
    const firstOfWeek = new Date(ts);
    if (firstOfWeek.getUTCMonth() !== lastMonth) {
      lastMonth = firstOfWeek.getUTCMonth();
      monthLabels.push({ index: weeks.length, label: lastMonth + 1 });
    }
    weeks.push(week);
  }
  // The window rarely starts on a month boundary, so the first label often
  // sits one or two columns before the second one and they overlap (e.g.
  // "6月7月"). Drop the leading fragment when the next label is that close.
  if (
    monthLabels.length >= 2 &&
    monthLabels[1]!.index - monthLabels[0]!.index < 3
  ) {
    monthLabels.shift();
  }
  return { weeks, monthLabels };
}

export function UserProfileView() {
  const t = useT();
  const [stats, setStats] = useState<UserStats | null | undefined>(undefined);
  const { locale } = useI18n();
  const [refresh, setRefresh] = useState(0);
  const range = useMemo(() => usageRange(365), [refresh]);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    setStats(undefined);
    void fetch(`/api/matos/user-stats?${new URLSearchParams(range)}`, { signal: controller.signal, cache: 'no-store', headers: { accept: 'application/json' } })
      .then(async (resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const value: unknown = await resp.json();
        if (!isUsageProfile(value) || value.from !== range.from || value.to !== range.to) throw new Error('Invalid usage profile');
        return value;
      })
      .then((payload) => {
        if (alive) setStats(payload);
      })
      .catch(() => {
        if (alive) setStats(null);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [range, refresh]);

  useEffect(() => {
    if (!stats) return;
    const updateWhenVisible = () => {
      if (document.visibilityState === 'visible') setRefresh(value => value + 1);
    };
    // Schedule after completion: a slow initial scan must not be aborted every minute.
    const timer = window.setTimeout(updateWhenVisible, 60_000);
    document.addEventListener('visibilitychange', updateWhenVisible);
    return () => { window.clearTimeout(timer); document.removeEventListener('visibilitychange', updateWhenVisible); };
  }, [stats]);

  const displayName = t('profile.localUser');
  const handle = 'local';
  const initials = displayName.slice(0, 2).toUpperCase();
  const heatmap = useMemo(() => buildHeatmap(stats?.daily ?? {}, range), [stats, range]);
  const avatarSeed = seedColor(handle);

  return (
    <section className="user-profile" aria-labelledby="profile-title" data-testid="user-profile">
      <header className="user-profile__hero">
        <div className="user-profile__banner" aria-hidden="true" />
        <div className="user-profile__identity">
          <span
            className="user-profile__avatar"
            style={{ '--avatar-seed': avatarSeed } as CSSProperties}
          >
            {initials}
          </span>
          <div className="user-profile__id">
            <h1 id="profile-title" className="user-profile__name">{displayName}</h1>
            <p className="user-profile__handle">
              @{handle.replace(/^user:/, '')}
              <span className="user-profile__badge">MatOS</span>
            </p>
          </div>
          {stats ? (
            <div className="user-profile__id-meta">
              <span className="user-profile__meta-chip">
                <Icon name="history" size={13} />
                {t('profile.firstInRange')}
                <strong>
                  {stats.firstActivityAt
                    ? new Date(stats.firstActivityAt).toLocaleDateString(locale)
                    : '—'}
                </strong>
              </span>
              <span className="user-profile__meta-chip">
                <Icon name="gauge" size={13} />
                {t('profile.activeDays', { n: String(stats.activeDays) })}
              </span>
            </div>
          ) : null}
        </div>
      </header>

      <div className={styles.toolbar}>
        <Button type="button" disabled={stats === undefined} onClick={() => setRefresh(value => value + 1)}>{t('library.refresh')}</Button>
        <span>{t('profile.rangeDays', { n: '365' })} · {range.from} – {range.to} · UTC</span>
      </div>

      {stats === undefined ? (
        <div className="assets-view__empty">{t('assets.loading')}</div>
      ) : stats === null ? (
        <div className="assets-view__error" role="alert">{t('profile.loadFailed')} <Button onClick={() => setRefresh(value => value + 1)}>{t('preview.retry')}</Button></div>
      ) : (
        <>
          <p className={styles.note} role="status">
            {t('profile.accountingNote', { n: String(stats.coverage.unavailableRecords) })}<br />
            {t('profile.updatedAt', { time: new Date(stats.generatedAt).toLocaleString(locale, { timeZone: 'UTC' }) })} · UTC
          </p>
          <div className="user-profile__stats" role="list">
            <StatCard icon="gauge" value={compactNumber(stats.totalTokens, locale)} label={t('profile.totalTokens')} />
            <StatCard icon="sparkles" value={compactNumber(stats.peakDayTokens, locale)} label={t('profile.peakTokens')} />
            <StatCard icon="history" value={formatDuration(stats.longestTaskMs, t)} label={t('profile.longestTask')} />
            <StatCard icon="sun" value={t('profile.days', { n: String(stats.currentStreakDays) })} label={t('profile.currentStreak')} />
            <StatCard icon="star" value={t('profile.days', { n: String(stats.longestStreakDays) })} label={t('profile.longestStreak')} />
          </div>

          <div className="user-profile__panel">
            <dl className={styles.breakdown}>
              <FactRow label={t('profile.foreground')} value={stats.foregroundTokens.toLocaleString(locale)} />
              <FactRow label={t('profile.background')} value={stats.backgroundTokens.toLocaleString(locale)} />
              <FactRow label={t('profile.inputUncached')} value={stats.tokensByKind.input.toLocaleString(locale)} />
              <FactRow label={t('profile.inputCached')} value={stats.tokensByKind.cacheRead.toLocaleString(locale)} />
              <FactRow label={t('profile.cacheCreated')} value={stats.tokensByKind.cacheCreation.toLocaleString(locale)} />
              <FactRow label={t('profile.outputTokens')} value={stats.tokensByKind.output.toLocaleString(locale)} />
            </dl>
          </div>

          <div className="user-profile__panel">
            <div className="user-profile__panel-head">
              <h2>
                <Icon name="grid" size={14} />
                {t('profile.heatmapTitle')}
              </h2>
              <span className="user-profile__panel-hint">
                {t('profile.activeDays', { n: String(stats.activeDays) })}
              </span>
            </div>
            <div className="user-profile__heatmap-scroll">
              <div className="user-profile__heatmap" role="img" aria-label={t('profile.heatmapTitle')}>
                {heatmap.weeks.map((week, wi) => (
                  <div key={wi} className="user-profile__heatmap-col">
                    {week.days.map((day, di) =>
                      day ? (
                        <span
                          key={di}
                          className="user-profile__cell"
                          data-level={day.level}
                          title={`${day.date} UTC · ${day.tokens.toLocaleString(locale)} tokens`}
                        />
                      ) : (
                        <span key={di} className="user-profile__cell user-profile__cell--void" />
                      ),
                    )}
                  </div>
                ))}
              </div>
              <div className="user-profile__heatmap-months" style={{ gridTemplateColumns: `repeat(${heatmap.weeks.length}, 14px)`, width: `${heatmap.weeks.length * 14 - 3}px` }}>
                {heatmap.monthLabels.map((month) => (
                  <span
                    key={`${month.index}-${month.label}`}
                    style={{ gridColumnStart: month.index + 1 }}
                  >
                    {t('profile.monthShort', { n: String(month.label) })}
                  </span>
                ))}
              </div>
            </div>
            <div className="user-profile__legend" aria-hidden="true">
              <span>{t('profile.legendLess')}</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span key={level} className="user-profile__cell" data-level={level} />
              ))}
              <span>{t('profile.legendMore')}</span>
            </div>
          </div>

          <div className="user-profile__columns">
            <div className="user-profile__panel">
              <div className="user-profile__panel-head">
                <h2>
                  <Icon name="kanban" size={14} />
                  {t('profile.insightsTitle')}
                </h2>
              </div>
              <dl className="user-profile__facts">
                <FactRow label={t('profile.sessions')} value={String(stats.sessionCount)} />
                <FactRow label={t('profile.messages')} value={String(stats.userMessageCount)} />
                <FactRow label={t('profile.toolCalls')} value={compactNumber(stats.toolCallCount, locale)} />
                <FactRow
                  label={t('profile.outputTokens')}
                  value={compactNumber(stats.tokensByKind.output, locale)}
                />
                <FactRow
                  label={t('profile.inputCacheHit')}
                  value={
                    cacheHitShare(stats) !== null
                      ? `${(cacheHitShare(stats)! * 100).toFixed(1)}%`
                      : '—'
                  }
                />
                <FactRow
                  label={t('profile.firstInRange')}
                  value={
                    stats.firstActivityAt
                      ? new Date(stats.firstActivityAt).toLocaleDateString(locale)
                      : '—'
                  }
                />
              </dl>
            </div>
            <div className="user-profile__panel">
              <div className="user-profile__panel-head">
                <h2>
                  <Icon name="hammer" size={14} />
                  {t('profile.topAssetsTitle')}
                </h2>
              </div>
              {stats.topTools.length === 0 ? (
                <p className="user-profile__empty-hint">
                  <Icon name="puzzle" size={14} />
                  {t('profile.noTools')}
                </p>
              ) : (
                <ul className="user-profile__tools">
                  {stats.topTools.map((tool, index) => (
                    <li key={tool.name}>
                      <span className="user-profile__tool-rank">{index + 1}</span>
                      <span
                        className="user-profile__tool-swatch"
                        style={{ backgroundColor: seedColor(tool.name) }}
                      />
                      <code className="user-profile__tool-name" title={tool.name}>{tool.name}</code>
                      <span className="user-profile__tool-count">
                        {t('profile.runs', { n: compactNumber(tool.count, locale) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function StatCard({ icon, value, label }: { icon: IconName; value: string; label: string }) {
  return (
    <div className="user-profile__stat" role="listitem">
      <span className="user-profile__stat-icon" aria-hidden="true">
        <Icon name={icon} size={15} />
      </span>
      <div className="user-profile__stat-body">
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="user-profile__fact">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
