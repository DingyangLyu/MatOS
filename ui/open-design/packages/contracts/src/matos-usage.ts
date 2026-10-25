/** User-scoped numeric projection from `matos usage profile --json`. */
export interface MatOSUserStats {
  schemaVersion: 1;
  generatedAt: string;
  timeZone: 'UTC';
  from: string;
  to: string;
  coverage: { status: 'recorded-only'; unavailableRecords: number; costStatus: 'unverified-estimate' };
  totalTokens: number;
  foregroundTokens: number;
  backgroundTokens: number;
  tokensByKind: { input: number; output: number; cacheRead: number; cacheCreation: number };
  peakDayTokens: number;
  daily: Record<string, number>;
  activeDays: number;
  currentStreakDays: number;
  longestStreakDays: number;
  sessionCount: number;
  userMessageCount: number;
  toolCallCount: number;
  longestTaskMs: number;
  topTools: Array<{ name: string; count: number }>;
  firstActivityAt: string | null;
  lastActivityAt: string | null;
}
