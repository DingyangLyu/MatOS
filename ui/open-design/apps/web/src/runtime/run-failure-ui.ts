// Failure-card copy for a failed run: maps the daemon error code to the card
// title and, when available, a clearer message than the raw upstream string.

// i18n keys for the gray-card text override (null = show the raw error).
export type RunFailureMessageKey =
  | 'chat.connectionDropped'
  | 'chat.workspaceRestarted'
  | 'chat.runError.matos.auth'
  | 'chat.runError.matos.rateLimited'
  | 'chat.runError.matos.unavailable'
  | 'chat.runError.matos.noKey'
  | null;

// i18n keys for the unified error card's TITLE (the "error type" line above the
// detail message).
export type RunFailureTitleKey =
  | 'chat.runError.title.authRequired'
  | 'chat.runError.title.connectionDropped'
  | 'chat.runError.title.rateLimited'
  | 'chat.runError.title.generic';

export interface RunFailureUi {
  titleKey: RunFailureTitleKey;
  messageKey: RunFailureMessageKey;
}

// The engine reports a missing provider key without an error code, naming the
// key variable instead.
const MISSING_MODEL_KEY = /no API key for provider route|DEEPSEEK_API_KEY/;

export function resolveRunFailureUi(
  code: string | null | undefined,
  detail?: string | null,
): RunFailureUi {
  // A mid-response connection drop gets a clear "lost connection — retry"
  // message instead of the raw SDK string.
  if (code === 'AGENT_CONNECTION_DROPPED') {
    return { titleKey: 'chat.runError.title.connectionDropped', messageKey: 'chat.connectionDropped' };
  }
  if (code === 'RUN_INTERRUPTED_BY_DAEMON_RESTART') {
    return { titleKey: 'chat.runError.title.connectionDropped', messageKey: 'chat.workspaceRestarted' };
  }
  if (detail && MISSING_MODEL_KEY.test(detail)) {
    return { titleKey: 'chat.runError.title.authRequired', messageKey: 'chat.runError.matos.noKey' };
  }
  const auth = code === 'AGENT_AUTH_REQUIRED' || code === 'UNAUTHORIZED';
  const limited = code === 'RATE_LIMITED';
  return {
    titleKey: auth ? 'chat.runError.title.authRequired'
      : limited ? 'chat.runError.title.rateLimited' : 'chat.runError.title.generic',
    messageKey: auth ? 'chat.runError.matos.auth'
      : limited ? 'chat.runError.matos.rateLimited'
      : code === 'UPSTREAM_UNAVAILABLE' ? 'chat.runError.matos.unavailable' : null,
  };
}
