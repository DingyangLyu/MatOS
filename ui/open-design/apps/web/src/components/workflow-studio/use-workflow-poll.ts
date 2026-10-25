import { useEffect, useState } from 'react';

/** One request chain per view, with retry and stale-response protection. */
export function useWorkflowPoll<T>(load: (signal: AbortSignal) => Promise<T>, interval = 2_000) {
  const [snapshot, setSnapshot] = useState<{
    source: typeof load;
    data: T | null;
    error: string | null;
    updatedAt: number | null;
  } | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const result = await load(controller.signal);
        if (cancelled) return;
        setSnapshot({ source: load, data: result, error: null, updatedAt: Date.now() });
        failures = 0;
      } catch (failure) {
        if (cancelled) return;
        setSnapshot((previous) => ({
          source: load,
          data: previous?.source === load ? previous.data : null,
          updatedAt: previous?.source === load ? previous.updatedAt : null,
          error: failure instanceof Error ? failure.message : String(failure),
        }));
        failures += 1;
      }
      if (!cancelled)
        timer = setTimeout(
          () => void tick(),
          document.hidden ? Math.max(15_000, interval) : Math.min(Math.max(15_000, interval), interval * 2 ** failures),
        );
    };
    void tick();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [load, interval, generation]);
  const current = snapshot?.source === load ? snapshot : null;
  return {
    data: current?.data ?? null,
    error: current?.error ?? null,
    updatedAt: current?.updatedAt ?? null,
    refresh: () => setGeneration((value) => value + 1),
  };
}
