import type { MatOSUserStats } from '@open-design/contracts';

export function usageRange(days: number, now = new Date()): { from: string; to: string } {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(end - (days - 1) * 86400000).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) };
}

export function cacheHitShare(stats: MatOSUserStats): number | null {
  const { input, cacheRead, cacheCreation } = stats.tokensByKind;
  const totalInput = input + cacheRead + cacheCreation;
  return totalInput > 0 ? cacheRead / totalInput : null;
}

export function isUsageProfile(value: unknown): value is MatOSUserStats {
  const v = value as MatOSUserStats | null;
  const number = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  const date = (d: unknown) => typeof d === 'string' && Number.isFinite(Date.parse(d));
  return !!v && v.schemaVersion === 1 && v.timeZone === 'UTC' && !!v.coverage && !!v.tokensByKind &&
    [v.totalTokens, v.foregroundTokens, v.backgroundTokens, v.peakDayTokens, v.activeDays, v.currentStreakDays,
      v.longestStreakDays, v.sessionCount, v.userMessageCount, v.toolCallCount, v.longestTaskMs, v.coverage.unavailableRecords,
      v.tokensByKind.input, v.tokensByKind.output, v.tokensByKind.cacheRead, v.tokensByKind.cacheCreation].every(number) &&
    date(v.generatedAt) && date(v.from) && date(v.to) && (v.firstActivityAt === null || date(v.firstActivityAt)) &&
    (v.lastActivityAt === null || date(v.lastActivityAt)) && !!v.daily && typeof v.daily === 'object' && !Array.isArray(v.daily) &&
    Object.entries(v.daily).every(([day, n]) => date(day) && number(n)) && Array.isArray(v.topTools) &&
    v.topTools.every(tool => !!tool && typeof tool.name === 'string' && number(tool.count));
}
