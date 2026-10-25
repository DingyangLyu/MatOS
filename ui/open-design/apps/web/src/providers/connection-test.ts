// Thin POST-and-decode wrapper around the daemon's /api/test/connection route.
// The daemon always answers with HTTP 200 and a `ConnectionTestResponse`
// body even on upstream-caused failures, so the only paths that throw here
// are network-level errors and abort signals.

import type {
  AgentTestRequest,
  ConnectionTestResponse,
} from '../types';

async function postTest(
  body: AgentTestRequest,
  signal?: AbortSignal,
): Promise<ConnectionTestResponse> {
  const start = Date.now();
  try {
    const response = await fetch('/api/test/connection', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'agent', ...body }),
      signal,
    });
    if (!response.ok) {
      let detail: string | undefined;
      try {
        const payload = (await response.json()) as
          | { error?: { message?: string }; message?: string }
          | null;
        detail = payload?.error?.message ?? payload?.message;
      } catch {
        // body was not JSON — keep detail undefined.
      }
      return {
        ok: false,
        kind: 'unknown',
        latencyMs: Date.now() - start,
        model: body.model?.trim() || 'default',
        detail: detail ?? `Daemon responded with ${response.status}`,
      };
    }
    return (await response.json()) as ConnectionTestResponse;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    return {
      ok: false,
      kind: 'unknown',
      latencyMs: Date.now() - start,
      model: body.model?.trim() || 'default',
      detail: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}

export function testAgent(
  input: AgentTestRequest,
  signal?: AbortSignal,
): Promise<ConnectionTestResponse> {
  return postTest(input, signal);
}
