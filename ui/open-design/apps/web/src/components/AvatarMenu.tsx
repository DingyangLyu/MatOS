import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n';
import { AgentIcon } from './AgentIcon';
import { RemixIcon } from './RemixIcon';
import { orderAgentsWithOpenDesignFirst } from './agentOrdering';
import { SearchableModelSelect } from './modelOptions';
import type { AgentInfo, AppConfig } from '../types';
import { isVisibleLocalCliAgent } from '../utils/visibleAgents';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  onAgentChange: (id: string) => void;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onOpenSettings: (section?: 'execution') => void;
  onRefreshAgents: () => void;
  onBack?: () => void;
  placement?: 'down' | 'up';
  /** Fired when the dropdown transitions from closed to open. */
  onOpen?: () => void;
}

function displayAgentName(agent: Pick<AgentInfo, 'id' | 'name'>): string {
  return agent.name;
}

/**
 * Compact runtime control. Click opens a dropdown with the agent picker and
 * its model/reasoning choices.
 */
export function AvatarMenu({
  config,
  agents,
  onAgentChange,
  onAgentModelChange,
  onOpenSettings,
  onRefreshAgents,
  onBack,
  placement = 'down',
  onOpen,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Toggle that notifies only on the closed→open transition, not on close.
  function toggleOpen() {
    setOpen((v) => {
      if (!v) onOpen?.();
      return !v;
    });
  }
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverStyle, setPopoverStyle] = useState<CSSProperties | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const margin = 16;
      const gap = 8;
      const width = Math.min(320, window.innerWidth - margin * 2);
      const left = Math.min(
        Math.max(rect.left + rect.width / 2 - width / 2, margin),
        window.innerWidth - width - margin,
      );

      if (placement === 'up') {
        const available = Math.max(160, rect.top - margin - gap);
        setPopoverStyle({
          position: 'fixed',
          top: 'auto',
          bottom: Math.max(margin, window.innerHeight - rect.top + gap),
          left,
          right: 'auto',
          width,
          maxHeight: Math.min(520, available),
          overflowY: 'auto',
          zIndex: 1000,
        });
        return;
      }

      const top = rect.bottom + gap;
      const available = Math.max(160, window.innerHeight - top - margin);
      setPopoverStyle({
        position: 'fixed',
        top,
        bottom: 'auto',
        left,
        right: 'auto',
        width,
        maxHeight: Math.min(520, available),
        overflowY: 'auto',
        zIndex: 1000,
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, placement]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );

  const installedAgents = orderAgentsWithOpenDesignFirst(
    agents.filter((a) => a.available && isVisibleLocalCliAgent(a, {})),
  );

  // Resolve the user's model + reasoning pick for the active agent. Falls
  // back to the agent's first declared option (`'default'`) when the user
  // hasn't touched the picker yet so the labels don't read as empty.
  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const currentModelId =
    currentChoice.model ?? currentAgent?.models?.[0]?.id ?? null;
  const currentReasoningId =
    currentChoice.reasoning ?? currentAgent?.reasoningOptions?.[0]?.id ?? null;
  const currentModelLabel = currentAgent?.models?.find(
    (m) => m.id === currentModelId,
  )?.label;

  return (
    <div className={`avatar-menu avatar-menu--${placement}`} ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="avatar-agent-trigger"
        onClick={toggleOpen}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tooltip={t('avatar.title')}
        title={t('avatar.title')}
        aria-label={t('avatar.title')}
      >
        {currentAgent ? (
          <AgentIcon id={currentAgent.id} size={20} />
        ) : (
          <RemixIcon name="link" size={20} />
        )}
        <RemixIcon name="arrow-down-s-line" size={14} />
      </button>
      {open && popoverStyle ? createPortal(
        <div
          ref={popoverRef}
          className="avatar-popover"
          role="dialog"
          aria-label={t('avatar.title')}
          style={popoverStyle}
        >
          <div className="avatar-popover-head">
            <span className="who">{t('avatar.localCli')}</span>
            <span className="where">
              {currentAgent
                ? `${displayAgentName(currentAgent)}${
                    currentAgent.version
                      ? ` · ${currentAgent.version}`
                      : ''
                  }${
                    currentModelLabel && currentModelId !== 'default'
                      ? ` · ${currentModelLabel}`
                      : ''
                  }`
                : t('avatar.noAgentSelected')}
            </span>
          </div>
          {installedAgents.length > 0 ? (
            <>
              <div className="avatar-section-label">{t('avatar.codeAgent')}</div>
              {installedAgents.map((a) => {
                const selected = config.agentId === a.id;
                // MatOS row carries the account (balance + plan) inline,
                // plus Upgrade and Console actions, so it is a container rather
                // than a single select button (which can't nest buttons/links).
                return (
                  <button
                    type="button"
                    key={a.id}
                    className={`avatar-item${selected ? ' active' : ''}`}
                    data-testid={`avatar-agent-option-${a.id}`}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => {
                      onAgentChange(a.id);
                      // Keep the popover open so the user can immediately
                      // pick a model for the agent they just chose.
                    }}
                  >
                    <AgentIcon id={a.id} size={18} />
                    <span>{displayAgentName(a)}</span>
                    {a.version ? (
                      <span className="avatar-item-meta">{a.version}</span>
                    ) : null}
                  </button>
                );
              })}
              {currentAgent &&
              currentAgent.available &&
              ((currentAgent.models && currentAgent.models.length > 0) ||
                (currentAgent.reasoningOptions &&
                  currentAgent.reasoningOptions.length > 0)) ? (
                <div className="avatar-model-section">
                  {currentAgent.models && currentAgent.models.length > 0 ? (
                    <label className="avatar-select-row">
                      <span className="avatar-select-label">
                        {t('avatar.modelLabel')}
                      </span>
                      <SearchableModelSelect
                        className="inline-switcher__select avatar-select"
                        value={currentModelId ?? ''}
                        onChange={(value) =>
                          onAgentModelChange(currentAgent.id, {
                            model: value,
                          })
                        }
                        models={currentAgent.models}
                        additionalOptions={
                          currentModelId &&
                          !currentAgent.models.some((m) => m.id === currentModelId)
                            ? [
                                {
                                  value: currentModelId,
                                  label: `${currentModelId} ${t('avatar.customSuffix')}` ,
                                },
                              ]
                            : undefined
                        }
                        searchPlaceholder={t('newproj.modelSearch')}
                        searchInputTestId="avatar-model-search"
                        popoverTestId="avatar-model-popover"
                        minSearchableOptions={5}
                      />
                    </label>
                  ) : null}
                  {currentAgent.reasoningOptions &&
                  currentAgent.reasoningOptions.length > 0 ? (
                    <label className="avatar-select-row">
                      <span className="avatar-select-label">
                        {t('avatar.reasoningLabel')}
                      </span>
                      <select
                        className="avatar-select"
                        value={currentReasoningId ?? ''}
                        onChange={(e) =>
                          onAgentModelChange(currentAgent.id, {
                            reasoning: e.target.value,
                          })
                        }
                      >
                        {currentAgent.reasoningOptions.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                className="avatar-item"
                onClick={() => {
                  onRefreshAgents();
                }}
              >
                <span className="avatar-item-icon" aria-hidden>
                  <RemixIcon name="refresh-line" size={15} />
                </span>
                <span>{t('avatar.rescan')}</span>
              </button>
            </>
          ) : null}

          <div style={{ height: 1, background: 'var(--border-soft)', margin: '4px 6px' }} />

          <button
            type="button"
            className="avatar-item avatar-item--execution-settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings('execution');
            }}
          >
            <span className="avatar-item-icon" aria-hidden>
              <RemixIcon name="settings-3-line" size={15} />
            </span>
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>

          {onBack ? (
            <>
              <button
                type="button"
                className="avatar-item"
                onClick={() => {
                  setOpen(false);
                  onBack();
                }}
              >
                <span className="avatar-item-icon" aria-hidden>
                  <RemixIcon name="arrow-left-line" size={15} />
                </span>
                <span>{t('avatar.backToProjects')}</span>
              </button>
            </>
          ) : null}
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
