// InlineModelSwitcher — top-bar chip exposing the MatOS CLI role/model and
// reasoning effort.
//
// Lives in the entry view's sticky top-bar so users can change the active
// role/model without opening the full Settings dialog. The chip shows the
// runtime + agent + model in one line and opens a compact popover. All
// persistence is delegated upward through the same callbacks `AvatarMenu`
// uses, so the switcher inherits autosave + daemon sync.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../i18n';
import type { AgentInfo, AppConfig } from '../types';
import { AgentIcon } from './AgentIcon';
import { Icon } from './Icon';
import { normalizeAgentModelChoice } from './agentModelSelection';
import { SearchableModelSelect } from './modelOptions';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  compact?: boolean;
  onAgentModelChange: (
    id: string,
    choice: { model?: string; reasoning?: string },
  ) => void;
  onOpenSettings: (section?: 'execution') => void;
}

export function InlineModelSwitcher({
  config,
  agents,
  compact = false,
  onAgentModelChange,
  onOpenSettings,
}: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      const target = e.target as Node;
      if (wrapRef.current.contains(target)) return;
      // The model picker renders its option list in a portal on
      // `document.body`; a click on an option must not close the panel first.
      if (
        target instanceof Element &&
        target.closest('.model-select-searchable__popover')
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const currentAgent = useMemo(
    () => agents.find((a) => a.id === config.agentId) ?? null,
    [agents, config.agentId],
  );
  const currentChoice =
    (config.agentId && config.agentModels?.[config.agentId]) || {};
  const normalizedCurrentChoice = normalizeAgentModelChoice(
    currentAgent,
    currentChoice,
  );
  const currentAgentId = currentAgent?.id ?? null;
  const normalizedCurrentModelId = normalizedCurrentChoice?.model ?? null;
  const normalizedCurrentReasoning = normalizedCurrentChoice?.reasoning;
  const currentModelId =
    (typeof currentChoice.model === 'string' && currentChoice.model) ||
    currentAgent?.models?.[0]?.id ||
    null;

  useEffect(() => {
    if (!currentAgentId || !normalizedCurrentModelId) return;
    onAgentModelChange(currentAgentId, {
      model: normalizedCurrentModelId,
      reasoning: normalizedCurrentReasoning,
    });
  }, [
    currentAgentId,
    normalizedCurrentModelId,
    normalizedCurrentReasoning,
    onAgentModelChange,
  ]);

  const currentModelLabel =
    currentAgent?.models?.find((m) => m.id === currentModelId)?.label ?? null;
  const chipMode = t('inlineSwitcher.chipCli');
  const chipPrimary = currentAgent ? currentAgent.name : t('inlineSwitcher.noAgent');
  const chipModel =
    currentModelLabel && currentModelId !== 'default'
      ? currentModelLabel
      : t('inlineSwitcher.modelDefault');

  const handleChipClick = useCallback(() => setOpen((value) => !value), []);

  return (
    <div
      className={`inline-switcher${compact ? ' inline-switcher--compact' : ''}`}
      ref={wrapRef}
      data-testid="inline-model-switcher"
    >
      <button
        type="button"
        className="inline-switcher__chip od-tooltip"
        data-testid="inline-model-switcher-chip"
        onClick={handleChipClick}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${chipMode} · ${chipPrimary} · ${chipModel}`}
        data-tooltip={`${chipMode} · ${chipPrimary} · ${chipModel}`}
        data-tooltip-placement="bottom"
      >
        <span className="inline-switcher__chip-icon" aria-hidden="true">
          {currentAgent ? (
            <AgentIcon id={currentAgent.id} size={18} />
          ) : (
            <Icon name="link" size={12} />
          )}
        </span>
        <span className="inline-switcher__chip-text">
          <span className="inline-switcher__chip-mode">{chipMode}</span>
          <span className="inline-switcher__chip-sep" aria-hidden="true">
            ·
          </span>
          <span className="inline-switcher__chip-primary">{chipPrimary}</span>
          <span className="inline-switcher__chip-sep" aria-hidden="true">
            ·
          </span>
          <span className="inline-switcher__chip-model">{chipModel}</span>
        </span>
        <Icon
          name="chevron-down"
          size={12}
          className="inline-switcher__chip-chevron"
        />
      </button>

      {open ? (
        <div
          className="inline-switcher__popover"
          role="menu"
          data-testid="inline-model-switcher-popover"
        >
          {!currentAgent ? (
            <div className="inline-switcher__row">
              <span className="inline-switcher__hint">
                {t('inlineSwitcher.noAgentsDetected')}
              </span>
            </div>
          ) : null}
          {currentAgent && currentAgent.models && currentAgent.models.length > 0 ? (
            <div className="inline-switcher__row">
              <span className="inline-switcher__label">
                {t('inlineSwitcher.modelLabel')}
              </span>
              <SearchableModelSelect
                className="inline-switcher__select"
                data-testid="inline-model-switcher-agent-model"
                searchInputTestId="inline-model-switcher-agent-model-search"
                popoverTestId="inline-model-switcher-agent-model-popover"
                searchPlaceholder={t('designs.searchPlaceholder')}
                aria-label={t('inlineSwitcher.modelLabel')}
                models={currentAgent.models}
                value={currentModelId ?? ''}
                onChange={(nextValue) => {
                                    onAgentModelChange(currentAgent.id, { model: nextValue });
                }}
                additionalOptions={
                  currentModelId &&
                  !currentAgent.models.some((m) => m.id === currentModelId)
                    ? [
                        {
                          value: currentModelId,
                          label: `${currentModelId} ${t('inlineSwitcher.customSuffix')}`,
                        },
                      ]
                    : undefined
                }
              />
            </div>
          ) : null}
          {currentAgent &&
          currentAgent.reasoningOptions &&
          currentAgent.reasoningOptions.length > 0 ? (
            <div className="inline-switcher__row">
              <span className="inline-switcher__label">
                {t('avatar.reasoningLabel')}
              </span>
              <select
                className="inline-switcher__select"
                data-testid="inline-model-switcher-agent-reasoning"
                aria-label={t('avatar.reasoningLabel')}
                value={
                  currentChoice.reasoning ??
                  currentAgent.reasoningOptions[0]?.id ??
                  ''
                }
                onChange={(e) => {
                                    onAgentModelChange(currentAgent.id, { reasoning: e.target.value });
                }}
              >
                {currentAgent.reasoningOptions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <button
            type="button"
            className="inline-switcher__more"
            data-testid="inline-model-switcher-open-settings"
            onClick={() => {
                            setOpen(false);
              onOpenSettings('execution');
            }}
          >
            <Icon name="settings" size={13} />
            <span>{t('inlineSwitcher.openFullSettings')}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
