import { describe, expect, it } from 'vitest';

import { createTerminalService } from '../src/terminals.js';

/**
 * Regression for "kill leaves the session running": interactive bash ignores
 * SIGTERM, so the old `kill(session, 'SIGTERM')` route behavior left the PTY
 * alive and the session status stuck at `running` until the user typed
 * `exit`. The service now defaults to SIGHUP (the terminal-hangup signal
 * every login shell exits on) and escalates to SIGKILL after a grace window
 * for processes that trap/ignore it.
 *
 * Real PTY, real /bin/bash — no mocks per the repo testing policy.
 */

function waitForExit(session: { status: string }, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (session.status === 'exited') return resolve(true);
      if (Date.now() - startedAt > timeoutMs) return resolve(false);
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('terminal kill termination', () => {
  it('kill() with the default signal terminates an interactive bash session', async () => {
    const terminals = createTerminalService();
    const session = await terminals.create({
      projectId: 'p-kill-default',
      cwd: process.cwd(),
      shell: '/bin/bash',
    });
    expect(session.status).toBe('running');

    expect(terminals.kill(session)).toBe(true);
    // Interactive bash exits on SIGHUP well within the escalation window.
    expect(await waitForExit(session, 8_000)).toBe(true);
    expect(session.signal === 'SIGHUP' || session.exitCode !== null).toBe(true);
  }, 20_000);

  it('escalates to SIGKILL when the process ignores the polite signal', async () => {
    const terminals = createTerminalService({ killEscalateMs: 500 });
    const session = await terminals.create({
      projectId: 'p-kill-escalate',
      cwd: process.cwd(),
      shell: '/bin/bash',
    });
    expect(session.status).toBe('running');

    // Make the shell trap-and-ignore SIGHUP so only the escalation can end it.
    terminals.write(session, "trap '' HUP\n");
    // Give bash a moment to install the trap before we send the signal.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    expect(terminals.kill(session)).toBe(true);
    expect(await waitForExit(session, 10_000)).toBe(true);
  }, 20_000);
});
