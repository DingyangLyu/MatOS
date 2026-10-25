// MatOS first-run welcome.
//
// Replaces the upstream runtime-connection onboarding (AMR cloud sign-in /
// local CLI scan / BYOK wizard) with MatOS semantics: on a MatOS gateway
// deployment the agent runtime is already provisioned (the `matos` CLI with
// the user's roles and scoped assets), so a new user needs orientation, not
// provider setup. Visuals reuse the upstream cloud-landing shell
// (`onboarding-view--cloud`, `onboarding-cloud__*`) plus a small capability
// card grid; the upstream OnboardingView stays in-tree but unrouted.

import { useMemo } from 'react';
import type { AgentInfo, AppConfig, AppTheme } from '../types';
import { useI18n, useT } from '../i18n';
import type { Route } from '../router';
import { Icon, type IconName } from './Icon';
import { LanguageMenu } from './LanguageMenu';
import { MatOSByokProviderCard } from './MatOSByokProviderCard';
import { MATOS_PRODUCT_NAME } from '../branding';

interface Props {
  config: AppConfig;
  agents: AgentInfo[];
  onAgentChange: (id: string) => void;
  onThemeChange: (theme: AppTheme) => void;
  /** Mark onboarding complete, then open a web route or the default home. */
  onComplete: (target?: Route) => void;
}

const CAPABILITY_CARDS: Array<{
  id: string;
  icon: IconName;
  target: Route;
}> = [
  { id: 'chat', icon: 'sparkles', target: { kind: 'home', view: 'home' } },
  { id: 'assets', icon: 'blocks', target: { kind: 'home', view: 'assets', assetRef: null } },
];

export function MatOSOnboardingView({
  config,
  agents,
  onAgentChange,
  onThemeChange,
  onComplete,
}: Props) {
  const t = useT();
  const { locale } = useI18n();
  const activeTheme: AppTheme = config.theme ?? 'system';
  const resolvedDark =
    activeTheme === 'dark' ||
    (activeTheme === 'system' &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  const themeIcon: 'sun' | 'moon' = resolvedDark ? 'moon' : 'sun';

  // The MatOS runtime is preprovisioned on gateway deployments; selecting it
  // here means the first chat run needs zero further setup.
  const matosAgent = useMemo(
    () => agents.find((agent) => agent.id === 'matos'),
    [agents],
  );

  const adoptMatOSRuntime = () => {
    if (matosAgent) {
      onAgentChange('matos');
    }
  };

  return (
    <section
      className="onboarding-view onboarding-view--cloud matos-onboarding"
      aria-label={t('matosOnboarding.title')}
      data-testid="matos-onboarding"
    >
      <div className="onboarding-cloud__topbar">
        <LanguageMenu compact placement="down" align="end" />
        <button
          type="button"
          className="onboarding-cloud__theme"
          aria-label={resolvedDark ? t('settings.themeLight') : t('settings.themeDark')}
          title={resolvedDark ? t('settings.themeLight') : t('settings.themeDark')}
          onClick={() => onThemeChange(resolvedDark ? 'light' : 'dark')}
        >
          <Icon name={themeIcon} size={25} />
        </button>
      </div>

      <div className="onboarding-cloud__center matos-onboarding__center">
        <span className="onboarding-cloud__logo" role="img" aria-label={MATOS_PRODUCT_NAME} />
        <h1 className="onboarding-cloud__title">{t('matosOnboarding.title')}</h1>
        <p className="onboarding-cloud__body">{t('matosOnboarding.body')}</p>

        <div
          className="matos-onboarding__cards"
          role="list"
          aria-label={t('matosOnboarding.cardsAria')}
        >
          {CAPABILITY_CARDS.map((card) => (
            <button
              key={card.id}
              type="button"
              role="listitem"
              className="matos-onboarding__card"
              onClick={() => {
                adoptMatOSRuntime();
                onComplete(card.target);
              }}
              data-testid={`matos-onboarding-card-${card.id}`}
            >
              <span className="matos-onboarding__card-icon">
                <Icon name={card.icon} size={17} />
              </span>
              <span className="matos-onboarding__card-text">
                <strong>{t(`matosOnboarding.${card.id}.title` as never)}</strong>
                <em>{t(`matosOnboarding.${card.id}.hint` as never)}</em>
              </span>
            </button>
          ))}
        </div>

        {/* A fresh single-user install has no model key yet; the first
            task would fail without one. An administrator-configured key shows
            here as the deployment default and this step can be skipped. */}
        <div className="matos-onboarding__connect" data-testid="matos-onboarding-connect">
          <h2>{t('matosOnboarding.connectTitle')}</h2>
          <p>{t('matosOnboarding.connectHint')}</p>
          <MatOSByokProviderCard locale={locale} />
        </div>

        <button
          type="button"
          className="onboarding-cloud__primary"
          onClick={() => {
            adoptMatOSRuntime();
            onComplete();
          }}
          data-testid="matos-onboarding-start"
        >
          <Icon name="sparkles" size={17} />
          <span>{t('matosOnboarding.start')}</span>
        </button>

      </div>

      <footer className="onboarding-cloud__footer">
        © {new Date().getFullYear()} MatOS · {t('settings.onboardingCloudRights')}
      </footer>
    </section>
  );
}
