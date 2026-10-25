import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppConfig } from '../types';
import { Icon } from './Icon';
import { McpClientSection } from './McpClientSection';
import { UseEverywhereGuidePanel } from './UseEverywhereModal';
import { useT } from '../i18n';

// MatOS: the Skills tab is gone from Integrations — skills are native MatOS
// assets managed in the Assets workbench (/assets), not an integration.
export type IntegrationTab = 'mcp' | 'use-everywhere';

interface Props {
  config: AppConfig;
  initialTab?: IntegrationTab;
  onConfigPersist: (config: AppConfig) => Promise<void> | void;
  onSkillsRefresh?: () => Promise<void> | void;
  onSkillsChanged?: (affectedSkillId?: string) => void;
}

const INTEGRATION_TABS: ReadonlyArray<{
  id: IntegrationTab;
}> = [
  { id: 'mcp' },
  { id: 'use-everywhere' },
];

export function IntegrationsView({
  config,
  initialTab = 'mcp',
  onConfigPersist,
}: Props) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<IntegrationTab>(initialTab);
  const [localConfig, setLocalConfig] = useState<AppConfig>(config);
  const localConfigRef = useRef(localConfig);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    localConfigRef.current = config;
    setLocalConfig(config);
  }, [config]);

  const updateLocalConfig = useCallback<Dispatch<SetStateAction<AppConfig>>>(
    (nextConfig) => {
      const base = localConfigRef.current;
      const resolved =
        typeof nextConfig === 'function'
          ? (nextConfig as (current: AppConfig) => AppConfig)(base)
          : nextConfig;
      localConfigRef.current = resolved;
      setLocalConfig(resolved);
      void onConfigPersist(resolved);
    },
    [onConfigPersist],
  );

  const liveDaemonUrl =
    typeof window !== 'undefined' ? window.location.origin : undefined;

  return (
    <section className="integrations-view" aria-labelledby="integrations-title">
      <header className="integrations-view__hero">
        <div>
          <p className="integrations-view__kicker">{t('integrations.kicker')}</p>
          <h1 id="integrations-title" className="entry-section__title">
            {t('entry.navIntegrations')}
          </h1>
          <p className="integrations-view__lede">
            {t('integrations.lede')}
          </p>
        </div>
        <div className="integrations-view__badge" aria-hidden="true">
          <Icon name="link" size={15} />
          <span>{t('integrations.agentReady')}</span>
        </div>
      </header>

      <nav
        className="integrations-view__tabs"
        role="tablist"
        aria-label={t('integrations.areasAria')}
      >
        {INTEGRATION_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              className={`integrations-view__tab${active ? ' is-active' : ''}`}
              onClick={() => {
                                setActiveTab(tab.id);
              }}
              data-testid={`integrations-tab-${tab.id}`}
            >
              <span className="integrations-view__tab-label">{integrationTabLabel(tab.id, t)}</span>
              <span className="integrations-view__tab-hint">{integrationTabHint(tab.id, t)}</span>
            </button>
          );
        })}
      </nav>

      <div className="integrations-view__panel">
        {activeTab === 'mcp' ? <McpClientSection /> : null}

        {activeTab === 'use-everywhere' ? (
          <div className="integrations-view__use-everywhere">
            <UseEverywhereGuidePanel
              onOpenSettings={() => setActiveTab('mcp')}
              {...(liveDaemonUrl ? { daemonUrl: liveDaemonUrl } : {})}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function integrationTabLabel(id: IntegrationTab, t: ReturnType<typeof useT>): string {
  switch (id) {
    case 'mcp': return t('integrations.tabLabel.mcp');
    case 'use-everywhere': return t('entry.useEverywhereTitle');
  }
}

function integrationTabHint(id: IntegrationTab, t: ReturnType<typeof useT>): string {
  switch (id) {
    case 'mcp': return t('integrations.tabHint.mcp');
    case 'use-everywhere': return t('integrations.tabHint.useEverywhere');
  }
}
