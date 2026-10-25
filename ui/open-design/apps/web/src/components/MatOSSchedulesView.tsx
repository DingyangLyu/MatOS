// MatOS scheduled tasks — the runtime's native cron workflow triggers surfaced
// as a dedicated automation page. Lists schedules with their next fire and
// last run, and drives create / edit / enable-pause / run-now / delete through
// the `/api/matos/schedules` daemon bridge (thin adapter over `matos workbench
// workflows ...`). A resident daemon tick loop fires due schedules; this view
// only reads and mutates them.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { Icon, type IconName } from './Icon';
import { navigate } from '../router';

interface ScheduleSummary {
  triggerId: string;
  workflowRef: string;
  name: string;
  cron: string;
  timezone: string | null;
  enabled: boolean;
  parameters: Record<string, unknown>;
  nextFireAt: number | null;
  lastFiredAt: number | null;
  lastRunId: string | null;
  lastError: string | null;
  createTime: number | null;
  updateTime: number | null;
}

interface WorkflowOption {
  ref: string;
  name: string;
}

interface SchedulesPayload {
  triggers: ScheduleSummary[];
  workflows: WorkflowOption[];
  generatedAt: string;
  autotick: boolean;
}

type Cadence = 'hourly' | 'daily' | 'weekly' | 'custom';

interface FormState {
  triggerId: string | null;
  workflowRef: string;
  name: string;
  cadence: Cadence;
  minute: number;
  hour: number;
  weekday: number;
  cron: string;
  timezone: string;
  parameters: string;
  enabled: boolean;
}

const DEFAULT_TIMEZONE =
  typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai' : 'Asia/Shanghai';

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Build a 6-field seconds-first cron from the cadence form (matches the Coze default form). */
function cronFromForm(form: FormState): string {
  if (form.cadence === 'custom') return form.cron.trim();
  const m = Math.min(59, Math.max(0, form.minute));
  const h = Math.min(23, Math.max(0, form.hour));
  const d = Math.min(6, Math.max(0, form.weekday));
  if (form.cadence === 'hourly') return `0 ${m} * * * *`;
  if (form.cadence === 'daily') return `0 ${m} ${h} * * *`;
  return `0 ${m} ${h} * * ${d}`;
}

/** Parse a stored cron back into cadence fields so editing pre-fills the form. */
function formFromCron(cron: string): Pick<FormState, 'cadence' | 'minute' | 'hour' | 'weekday' | 'cron'> {
  const parts = cron.trim().split(/\s+/);
  // Normalize to [min, hour, dom, mon, dow] regardless of a leading seconds field.
  const fields = parts.length === 6 ? parts.slice(1) : parts;
  const base = { minute: 0, hour: 9, weekday: 1, cron };
  if (fields.length !== 5) return { cadence: 'custom', ...base };
  const min = fields[0] ?? '';
  const hour = fields[1] ?? '';
  const dom = fields[2] ?? '';
  const mon = fields[3] ?? '';
  const dow = fields[4] ?? '';
  const num = (v: string) => (/^\d+$/.test(v) ? Number(v) : null);
  const m = num(min);
  if (m === null || dom !== '*' || mon !== '*') return { cadence: 'custom', ...base };
  if (hour === '*' && dow === '*') return { cadence: 'hourly', minute: m, hour: 9, weekday: 1, cron };
  const h = num(hour);
  if (h === null) return { cadence: 'custom', ...base };
  if (dow === '*') return { cadence: 'daily', minute: m, hour: h, weekday: 1, cron };
  const d = num(dow);
  if (d === null) return { cadence: 'custom', ...base };
  return { cadence: 'weekly', minute: m, hour: h, weekday: d, cron };
}

function relativeTime(ms: number | null, locale: string): string {
  if (ms == null) return '';
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 3_600_000;
  const day = 86_400_000;
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (abs < minute) return rtf.format(Math.round(diff / 1000), 'second');
    if (abs < hour) return rtf.format(Math.round(diff / minute), 'minute');
    if (abs < day) return rtf.format(Math.round(diff / hour), 'hour');
    if (abs < day * 30) return rtf.format(Math.round(diff / day), 'day');
  } catch {
    /* fall through */
  }
  return new Date(ms).toLocaleDateString(locale);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const WEEKDAY_KEYS: Array<
  'schedules.sun' | 'schedules.mon' | 'schedules.tue' | 'schedules.wed' | 'schedules.thu' | 'schedules.fri' | 'schedules.sat'
> = [
  'schedules.sun',
  'schedules.mon',
  'schedules.tue',
  'schedules.wed',
  'schedules.thu',
  'schedules.fri',
  'schedules.sat',
];

function emptyForm(workflowRef = ''): FormState {
  return {
    triggerId: null,
    workflowRef,
    name: '',
    cadence: 'daily',
    minute: 0,
    hour: 9,
    weekday: 1,
    cron: '0 0 9 * * *',
    timezone: DEFAULT_TIMEZONE,
    parameters: '',
    enabled: true,
  };
}

export function MatOSSchedulesView() {
  const t = useT();
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en';
  const [data, setData] = useState<SchedulesPayload | null | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const resp = await fetch('/api/matos/schedules', { headers: { accept: 'application/json' } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setData((await resp.json()) as SchedulesPayload);
    } catch {
      setData((current) => current ?? null);
    }
  }, []);

  useEffect(() => {
    void refresh();
    timerRef.current = window.setInterval(() => void refresh(), 30_000);
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, [refresh]);

  const triggers = data?.triggers ?? [];
  const workflows = data?.workflows ?? [];
  const activeCount = triggers.filter((item) => item.enabled).length;
  const nextFire = triggers
    .filter((item) => item.enabled && item.nextFireAt != null)
    .map((item) => item.nextFireAt as number)
    .sort((a, b) => a - b)[0];

  const describeCron = useCallback(
    (cron: string): string => {
      const parsed = formFromCron(cron);
      const time = `${pad2(parsed.hour)}:${pad2(parsed.minute)}`;
      if (parsed.cadence === 'hourly') return t('schedules.cronHourly', { minute: pad2(parsed.minute) });
      if (parsed.cadence === 'daily') return t('schedules.cronDaily', { time });
      if (parsed.cadence === 'weekly') {
        return t('schedules.cronWeekly', { day: t(WEEKDAY_KEYS[parsed.weekday] ?? 'schedules.mon'), time });
      }
      return t('schedules.cronCustomLabel');
    },
    [t],
  );

  const openCreate = useCallback(() => {
    setFormError(null);
    setForm(emptyForm(workflows[0]?.ref ?? ''));
  }, [workflows]);

  const openEdit = useCallback((schedule: ScheduleSummary) => {
    setFormError(null);
    const parsed = formFromCron(schedule.cron);
    setForm({
      triggerId: schedule.triggerId,
      workflowRef: schedule.workflowRef,
      name: schedule.name,
      cadence: parsed.cadence,
      minute: parsed.minute,
      hour: parsed.hour,
      weekday: parsed.weekday,
      cron: schedule.cron,
      timezone: schedule.timezone ?? DEFAULT_TIMEZONE,
      parameters:
        schedule.parameters && Object.keys(schedule.parameters).length > 0
          ? JSON.stringify(schedule.parameters, null, 2)
          : '',
      enabled: schedule.enabled,
    });
  }, []);

  const submitForm = useCallback(async () => {
    if (!form) return;
    if (!form.workflowRef) {
      setFormError(t('schedules.errNoWorkflow'));
      return;
    }
    const cron = cronFromForm(form);
    if (!cron) {
      setFormError(t('schedules.errNoCron'));
      return;
    }
    let parameters: Record<string, unknown> = {};
    if (form.parameters.trim()) {
      try {
        const parsed = JSON.parse(form.parameters);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('not an object');
        }
        parameters = parsed as Record<string, unknown>;
      } catch {
        setFormError(t('schedules.errParams'));
        return;
      }
    }
    setSaving(true);
    setFormError(null);
    try {
      const resp = await fetch('/api/matos/schedules', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          triggerId: form.triggerId ?? undefined,
          workflowRef: form.workflowRef,
          name: form.name.trim() || undefined,
          cron,
          timezone: form.timezone.trim() || undefined,
          parameters,
          enabled: form.enabled,
        }),
      });
      if (resp.status === 422) {
        const body = (await resp.json()) as { validation?: { errors?: Array<{ message?: string }> } };
        setFormError(body.validation?.errors?.[0]?.message ?? t('schedules.errInvalidCron'));
        return;
      }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      setForm(null);
      await refresh();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [form, refresh, t]);

  const runNow = useCallback(
    async (schedule: ScheduleSummary) => {
      setBusyId(schedule.triggerId);
      try {
        await fetch(`/api/matos/schedules/${encodeURIComponent(schedule.triggerId)}/fire`, { method: 'POST' });
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const toggleEnabled = useCallback(
    async (schedule: ScheduleSummary) => {
      setBusyId(schedule.triggerId);
      try {
        await fetch('/api/matos/schedules', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            triggerId: schedule.triggerId,
            workflowRef: schedule.workflowRef,
            name: schedule.name,
            cron: schedule.cron,
            timezone: schedule.timezone ?? undefined,
            parameters: schedule.parameters,
            enabled: !schedule.enabled,
          }),
        });
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const removeSchedule = useCallback(
    async (schedule: ScheduleSummary) => {
      if (typeof window !== 'undefined' && !window.confirm(t('schedules.deleteConfirm', { name: schedule.name }))) {
        return;
      }
      setBusyId(schedule.triggerId);
      try {
        await fetch(`/api/matos/schedules/${encodeURIComponent(schedule.triggerId)}`, { method: 'DELETE' });
        await refresh();
      } finally {
        setBusyId(null);
      }
    },
    [refresh, t],
  );

  return (
    <section className="matos-sched" aria-labelledby="matos-sched-title" data-testid="matos-schedules-view">
      <header className="integrations-view__hero">
        <div>
          <p className="integrations-view__kicker">{t('schedules.kicker')}</p>
          <h1 id="matos-sched-title" className="entry-section__title">{t('schedules.title')}</h1>
          <p className="integrations-view__lede">{t('schedules.lede')}</p>
        </div>
        <div className="matos-sched__hero-side">
          {data ? (
            <span
              className={`matos-sched__pulse${data.autotick ? ' is-live' : ''}`}
              title={data.autotick ? t('schedules.autotickOn') : t('schedules.autotickOff')}
            >
              <span className="matos-sched__pulse-dot" aria-hidden />
              {data.autotick ? t('schedules.live') : t('schedules.autotickOff')}
            </span>
          ) : null}
          <button
            type="button"
            className="matos-ops__refresh"
            onClick={() => void refresh()}
            aria-label={t('schedules.refresh')}
            title={t('schedules.refresh')}
          >
            <Icon name="refresh" size={14} />
          </button>
          <button type="button" className="matos-sched__new" onClick={openCreate} disabled={!data}>
            <Icon name="plus" size={15} />
            <span>{t('schedules.new')}</span>
          </button>
        </div>
      </header>

      {data === null ? <div className="assets-view__error">{t('schedules.loadFailed')}</div> : null}

      <div className="matos-sched__stats" data-testid="matos-sched-stats">
        <SchedStat icon="clock" label={t('schedules.statTotal')} value={data ? `${triggers.length}` : '—'} />
        <SchedStat icon="play" label={t('schedules.statActive')} value={data ? `${activeCount}` : '—'} tone="accent" />
        <SchedStat
          icon="bell"
          label={t('schedules.statNextFire')}
          value={nextFire ? relativeTime(nextFire, locale) : data ? t('schedules.statNever') : '—'}
        />
      </div>

      {form ? (
        <ScheduleForm
          form={form}
          workflows={workflows}
          saving={saving}
          error={formError}
          onChange={setForm}
          onCancel={() => setForm(null)}
          onSubmit={() => void submitForm()}
          describeCron={describeCron}
        />
      ) : null}

      <div className="assets-panel matos-sched__panel">
        <div className="assets-panel__head">
          <h2>{t('schedules.listTitle')}</h2>
          <button
            type="button"
            className="plugins-home__linkbtn"
            onClick={() => navigate({ kind: 'home', view: 'ops' })}
          >
            {t('schedules.openOps')}
          </button>
        </div>
        {data === undefined ? (
          <p className="assets-panel__hint">{t('schedules.loading')}</p>
        ) : triggers.length === 0 ? (
          <div className="matos-sched__empty">
            <Icon name="clock" size={26} />
            <p className="matos-sched__empty-title">{t('schedules.empty')}</p>
            <p className="matos-sched__empty-body">{t('schedules.emptyBody')}</p>
            <button type="button" className="matos-sched__new" onClick={openCreate} disabled={!data}>
              <Icon name="plus" size={15} />
              <span>{t('schedules.new')}</span>
            </button>
          </div>
        ) : (
          <ul className="matos-sched__list">
            {triggers.map((schedule) => (
              <li key={schedule.triggerId} className={`matos-sched__card${schedule.enabled ? '' : ' is-paused'}`}>
                <div className="matos-sched__card-main">
                  <div className="matos-sched__card-head">
                    <span
                      className={`matos-sched__state matos-sched__state--${schedule.enabled ? 'on' : 'off'}`}
                      aria-hidden
                    />
                    <span className="matos-sched__name" title={schedule.name}>{schedule.name}</span>
                    <span className="matos-sched__wf" title={schedule.workflowRef}>
                      <Icon name="workflow" size={12} />
                      {schedule.workflowRef.replace(/^workflow:/, '')}
                    </span>
                  </div>
                  <div className="matos-sched__meta">
                    <span className="matos-sched__cadence">
                      <Icon name="reload" size={12} />
                      {describeCron(schedule.cron)}
                    </span>
                    <code className="matos-sched__cron">{schedule.cron}</code>
                    {schedule.timezone ? <span className="matos-sched__tz">{schedule.timezone}</span> : null}
                  </div>
                  <div className="matos-sched__facts">
                    <span className="matos-sched__fact">
                      <em>{t('schedules.nextFire')}</em>
                      {schedule.enabled
                        ? schedule.nextFireAt
                          ? (
                            <strong title={new Date(schedule.nextFireAt).toLocaleString(locale)}>
                              {relativeTime(schedule.nextFireAt, locale)}
                            </strong>
                          )
                          : <strong className="is-muted">{t('schedules.pendingArm')}</strong>
                        : <strong className="is-muted">{t('schedules.paused')}</strong>}
                    </span>
                    <span className="matos-sched__fact">
                      <em>{t('schedules.lastRun')}</em>
                      {schedule.lastFiredAt ? (
                        <strong title={new Date(schedule.lastFiredAt).toLocaleString(locale)}>
                          {relativeTime(schedule.lastFiredAt, locale)}
                        </strong>
                      ) : (
                        <strong className="is-muted">{t('schedules.neverRun')}</strong>
                      )}
                    </span>
                    {schedule.lastError ? (
                      <span className="matos-sched__fact matos-sched__fact--error" title={schedule.lastError}>
                        <Icon name="alert-triangle" size={12} />
                        {t('schedules.lastError')}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="matos-sched__actions">
                  <button
                    type="button"
                    className="matos-sched__act"
                    onClick={() => void runNow(schedule)}
                    disabled={busyId === schedule.triggerId}
                    title={t('schedules.runNowTitle')}
                  >
                    <Icon name="play" size={14} />
                    <span>{t('schedules.runNow')}</span>
                  </button>
                  <button
                    type="button"
                    className="matos-sched__act"
                    onClick={() => void toggleEnabled(schedule)}
                    disabled={busyId === schedule.triggerId}
                    title={schedule.enabled ? t('schedules.pause') : t('schedules.enable')}
                  >
                    <Icon name={schedule.enabled ? 'stop' : 'play'} size={14} />
                    <span>{schedule.enabled ? t('schedules.pause') : t('schedules.enable')}</span>
                  </button>
                  <button
                    type="button"
                    className="matos-sched__act"
                    onClick={() => openEdit(schedule)}
                    disabled={busyId === schedule.triggerId}
                    title={t('schedules.edit')}
                  >
                    <Icon name="edit" size={14} />
                  </button>
                  <button
                    type="button"
                    className="matos-sched__act matos-sched__act--danger"
                    onClick={() => void removeSchedule(schedule)}
                    disabled={busyId === schedule.triggerId}
                    title={t('schedules.delete')}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function SchedStat({
  icon,
  label,
  value,
  tone,
}: {
  icon: IconName;
  label: string;
  value: string;
  tone?: 'accent';
}) {
  return (
    <div className="matos-sched__stat" data-tone={tone ?? 'default'}>
      <div className="matos-sched__stat-head">
        <Icon name={icon} size={14} />
        <span>{label}</span>
      </div>
      <div className="matos-sched__stat-value">{value}</div>
    </div>
  );
}

function ScheduleForm({
  form,
  workflows,
  saving,
  error,
  onChange,
  onCancel,
  onSubmit,
  describeCron,
}: {
  form: FormState;
  workflows: WorkflowOption[];
  saving: boolean;
  error: string | null;
  onChange: (next: FormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
  describeCron: (cron: string) => string;
}) {
  const t = useT();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => onChange({ ...form, [key]: value });
  const preview = describeCron(cronFromForm(form));
  const isEdit = form.triggerId !== null;

  return (
    <div className="assets-panel matos-sched__form" data-testid="matos-sched-form">
      <div className="assets-panel__head">
        <h2>{isEdit ? t('schedules.formEditTitle') : t('schedules.formNewTitle')}</h2>
      </div>
      <div className="matos-sched__form-grid">
        <label className="matos-sched__field matos-sched__field--wide">
          <span>{t('schedules.fieldWorkflow')}</span>
          {workflows.length > 0 ? (
            <select value={form.workflowRef} onChange={(e) => set('workflowRef', e.target.value)} disabled={isEdit}>
              <option value="" disabled>{t('schedules.pickWorkflow')}</option>
              {workflows.map((wf) => (
                <option key={wf.ref} value={wf.ref}>{wf.name}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={form.workflowRef}
              placeholder="workflow:my-flow@1.0.0"
              onChange={(e) => set('workflowRef', e.target.value)}
              disabled={isEdit}
            />
          )}
        </label>
        <label className="matos-sched__field matos-sched__field--wide">
          <span>{t('schedules.fieldName')}</span>
          <input
            type="text"
            value={form.name}
            placeholder={t('schedules.namePlaceholder')}
            onChange={(e) => set('name', e.target.value)}
          />
        </label>
        <label className="matos-sched__field">
          <span>{t('schedules.fieldCadence')}</span>
          <select value={form.cadence} onChange={(e) => set('cadence', e.target.value as Cadence)}>
            <option value="hourly">{t('schedules.cadenceHourly')}</option>
            <option value="daily">{t('schedules.cadenceDaily')}</option>
            <option value="weekly">{t('schedules.cadenceWeekly')}</option>
            <option value="custom">{t('schedules.cadenceCustom')}</option>
          </select>
        </label>
        {form.cadence === 'weekly' ? (
          <label className="matos-sched__field">
            <span>{t('schedules.fieldWeekday')}</span>
            <select value={form.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
              {WEEKDAY_KEYS.map((key, index) => (
                <option key={key} value={index}>{t(key)}</option>
              ))}
            </select>
          </label>
        ) : null}
        {form.cadence === 'hourly' ? (
          <label className="matos-sched__field">
            <span>{t('schedules.fieldMinute')}</span>
            <input
              type="number"
              min={0}
              max={59}
              value={form.minute}
              onChange={(e) => set('minute', Number(e.target.value))}
            />
          </label>
        ) : null}
        {form.cadence === 'daily' || form.cadence === 'weekly' ? (
          <label className="matos-sched__field">
            <span>{t('schedules.fieldTime')}</span>
            <input
              type="time"
              value={`${pad2(form.hour)}:${pad2(form.minute)}`}
              onChange={(e) => {
                const parts = e.target.value.split(':');
                const h = Number(parts[0]);
                const m = Number(parts[1]);
                onChange({
                  ...form,
                  hour: Number.isFinite(h) ? h : form.hour,
                  minute: Number.isFinite(m) ? m : form.minute,
                });
              }}
            />
          </label>
        ) : null}
        {form.cadence === 'custom' ? (
          <label className="matos-sched__field matos-sched__field--wide">
            <span>{t('schedules.fieldCron')}</span>
            <input
              type="text"
              value={form.cron}
              placeholder="0 0 3 * * *"
              onChange={(e) => set('cron', e.target.value)}
            />
            <small className="matos-sched__hint">{t('schedules.cronHint')}</small>
          </label>
        ) : null}
        <label className="matos-sched__field">
          <span>{t('schedules.fieldTimezone')}</span>
          <input type="text" value={form.timezone} onChange={(e) => set('timezone', e.target.value)} />
        </label>
        <label className="matos-sched__field matos-sched__field--wide">
          <span>{t('schedules.fieldParams')}</span>
          <textarea
            rows={3}
            value={form.parameters}
            placeholder='{"structure": "cu.cif"}'
            onChange={(e) => set('parameters', e.target.value)}
          />
          <small className="matos-sched__hint">{t('schedules.paramsHint')}</small>
        </label>
      </div>
      <div className="matos-sched__form-foot">
        <span className="matos-sched__preview">
          <Icon name="clock" size={13} />
          {preview}
        </span>
        {error ? <span className="matos-sched__form-error">{error}</span> : null}
        <div className="matos-sched__form-actions">
          <button type="button" className="matos-sched__btn" onClick={onCancel} disabled={saving}>
            {t('schedules.cancel')}
          </button>
          <button type="button" className="matos-sched__btn matos-sched__btn--primary" onClick={onSubmit} disabled={saving}>
            {saving ? t('schedules.saving') : t('schedules.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
