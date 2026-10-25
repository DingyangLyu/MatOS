// Native MatOS product-feedback page.
//
// This is a thin UI over `/api/matos/feedback`, which in turn delegates to
// the native `matos workbench feedback` service. It intentionally follows the
// profile page's panel/heatmap language while using a GitHub-issue-like form
// and chronological issue ledger.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  FEEDBACK_ISSUE_STATUSES,
  type FeedbackIssue,
  type FeedbackIssueKind,
  type FeedbackIssueListResponse,
  type FeedbackIssueSeverity,
  type FeedbackIssueStatus,
} from '@open-design/contracts';
import { useI18n, useT } from '../i18n';
import { Icon } from './Icon';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ISSUES_PER_PAGE = 6;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const FEEDBACK_SOURCE_PATH_KEY = 'matos.feedback.sourcePath';
const FEEDBACK_DRAFT_KEY = 'matos.feedback.draft';

interface SelectedImage {
  file: File;
  previewUrl: string;
}

interface FeedbackDraft {
  kind: FeedbackIssueKind;
  severity: FeedbackIssueSeverity;
  title: string;
  message: string;
  contextNote: string;
}

function readFeedbackDraft(): FeedbackDraft | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.sessionStorage.getItem(FEEDBACK_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FeedbackDraft>;
    return {
      kind: parsed.kind === 'suggestion' ? 'suggestion' : 'bug',
      severity: parsed.severity === 'low' || parsed.severity === 'high' || parsed.severity === 'blocking'
        ? parsed.severity
        : 'normal',
      title: typeof parsed.title === 'string' ? parsed.title.slice(0, 200) : '',
      message: typeof parsed.message === 'string' ? parsed.message.slice(0, 8000) : '',
      contextNote: typeof parsed.contextNote === 'string' ? parsed.contextNote.slice(0, 500) : '',
    };
  } catch {
    return null;
  }
}

interface HeatmapDay {
  date: string;
  count: number;
  level: number;
}

interface HeatmapWeek {
  days: Array<HeatmapDay | null>;
}

export function buildFixHeatmap(
  daily: Record<string, number>,
  now = new Date(),
): {
  weeks: HeatmapWeek[];
  monthLabels: Array<{ index: number; label: number }>;
  visibleTotal: number;
} {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - 370 * 86_400_000;
  const alignedStart = start - new Date(start).getUTCDay() * 86_400_000;
  const weeks: HeatmapWeek[] = [];
  const monthLabels: Array<{ index: number; label: number }> = [];
  let lastMonth = -1;
  let visibleTotal = 0;
  for (let ts = alignedStart; ts <= end; ts += 7 * 86_400_000) {
    const week: HeatmapWeek = { days: [] };
    for (let dayIndex = 0; dayIndex < 7; dayIndex += 1) {
      const dayTs = ts + dayIndex * 86_400_000;
      if (dayTs > end) {
        week.days.push(null);
        continue;
      }
      const date = new Date(dayTs).toISOString().slice(0, 10);
      const count = Math.max(0, Math.floor(daily[date] ?? 0));
      visibleTotal += count;
      week.days.push({
        date,
        count,
        level: count <= 0 ? 0 : count === 1 ? 1 : count === 2 ? 2 : count === 3 ? 3 : 4,
      });
    }
    const month = new Date(ts).getUTCMonth();
    if (month !== lastMonth) {
      lastMonth = month;
      monthLabels.push({ index: weeks.length, label: month + 1 });
    }
    weeks.push(week);
  }
  if (monthLabels.length >= 2 && monthLabels[1]!.index - monthLabels[0]!.index < 3) {
    monthLabels.shift();
  }
  return { weeks, monthLabels, visibleTotal };
}

function statusGroup(status: FeedbackIssueStatus): 'open' | 'active' | 'fixed' | 'rejected' {
  if (status === 'resolved' || status === 'closed') return 'fixed';
  if (status === 'triaged' || status === 'in_progress') return 'active';
  if (status === 'rejected') return 'rejected';
  return 'open';
}

function humanFileSize(bytes: number, locale: string): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(bytes / 1024)} KB`;
}

async function apiError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json() as { error?: { message?: unknown } };
    return typeof payload.error?.message === 'string' ? payload.error.message : fallback;
  } catch {
    return fallback;
  }
}

export function UserFeedbackView() {
  const t = useT();
  const { locale } = useI18n();
  const [data, setData] = useState<FeedbackIssueListResponse | null | undefined>(undefined);
  const [loadError, setLoadError] = useState('');
  // The composer draft survives in-app navigation (the view unmounts when the
  // user switches to another section) through per-tab sessionStorage.
  const [draft] = useState(readFeedbackDraft);
  const [kind, setKind] = useState<FeedbackIssueKind>(draft?.kind ?? 'bug');
  const [severity, setSeverity] = useState<FeedbackIssueSeverity>(draft?.severity ?? 'normal');
  const [title, setTitle] = useState(draft?.title ?? '');
  const [message, setMessage] = useState(draft?.message ?? '');
  const [contextNote, setContextNote] = useState(draft?.contextNote ?? '');
  const [images, setImages] = useState<SelectedImage[]>([]);
  const [imageError, setImageError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [submittedId, setSubmittedId] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'active' | 'fixed' | 'rejected'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [issuePage, setIssuePage] = useState(1);
  const [dragActive, setDragActive] = useState(false);
  const [updatingStatusId, setUpdatingStatusId] = useState('');
  const [statusError, setStatusError] = useState<{ id: string; message: string } | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const imagesRef = useRef<SelectedImage[]>([]);

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => () => {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
  }, []);

  useEffect(() => {
    try {
      if (!title && !message && !contextNote) {
        window.sessionStorage.removeItem(FEEDBACK_DRAFT_KEY);
        return;
      }
      window.sessionStorage.setItem(FEEDBACK_DRAFT_KEY, JSON.stringify({
        kind,
        severity,
        title,
        message,
        contextNote,
      } satisfies FeedbackDraft));
    } catch {
      /* storage can be disabled */
    }
  }, [kind, severity, title, message, contextNote]);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const response = await fetch('/api/matos/feedback', {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) {
        const message = await apiError(response, t('feedback.loadFailed'));
        throw new Error(`${message} (HTTP ${response.status})`);
      }
      setData(await response.json() as FeedbackIssueListResponse);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('feedback.loadFailed'));
      setData(null);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const heatmap = useMemo(
    () => buildFixHeatmap(data?.summary.resolvedDaily ?? {}),
    [data?.summary.resolvedDaily],
  );

  const groupCounts = useMemo(() => {
    const counts = { all: 0, open: 0, active: 0, fixed: 0, rejected: 0 };
    for (const issue of data?.issues ?? []) {
      counts.all += 1;
      counts[statusGroup(issue.status)] += 1;
    }
    return counts;
  }, [data?.issues]);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const visibleIssues = useMemo(() => {
    const issues = [...(data?.issues ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const grouped = filter === 'all'
      ? issues
      : issues.filter((issue) => statusGroup(issue.status) === filter);
    if (!normalizedQuery) return grouped;
    return grouped.filter((issue) =>
      issue.title.toLowerCase().includes(normalizedQuery) ||
      issue.id.toLowerCase().includes(normalizedQuery) ||
      issue.messagePreview.toLowerCase().includes(normalizedQuery));
  }, [data?.issues, filter, normalizedQuery]);
  const issuePageCount = Math.max(1, Math.ceil(visibleIssues.length / ISSUES_PER_PAGE));
  const currentIssuePage = Math.min(issuePage, issuePageCount);
  const issuePageStart = (currentIssuePage - 1) * ISSUES_PER_PAGE;
  const displayedIssues = visibleIssues.slice(issuePageStart, issuePageStart + ISSUES_PER_PAGE);

  function resetImages(): void {
    for (const image of imagesRef.current) URL.revokeObjectURL(image.previewUrl);
    imagesRef.current = [];
    setImages([]);
    if (imageInputRef.current) imageInputRef.current.value = '';
  }

  function addImages(files: File[]): void {
    setImageError('');
    const accepted: File[] = [];
    for (const file of files) {
      if (!IMAGE_TYPES.has(file.type)) {
        setImageError(t('feedback.imagesTypeError'));
        continue;
      }
      if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) {
        setImageError(t('feedback.imagesSizeError'));
        continue;
      }
      accepted.push(file);
    }
    const remaining = Math.max(0, MAX_IMAGES - imagesRef.current.length);
    if (accepted.length > remaining) setImageError(t('feedback.imagesCountError'));
    const next = accepted.slice(0, remaining).map((file) => ({
      file,
      previewUrl: URL.createObjectURL(file),
    }));
    setImages((current) => [...current, ...next]);
  }

  function removeImage(index: number): void {
    setImages((current) => {
      const target = current[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  function onImageInput(event: ChangeEvent<HTMLInputElement>): void {
    addImages(Array.from(event.target.files ?? []));
  }

  function onDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setDragActive(false);
    addImages(Array.from(event.dataTransfer.files));
  }

  function onPaste(event: ClipboardEvent<HTMLFormElement>): void {
    const files = Array.from(event.clipboardData?.files ?? [])
      .filter((file) => IMAGE_TYPES.has(file.type));
    if (!files.length) return;
    event.preventDefault();
    addImages(files);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.requestSubmit();
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setSubmitError('');
    setSubmittedId('');
    const form = new FormData();
    form.set('kind', kind);
    form.set('severity', severity);
    form.set('title', title.trim());
    form.set('message', message.trim());
    let sourcePath = '';
    try {
      sourcePath = window.sessionStorage.getItem(FEEDBACK_SOURCE_PATH_KEY) ?? '';
    } catch {
      /* storage can be disabled */
    }
    form.set('context', JSON.stringify({
      sourcePath: sourcePath || '/',
      pagePath: window.location.pathname,
      viewport: `${window.innerWidth}x${window.innerHeight}`,
      locale,
      userAgent: navigator.userAgent,
      capturedAt: new Date().toISOString(),
      ...(contextNote.trim() ? { note: contextNote.trim() } : {}),
    }));
    for (const image of images) form.append('images', image.file, image.file.name);
    try {
      const response = await fetch('/api/matos/feedback', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await apiError(response, t('feedback.submitFailed')));
      const payload = await response.json() as { issue: FeedbackIssue };
      setSubmittedId(payload.issue.id);
      setExpandedId(payload.issue.viewerAccess === 'full' ? payload.issue.id : null);
      setFilter('all');
      setSearchQuery('');
      setIssuePage(1);
      setTitle('');
      setMessage('');
      setContextNote('');
      setKind('bug');
      setSeverity('normal');
      resetImages();
      try {
        window.sessionStorage.removeItem(FEEDBACK_DRAFT_KEY);
      } catch {
        /* storage can be disabled */
      }
      await load();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : t('feedback.submitFailed'));
    } finally {
      setSubmitting(false);
    }
  }

  async function updateIssueStatus(
    issue: FeedbackIssue,
    status: FeedbackIssueStatus,
  ): Promise<void> {
    if (status === issue.status || updatingStatusId) return;
    setUpdatingStatusId(issue.id);
    setStatusError(null);
    try {
      const response = await fetch(`/api/matos/feedback/${encodeURIComponent(issue.id)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) {
        throw new Error(await apiError(response, t('feedback.submitFailed')));
      }
      const payload = await response.json() as { issue?: FeedbackIssue };
      if (!payload.issue || payload.issue.id !== issue.id) {
        throw new Error(t('feedback.loadFailed'));
      }
      const updatedIssue = payload.issue;
      setData((current) => {
        if (!current) return current;
        const issues = current.issues.map((candidate) => (
          candidate.id === updatedIssue.id ? updatedIssue : candidate
        ));
        const statusCounts: Partial<Record<FeedbackIssueStatus, number>> = {};
        const resolvedDaily: Record<string, number> = {};
        let fixedTotal = 0;
        for (const candidate of issues) {
          statusCounts[candidate.status] = (statusCounts[candidate.status] ?? 0) + 1;
          if (candidate.status !== 'resolved' && candidate.status !== 'closed') continue;
          fixedTotal += 1;
          const timestamp = candidate.resolvedAt ?? candidate.updatedAt ?? candidate.createdAt;
          const parsed = Date.parse(timestamp);
          if (!Number.isFinite(parsed)) continue;
          const day = new Date(parsed).toISOString().slice(0, 10);
          resolvedDaily[day] = (resolvedDaily[day] ?? 0) + 1;
        }
        return {
          issues,
          summary: {
            ...current.summary,
            fixedTotal,
            statusCounts,
            resolvedDaily,
          },
        };
      });
    } catch (error) {
      setStatusError({
        id: issue.id,
        message: error instanceof Error ? error.message : t('feedback.submitFailed'),
      });
    } finally {
      setUpdatingStatusId('');
    }
  }

  const statusCounts = data?.summary.statusCounts ?? {};
  const openCount = (statusCounts.open ?? 0) + (statusCounts.triaged ?? 0);
  const activeCount = statusCounts.in_progress ?? 0;

  return (
    <section className="user-feedback" aria-labelledby="feedback-title" data-testid="user-feedback">
      <header className="user-feedback__hero">
        <div className="user-feedback__hero-mark" aria-hidden="true">
          <Icon name="comment" size={22} />
        </div>
        <div className="user-feedback__hero-copy">
          <span>{t('feedback.eyebrow')}</span>
          <h1 id="feedback-title">{t('feedback.title')}</h1>
          <p>{t('feedback.subtitle')}</p>
        </div>
        <div className="user-feedback__hero-note">
          <Icon name="shield" size={14} />
          <span>{t('feedback.privacy')}</span>
        </div>
      </header>

      {data === undefined ? (
        <div className="assets-view__empty">{t('assets.loading')}</div>
      ) : data === null ? (
        <div className="user-feedback__load-error">
          <Icon name="alert-triangle" size={18} />
          <span>{loadError || t('feedback.loadFailed')}</span>
          <button type="button" onClick={() => void load()}>{t('feedback.retry')}</button>
        </div>
      ) : (
        <>
          <div className="user-feedback__stats" role="list">
            <FeedbackStat icon="comment" value={data.summary.total} label={t('feedback.statTotal')} />
            <FeedbackStat icon="alert-triangle" value={openCount} label={t('feedback.statOpen')} tone="amber" />
            <FeedbackStat icon="clock" value={activeCount} label={t('feedback.statProgress')} tone="blue" />
            <FeedbackStat icon="check" value={data.summary.fixedTotal} label={t('feedback.statFixed')} tone="green" />
          </div>

          <section className="user-feedback__panel user-feedback__heatmap-panel">
            <div className="user-feedback__panel-head">
              <div>
                <span className="user-feedback__section-icon"><Icon name="grid" size={14} /></span>
                <div>
                  <h2>{t('feedback.heatmapTitle')}</h2>
                  <p>{t('feedback.heatmapSubtitle')}</p>
                </div>
              </div>
              <span className="user-feedback__panel-count">
                {t('feedback.fixedInYear', { n: String(heatmap.visibleTotal) })}
              </span>
            </div>
            <div className="user-feedback__heatmap-scroll">
              <div className="user-feedback__heatmap" role="img" aria-label={t('feedback.heatmapTitle')}>
                {heatmap.weeks.map((week, weekIndex) => (
                  <div key={weekIndex} className="user-feedback__heatmap-col">
                    {week.days.map((day, dayIndex) => day ? (
                      <span
                        key={day.date}
                        className="user-feedback__heatmap-cell"
                        data-level={day.level}
                        title={`${day.date} · ${t('feedback.fixedCount', { n: String(day.count) })}`}
                      />
                    ) : (
                      <span key={dayIndex} className="user-feedback__heatmap-cell is-void" />
                    ))}
                  </div>
                ))}
              </div>
              <div className="user-feedback__heatmap-months">
                {heatmap.monthLabels.map((month) => (
                  <span key={`${month.index}-${month.label}`} style={{ gridColumnStart: month.index + 1 }}>
                    {t('profile.monthShort', { n: String(month.label) })}
                  </span>
                ))}
              </div>
            </div>
            <div className="user-feedback__heatmap-legend" aria-hidden="true">
              <span>{t('feedback.legendLess')}</span>
              {[0, 1, 2, 3, 4].map((level) => (
                <span key={level} className="user-feedback__heatmap-cell" data-level={level} />
              ))}
              <span>{t('feedback.legendMore')}</span>
            </div>
          </section>

          <div className="user-feedback__workspace">
            <section className="user-feedback__panel user-feedback__composer">
              <div className="user-feedback__panel-head">
                <div>
                  <span className="user-feedback__section-icon"><Icon name="pencil" size={14} /></span>
                  <div>
                    <h2>{t('feedback.newTitle')}</h2>
                    <p>{t('feedback.newSubtitle')}</p>
                  </div>
                </div>
              </div>
              {submittedId ? (
                <div className="user-feedback__notice is-success" role="status">
                  <Icon name="check" size={14} />
                  <span>{t('feedback.submitSuccess', { id: submittedId })}</span>
                </div>
              ) : null}
              {submitError ? (
                <div className="user-feedback__notice is-error" role="alert">
                  <Icon name="alert-triangle" size={14} />
                  <span>{submitError}</span>
                </div>
              ) : null}
              <form
                className="user-feedback__form"
                onSubmit={(event) => void onSubmit(event)}
                onPaste={onPaste}
                onKeyDown={onComposerKeyDown}
              >
                <fieldset className="user-feedback__kind-field">
                  <legend>{t('feedback.kindLabel')}</legend>
                  <div className="user-feedback__kind-picker">
                    <button
                      type="button"
                      className={kind === 'bug' ? 'is-active' : ''}
                      aria-pressed={kind === 'bug'}
                      onClick={() => setKind('bug')}
                    >
                      <Icon name="alert-triangle" size={14} />
                      <span>{t('feedback.kindBug')}</span>
                    </button>
                    <button
                      type="button"
                      className={kind === 'suggestion' ? 'is-active' : ''}
                      aria-pressed={kind === 'suggestion'}
                      onClick={() => setKind('suggestion')}
                    >
                      <Icon name="lightbulb" size={14} />
                      <span>{t('feedback.kindSuggestion')}</span>
                    </button>
                  </div>
                </fieldset>

                <label className="user-feedback__field">
                  <span>{t('feedback.titleLabel')} <em>{t('feedback.required')}</em></span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    maxLength={200}
                    required
                    placeholder={t('feedback.titlePlaceholder')}
                  />
                </label>

                <label className="user-feedback__field">
                  <span>{t('feedback.contentLabel')} <em>{t('feedback.required')}</em></span>
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    maxLength={8000}
                    required
                    rows={7}
                    placeholder={kind === 'bug' ? t('feedback.contentBugPlaceholder') : t('feedback.contentSuggestionPlaceholder')}
                  />
                  <small>{message.length} / 8000</small>
                </label>

                <div className="user-feedback__field-row">
                  <label className="user-feedback__field">
                    <span>{t('feedback.severityLabel')}</span>
                    <select value={severity} onChange={(event) => setSeverity(event.target.value as FeedbackIssueSeverity)}>
                      <option value="low">{t('feedback.severityLow')}</option>
                      <option value="normal">{t('feedback.severityNormal')}</option>
                      <option value="high">{t('feedback.severityHigh')}</option>
                      <option value="blocking">{t('feedback.severityBlocking')}</option>
                    </select>
                  </label>
                  <div className="user-feedback__auto-context">
                    <span>{t('feedback.autoContextLabel')}</span>
                    <strong><Icon name="check" size={12} /> {t('feedback.autoContextReady')}</strong>
                  </div>
                </div>

                <label className="user-feedback__field">
                  <span>{t('feedback.contextLabel')}</span>
                  <textarea
                    value={contextNote}
                    onChange={(event) => setContextNote(event.target.value)}
                    maxLength={500}
                    rows={3}
                    placeholder={t('feedback.contextPlaceholder')}
                  />
                </label>

                <div className="user-feedback__field">
                  <span>{t('feedback.imagesLabel')}</span>
                  <label
                    className={`user-feedback__dropzone${dragActive ? ' is-dragging' : ''}`}
                    htmlFor="feedback-images"
                    onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
                    onDragOver={(event) => event.preventDefault()}
                    onDragLeave={() => setDragActive(false)}
                    onDrop={onDrop}
                  >
                    <Icon name="image" size={19} />
                    <span>{t('feedback.imagesDrop')}</span>
                    <small>{t('feedback.imagesHint')}</small>
                  </label>
                  <input
                    ref={imageInputRef}
                    id="feedback-images"
                    className="user-feedback__file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    multiple
                    onChange={onImageInput}
                  />
                  {imageError ? <small className="user-feedback__field-error" role="alert">{imageError}</small> : null}
                  {images.length ? (
                    <div className="user-feedback__image-previews">
                      {images.map((image, index) => (
                        <div key={`${image.file.name}-${image.file.lastModified}-${index}`}>
                          <img src={image.previewUrl} alt="" />
                          <span title={image.file.name}>{image.file.name}</span>
                          <small>{humanFileSize(image.file.size, locale)}</small>
                          <button
                            type="button"
                            onClick={() => removeImage(index)}
                            aria-label={t('feedback.removeImage', { name: image.file.name })}
                          >
                            <Icon name="close" size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="user-feedback__composer-footer">
                  <button
                    className="user-feedback__submit"
                    type="submit"
                    data-submitting={submitting ? 'true' : 'false'}
                    disabled={submitting || !title.trim() || !message.trim()}
                  >
                    {submitting ? <Icon name="spinner" size={15} /> : <Icon name="send" size={15} />}
                    <span>{submitting ? t('feedback.submitting') : t('feedback.submit')}</span>
                  </button>
                  <small className="user-feedback__submit-hint">{t('feedback.submitHint')}</small>
                </div>
              </form>
            </section>

            <section className="user-feedback__panel user-feedback__issues">
              <div className="user-feedback__panel-head user-feedback__issues-head">
                <div>
                  <span className="user-feedback__section-icon"><Icon name="kanban" size={14} /></span>
                  <div>
                    <h2>{t('feedback.listTitle')}</h2>
                    <p>{t('feedback.listSubtitle')}</p>
                  </div>
                </div>
                <button type="button" className="user-feedback__refresh" onClick={() => void load()} aria-label={t('feedback.refresh')}>
                  <Icon name="refresh" size={14} />
                </button>
              </div>
              <div className="user-feedback__list-tools">
                <div className="user-feedback__filters" role="group" aria-label={t('feedback.filterAria')}>
                  {(['all', 'open', 'active', 'fixed', 'rejected'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={filter === value ? 'is-active' : ''}
                      aria-pressed={filter === value}
                      onClick={() => {
                        setFilter(value);
                        setIssuePage(1);
                        setExpandedId(null);
                      }}
                    >
                      {t(`feedback.filter.${value}` as never)}
                      <span className="user-feedback__filter-count">{groupCounts[value]}</span>
                    </button>
                  ))}
                </div>
                <label className="user-feedback__search">
                  <Icon name="search" size={13} />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => {
                      setSearchQuery(event.target.value);
                      setIssuePage(1);
                      setExpandedId(null);
                    }}
                    placeholder={t('feedback.searchPlaceholder')}
                    aria-label={t('feedback.searchPlaceholder')}
                  />
                </label>
              </div>
              {visibleIssues.length === 0 ? (
                <div className="user-feedback__empty">
                  <span><Icon name="comment" size={20} /></span>
                  <strong>{normalizedQuery ? t('feedback.emptySearch') : t('feedback.emptyTitle')}</strong>
                  <p>
                    {normalizedQuery
                      ? t('feedback.emptySearchSubtitle')
                      : filter === 'all' ? t('feedback.emptySubtitle') : t('feedback.emptyFilter')}
                  </p>
                </div>
              ) : (
                <div className="user-feedback__issue-list">
                  {displayedIssues.map((issue) => (
                    <FeedbackIssueRow
                      key={issue.id}
                      issue={issue}
                      expanded={expandedId === issue.id}
                      locale={locale}
                      onToggle={() => setExpandedId((current) => current === issue.id ? null : issue.id)}
                      updatingStatus={updatingStatusId === issue.id}
                      statusError={statusError?.id === issue.id ? statusError.message : ''}
                      onStatusChange={(status) => void updateIssueStatus(issue, status)}
                    />
                  ))}
                </div>
              )}
              {visibleIssues.length > 0 && issuePageCount > 1 ? (
                <nav className="user-feedback__pagination" aria-label={t('feedback.listTitle')}>
                  <span className="user-feedback__pagination-range">
                    {issuePageStart + 1}–{Math.min(issuePageStart + ISSUES_PER_PAGE, visibleIssues.length)} / {visibleIssues.length}
                  </span>
                  <button
                    type="button"
                    aria-label={t('designFiles.prev')}
                    disabled={currentIssuePage === 1}
                    onClick={() => {
                      setIssuePage(Math.max(1, currentIssuePage - 1));
                      setExpandedId(null);
                    }}
                  >
                    <Icon name="chevron-left" size={14} />
                  </button>
                  <span className="user-feedback__pagination-page">
                    <strong>{currentIssuePage}</strong>
                    <span>/</span>
                    {issuePageCount}
                  </span>
                  <button
                    type="button"
                    aria-label={t('designFiles.next')}
                    disabled={currentIssuePage === issuePageCount}
                    onClick={() => {
                      setIssuePage(Math.min(issuePageCount, currentIssuePage + 1));
                      setExpandedId(null);
                    }}
                  >
                    <Icon name="chevron-right" size={14} />
                  </button>
                </nav>
              ) : null}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function FeedbackStat({
  icon,
  value,
  label,
  tone = 'accent',
}: {
  icon: 'comment' | 'alert-triangle' | 'clock' | 'check';
  value: number;
  label: string;
  tone?: 'accent' | 'amber' | 'blue' | 'green';
}) {
  return (
    <div className="user-feedback__stat" data-tone={tone} role="listitem">
      <span><Icon name={icon} size={16} /></span>
      <div><strong>{value}</strong><small>{label}</small></div>
    </div>
  );
}

function FeedbackIssueRow({
  issue,
  expanded,
  locale,
  onToggle,
  updatingStatus,
  statusError,
  onStatusChange,
}: {
  issue: FeedbackIssue;
  expanded: boolean;
  locale: string;
  onToggle: () => void;
  updatingStatus: boolean;
  statusError: string;
  onStatusChange: (status: FeedbackIssueStatus) => void;
}) {
  const t = useT();
  const group = statusGroup(issue.status);
  const date = new Date(issue.createdAt).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
  const contextRows = [
    ['sourcePath', issue.context.sourcePath],
    ['scopeRef', issue.context.scopeRef],
    ['roleRef', issue.context.roleRef],
    ['runtimeRef', issue.context.runtimeRef],
    ['viewport', issue.context.viewport],
  ].filter((row): row is [string, string] => Boolean(row[1]));
  const canExpand = issue.viewerAccess === 'full';
  return (
    <article className="user-feedback__issue" data-status={group}>
      <button
        type="button"
        className="user-feedback__issue-summary"
        onClick={canExpand ? onToggle : undefined}
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        title={canExpand ? undefined : t('feedback.detailLocked')}
      >
        <span className="user-feedback__issue-kind" data-kind={issue.kind}>
          <Icon name={issue.kind === 'bug' ? 'alert-triangle' : 'lightbulb'} size={14} />
        </span>
        <span className="user-feedback__issue-main">
          <span className="user-feedback__issue-title-row">
            <strong>{issue.title}</strong>
            <span className="user-feedback__status" data-status={group}>
              {t(`feedback.status.${issue.status}` as never)}
            </span>
          </span>
          <span className="user-feedback__issue-preview">{issue.messagePreview}</span>
          <span className="user-feedback__issue-meta">
            <code>{issue.id}</code>
            <span>{date}</span>
            <span>{t(`feedback.severity.${issue.severity}` as never)}</span>
            {issue.attachments.length ? (
              <span><Icon name="image" size={11} /> {issue.attachments.length}</span>
            ) : null}
          </span>
        </span>
        <Icon name={canExpand ? (expanded ? 'chevron-down' : 'chevron-right') : 'eye-off'} size={14} />
      </button>
      {canExpand && expanded ? (
        <div className="user-feedback__issue-detail">
          <div className="user-feedback__status-editor">
            <Icon name={updatingStatus ? 'spinner' : 'kanban'} size={13} />
            <select
              aria-label={`${issue.title} · ${t(`feedback.status.${issue.status}` as never)}`}
              value={issue.status}
              disabled={updatingStatus}
              onChange={(event) => onStatusChange(event.target.value as FeedbackIssueStatus)}
            >
              {FEEDBACK_ISSUE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`feedback.status.${status}` as never)}
                </option>
              ))}
            </select>
            {statusError ? <span role="alert">{statusError}</span> : null}
          </div>
          <div className="user-feedback__issue-body">{issue.message}</div>
          {issue.context.note ? (
            <div className="user-feedback__context-note">
              <span>{t('feedback.contextLabel')}</span>
              <p>{issue.context.note}</p>
            </div>
          ) : null}
          {contextRows.length ? (
            <dl className="user-feedback__context-grid">
              {contextRows.map(([key, value]) => (
                <div key={key}><dt>{key}</dt><dd>{value}</dd></div>
              ))}
            </dl>
          ) : null}
          {issue.attachments.length ? (
            <div className="user-feedback__issue-images">
              {issue.attachments.map((attachment) => (
                <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer noopener" title={attachment.name}>
                  <img src={attachment.url} alt={attachment.name} loading="lazy" />
                  <span>{attachment.name}</span>
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
