import { useEffect, useRef, useState } from 'react';

import {
  fetchEvolutionPanel,
  type EvolutionPanelView,
} from '../matos-evolution-client';
import { EvolutionJuryPanel } from './EvolutionJuryPanel';

interface Props {
  enabled: boolean;
  /**
   * Optional native MatOS session id to scope the panel to. When omitted the
   * daemon auto-selects the most recently active session, which is the common
   * case for the chat surface (the panel tracks whatever run just produced
   * learning activity).
   */
  sessionId?: string | null;
  /** The project whose review records the panel reads. */
  projectId?: string | null;
  /** How often to poll the bridge while enabled. */
  pollMs?: number;
  /** Recent-activity window (minutes) for the auto-selected session. */
  recentMinutes?: number;
  /** Test seam: swap the bridge fetch. Production passes nothing. */
  fetchPanel?: typeof fetchEvolutionPanel;
}

const DEFAULT_POLL_MS = 4000;

/**
 * Drop-in mount for the self-evolution review panel. Owns the poll loop
 * against the daemon bridge and renders nothing until there is recent
 * self-evolution activity, so a quiet workspace stays visually unchanged
 * (mirrors the Design Jury's idle=null behaviour). `enabled=false` tears the
 * poll down entirely — the flag is a pure visibility switch; how far the
 * pipeline may go is the approval mode on the Evolution page.
 */
export function EvolutionJuryMount({
  enabled,
  sessionId,
  projectId,
  pollMs = DEFAULT_POLL_MS,
  recentMinutes,
  fetchPanel = fetchEvolutionPanel,
}: Props) {
  const [panel, setPanel] = useState<EvolutionPanelView | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setPanel(null);
      return;
    }
    let cancelled = false;

    const poll = async (): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const next = await fetchPanel({
          ...(sessionId ? { sessionId } : {}),
          ...(projectId ? { projectId } : {}),
          ...(recentMinutes != null ? { recentMinutes } : {}),
        });
        if (!cancelled) setPanel(next);
      } catch {
        // The review panel must never interrupt the active workspace; a
        // transient bridge error just keeps the last snapshot until the next
        // successful poll.
      } finally {
        inFlightRef.current = false;
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), pollMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, sessionId, projectId, pollMs, recentMinutes, fetchPanel]);

  if (!enabled) return null;
  if (!panel || panel.cases.length === 0) return null;
  return <EvolutionJuryPanel cases={panel.cases} />;
}
