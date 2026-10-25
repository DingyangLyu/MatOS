// AG-UI encoder unit test.

import { describe, expect, it } from 'vitest';
import { encodeOdEventForAgui } from '../src/encode.js';

const RUN_ID = 'run-1';
const NOW = 1_700_000_000_000;

describe('encodeOdEventForAgui', () => {
  it('maps message_chunk to agent.message + carries done', () => {
    const out = encodeOdEventForAgui(
      { kind: 'message_chunk', text: 'hello', done: true },
      { runId: RUN_ID, now: NOW },
    );
    expect(out).toEqual({
      kind: 'agent.message',
      runId: RUN_ID,
      ts: NOW,
      text: 'hello',
      done: true,
    });
  });

  it('maps tool_call with status + result', () => {
    const out = encodeOdEventForAgui(
      {
        kind: 'tool_call',
        toolName: 'connectors.execute',
        args: { name: 'index.html' },
        callId: 'tc-1',
        status: 'completed',
        result: { ok: true },
      },
      { runId: RUN_ID, now: NOW, seq: 7 },
    );
    expect(out).toEqual({
      kind: 'tool_call',
      runId: RUN_ID,
      ts: NOW,
      seq: 7,
      toolName: 'connectors.execute',
      args: { name: 'index.html' },
      callId: 'tc-1',
      status: 'completed',
      result: { ok: true },
    });
  });

  it('maps run lifecycle: run_started → started, end → completed/failed/cancelled', () => {
    expect(encodeOdEventForAgui({ kind: 'run_started' }, { runId: RUN_ID, now: NOW })).toEqual({
      kind: 'run.lifecycle',
      runId: RUN_ID,
      ts: NOW,
      status: 'started',
    });
    expect(encodeOdEventForAgui({ kind: 'end', status: 'succeeded' }, { runId: RUN_ID, now: NOW }))
      .toMatchObject({ status: 'completed' });
    expect(encodeOdEventForAgui({ kind: 'end', status: 'failed' }, { runId: RUN_ID, now: NOW }))
      .toMatchObject({ status: 'failed' });
    expect(encodeOdEventForAgui({ kind: 'end', status: 'canceled' }, { runId: RUN_ID, now: NOW }))
      .toMatchObject({ status: 'cancelled' });
  });

  it('drops events the encoder does not understand', () => {
    const out = encodeOdEventForAgui(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { kind: 'mystery' as any },
      { runId: RUN_ID, now: NOW },
    );
    expect(out).toBeNull();
  });

  it('falls back to Date.now() when ctx.now is not supplied', () => {
    const before = Date.now();
    const out = encodeOdEventForAgui(
      { kind: 'message_chunk', text: 'hi' },
      { runId: RUN_ID },
    );
    const after = Date.now();
    expect(out).not.toBeNull();
    expect(out!.ts).toBeGreaterThanOrEqual(before);
    expect(out!.ts).toBeLessThanOrEqual(after);
  });

  it('substitutes defaults for tool_call when toolName/args/callId are absent', () => {
    const out = encodeOdEventForAgui(
      { kind: 'tool_call' },
      { runId: RUN_ID, now: NOW },
    );
    expect(out).toMatchObject({
      kind: 'tool_call',
      runId: RUN_ID,
      ts: NOW,
      toolName: 'unknown',
      args: null,
    });
    const record = out as unknown as Record<string, unknown>;
    expect(record.callId).toBeUndefined();
    expect(record.status).toBeUndefined();
    expect(record.result).toBeUndefined();
  });

  it('keeps the value key on state_update when the value is explicitly null', () => {
    const out = encodeOdEventForAgui(
      { kind: 'state_update', path: 'mystery', value: null },
      { runId: RUN_ID, now: NOW },
    );
    expect(out).not.toBeNull();
    const record = out as unknown as Record<string, unknown>;
    expect('value' in record).toBe(true);
    expect(record.value).toBeNull();
  });
});
