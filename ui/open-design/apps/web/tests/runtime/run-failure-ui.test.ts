import { describe, expect, it } from 'vitest';

import { resolveRunFailureUi } from '../../src/runtime/run-failure-ui';

describe('resolveRunFailureUi', () => {
  it('explains a missing model key, which arrives without an error code', () => {
    expect(
      resolveRunFailureUi(
        null,
        'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service',
      ),
    ).toEqual({ titleKey: 'chat.runError.title.authRequired', messageKey: 'chat.runError.matos.noKey' });
  });

  it('keeps the code-based mapping for other failures', () => {
    expect(resolveRunFailureUi('RATE_LIMITED', 'too many requests').messageKey).toBe('chat.runError.matos.rateLimited');
    expect(resolveRunFailureUi(null, 'some other failure').messageKey).toBeNull();
  });
});
