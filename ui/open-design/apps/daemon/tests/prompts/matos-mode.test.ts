import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { usesNativeMatOSPromptAuthority } from '../../src/runtimes/matos-native-policy.js';

describe('MatOS native prompt authority', () => {
  it('detects matos agent ids including local profiles', () => {
    expect(usesNativeMatOSPromptAuthority('matos')).toBe(true);
    expect(usesNativeMatOSPromptAuthority('MatOS')).toBe(true);
    expect(usesNativeMatOSPromptAuthority('matos-academic')).toBe(true);
    expect(usesNativeMatOSPromptAuthority('claude')).toBe(false);
    expect(usesNativeMatOSPromptAuthority(null)).toBe(false);
  });

  it('returns no Open Design prompt for MatOS regardless of supplied OD context', () => {
    expect(composeSystemPrompt({
      agentId: 'matos',
      sessionMode: 'design',
      skillBody: 'legacy OD skill prompt',
      userInstructions: 'legacy user instructions',
      projectInstructions: 'legacy project instructions',
    })).toBe('');
  });

  it('leaves non-matos agents on the Open Design design arc', () => {
    const prompt = composeSystemPrompt({ agentId: 'claude' });
    expect(prompt).toContain('OD core directives');
  });
});
