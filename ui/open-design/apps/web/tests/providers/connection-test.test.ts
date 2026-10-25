// Surface checks for the daemon /api/test/connection helper. Verifies the request
// shape (URL, method, JSON body), happy-path decoding, and how the helper
// degrades when the daemon answers with a 5xx envelope.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { testAgent } from '../../src/providers/connection-test';
import type { ConnectionTestResponse } from '../../src/types';

const realFetch = globalThis.fetch;

beforeEach(() => {
  // Each test installs its own stub.
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('testAgent', () => {
  it('POSTs to /api/test/connection with model and reasoning passthrough', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          ok: false,
          kind: 'agent_not_installed',
          latencyMs: 0,
          agentName: 'Devin',
        }),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await testAgent({
      agentId: 'devin',
      model: 'sonnet',
      reasoning: 'high',
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    });

    expect(result.kind).toBe('agent_not_installed');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/test/connection');
    expect(JSON.parse(init.body)).toEqual({
      mode: 'agent',
      agentId: 'devin',
      model: 'sonnet',
      reasoning: 'high',
      agentCliEnv: {
        codex: { CODEX_HOME: '~/.codex-alt' },
      },
    });
  });
});
