import {it,expect} from 'vitest';
import type {SkillSummary} from '../../src/types';
import {localizeSkillName,localizeSkillDescription,localizeSkillPrompt} from '../../src/i18n/content';
it('uses inline skill display metadata before falling back to source fields', () => {
    const inlineSkill = {
      id: 'inline-skill',
      name: 'inline-skill',
      displayName: {
        en: 'Inline Skill',
        'zh-CN': '内联技能',
      },
      description: ' English description from source. ',
      descriptionI18n: {
        en: 'English inline description.',
        'zh-CN': '中文内联描述。',
      },
      examplePrompt: ' English prompt from source. ',
      examplePromptI18n: {
        en: 'English inline prompt.',
        'zh-CN': '中文内联 prompt。',
      },
    } as unknown as SkillSummary;

    expect(localizeSkillName('zh-CN', inlineSkill)).toBe('内联技能');
    expect(localizeSkillName('zh-TW', inlineSkill)).toBe('内联技能');
    expect(localizeSkillName('fr', inlineSkill)).toBe('Inline Skill');
    expect(localizeSkillDescription('zh-CN', inlineSkill)).toBe('中文内联描述。');
    expect(localizeSkillDescription('fr', inlineSkill)).toBe('English inline description.');
    expect(localizeSkillPrompt('zh-CN', inlineSkill)).toBe('中文内联 prompt。');
    expect(localizeSkillPrompt('fr', inlineSkill)).toBe('English inline prompt.');
  });
