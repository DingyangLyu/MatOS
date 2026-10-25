/**
 * MatOS provider-model picker — the web equivalent of the CLI `/model`
 * command. Renders as a compact pill next to the role picker; the popover
 * lists the native provider catalog (`matos workbench models list` via the
 * daemon bridge). Picking a model persists per project and reaches the CLI
 * as `--model <id>` on every following run; "Default" clears the override so
 * the deployment default applies again.
 *
 * A role decides prompts/tools/skills composition; this decides the
 * underlying LLM. Keeping them as two pills preserves that mental model.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '../i18n';
import { Icon } from './Icon';
import { fetchMatOSModels, type MatOSModelOption } from '../runtime/matos-models';

interface PopoverAnchor {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
}

interface Props {
  /** Persisted `--model` override; null = deployment default. */
  selectedModelId: string | null;
  onChange: (id: string | null) => void;
}

export function MatOSModelPicker({ selectedModelId, onChange }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<MatOSModelOption[] | null>(null);
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMatOSModels().then((catalog) => {
      if (!cancelled) setModels(catalog);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Same viewport-aware anchoring as the role picker: the trigger sits in the
  // row below the composer, so the popover usually opens upward.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;
    function updateAnchor() {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.innerWidth;
      const popoverWidth = Math.min(360, Math.max(260, viewport - 24));
      const left = Math.max(8, Math.min(viewport - popoverWidth - 8, rect.left));
      const gap = 6;
      const margin = 12;
      const spaceBelow = window.innerHeight - rect.bottom - gap - margin;
      const spaceAbove = rect.top - gap - margin;
      const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
      if (openUp) {
        setAnchor({
          bottom: window.innerHeight - rect.top + gap,
          left,
          width: popoverWidth,
          maxHeight: Math.max(180, Math.min(360, spaceAbove)),
        });
      } else {
        setAnchor({
          top: rect.bottom + gap,
          left,
          width: popoverWidth,
          maxHeight: Math.max(180, Math.min(360, spaceBelow)),
        });
      }
    }
    updateAnchor();
    window.addEventListener('resize', updateAnchor);
    window.addEventListener('scroll', updateAnchor, true);
    return () => {
      window.removeEventListener('resize', updateAnchor);
      window.removeEventListener('scroll', updateAnchor, true);
    };
  }, [open]);

  const options = useMemo(() => {
    const catalog = models ?? [];
    // Ensure a persisted override the catalog no longer lists still renders
    // (and can be cleared) instead of silently displaying "Default".
    if (
      selectedModelId &&
      !catalog.some((option) => option.id === selectedModelId)
    ) {
      return [
        ...catalog,
        {
          id: selectedModelId,
          label: selectedModelId,
          description: '',
          isDefault: false,
        },
      ];
    }
    return catalog;
  }, [models, selectedModelId]);

  const selected = useMemo(
    () => options.find((option) => option.id !== null && option.id === selectedModelId) ?? null,
    [options, selectedModelId],
  );

  // Hide entirely when the catalog is unavailable and nothing is selected —
  // never advertise a picker that cannot list anything.
  if ((models === null || models.length === 0) && !selectedModelId) return null;

  const pick = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  const popover =
    open && anchor && typeof document !== 'undefined'
      ? createPortal(
          <div
            ref={popoverRef}
            className="project-ds-picker-popover matos-model-picker-popover"
            data-testid="matos-model-picker-popover"
            data-placement={anchor.bottom !== undefined ? 'up' : 'down'}
            style={{
              top: anchor.top,
              bottom: anchor.bottom,
              left: anchor.left,
              width: anchor.width,
              maxHeight: anchor.maxHeight,
            }}
          >
            <div className="matos-model-picker-list" role="listbox">
              {options.map((option) => {
                const active =
                  option.id === null ? selectedModelId === null : option.id === selectedModelId;
                return (
                  <button
                    key={option.id ?? '__default__'}
                    type="button"
                    className={`project-ds-picker-option${active ? ' active' : ''}`}
                    role="option"
                    aria-selected={active}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      pick(option.id);
                    }}
                    data-testid={`matos-model-picker-option-${option.id ?? 'default'}`}
                  >
                    <div className="project-ds-picker-option-head">
                      <span className="project-ds-picker-option-title">{option.label}</span>
                      {active ? (
                        <span className="project-ds-picker-option-check">
                          <Icon name="check" size={13} strokeWidth={2} />
                        </span>
                      ) : null}
                    </div>
                    {option.description ? (
                      <div className="matos-model-picker-option-desc">{option.description}</div>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <div
      ref={wrapRef}
      className="home-hero__ds-row-picker"
      data-testid="matos-model-picker"
    >
      <button
        ref={triggerRef}
        type="button"
        className="home-hero__ds-row-trigger"
        data-testid="matos-model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.label ?? t('matosModelPicker.defaultTitle')}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="server" size={12} className="home-hero__ds-row-trigger-icon" />
        <span className="home-hero__ds-row-trigger-label">
          {selected?.label ?? t('matosModelPicker.defaultTitle')}
        </span>
        <Icon name="chevron-down" size={11} className="home-hero__ds-row-trigger-chevron" />
      </button>
      {popover}
    </div>
  );
}
