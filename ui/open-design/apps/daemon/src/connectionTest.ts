// Smoke test for the Settings dialog. `testAgentConnection` spawns the
// selected Local CLI adapter with a tiny "Reply with only: ok" prompt, drives
// the existing stream parser through a collector sink, and treats assistant
// text as proof that the CLI can run unless the text is an explicit
// model-selection error. It persists nothing — no project, no chat record.

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, EnvHttpProxyAgent, Socks5ProxyAgent } from 'undici';
import type { Dispatcher, Pool } from 'undici';
import {
  applyAgentLaunchEnv,
  getAgentDef,
  resolveAgentLaunch,
  spawnEnvForAgent,
} from './agents.js';
import {
  createCommandInvocation,
  mergeProxyAwareEnv,
  resolveSystemProxyEnv,
} from '@open-design/platform';
import { createClaudeStreamHandler } from './runtimes/claude-stream.js';
import { agentCliEnvForAgent, validateAgentCliEnv } from './app-config.js';
import {
  classifyAgentServiceFailure,
  probeAgentAuthStatus,
} from './runtimes/auth.js';
import type { RuntimeAgentDef } from './runtimes/types.js';
import type {
  AgentTestRequest,
  ConnectionTestDiagnostics,
  ConnectionTestKind,
  ConnectionTestPhase,
  ConnectionTestResponse,
} from '@open-design/contracts/api/connectionTest';

const LOOPBACK_NO_PROXY_TOKENS = ['localhost', '127.0.0.1', '[::1]'] as const;
// CLI boot time is dominated by adapter auth/session restore; the heavy
// adapters regularly take 5–10 s on a cold first
// run, so 45 s leaves headroom without making a hung child invisible.
// Override with OD_CONNECTION_TEST_AGENT_TIMEOUT_MS.
const DEFAULT_AGENT_TIMEOUT_MS = 45_000;
const AGENT_STDOUT_DRAIN_MS = 25;
// Node's `setTimeout` silently clamps any delay above this to ~1 ms
// (with a TimeoutOverflowWarning), so an override meant to *extend*
// the budget — e.g. `OD_CONNECTION_TEST_AGENT_TIMEOUT_MS=3000000000` —
// would actually make every connection test fail almost immediately.
// Reject above the cap so the safety timeout cannot be accidentally
// disarmed by an oversized env value.
const MAX_CONNECTION_TEST_TIMEOUT_MS = 2_147_483_647;

type AgentConnectionInput = AgentTestRequest & { signal?: AbortSignal };

function smokeFailureDetail(sample: string): string {
  return sample
    ? `Expected smoke test reply "ok"; got "${sample}"`
    : 'The agent returned a 2xx response without assistant text';
}

export function resolveConnectionTestTimeoutMs(
  key: 'OD_CONNECTION_TEST_AGENT_TIMEOUT_MS',
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_CONNECTION_TEST_TIMEOUT_MS) {
    console.warn(
      `connection-test: ignoring ${key}=${JSON.stringify(raw)} (must be a positive integer between 1 and ${MAX_CONNECTION_TEST_TIMEOUT_MS} ms); using ${fallback}ms`,
    );
    return fallback;
  }
  return n;
}

function agentTimeoutMs(): number {
  return resolveConnectionTestTimeoutMs(
    'OD_CONNECTION_TEST_AGENT_TIMEOUT_MS',
    DEFAULT_AGENT_TIMEOUT_MS,
  );
}

export function mergeNoProxyWithLoopbackDefaults(noProxy: string | undefined): string | null {
  if (noProxy?.split(/[\s,]+/).some((token) => token.trim() === '*')) return '*';
  const seen = new Set<string>();
  const values: string[] = [];
  for (const rawToken of [
    ...(noProxy ? noProxy.split(/[\s,]+/) : []),
    ...LOOPBACK_NO_PROXY_TOKENS,
  ]) {
    const token = rawToken.trim() === '::1' ? '[::1]' : rawToken.trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    values.push(token);
  }
  return values.length > 0 ? values.join(',') : null;
}

function defaultPortForProtocol(protocol: string): string {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function splitNoProxyHostAndPort(token: string): { host: string; port: string } {
  const trimmed = token.trim();
  if (!trimmed) return { host: '', port: '' };
  if (trimmed.startsWith('[')) {
    const closingBracket = trimmed.indexOf(']');
    if (closingBracket === -1) return { host: trimmed.toLowerCase(), port: '' };
    const host = trimmed.slice(0, closingBracket + 1).toLowerCase();
    const port = trimmed.slice(closingBracket + 1).replace(/^:/, '');
    return { host, port };
  }
  const firstColon = trimmed.indexOf(':');
  const lastColon = trimmed.lastIndexOf(':');
  if (firstColon !== -1 && firstColon === lastColon) {
    return {
      host: trimmed.slice(0, firstColon).toLowerCase(),
      port: trimmed.slice(firstColon + 1),
    };
  }
  return { host: trimmed.toLowerCase(), port: '' };
}

function noProxyTokenMatchesUrl(token: string, url: URL): boolean {
  const trimmed = token.trim();
  if (!trimmed) return false;
  if (trimmed === '*') return true;
  if (trimmed === '<local>') return !url.hostname.includes('.') && !url.hostname.includes(':');
  const { host, port } = splitNoProxyHostAndPort(trimmed.replace(/^\*\./, '.'));
  if (!host) return false;
  const normalizedHost = host === '::1' ? '[::1]' : host;
  const hostname = url.hostname.toLowerCase();
  const matchesHost = normalizedHost.startsWith('.')
    ? hostname === normalizedHost.slice(1) || hostname.endsWith(normalizedHost)
    : hostname === normalizedHost || hostname.endsWith(`.${normalizedHost}`);
  if (!matchesHost) return false;
  if (!port) return true;
  return (url.port || defaultPortForProtocol(url.protocol)) === port;
}

function shouldBypassProxyForUrl(target: string | URL, noProxy: string | null): boolean {
  if (!noProxy) return false;
  let url: URL;
  try {
    url = target instanceof URL ? target : new URL(target);
  } catch {
    return false;
  }
  return noProxy.split(/[\s,]+/).some((token) => noProxyTokenMatchesUrl(token, url));
}

function socksProxyAgentOptions(
  options: Pool.Options,
): ConstructorParameters<typeof Socks5ProxyAgent>[1] {
  return {
    ...(options.bodyTimeout === undefined ? {} : { bodyTimeout: options.bodyTimeout }),
    ...(options.headersTimeout === undefined ? {} : { headersTimeout: options.headersTimeout }),
  };
}

class NoProxyAwareSocksProxyAgent {
  private readonly directAgent: Agent;

  private readonly socksAgent: Socks5ProxyAgent;

  private readonly socksDispatchTimeouts: Pick<Dispatcher.DispatchOptions, 'bodyTimeout' | 'headersTimeout'>;

  constructor(
    private readonly noProxy: string | null,
    socksProxy: string,
    options: Pool.Options,
  ) {
    this.directAgent = new Agent(options as ConstructorParameters<typeof Agent>[0]);
    this.socksAgent = new Socks5ProxyAgent(socksProxy, socksProxyAgentOptions(options));
    this.socksDispatchTimeouts = {
      ...(options.bodyTimeout === undefined ? {} : { bodyTimeout: options.bodyTimeout }),
      ...(options.headersTimeout === undefined
        ? {}
        : { headersTimeout: options.headersTimeout }),
    };
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin;
    const targetUrl =
      typeof origin === 'string' || origin instanceof URL
        ? new URL(options.path, origin)
        : null;
    const dispatcher =
      targetUrl && shouldBypassProxyForUrl(targetUrl, this.noProxy)
        ? this.directAgent
        : this.socksAgent;
    return dispatcher.dispatch(
      dispatcher === this.socksAgent ? { ...this.socksDispatchTimeouts, ...options } : options,
      handler,
    );
  }

  async close(): Promise<void> {
    await Promise.all([this.directAgent.close(), this.socksAgent.close()]);
  }

  async destroy(error?: Error | null): Promise<void> {
    await Promise.all([
      this.directAgent.destroy(error ?? null),
      this.socksAgent.destroy(error ?? null),
    ]);
  }
}

class NoProxyAwareEnvProxyAgent {
  private readonly directAgent: Agent;

  constructor(
    private readonly noProxy: string,
    private readonly proxyAgent: EnvHttpProxyAgent,
    options: Pool.Options,
  ) {
    this.directAgent = new Agent(options as ConstructorParameters<typeof Agent>[0]);
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin;
    const targetUrl =
      typeof origin === 'string' || origin instanceof URL
        ? new URL(options.path, origin)
        : null;
    return (targetUrl && shouldBypassProxyForUrl(targetUrl, this.noProxy) ? this.directAgent : this.proxyAgent).dispatch(
      options,
      handler,
    );
  }

  async close(): Promise<void> {
    await Promise.all([this.directAgent.close(), this.proxyAgent.close()]);
  }

  async destroy(error?: Error | null): Promise<void> {
    await Promise.all([
      this.directAgent.destroy(error ?? null),
      this.proxyAgent.destroy(error ?? null),
    ]);
  }
}

class NoProxyAwareMixedProxyAgent {
  private readonly directAgent: Agent;

  private readonly proxyAgent: EnvHttpProxyAgent;

  private readonly socksAgent: Socks5ProxyAgent;

  private readonly socksDispatchTimeouts: Pick<Dispatcher.DispatchOptions, 'bodyTimeout' | 'headersTimeout'>;

  constructor(
    private readonly noProxy: string | null,
    private readonly hasHttpProxy: boolean,
    private readonly hasHttpsProxy: boolean,
    proxyOptions: ConstructorParameters<typeof EnvHttpProxyAgent>[0],
    socksProxy: string,
    options: Pool.Options,
  ) {
    this.directAgent = new Agent(options as ConstructorParameters<typeof Agent>[0]);
    this.proxyAgent = new EnvHttpProxyAgent(proxyOptions);
    this.socksAgent = new Socks5ProxyAgent(socksProxy, socksProxyAgentOptions(options));
    this.socksDispatchTimeouts = {
      ...(options.bodyTimeout === undefined ? {} : { bodyTimeout: options.bodyTimeout }),
      ...(options.headersTimeout === undefined
        ? {}
        : { headersTimeout: options.headersTimeout }),
    };
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const origin = options.origin;
    const targetUrl =
      typeof origin === 'string' || origin instanceof URL
        ? new URL(options.path, origin)
        : null;
    if (targetUrl && shouldBypassProxyForUrl(targetUrl, this.noProxy)) {
      return this.directAgent.dispatch(options, handler);
    }
    if (
      targetUrl && ((targetUrl.protocol === 'http:' && this.hasHttpProxy) ||
        (targetUrl.protocol === 'https:' && this.hasHttpsProxy))
    ) {
      return this.proxyAgent.dispatch(options, handler);
    }
    return this.socksAgent.dispatch({ ...this.socksDispatchTimeouts, ...options }, handler);
  }

  async close(): Promise<void> {
    await Promise.all([this.directAgent.close(), this.proxyAgent.close(), this.socksAgent.close()]);
  }

  async destroy(error?: Error | null): Promise<void> {
    await Promise.all([
      this.directAgent.destroy(error ?? null),
      this.proxyAgent.destroy(error ?? null),
      this.socksAgent.destroy(error ?? null),
    ]);
  }
}

type ConnectionTestProxyDispatcher =
  | EnvHttpProxyAgent
  | NoProxyAwareEnvProxyAgent
  | NoProxyAwareMixedProxyAgent
  | NoProxyAwareSocksProxyAgent;

function envProxyAgentOptions(
  options: Pool.Options,
  httpProxy: string | undefined,
  httpsProxy: string | undefined,
  noProxy: string | null,
): ConstructorParameters<typeof EnvHttpProxyAgent>[0] {
  return {
    ...options,
    ...(httpProxy ? { httpProxy } : {}),
    ...(httpsProxy ? { httpsProxy } : {}),
    ...(noProxy ? { noProxy } : {}),
  };
}

function buildConnectionTestProxyDispatcher(
  env: NodeJS.ProcessEnv = process.env,
  options: Pool.Options = {},
): ConnectionTestProxyDispatcher | null {
  const proxyEnv = mergeProxyAwareEnv(
    process.platform,
    resolveSystemProxyEnv(),
    env,
  );
  const allProxy = proxyEnv.ALL_PROXY ?? proxyEnv.all_proxy;
  const socksProxy = socksProxyUrl(allProxy);
  const httpProxyFromAll = isHttpOrHttpsProxy(allProxy);
  const httpProxy = proxyEnv.HTTP_PROXY ?? proxyEnv.http_proxy ?? httpProxyFromAll;
  const httpsProxy = proxyEnv.HTTPS_PROXY ?? proxyEnv.https_proxy ?? httpProxyFromAll;
  const noProxy = mergeNoProxyWithLoopbackDefaults(proxyEnv.NO_PROXY ?? proxyEnv.no_proxy);
  const proxyOptions = envProxyAgentOptions(options, httpProxy, httpsProxy, noProxy);
  if (socksProxy && (httpProxy || httpsProxy) && (!httpProxy || !httpsProxy)) {
    return new NoProxyAwareMixedProxyAgent(
      noProxy,
      Boolean(httpProxy),
      Boolean(httpsProxy),
      proxyOptions,
      socksProxy,
      options,
    );
  }
  if (!httpProxy && !httpsProxy && socksProxy) {
    return new NoProxyAwareSocksProxyAgent(noProxy, socksProxy, options);
  }
  if (!httpProxy && !httpsProxy) return null;
  const proxyAgent = new EnvHttpProxyAgent(proxyOptions);
  return noProxy?.split(/[\s,]+/).some((token) => token.trim() === '<local>')
    ? new NoProxyAwareEnvProxyAgent(noProxy, proxyAgent, options)
    : proxyAgent;
}

function isHttpOrHttpsProxy(proxyUrl: string | undefined): string | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return undefined;
  try {
    const { protocol } = new URL(trimmed);
    return protocol === 'http:' || protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

function socksProxyUrl(proxyUrl: string | undefined): string | undefined {
  const trimmed = proxyUrl?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol === 'socks:' || url.protocol === 'socks5:') return trimmed;
    if (url.protocol === 'socks5h:') {
      url.protocol = 'socks5:';
      return url.toString();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function proxyDispatcherRequestInit(
  env: NodeJS.ProcessEnv = process.env,
  options: Pool.Options = {},
): {
  close(): Promise<void>;
  requestInit: Pick<RequestInit, 'dispatcher'>;
} {
  const dispatcher = buildConnectionTestProxyDispatcher(env, options);
  if (dispatcher == null) {
    return {
      async close() {},
      requestInit: {},
    };
  }
  return {
    close: () => dispatcher.close(),
    requestInit: {
      dispatcher: dispatcher as unknown as NonNullable<RequestInit['dispatcher']>,
    },
  };
}

const AGENT_COMPLETION_DEBOUNCE_MS = 500;
const AGENT_KILL_GRACE_MS = 2_000;
// Truncates the assistant reply we surface in the success copy so a
// chatty model can't dump kilobytes into the inline status node.
const SAMPLE_MAX_CHARS = 120;
// Generation budget for the smoke prompt. Keep this small, but not tiny:
// reasoning models can spend the first few dozen tokens in hidden reasoning
// before producing a visible `ok`.
const PROVIDER_MAX_TOKENS = 100;
const SMOKE_PROMPT = 'Reply with only: ok';

function formatPromptForAgentStdin(
  def: Pick<RuntimeAgentDef, 'promptInputFormat'>,
  prompt: string,
): string {
  const promptInputFormat = def.promptInputFormat ?? 'text';
  if (promptInputFormat === 'stream-json') {
    return `${JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: prompt }],
      },
    })}\n`;
  }
  return prompt;
}





// Catches `Bearer …`, `x-api-key`/`api-key`/`x-goog-api-key` headers, and
// `?key=…` query strings. Agent error text is funnelled through this before
// logging so a leaked key stays out of the daemon log.
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactSecrets(
  text: string,
  exactSecrets: Array<string | undefined | null> = [],
): string {
  if (typeof text !== 'string' || text.length === 0) return '';
  let redacted = text
    .replace(/Bearer\s+[A-Za-z0-9_\-.+/=]+/gi, 'Bearer [REDACTED]')
    .replace(/(x-api-key|api-key|x-goog-api-key)\s*[:=]\s*[^\s,;"']+/gi, '$1: [REDACTED]')
    .replace(/([?&]key=)[^&\s]+/gi, '$1[REDACTED]');
  for (const secret of exactSecrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    redacted = redacted.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }
  return redacted;
}

function truncateSample(text: unknown): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= SAMPLE_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, SAMPLE_MAX_CHARS - 1)}…`;
}

export function isSmokeOkReply(text: unknown): boolean {
  return typeof text === 'string' && text.trim().toLowerCase() === 'ok';
}

function isLikelyModelErrorText(text: string): boolean {
  return (
    /model/i.test(text) &&
    /(not found|not exist|does not exist|unknown|invalid|unsupported|not supported|not have access|no access|issue with the selected model)/i.test(
      text,
    )
  );
}

function isLikelyAuthErrorText(text: string): boolean {
  return /(?:api[_ -]?key|x-goog-api-key|unauthorized|unauthenticated|permission denied|invalid credentials|authentication credentials|access denied|invalid key)/i.test(
    text,
  );
}

// Build a `send(event, payload)` collector that buffers assistant text until
// the stream goes quiet. Mirrors the shape startChatRun hands to the stream
// parsers, so the parsers don't notice they're talking to a test rather than
// the real SSE writer.
type AgentSinkResult =
  | { kind: 'text'; text: string }
  | { kind: 'streamError'; error: Error };

interface AgentSink {
  send: (event: string, payload: unknown) => void;
  result: Promise<AgentSinkResult>;
  streamError: Promise<Error>;
  getText: () => string;
  getStderrTail: () => string;
  appendRawStdout: (chunk: string) => void;
  getRawStdout: () => string;
  getRawStdoutTail: () => string;
  sawTerminalCompletion: () => boolean;
  dispose: () => void;
}

function isTerminalCompletionStopReason(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0 && value !== 'tool_use';
}


export function createAgentSink(): AgentSink {
  let buffer = '';
  let stderrTail = '';
  let rawStdout = '';
  let rawStdoutTail = '';
  let terminalCompletionSeen = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveResult!: (value: AgentSinkResult) => void;
  let resolveStreamError!: (value: Error) => void;
  let settled = false;
  let streamErrorSettled = false;
  const result = new Promise<AgentSinkResult>((resolve) => {
    resolveResult = (value) => {
      if (settled) return;
      settled = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      resolve(value);
    };
  });
  const streamError = new Promise<Error>((resolve) => {
    resolveStreamError = (error) => {
      if (streamErrorSettled) return;
      streamErrorSettled = true;
      resolve(error);
    };
  });

  const publishStreamError = (error: Error) => {
    resolveStreamError(error);
    resolveResult({ kind: 'streamError', error });
  };

  const scheduleTextResolution = () => {
    if (settled || buffer.trim().length === 0) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      resolveResult({ kind: 'text', text: buffer });
    }, AGENT_COMPLETION_DEBOUNCE_MS);
    debounceTimer.unref?.();
  };

  const consumeText = (text: string) => {
    if (typeof text !== 'string' || text.length === 0) return;
    buffer += text;
    scheduleTextResolution();
  };

  const appendRawStdout = (chunk: string) => {
    if (typeof chunk === 'string' && chunk.length > 0) {
      rawStdout = (rawStdout + chunk).slice(-16_384);
      rawStdoutTail = (rawStdoutTail + chunk).slice(-400);
    }
  };

  const send = (event: string, payload: unknown) => {
    const data = (payload ?? {}) as Record<string, unknown>;
    if (event === 'error') {
      const message =
        typeof data.message === 'string'
          ? data.message
          : typeof (data as { error?: { message?: string } }).error?.message === 'string'
            ? (data as { error: { message: string } }).error.message
            : 'agent stream error';
      publishStreamError(new Error(message));
      return;
    }
    if (event === 'agent') {
      const type = data.type;
      if (type === 'error') {
        const message =
          typeof data.message === 'string' ? data.message : 'agent stream error';
        publishStreamError(new Error(message));
        return;
      }
      const delta = data.delta;
      const text = data.text;
      if (type === 'text_delta' && typeof delta === 'string') {
        consumeText(delta);
      } else if (type === 'text' && typeof text === 'string') {
        consumeText(text);
      } else if (
        (type === 'turn_end' || type === 'usage') &&
        isTerminalCompletionStopReason(data.stopReason)
      ) {
        terminalCompletionSeen = true;
      }
      return;
    }
    if (event === 'stdout') {
      const chunk = data.chunk;
      if (typeof chunk === 'string') {
        appendRawStdout(chunk);
        consumeText(chunk);
      }
      return;
    }
    if (event === 'stderr') {
      const chunk = data.chunk;
      if (typeof chunk === 'string') {
        stderrTail = (stderrTail + chunk).slice(-400);
      }
      return;
    }
    // Ignore 'start', 'status', 'end', 'tool_use', 'thinking', etc. —
    // they don't carry assistant prose.
  };

  return {
    send,
    result,
    streamError,
    getText: () => buffer,
    getStderrTail: () => stderrTail,
    appendRawStdout,
    getRawStdout: () => rawStdout,
    getRawStdoutTail: () => rawStdoutTail,
    sawTerminalCompletion: () => terminalCompletionSeen,
    dispose: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
  };
}




interface AgentSpawnHandle {
  child: ReturnType<typeof spawn>;
}

function attachAgentStreamHandlers(
  def: { streamFormat?: string; eventParser?: string; id: string; promptViaStdin?: boolean },
  child: ReturnType<typeof spawn>,
  prompt: string,
  cwd: string,
  model: string | undefined,
  modelEnv: Record<string, string | undefined>,
  liveModelScope: string | null,
  send: (event: string, payload: unknown) => void,
  appendRawStdout?: (chunk: string) => void,
  reasoningEffort?: string,
): AgentSpawnHandle {
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  {
    const claude = createClaudeStreamHandler((ev: unknown) => send('agent', ev));
    child.stdout?.on('data', (chunk: string) => {
      appendRawStdout?.(chunk);
      claude.feed(chunk);
    });
    child.on('close', () => claude.flush());
  }
  child.stderr?.on('data', (chunk: string) => send('stderr', { chunk }));
  return { child };
}

type AgentChild = ReturnType<typeof spawn>;
type AgentChildExit =
  | { kind: 'exit'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'spawnError'; error: Error };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}



async function testAgentConnectionInternal(
  input: AgentConnectionInput,
): Promise<ConnectionTestResponse> {
  const start = Date.now();
  const model =
    typeof input.model === 'string' && input.model.trim()
      ? input.model.trim()
      : 'default';
  const def = getAgentDef(input.agentId);
  if (!def) {
    return {
      ok: false,
      kind: 'agent_not_installed',
      latencyMs: Date.now() - start,
      model,
      agentName: input.agentId,
      detail: `Unknown agent id: ${input.agentId}`,
      diagnostics: { phase: 'binary_resolution' },
    };
  }
  const configuredAgentEnv = agentCliEnvForAgent(
    validateAgentCliEnv(input.agentCliEnv),
    input.agentId,
  );
  const executableResolution = resolveAgentLaunch(def, configuredAgentEnv);
  const resolvedBin = executableResolution.selectedPath;
  if (!resolvedBin || !executableResolution.launchPath) {
    return {
      ok: false,
      kind: 'agent_not_installed',
      latencyMs: Date.now() - start,
      model,
      agentName: def.name,
      diagnostics: { phase: 'binary_resolution' },
    };
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-conn-test-'));
  let child: AgentChild | null = null;
  let childExit: Promise<AgentChildExit> | null = null;
  let childClosed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  const sink = createAgentSink();

  // Phase tracker for structured diagnostics (#2248). The order matches
  // the lifecycle: binary_resolution → spawn → connection_smoke_test →
  // output_parse. Each result helper below stamps the *current* phase
  // into the response so consumers don't have to scrape `detail` to
  // know how far the test got. Phase is mutated at the points where
  // the daemon meaningfully advances (just before spawn, when the
  // child first produces stdout, etc.) — not on every event.
  let phase: ConnectionTestPhase = 'binary_resolution';
  const buildDiagnostics = (
    overrides: Partial<ConnectionTestDiagnostics> = {},
  ): ConnectionTestDiagnostics => {
    const rawStderr = sink.getStderrTail().trim();
    const rawStdout = sink.getRawStdoutTail().trim();
    // `exactOptionalPropertyTypes: true` means we can't pass `undefined`
    // to an optional field directly — conditionally spread instead so
    // empty values just don't appear in the response.
    return {
      phase,
      ...(executableResolution.launchPath
        ? { binaryPath: executableResolution.launchPath }
        : {}),
      ...(rawStderr ? { stderrTail: redactSecrets(rawStderr) } : {}),
      ...(rawStdout ? { stdoutTail: redactSecrets(rawStdout) } : {}),
      ...overrides,
    };
  };

  const resultFromAgentText = (
    text: string,
    exit?: { code: number | null; signal: NodeJS.Signals | null },
  ): ConnectionTestResponse => {
    const latencyMs = Date.now() - start;
    const rawSample = truncateSample(text);
    const sample = redactSecrets(rawSample);
    if (rawSample && isLikelyModelErrorText(rawSample)) {
      const detail = redactSecrets(smokeFailureDetail(rawSample));
      console.warn(
        `[test:agent] ${def.name} → not_found_model: ${detail}`,
      );
      return {
        ok: false,
        kind: 'not_found_model',
        latencyMs,
        model,
        agentName: def.name,
        detail,
        diagnostics: buildDiagnostics({
          phase: 'output_parse',
          ...(exit ? { exitCode: exit.code, signal: exit.signal } : {}),
        }),
      };
    }
    if (!isSmokeOkReply(text)) {
      console.warn(
        `[test:agent] ${def.name} → connected_unexpected_sample: ${sample}`,
      );
    }
    console.log(`[test:agent] ${def.name} → ok in ${(latencyMs / 1000).toFixed(1)}s`);
    // Pass through the real `winner.code` / `winner.signal` when the caller
    // has them and only synthesize `exitCode: 0` when no exit context is
    // available (theoretical text-without-exit path).
    return {
      ok: true,
      kind: 'success',
      latencyMs,
      model,
      agentName: def.name,
      sample,
      diagnostics: buildDiagnostics(
        exit
          ? { phase: 'connection_smoke_test', exitCode: exit.code, signal: exit.signal }
          : { phase: 'connection_smoke_test', exitCode: 0 },
      ),
    };
  };

  const resultFromStreamError = (error: unknown): ConnectionTestResponse => {
    const latencyMs = Date.now() - start;
    const detail = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    const auth = classifyAgentServiceFailure(detail) === 'AGENT_AUTH_REQUIRED';
    if (auth) {
      console.warn(`[test:agent] ${def.name} → auth_required: ${detail}`);
      return {
        ok: false,
        kind: 'agent_auth_required',
        latencyMs,
        model,
        agentName: def.name,
        detail: detail || `${def.name} authentication required.`,
        diagnostics: buildDiagnostics(),
      };
    }
    if (detail && isLikelyModelErrorText(detail)) {
      console.warn(
        `[test:agent] ${def.name} → not_found_model: ${detail}`,
      );
      return {
        ok: false,
        kind: 'not_found_model',
        latencyMs,
        model,
        agentName: def.name,
        detail,
        diagnostics: buildDiagnostics({ phase: 'output_parse' }),
      };
    }
    console.warn(
      `[test:agent] ${def.name} → stream_error: ${detail}`,
    );
    return {
      ok: false,
      kind: 'agent_spawn_failed',
      latencyMs,
      model,
      agentName: def.name,
      detail,
      diagnostics: buildDiagnostics(),
    };
  };

  const resultFromCancellation = (
    kind: 'timeout' | 'aborted',
  ): ConnectionTestResponse => {
    const latencyMs = Date.now() - start;
    console.warn(`[test:agent] ${def.name} → ${kind} in ${(latencyMs / 1000).toFixed(1)}s`);
    return {
      ok: false,
      kind: 'timeout',
      latencyMs,
      model,
      agentName: def.name,
      diagnostics: buildDiagnostics(),
    };
  };

  try {
    let args: string[];
    try {
      args = def.buildArgs(
        SMOKE_PROMPT,
        [],
        [],
        { model: input.model ?? null, reasoning: input.reasoning ?? null },
        {
          cwd: tempDir,
        },
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // buildArgs runs *after* binary resolution but *before* spawn, so
      // phase is still 'binary_resolution' here. Stamp diagnostics so the
      // contract advertised in packages/contracts/src/api/connectionTest.ts
      // ("Always set on local agent test responses") actually holds.
      return {
        ok: false,
        kind: 'agent_spawn_failed',
        latencyMs: Date.now() - start,
        model,
        agentName: def.name,
        detail: redactSecrets(detail),
        diagnostics: buildDiagnostics(),
      };
    }
    const stdinMode =
      def.promptViaStdin || false ? 'pipe' : 'ignore';
    const baseEnv = spawnEnvForAgent(
      input.agentId,
      {
        ...process.env,
        ...(def.env || {}),
      },
      configuredAgentEnv,
      undefined,
      { resolvedBin: executableResolution.selectedPath },
    );
    const env = applyAgentLaunchEnv({
      ...baseEnv,
      ...({}),
    }, executableResolution);
    const auth = await probeAgentAuthStatus(def, executableResolution.launchPath, env);
    if (auth?.status === 'missing') {
      // Preflight auth probe runs after binary resolution but before the
      // smoke spawn — phase is still 'binary_resolution'. The smoke
      // sink is empty here (no spawn happened), so the probe itself is
      // the only source of stderr/stdout/exit context. Fold what the
      // probe captured into the diagnostics block; `...overrides` in
      // buildDiagnostics() lets these win over the empty sink tails.
      const probeOverrides: Partial<ConnectionTestDiagnostics> = {};
      if (auth.stdoutTail) probeOverrides.stdoutTail = redactSecrets(auth.stdoutTail);
      if (auth.stderrTail) probeOverrides.stderrTail = redactSecrets(auth.stderrTail);
      if (auth.exitCode !== undefined) probeOverrides.exitCode = auth.exitCode;
      if (auth.signal !== undefined) probeOverrides.signal = auth.signal;
      return {
        ok: false,
        kind: 'agent_auth_required',
        latencyMs: Date.now() - start,
        model,
        agentName: def.name,
        detail: auth.message ?? `${def.name} authentication required.`,
        diagnostics: buildDiagnostics(probeOverrides),
      };
    }
    const invocation = createCommandInvocation({
      command: executableResolution.launchPath,
      args,
      env,
    });
    // We are about to hand off to child_process.spawn(). Any failure
    // from here on (ENOENT, bad argv, non-zero exit) belongs to the
    // 'spawn' phase rather than 'binary_resolution', so flip the tracker
    // *before* spawning. resultFromAgentText flips it again to
    // 'connection_smoke_test' / 'output_parse' once we get text out.
    phase = 'spawn';
    child = spawn(invocation.command, invocation.args, {
      env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: tempDir,
      shell: false,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    childExit = new Promise<AgentChildExit>((resolve) => {
      child!.once('error', (err) => {
        childClosed = true;
        resolve({ kind: 'spawnError', error: err });
      });
      child!.once('close', (code, signal) => {
        childClosed = true;
        resolve({ kind: 'exit', code, signal });
      });
    });

    attachAgentStreamHandlers(
      def,
      child,
      SMOKE_PROMPT,
      tempDir,
      input.model,
      env,
      null,
      sink.send,
      sink.appendRawStdout,
      input.reasoning,
    );

    const resultFromChildExit = async (
      winner: AgentChildExit,
    ): Promise<ConnectionTestResponse> => {
      if (winner.kind === 'spawnError') {
        const latencyMs = Date.now() - start;
        const detail = redactSecrets(winner.error.message);
        const guidance = redactSecrets(
          `${executableResolution.diagnostic ? ` ${executableResolution.diagnostic}` : ''}`,
        );
        const errnoCode = (winner.error as NodeJS.ErrnoException).code;
        const isMissing = errnoCode === 'ENOENT';
        console.warn(
          `[test:agent] ${def.name} → spawn_failed: ${detail}${guidance}`,
        );
        return {
          ok: false,
          kind: isMissing ? 'agent_not_installed' : 'agent_spawn_failed',
          latencyMs,
          model,
          agentName: def.name,
          detail: `${detail}${guidance}`,
          diagnostics: buildDiagnostics({
            phase: isMissing ? 'binary_resolution' : 'spawn',
          }),
        };
      }

      // On Windows, short-lived JSON-stream CLIs can deliver the process
      // close event before all stdout chunks have reached the parser.
      await delay(AGENT_STDOUT_DRAIN_MS);
      const latencyMs = Date.now() - start;
      const buffered = sink.getText().trim();
      const visibleText = buffered;
      const exitedCleanly = winner.code === 0 && !winner.signal;
      if (visibleText) {
        const rawSample = truncateSample(visibleText);
        const exitInfo = { code: winner.code, signal: winner.signal };
        if (rawSample && isLikelyModelErrorText(rawSample)) {
          return resultFromAgentText(visibleText, exitInfo);
        }
        if (exitedCleanly) return resultFromAgentText(visibleText, exitInfo);
      }
      const stderrTail = sink.getStderrTail().trim();
      const rawStdoutTail = sink.getRawStdoutTail().trim();
      const rawDetail = [
        winner.code != null ? `exit ${winner.code}` : null,
        winner.signal ? `signal ${winner.signal}` : null,
        stderrTail ? `stderr: ${stderrTail.slice(-200)}` : null,
        rawStdoutTail || buffered
          ? `stdout: ${(rawStdoutTail || buffered).slice(-200)}`
          : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const auth = classifyAgentServiceFailure(rawDetail) === 'AGENT_AUTH_REQUIRED';
      if (auth) {
        console.warn(`[test:agent] ${def.name} → auth_required: ${redactSecrets(rawDetail)}`);
        return {
          ok: false,
          kind: 'agent_auth_required',
          latencyMs,
          model,
          agentName: def.name,
          detail: rawDetail || `${def.name} authentication required.`,
          diagnostics: buildDiagnostics({
            phase: 'connection_smoke_test',
            exitCode: winner.code,
            signal: winner.signal,
          }),
        };
      }
      const detail = redactSecrets(
        rawDetail,
      );
      const guidance = redactSecrets(
        `${executableResolution.diagnostic ? ` ${executableResolution.diagnostic}` : ''}`,
      );
      const label = buffered ? 'exit_failed' : 'no_text';
      console.warn(
        `[test:agent] ${def.name} → ${label} (${detail || 'no detail'}${guidance})`,
      );
      return {
        ok: false,
        kind: !exitedCleanly ? 'agent_spawn_failed' : 'unknown',
        latencyMs,
        model,
        agentName: def.name,
        detail:
          `${detail || 'Agent exited without producing assistant text'}${guidance}`,
        diagnostics: buildDiagnostics({
          phase: buffered ? 'output_parse' : 'spawn',
          exitCode: winner.code,
          signal: winner.signal,
        }),
      };
    };

    if (def.promptViaStdin && child.stdin) {
      child.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EPIPE') {
          sink.send('error', {
            message: `stdin: ${err.message}`,
          });
        }
      });
      child.stdin.end(formatPromptForAgentStdin(def, SMOKE_PROMPT), 'utf8');
    }
    const cancellationPromise = new Promise<{ kind: 'timeout' } | { kind: 'aborted' }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), agentTimeoutMs());
      abortHandler = () => resolve({ kind: 'aborted' });
      if (input.signal?.aborted) {
        abortHandler();
      } else {
        input.signal?.addEventListener('abort', abortHandler, { once: true });
      }
    });
    const streamError = sink.streamError.then((error) => ({
      kind: 'streamError' as const,
      error,
    }));

    const winner = await Promise.race([
      sink.result,
      childExit,
      cancellationPromise,
    ]);

    if (winner.kind === 'text') {
      const completion = await Promise.race([
        streamError,
        childExit,
        cancellationPromise,
      ]);
      if (completion.kind === 'streamError') {
        return resultFromStreamError(completion.error);
      }
      if (completion.kind === 'timeout' || completion.kind === 'aborted') {
        return resultFromCancellation(completion.kind);
      }
      return await resultFromChildExit(completion);
    }
    if (winner.kind === 'streamError') {
      return resultFromStreamError(winner.error);
    }
    if (winner.kind === 'timeout' || winner.kind === 'aborted') {
      return resultFromCancellation(winner.kind);
    }
    return await resultFromChildExit(winner);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    // Outer catch — the failure may have happened at any phase between
    // binary_resolution and output_parse, so stamp the current phase as
    // observed. buildDiagnostics is defined in the enclosing scope and
    // is safe to call here.
    return {
      ok: false,
      kind: 'agent_spawn_failed',
      latencyMs: Date.now() - start,
      model,
      agentName: def.name,
      detail: redactSecrets(detail),
      diagnostics: buildDiagnostics(),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) {
      input.signal?.removeEventListener('abort', abortHandler);
    }
    sink.dispose();
    if (child && !childClosed) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone — nothing to do.
      }
      const closedAfterTerm = childExit
        ? await Promise.race([
            childExit.then(() => true),
            delay(AGENT_KILL_GRACE_MS).then(() => false),
          ])
        : false;
      if (!closedAfterTerm && !childClosed) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone — nothing to do.
        }
        if (childExit) {
          await Promise.race([
            childExit.catch(() => null),
            delay(AGENT_KILL_GRACE_MS),
          ]);
        }
      }
    }
    await fsp
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => {
        // Best-effort cleanup; the OS reaps /tmp eventually.
      });
  }
}

export async function testAgentConnection(
  input: AgentConnectionInput,
): Promise<ConnectionTestResponse> {
  return testAgentConnectionInternal(input);
}
