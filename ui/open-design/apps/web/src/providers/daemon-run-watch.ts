import type { ChatRunStatusResponse } from '@open-design/contracts';

const CHECK_INTERVAL_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Reconnect an idle transport only when the daemon confirms the run ended.
 * Heartbeats prove socket liveness, not delivery of the run's terminal event. */
export function watchDaemonRunTerminal(options: {
  probe: (signal: AbortSignal) => Promise<ChatRunStatusResponse | null>;
  reconnect: () => void;
}): { progress: () => void; stop: () => void } {
  let stopped = false;
  let lastProgressAt = Date.now();
  let progressVersion = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let probeController: AbortController | undefined;

  const check = async (force = false) => {
    if (stopped || probeController) return;
    if (!force && Date.now() - lastProgressAt < CHECK_INTERVAL_MS) return;
    const controller = new AbortController();
    const progressAtProbe = progressVersion;
    probeController = controller;
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const status = await options.probe(controller.signal);
      if (stopped || controller.signal.aborted || progressVersion !== progressAtProbe) return;
      if (status && ['succeeded', 'failed', 'canceled'].includes(status.status)) {
        stop();
        options.reconnect();
      }
    } catch {
      // Unreachable status is not evidence of task failure or completion.
    } finally {
      clearTimeout(timeout);
      if (probeController === controller) probeController = undefined;
    }
  };

  const tick = async () => {
    await check();
    if (!stopped) timer = setTimeout(tick, CHECK_INTERVAL_MS);
  };
  const wake = () => {
    if (document.visibilityState === 'visible') void check(true);
  };
  function stop() {
    stopped = true;
    clearTimeout(timer);
    probeController?.abort();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', wake);
  }
  timer = setTimeout(tick, CHECK_INTERVAL_MS);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', wake);
  return { progress: () => { lastProgressAt = Date.now(); progressVersion += 1; }, stop };
}
