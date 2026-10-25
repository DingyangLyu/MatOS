// Stable stream-json compatibility fixture for the browser parser. This is a
// protocol unit test; real DSH integration is checked separately.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createClaudeStreamHandler } from '../../src/runtimes/claude-stream.js';

const FIXTURE_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  './fixtures/matos-stream-json.golden.jsonl',
);

function fixtureLines(): string[] {
  return readFileSync(FIXTURE_PATH, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
}

type StreamEvent = Record<string, unknown> & { type: string };

function replayFixture(): StreamEvent[] {
  const events: StreamEvent[] = [];
  const handler = createClaudeStreamHandler((event: unknown) => {
    events.push(event as StreamEvent);
  });
  for (const line of fixtureLines()) {
    handler.feed(`${line}\n`);
  }
  handler.flush();
  return events;
}

describe('matos stream-json contract (daemon parser)', () => {
  it('locates the shared golden fixture', () => {
    expect(fixtureLines().length).toBeGreaterThanOrEqual(8);
  });

  it('replays the golden fixture into the stable chat event sequence', () => {
    const events = replayFixture();
    const types = events.map((e) => e.type);

    // The system init line opens the run with model + session identity.
    expect(events[0]).toMatchObject({
      type: 'status',
      label: 'initializing',
      model: 'claude-fable-5',
      sessionId: 'a1b2c3d4-1111-4111-8111-000000000001',
    });

    // Streamed content: thinking delta, then text delta, exactly once each
    // (the final assistant wrapper must not double-emit streamed content).
    expect(
      events.filter((e) => e.type === 'thinking_delta' && e.delta === '先检查环境。'),
    ).toHaveLength(1);
    expect(
      events.filter((e) => e.type === 'text_delta' && e.delta === 'GPU 当前空闲。'),
    ).toHaveLength(1);

    // The Bash tool_use from the assistant wrapper surfaces exactly once,
    // with its input intact, and the turn pauses on tool_use.
    const toolUses = events.filter((e) => e.type === 'tool_use');
    expect(toolUses).toHaveLength(1);
    expect(toolUses[0]).toMatchObject({
      id: 'toolu_golden_0001',
      name: 'Bash',
      input: { command: 'nvidia-smi' },
    });
    expect(events.filter((e) => e.type === 'turn_end')).toMatchObject([
      { stopReason: 'tool_use' },
    ]);

    // The user tool_result round-trips with its correlation id.
    expect(events.filter((e) => e.type === 'tool_result')).toMatchObject([
      { toolUseId: 'toolu_golden_0001', isError: false },
    ]);

    // Every result envelope (success AND error_during_execution) closes as a
    // usage event; the parser deliberately emits no `error` event for a
    // result-level failure — run failure is decided by the exit code at the
    // spawn layer. If that division of labor changes, update this pin and
    // the server bookkeeping together.
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(2);
    expect(types.filter((t) => t === 'error')).toHaveLength(0);
  });

  it('never invents content outside the known event vocabulary', () => {
    const KNOWN = new Set([
      'status',
      'text_delta',
      'thinking_delta',
      'tool_use',
      'tool_result',
      'usage',
      'turn_end',
      'error',
      'runtime_task',
    ]);
    for (const event of replayFixture()) {
      expect(KNOWN.has(event.type), `unknown event type ${event.type}`).toBe(true);
    }
  });
});
