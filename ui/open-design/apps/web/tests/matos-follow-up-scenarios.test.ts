import { describe, expect, it } from 'vitest';
import { MATOS_FOLLOW_UP_SCENARIO_DEFS } from '../src/components/home-hero/placeholderScenarios';
import { MATOS_CHAT_FOLLOW_UPS_VISIBLE } from '../src/features/matosChatFollowUps';
import { en } from '../src/i18n/locales/en';
import { zhCN } from '../src/i18n/locales/zh-CN';

describe('MATOS_FOLLOW_UP_SCENARIO_DEFS', () => {
  it('is the MatOS product default for the in-project follow-up rotation', () => {
    // ChatPane swaps the upstream design-toolbox polish prompts for these
    // when the flag is on; a design prompt like "润色动效节奏" mid compute
    // session was the reported regression.
    expect(MATOS_CHAT_FOLLOW_UPS_VISIBLE).toBe(true);
    expect(MATOS_FOLLOW_UP_SCENARIO_DEFS.length).toBeGreaterThan(0);
  });

  it('has unique ids and resolvable, non-empty copy in en and zh-CN', () => {
    const ids = MATOS_FOLLOW_UP_SCENARIO_DEFS.map((def) => def.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The typecheck enforces all locales carry the keys; this catches empty
    // values in the two primary product locales, which would render a blank
    // rotating placeholder.
    for (const def of MATOS_FOLLOW_UP_SCENARIO_DEFS) {
      expect(en[def.textKey]?.trim().length, `en[${def.textKey}]`).toBeGreaterThan(0);
      expect(zhCN[def.textKey]?.trim().length, `zh-CN[${def.textKey}]`).toBeGreaterThan(0);
    }
  });

  it('never reuses the upstream design-toolbox prompt keys', () => {
    for (const def of MATOS_FOLLOW_UP_SCENARIO_DEFS) {
      expect(def.textKey.startsWith('chat.designToolbox.')).toBe(false);
    }
  });
});
