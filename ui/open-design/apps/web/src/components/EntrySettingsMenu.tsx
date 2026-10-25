import {
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  LOCALE_LABEL,
  LOCALES,
  useI18n,
  useT,
  type Locale,
} from '../i18n';
import type { AppConfig, AppTheme } from '../types';
import { Icon } from './Icon';

export type EntrySettingsSection =
  | 'execution'
  | 'media'
  | 'mcpClient'
  | 'language'
  | 'appearance'
  | 'notifications'
  | 'projectLocations'
  | 'library'
  | 'about';

const ENTRY_THEME_OPTIONS: Array<{
  value: AppTheme;
  icon: 'sun-moon' | 'sun' | 'moon';
  labelKey: 'settings.themeSystem' | 'settings.themeLight' | 'settings.themeDark';
}> = [
  { value: 'system', icon: 'sun-moon', labelKey: 'settings.themeSystem' },
  { value: 'light', icon: 'sun', labelKey: 'settings.themeLight' },
  { value: 'dark', icon: 'moon', labelKey: 'settings.themeDark' },
];

interface Props {
  config: AppConfig;
  onThemeChange: (theme: AppTheme) => void;
  onOpenSettings: (section?: EntrySettingsSection) => void;
}

export function EntrySettingsMenu({
  config,
  onThemeChange,
  onOpenSettings,
}: Props) {
  const t = useT();
  const { locale, setLocale } = useI18n();
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const langListRef = useRef<HTMLDivElement | null>(null);
  const activeTheme = config.theme ?? 'system';

  useEffect(() => {
    if (!open) setLangOpen(false);
  }, [open]);

  // Keep the collapsed language list out of the a11y tree and tab order so the
  // popover stays a single, consistent menu model even though the options stay
  // mounted for the expand/collapse animation.
  useEffect(() => {
    const el = langListRef.current;
    if (!el) return;
    if (langOpen) el.removeAttribute('inert');
    else el.setAttribute('inert', '');
  }, [langOpen, open]);

  useEffect(() => {
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
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

  return (
    <div className="entry-settings-menu" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        className="settings-icon-btn od-tooltip"
        onClick={() => {
          setOpen((value) => !value);
        }}
        title={t('entry.openSettingsTitle')}
        data-tooltip={t('entry.openSettingsTitle')}
        data-tooltip-placement="bottom"
        aria-label={t('entry.openSettingsAria')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="entry-settings-menu-trigger"
      >
        <Icon name="settings" size={17} />
      </button>
      {open ? (
        <div
          className="entry-settings-menu__popover"
          role="menu"
          aria-label={t('entry.openSettingsTitle')}
          data-testid="entry-settings-menu"
        >
          <section className="entry-settings-menu__section">
            <div className="entry-settings-menu__section-title">
              <Icon name="languages" size={13} />
              <span>{t('settings.language')}</span>
            </div>
            <div className="entry-settings-menu__select">
              <button
                type="button"
                role="menuitem"
                className="entry-settings-menu__select-trigger"
                aria-haspopup="menu"
                aria-expanded={langOpen}
                onClick={() => setLangOpen((value) => !value)}
              >
                <span className="entry-settings-menu__select-value">
                  {LOCALE_LABEL[locale]}
                </span>
                <Icon
                  name="chevron-down"
                  size={14}
                  className="entry-settings-menu__select-caret"
                />
              </button>
              <div
                ref={langListRef}
                className={`entry-settings-menu__select-list${
                  langOpen ? ' is-open' : ''
                }`}
              >
                <div className="entry-settings-menu__select-list-inner">
                  <div
                    className="entry-settings-menu__select-panel"
                    role="menu"
                    aria-label={t('settings.language')}
                  >
                    {LOCALES.map((code) => {
                      const active = locale === code;
                      return (
                        <button
                          key={code}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={`entry-settings-menu__option${
                            active ? ' is-active' : ''
                          }`}
                          onClick={() => {
                                                        setLocale(code as Locale);
                            setLangOpen(false);
                            setOpen(false);
                          }}
                        >
                          <span className="entry-settings-menu__option-label">
                            {LOCALE_LABEL[code]}
                          </span>
                          {active ? (
                            <Icon
                              name="check"
                              size={12}
                              className="entry-settings-menu__option-check"
                            />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section className="entry-settings-menu__section">
            <div className="entry-settings-menu__section-title">
              <Icon name="palette" size={13} />
              <span>{t('settings.appearance')}</span>
            </div>
            <div className="entry-settings-menu__theme-row">
              {ENTRY_THEME_OPTIONS.map((option) => {
                const active = activeTheme === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    className={`entry-settings-menu__theme${
                      active ? ' is-active' : ''
                    }`}
                    onClick={() => {
                                            onThemeChange(option.value);
                      setOpen(false);
                    }}
                  >
                    <Icon name={option.icon} size={13} />
                    <span>{t(option.labelKey)}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="entry-settings-menu__divider" aria-hidden />

          <button
            type="button"
            className="entry-settings-menu__item entry-settings-menu__item--primary"
            data-testid="entry-settings-open-details"
            role="menuitem"
            onClick={() => {
                            setOpen(false);
              onOpenSettings();
            }}
          >
            <span className="entry-settings-menu__item-icon" aria-hidden>
              <Icon name="settings" size={14} />
            </span>
            <span>{t('avatar.settings')}</span>
            <span className="entry-settings-menu__item-meta">
              {t('homeHero.details')}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
