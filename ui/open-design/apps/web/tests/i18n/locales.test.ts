import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSystemLocale } from '../../src/i18n';
import { workflowStudioZh } from '../../src/i18n/workflow-studio';
import { en } from '../../src/i18n/locales/en';
import { zhCN } from '../../src/i18n/locales/zh-CN';
import { zhTW } from '../../src/i18n/locales/zh-TW';
import { LOCALES, LOCALE_LABEL, type Dict, type Locale } from '../../src/i18n/types';

const EXPECTED_LOCALES = ['en', 'zh-CN', 'zh-TW'];

function placeholders(value: string): string[] {
  const names: string[] = [];
  for (const match of value.matchAll(/\{(\w+)\}/g)) {
    if (match[1]) {
      names.push(match[1]);
    }
  }
  return names.sort();
}

async function loadDict(locale: Locale): Promise<Dict> {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => {
    return Boolean(value) && typeof value === 'object';
  });
  if (!dict) {
    throw new Error(`No dictionary export found for locale ${locale}`);
  }
  return dict;
}

function explicitLocaleKeys(locale: Locale): string[] {
  const source = readFileSync(new URL(`../../src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8');
  return Array.from(source.matchAll(/^\s*['"]([^'"]+)['"]:/gm), (match) => match[1] ?? '').filter(Boolean);
}

describe('i18n locales', () => {
  it('resolves the initial locale from browser language preferences', () => {
    expect(resolveSystemLocale(['zh-Hans-CN', 'en-US'])).toBe('zh-CN');
    expect(resolveSystemLocale(['zh-Hant-HK', 'en-US'])).toBe('zh-TW');
    expect(resolveSystemLocale(['pt-PT', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['es-MX', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['nl-NL', 'en-US'])).toBe('en');
    expect(resolveSystemLocale(['nl-NL'])).toBeNull();
  });

  it('registers every supported locale in the language menu', () => {
    expect(LOCALES).toEqual(EXPECTED_LOCALES);
    expect((LOCALE_LABEL as Record<string, string>).id).toBe('Bahasa Indonesia');
    expect((LOCALE_LABEL as Record<string, string>).de).toBe('Deutsch');
    expect((LOCALE_LABEL as Record<string, string>).it).toBe('Italiano');
    expect((LOCALE_LABEL as Record<string, string>).ja).toBe('日本語');
  });

  it('keeps locale dictionaries aligned with English keys and placeholders', async () => {
    const englishKeys = Object.keys(en).sort();

    for (const locale of LOCALES) {
      const dict = await loadDict(locale);
      expect(Object.keys(dict).sort()).toEqual(englishKeys);

      for (const key of englishKeys) {
        const dictKey = key as keyof Dict;
        expect(placeholders(dict[dictKey] ?? ''), `${locale}.${key}`).toEqual(
          placeholders(en[dictKey] ?? ''),
        );
      }
    }
    // 19 locales are pulled in via dynamic import(); under full-suite transform
    // pressure that cold-import cost blows past the 5s default even though the
    // comparison itself is trivial. Give the import fan-out real headroom.
  }, 30000);

  it('keeps Chinese integrations copy translated instead of falling back to English', () => {
    const translatedKeys: Array<keyof Dict> = [
      'entry.navIntegrations',
      'integrations.kicker',
      'integrations.lede',
      'integrations.agentReady',
      'integrations.tabLabel.mcp',
      'integrations.tabHint.mcp',
      'integrations.tabHint.useEverywhere',
      'mcpClient.title',
      'mcpClient.subtitle',
      'mcpClient.addServer',
      'mcpClient.emptyTitle',
      'mcpClient.emptyBody',
      'mcpClient.saveChanges',
      'mcpClient.daemonError',
      'mcpClient.saveFailed',
    ];

    for (const key of translatedKeys) {
      expect(zhCN[key], `zh-CN.${key}`).not.toBe(en[key]);
      expect(zhTW[key], `zh-TW.${key}`).not.toBe(en[key]);
    }
  });

  it('keeps the MatOS automation catalog translated in Chinese', () => {
    const translatedKeys: Array<keyof Dict> = [
      'automations.catalog.crystallizeSkill.title',
      'automations.catalog.crystallizeSkill.desc',
      'automations.catalog.crystallizeSkill.prompt',
      'automations.tpl.designSystemRefresh.prompt',
      'automations.tpl.releaseNotes.prompt',
      'automations.tpl.qualityRegressionWatch.prompt',
    ];

    for (const key of translatedKeys) {
      expect(zhCN[key], `zh-CN.${key}`).not.toBe(en[key]);
      expect(zhTW[key], `zh-TW.${key}`).not.toBe(en[key]);
    }
  });

  it('keeps Routines settings page copy translated in Chinese (issue #1372)', () => {
    const translatedKeys: Array<keyof Dict> = [
      'routines.title',
      'routines.subtitle',
      'routines.newAutomation',
      'routines.runNow',
      'routines.pause',
      'routines.resume',
      'routines.history',
      'routines.delete',
      'routines.describe.daily',
      'routines.describe.weekly',
      'routines.status.succeeded',
      'routines.status.failed',
      'routines.modeCreate',
      'routines.confirmDelete',
      'routines.errorPickProject',
    ];

    for (const key of translatedKeys) {
      expect(zhCN[key], `zh-CN.${key}`).not.toBe(en[key]);
      expect(zhTW[key], `zh-TW.${key}`).not.toBe(en[key]);
    }
  });

  // Tier-1 locale parity lock (issue #1894):
  //
  // Most locale modules use `...en` spread so missing translations silently
  // fall back to English at runtime — that satisfies the dictionary-shape
  // test above (`Object.keys(dict)` is complete) but hides drift between
  // English and the rendered locale. `zh-CN` is the one locale today that
  // declares every key explicitly with no `...en` spread, so a new English
  // key without a matching `zh-CN` entry is a *real* hole, not a benign
  // fallback. The two cases below lock that property in place: any future
  // PR that lets `zh-CN` drift, or reintroduces an implicit spread, fails
  // CI loudly instead of regressing translation coverage in silence.
  it('keeps zh-CN explicitly translated for every English key (tier-1 parity lock)', () => {
    const englishKeys = Object.keys(en).sort();
    const explicit = [...new Set([...explicitLocaleKeys('zh-CN'), ...Object.keys(workflowStudioZh)])].sort();

    expect(
      explicit,
      'zh-CN must explicitly declare every English key (no implicit `...en` spread fallback). ' +
        'Add the missing translations to `apps/web/src/i18n/locales/zh-CN.ts` rather than re-introducing the spread.',
    ).toEqual(englishKeys);
  });

  it('keeps the zh-CN locale source free of the `...en` spread fallback', () => {
    const source = readFileSync(
      new URL('../../src/i18n/locales/zh-CN.ts', import.meta.url),
      'utf8',
    );

    expect(
      source,
      'zh-CN.ts must not use `...en` spread — every key must be explicitly translated. ' +
        'If you need to add new keys, declare them with their Chinese values directly.',
    ).not.toMatch(/\.\.\.en\b/);
  });
});
