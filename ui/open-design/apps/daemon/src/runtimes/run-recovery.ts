type PersistedAgentSessionCursor = {
  existingPosition?: unknown;
  lastMessageId?: unknown;
  recoveringPosition?: unknown;
  updatedAt?: unknown;
};

type RecoveredRunCursor = {
  assistantMessageId?: string | null;
  updatedAt?: unknown;
};

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Lazy run recovery may be triggered by opening an old interrupted turn after
 * the conversation has already continued. Positions are authoritative when
 * both messages still exist; timestamps are the fallback for legacy or
 * partially-pruned rows. If neither ordering signal is usable, preserve the
 * existing cursor instead of risking a rollback to an older upstream thread.
 */
export function shouldPreserveExistingAgentSession(
  existing: PersistedAgentSessionCursor | null | undefined,
  recoveredRun: RecoveredRunCursor,
): boolean {
  if (!existing || existing.lastMessageId === recoveredRun.assistantMessageId) {
    return false;
  }

  const existingPosition = finiteNumber(existing.existingPosition);
  const recoveringPosition = finiteNumber(existing.recoveringPosition);
  if (existingPosition !== null && recoveringPosition !== null) {
    return existingPosition > recoveringPosition;
  }

  const existingUpdatedAt = finiteNumber(existing.updatedAt);
  const recoveringUpdatedAt = finiteNumber(recoveredRun.updatedAt);
  if (existingUpdatedAt !== null && recoveringUpdatedAt !== null) {
    return existingUpdatedAt > recoveringUpdatedAt;
  }

  return true;
}
