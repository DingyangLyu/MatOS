// The group-dispatch watcher polls the durable group-task ledger while the
// daemon-owned fan-out/relay chain runs. Regression pin for the silent-death
// bug: one transient poll failure (daemon hiccup, proxy 502) used to
// terminate the watcher outright — live member-task rows stopped appearing
// for the rest of the conversation and the watch token leaked.

import { describe, expect, it } from 'vitest';

import { nextGroupDispatchPollStep } from '../../src/components/ProjectView';

describe('nextGroupDispatchPollStep', () => {
  it('keeps polling through a transient failure instead of settling', () => {
    expect(
      nextGroupDispatchPollStep({ attempt: 3, idleProbes: 0, probe: 'failed' }),
    ).toEqual({ kind: 'reschedule', refresh: false, idleProbes: 0 });
  });

  it('does not let failures consume idle probes', () => {
    // Four failures in a row while two idle probes are banked: the idle
    // count must be unchanged — only a successful "ledger is idle"
    // observation is evidence toward settling.
    let idleProbes = 2;
    for (let attempt = 10; attempt < 14; attempt += 1) {
      const step = nextGroupDispatchPollStep({ attempt, idleProbes, probe: 'failed' });
      expect(step).toMatchObject({ kind: 'reschedule', idleProbes: 2 });
      if (step.kind === 'reschedule') idleProbes = step.idleProbes;
    }
  });

  it('an active ledger refreshes and resets the idle counter', () => {
    expect(
      nextGroupDispatchPollStep({ attempt: 42, idleProbes: 4, probe: 'active' }),
    ).toEqual({ kind: 'reschedule', refresh: true, idleProbes: 0 });
  });

  it('settles only after the idle-probe budget is spent on real observations', () => {
    let idleProbes = 0;
    for (let probeCount = 0; probeCount < 5; probeCount += 1) {
      const step = nextGroupDispatchPollStep({
        attempt: probeCount,
        idleProbes,
        probe: 'idle',
      });
      expect(step.kind).toBe('reschedule');
      if (step.kind === 'reschedule') {
        expect(step.refresh).toBe(false);
        idleProbes = step.idleProbes;
      }
    }
    expect(idleProbes).toBe(5);
    expect(
      nextGroupDispatchPollStep({ attempt: 6, idleProbes, probe: 'idle' }),
    ).toEqual({ kind: 'settle' });
  });

  it('exhausting the attempt budget settles (cleanup) rather than silently stopping', () => {
    for (const probe of ['active', 'idle', 'failed'] as const) {
      expect(
        nextGroupDispatchPollStep({ attempt: 900, idleProbes: 0, probe }),
      ).toEqual({ kind: 'settle' });
    }
  });
});
