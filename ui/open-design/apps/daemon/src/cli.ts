#!/usr/bin/env node
// @ts-nocheck
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { runDaemonCliStartup, startDaemonRuntime } from './daemon-startup.js';
import { runArtifactsCli } from './artifacts-cli.js';
import { splitResearchSubcommand } from './research/cli-args.js';
import { resolveDaemonUrl } from './daemon-url.js';
import { requestJsonIpc } from '@open-design/sidecar';
import { SIDECAR_ENV, SIDECAR_MESSAGES } from '@open-design/sidecar-proto';
import { EXPORT_FORMATS, EXPORT_IMAGE_FORMATS } from '@open-design/contracts';
import { buildExportCliRequestBody, buildExportCliResultEnvelope, resolveExportCliDeckMode } from './export-cli-request.js';
import { exportRoutePath } from './export-cli-routing.js';

const argv = process.argv.slice(2);

// ---- Subcommand router ----------------------------------------------------
//
// Default mode starts the daemon and opens the web UI. Subcommands such as
// `od research …` and `od automation …` are thin clients that
// call the running daemon.
//
// We dispatch on the first positional argument so flags like --port keep
// working unchanged. Subcommand routing is keyword-based; flags are
// parsed inside each handler.

const RESEARCH_SEARCH_STRING_FLAGS = new Set([
  'query',
  'max-sources',
  'daemon-url',
]);
const RESEARCH_SEARCH_BOOLEAN_FLAGS = new Set([
  'help',
  'h',
]);

// Hoist flag set bindings consumed by handlers reachable through
// the top-of-file dispatcher. The dispatch block runs synchronously
// during module load; any const declared further down the file is
// still in TDZ when the handler executes, so `od status` / etc. would
// crash with `Cannot access X before
// initialization`.
const DAEMON_STRING_FLAGS = new Set([
  'daemon-url', 'port', 'host',
]);
const DAEMON_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json', 'headless', 'serve-web', 'no-open', 'quick',
]);
const LIBRARY_STRING_FLAGS = new Set(['daemon-url', 'query', 'tag']);
const LIBRARY_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const DIAGNOSTICS_STRING_FLAGS = new Set(['daemon-url', 'output']);
const DIAGNOSTICS_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const CONFIG_STRING_FLAGS = new Set(['daemon-url', 'value', 'value-json']);
const CONFIG_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
const PROJECT_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'skill', 'metadata-json',
  'pending-prompt', 'project', 'conversation', 'message', 'prompt',
  'prompt-file', 'path', 'dir', 'as',
  'agent', 'model', 'editor',
  'title', 'label', 'against', 'seed-from', 'fork-after', 'mode',
  'source',
]);
const PROJECT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json', 'follow']);
// `od templates …` mirrors NewProjectPanel / ExamplesTab. Same surface,
// same /api/templates store. The CLI form is the embeddability contract:
// external agents can snapshot, list, or
// remove user-saved project templates without going through the web UI.
const TEMPLATES_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'description',
]);
const TEMPLATES_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
// `od automation …` mirrors the Automations tab. Same surface, same
// /api/routines store. The CLI form is the embeddability contract:
// external agents can drive MatOS
// automations headlessly without going through the web UI.
const AUTOMATION_STRING_FLAGS = new Set([
  'daemon-url', 'name', 'prompt', 'prompt-file', 'schedule', 'target',
  'project', 'skill', 'agent', 'limit', 'mcp',
  'status', 'reason', 'template', 'source-kind', 'source-ref', 'title',
  'body', 'body-file', 'compression', 'sensitivity', 'account',
  'candidate-sinks',
]);
const AUTOMATION_BOOLEAN_FLAGS = new Set([
  'help', 'h', 'json', 'disabled', 'enabled',
]);
const FEEDBACK_STRING_FLAGS = new Set([
  'daemon-url', 'title', 'body', 'prompt-file', 'kind', 'severity',
  'context', 'contact', 'image',
]);
const FEEDBACK_BOOLEAN_FLAGS = new Set(['help', 'h', 'json']);
// Hoisted because `runAutomation` is reachable through the top-of-file
// SUBCOMMAND_MAP dispatch, which runs during module evaluation —
// any `const` declared further down would still be in TDZ when
// `parseScheduleFlag` reads this map. Same reason the other dispatch-
// touched constants live near the top.
const AUTOMATION_WEEKDAY_TOKENS = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const RECOVERABLE_EXIT_CODES = {
  'daemon-not-running':       64,
  'missing-input':            67,
  'project-not-found':        68,
  'run-not-found':            69,
  'provider-not-configured':  70,
  'desktop-auth-pending':     74,
  'desktop-import-token-rejected': 75,
};

const SUBCOMMAND_MAP = {
  artifacts: runArtifacts,
  research: runResearch,
  project: runProject,
  automation: runAutomation,
  automations: runAutomation,
  feedback: runFeedback,
  run: runRun,
  files: runFiles,
  templates: runTemplates,
  conversation: runConversation,
  chat: runChat,
  daemon: runDaemon,
  skills: runSkills,
  diagnostics: runDiagnostics,
  export: runExport,
  status: runStatus,
  version: runVersion,
  doctor: runDoctor,
  config: runConfig,
};

const EXPORT_STRING_FLAGS = new Set([
  'daemon-url', 'project', 'format', 'out', 'output', 'image-format', 'title', 'file',
]);
const EXPORT_BOOLEAN_FLAGS = new Set(['help', 'h', 'json', 'deck', 'page', 'no-deck']);
// EXPORT_FORMATS / EXPORT_IMAGE_FORMATS are the shared contract DTO (single
// source of truth for the web/daemon/CLI export surface), imported above.

function printExportHelp() {
  console.log(`Usage:
  od export <file> --project <id> --format <fmt> [options]

Programmatic export of an HTML/deck artifact to PDF, image, or PPTX. Runs
entirely from the rendered design (no model/agent calls). Rasterization uses
the desktop runtime's bundled Chromium, so a desktop/packaged runtime must be
reachable; otherwise the command reports that the renderer is unavailable.

Formats:  ${EXPORT_FORMATS.join(', ')}

Options:
  --project <id>           Project id (required)
  --format <fmt>           One of: ${EXPORT_FORMATS.join(' | ')} (required)
  --out <path>             Write the file here (defaults to the suggested name)
  --image-format <fmt>     png | jpeg (for --format image)
  --deck                   Treat the artifact as a multi-slide deck
  --page, --no-deck        Treat the artifact as a normal scrollable page
  --title <title>          Title used for metadata / default filename
  --json                   Print a machine-readable result envelope
  --daemon-url <url>       Override daemon URL

Examples:
  od export index.html --project p1 --format pdf --out page.pdf
  od export slide.html --project p1 --format image --image-format png --out slide.png
  od export deck.html --project p1 --format pptx --out deck.pptx`);
}

async function runExport(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printExportHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  let flags;
  try {
    flags = parseFlags(args, { string: EXPORT_STRING_FLAGS, boolean: EXPORT_BOOLEAN_FLAGS });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const pos = positionalArgs(args, EXPORT_STRING_FLAGS);
  const file = flags.file || pos[0];
  const projectId = flags.project || process.env.OD_PROJECT_ID;
  const format = flags.format;
  if (!file || !projectId || !format) {
    printExportHelp();
    process.exit(2);
  }
  if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
    console.error(`invalid --format: ${format} (expected ${EXPORT_FORMATS.join(' | ')})`);
    process.exit(2);
  }
  if (flags['image-format'] && !(EXPORT_IMAGE_FORMATS as readonly string[]).includes(flags['image-format'])) {
    console.error(`invalid --image-format: ${flags['image-format']} (expected ${EXPORT_IMAGE_FORMATS.join(' | ')})`);
    process.exit(2);
  }
  if (flags['image-format'] && format !== 'image') {
    console.error('--image-format is only valid with --format image');
    process.exit(2);
  }
  const base = await cliDaemonBaseUrl(flags);
  // All three formats rasterize through the desktop screenshot renderer so the
  // CLI matches the UI exactly. In particular `pdf` uses `/export/pdf-image`
  // (one raster page per deck slide / per viewport for a page) — NOT the generic
  // `/export` vector `printToPDF` path, which drops CJK glyphs in the packaged
  // runtime and is the bug this feature exists to avoid.
  const exportPath = exportRoutePath(format);
  let deckMode;
  try {
    deckMode = resolveExportCliDeckMode({
      format,
      deck: flags.deck === true,
      page: flags.page === true,
      noDeck: flags['no-deck'] === true,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  const requestBody = buildExportCliRequestBody({
    fileName: file,
    format,
    deck: deckMode,
    ...(format === 'image' && flags['image-format'] ? { imageFormat: flags['image-format'] } : {}),
    ...(flags.title ? { title: flags.title } : {}),
  });
  let resp;
  try {
    resp = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/${exportPath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    surfaceFetchError(err, base);
    process.exit(3);
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  const buffer = Buffer.from(await resp.arrayBuffer());
  let out = flags.out || flags.output;
  if (!out) {
    const cd = resp.headers.get('content-disposition') || '';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const plain = /filename="([^"]+)"/i.exec(cd);
    if (star && star[1]) {
      try { out = decodeURIComponent(star[1]); } catch { out = plain && plain[1] ? plain[1] : null; }
    } else if (plain && plain[1]) {
      out = plain[1];
    }
    if (!out) {
      const ext = format === 'image'
        ? (flags['image-format'] === 'jpeg' ? 'jpg' : 'png')
        : format === 'pptx' ? 'pptx' : 'pdf';
      out = `artifact.${ext}`;
    }
  }
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, buffer);
  if (flags.json) {
    return process.stdout.write(
      JSON.stringify(buildExportCliResultEnvelope({ path: out, bytes: buffer.length, format }), null, 2) + '\n',
    );
  }
  console.log(`wrote ${out} (${buffer.length} bytes)`);
}

const first = argv.find((a) => !a.startsWith('-'));
if (first && SUBCOMMAND_MAP[first]) {
  const idx = argv.indexOf(first);
  const rest = [...argv.slice(0, idx), ...argv.slice(idx + 1)];
  await SUBCOMMAND_MAP[first](rest);
  process.exit(0);
}

await runDaemonCliStartup(argv, { printHelp: printRootHelp });

function printRootHelp() {
  console.log(`Usage:
  od [--port <n>] [--host <addr>] [--no-open]
      Start the local daemon and open the web UI.

  od artifacts create --name <path> --input <file> [--project <id-or-name>]
      Create a normal project artifact through the local daemon.

  od research search --query <text> [--max-sources 5] [--daemon-url <url>]
      Run agent-callable Tavily research through the local daemon.

  od automation <list|get|create|update|run|runs|pause|resume|delete> [args]
      Drive the Automations surface headlessly. Same store as the UI's
      Automations tab, so an external agent can
      schedule, trigger, or harvest results from a routine without
      opening the web UI.

  od feedback <list|submit|status> [args]
      Submit bugs or suggestions, list the issue ledger, and update issue
      status through the same native MatOS feedback service as the web UI.

  od chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<t>"] [--json]
      Create a Side Chat: a new conversation that inherits another
      conversation's context by copying its messages (--seed-from), optionally
      stopping at one message (--fork-after). Mirrors the web chat fork action.

  od diagnostics export [<path>] [--json]
      Bundle daemon/web/desktop logs, machine info, and recent crash reports
      into a zip for support tickets. Same output as Settings → About →
      Export diagnostics.

  od export <file> --project <id> --format <pdf|image|pptx> [--out <path>]
      Programmatically export an HTML/deck artifact to PDF, image, or PPTX
      (no model/agent calls). Mirrors the web Download menu; rasterization uses
      the desktop runtime's bundled Chromium.

  "$OD_NODE_BIN" "$OD_BIN" tools ...
      Recommended agent-runtime form; avoids relying on user PATH for od or node.

Options:
  --port <n>       Port to listen on (default: 7456, env: OD_PORT).
  --host <addr>    Interface address to bind to (default: 127.0.0.1, env: OD_BIND_HOST).
                   Set to a specific IP (e.g. a Tailscale address) to restrict access
                   to that interface only.
  --no-open        Do not open the browser after start.

What the daemon does:
  * runs conversations through the native MatOS/DeepSeek Harness runtime
  * serves the chat UI at http://<host>:<port>
  * proxies messages (text + images) to the selected agent via child-process spawn
  * exposes the project, chat, automation, and research APIs used by the UI and CLI.`);
}

// ---------------------------------------------------------------------------
// Subcommand: od research …
// ---------------------------------------------------------------------------

async function runResearch(args) {
  const { sub, subArgs } = splitResearchSubcommand(args);
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    printResearchHelp();
    process.exit(sub === 'help' || args.includes('--help') || args.includes('-h') ? 0 : 2);
  }
  if (sub !== 'search') {
    console.error(`unknown subcommand: od research ${sub}`);
    printResearchHelp();
    process.exit(2);
  }
  return runResearchSearch(subArgs);
}

async function runResearchSearch(rawArgs) {
  let flags;
  try {
    flags = parseFlags(rawArgs, {
      string: RESEARCH_SEARCH_STRING_FLAGS,
      boolean: RESEARCH_SEARCH_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    printResearchHelp();
    process.exit(2);
  }
  const query = typeof flags.query === 'string' ? flags.query.trim() : '';
  if (!query) {
    console.error('--query required');
    process.exit(2);
  }
  const daemonUrl = await cliDaemonUrl(flags);
  const maxSources =
    flags['max-sources'] == null ? undefined : Number(flags['max-sources']);
  const url = `${daemonUrl.replace(/\/$/, '')}/api/research/search`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        ...(Number.isFinite(maxSources) ? { maxSources } : {}),
      }),
    });
  } catch (err) {
    surfaceFetchError(err, daemonUrl);
    process.exit(3);
  }
  if (!resp.ok) {
    const text = await resp.text();
    console.error(`daemon ${resp.status}: ${text}`);
    process.exit(4);
  }
  process.stdout.write(`${await resp.text()}\n`);
}

async function runArtifacts(args) {
  const { exitCode } = await runArtifactsCli(args);
  process.exit(exitCode);
}

function printResearchHelp() {
  console.log(`Usage:
  od research search --query <text> [--max-sources 5] [--daemon-url <url>]

Runs Tavily-backed shallow research through the local MatOS daemon.
Output is JSON only on stdout:
  { "query": "...", "summary": "...", "sources": [...], "provider": "tavily", "depth": "shallow", "fetchedAt": 0 }

Flags:
  --query        Required search query.
  --max-sources  Optional source cap. Defaults to 5, clamped to Tavily's max.
  --daemon-url   Local daemon URL. Defaults to OD_DAEMON_URL, OD_SIDECAR_IPC_PATH discovery, or http://127.0.0.1:7456.`);
}

function surfaceFetchError(err, daemonUrl) {
  const cause = err && typeof err === 'object' ? err.cause : null;
  const code =
    cause && typeof cause === 'object' && typeof cause.code === 'string'
      ? cause.code
      : null;
  const causeMsg =
    cause && typeof cause === 'object' && typeof cause.message === 'string'
      ? cause.message
      : '';
  let detail = err && err.message ? err.message : String(err);
  if (code) detail = `${code}${causeMsg ? ` — ${causeMsg}` : ''}`;
  else if (causeMsg) detail = causeMsg;
  console.error(`failed to reach daemon at ${daemonUrl}: ${detail}`);
  if (code === 'EPERM' || code === 'ENETUNREACH') {
    console.error(
      'hint: outbound connect was denied by a sandbox. If you launched ' +
        'this command from a code agent, check the agent\'s sandbox / ' +
        'network policy. The MatOS daemon itself is unaffected - it can be ' +
        'reached from a regular shell.',
    );
  }
}

function parseFlags(argv, opts = {}) {
  const stringFlags = opts.string instanceof Set ? opts.string : new Set();
  const booleanFlags = opts.boolean instanceof Set ? opts.boolean : new Set();
  const knownFlags = new Set([...stringFlags, ...booleanFlags]);
  // Positionals collected silently; callers that take `<id>` style
  // positional args re-scan `argv`
  // themselves to pick them up. Strict positional rejection here
  // would break those commands, so we only enforce strict-flag
  // semantics for things that *are* prefixed with `--`.
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) {
      // Positional — let the caller decide what to do with it.
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (knownFlags.size > 0 && !knownFlags.has(key)) {
      throw new Error(
        `unknown flag: --${key}. Run with --help for the list of accepted flags.`,
      );
    }
    if (eq >= 0) {
      out[key] = a.slice(eq + 1);
      continue;
    }
    if (booleanFlags.has(key)) {
      out[key] = true;
      continue;
    }
    if (stringFlags.has(key)) {
      const next = argv[i + 1];
      if (next == null) {
        throw new Error(`flag --${key} requires a value`);
      }
      out[key] = next;
      i++;
      continue;
    }
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function positionalArgs(argv, stringFlags = new Set()) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a) continue;
    if (!a.startsWith('--')) {
      out.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq >= 0 ? a.slice(2, eq) : a.slice(2);
    if (eq < 0 && stringFlags.has(key)) i++;
  }
  return out;
}

async function cliDaemonUrl(flags) {
  return resolveDaemonUrl({ flagUrl: flags?.['daemon-url'] });
}

async function cliDaemonBaseUrl(flags) {
  return (await cliDaemonUrl(flags)).replace(/\/$/, '');
}

// Plan §3.B1 / spec §12.4: CLI structured error helper. Maps a daemon
// HTTP error envelope (or a synthetic local error) to a stable exit
// code + a JSON envelope on stderr. Code agents read these to decide
// whether the failure is recoverable (re-grant capabilities, prompt
// the user, retry with --grant-caps, etc.).
function exitWithStructuredError({ code, message, data }) {
  const exit = RECOVERABLE_EXIT_CODES[code] ?? 1;
  const envelope = { error: { code, message, data: data ?? {} } };
  process.stderr.write(JSON.stringify(envelope) + '\n');
  process.exit(exit);
}

// Map a daemon HTTP response into the exit-code envelope. Returns the
// parsed body (so the caller can keep going if it doesn't want to exit).
//
// Daemon error envelopes come in two shapes in practice:
//   { error: { code, message, ... } }  — newer routes using sendApiError
//   { error: '<message>' }             — older flat-string routes
//                                         (e.g. POST /api/templates at
//                                         routes/project/index.ts)
// Normalize so a flat-string body still surfaces its message to the
// structured envelope instead of collapsing to `HTTP <status>: `, which
// would drop the only diagnostic the daemon actually returned to a
// headless caller.
async function structuredHttpFailure(resp, fallbackCode = 'daemon-not-running') {
  let raw = '';
  let parsed;
  try {
    raw = await resp.text();
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = {};
  }
  const errorObj =
    typeof parsed?.error === 'string'
      ? { message: parsed.error }
      : parsed?.error;
  const errCode = normalizeRecoverableErrorCode(errorObj?.code, errorObj?.message);
  if (errCode) {
    exitWithStructuredError({
      code:    errCode,
      message: errorObj?.message ?? `HTTP ${resp.status}`,
      data:    structuredErrorData(errorObj),
    });
  }
  exitWithStructuredError({
    code:    fallbackCode,
    message: errorObj?.message ?? `HTTP ${resp.status}${raw ? `: ${raw}` : ''}`,
    data:    structuredErrorData(errorObj),
  });
}

function normalizeRecoverableErrorCode(code, message) {
  if (code === 'DESKTOP_AUTH_PENDING') return 'desktop-auth-pending';
  if (code === 'FORBIDDEN' && /desktop import token rejected/i.test(String(message ?? ''))) {
    return 'desktop-import-token-rejected';
  }
  return code;
}

function structuredErrorData(error) {
  if (!error || typeof error !== 'object') return undefined;
  const data = {};
  if ('data' in error && error.data !== undefined) Object.assign(data, error.data);
  if ('details' in error && error.details !== undefined) data.details = error.details;
  if (typeof error.retryable === 'boolean') data.retryable = error.retryable;
  return Object.keys(data).length > 0 ? data : undefined;
}

// Subcommand: od project / od run / od files / od conversation
//
// Plan §6 Phase 1 follow-up + Phase 2C: thin CLI wrappers over the
// existing daemon HTTP endpoints (POST /api/projects, POST /api/runs,
// GET /api/projects/:id/files, …). The §12.5 walkthrough relies on
// these so a code agent can drive MatOS end-to-end without
// hitting `/api/*` directly. Spec §11.7 invariant: every UI feature is
// reachable via the CLI; we wrap rather than duplicate.
// ---------------------------------------------------------------------------

async function projectDaemonUrl(flags) {
  return cliDaemonUrl(flags);
}

function normalizeChatSessionModeFlag(value) {
  if (value == null) return undefined;
  const mode = String(value).trim().toLowerCase();
  if (mode === 'design' || mode === 'chat' || mode === 'plan') return mode;
  console.error('--mode must be one of: design, chat, plan');
  process.exit(2);
}

function safeReadJsonFile(p) {
  try {
    if (p === '-') return JSON.parse(readFileSync(0, 'utf8'));
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function collectCliPositionals(argv, stringFlags = new Set()) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === '--') {
      out.push(...argv.slice(i + 1));
      break;
    }
    if (typeof value === 'string' && value.startsWith('--')) {
      const eq = value.indexOf('=');
      const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
      if (eq < 0 && stringFlags.has(key)) i++;
      continue;
    }
    out.push(value);
  }
  return out;
}

async function resolveFolderPathForCli(rawPath) {
  const path = await import('node:path');
  const os = await import('node:os');
  const raw = typeof rawPath === 'string' && rawPath.trim().length > 0
    ? rawPath.trim()
    : (process.env.INIT_CWD || process.cwd());
  const expanded = raw === '~'
    ? os.homedir()
    : raw.startsWith(`~${path.sep}`)
      ? path.join(os.homedir(), raw.slice(2))
      : raw;
  return path.resolve(expanded);
}

async function basenameForCli(folderPath) {
  const path = await import('node:path');
  return path.basename(folderPath) || 'Imported project';
}

async function readRunMessageFromFlags(flags, fallback = null) {
  if (typeof flags.message === 'string' && flags.message.length > 0) {
    return flags.message;
  }
  const prompt = await readPromptFromFlags(flags);
  if (typeof prompt === 'string' && prompt.length > 0) return prompt;
  return fallback;
}

async function postJsonToDaemon(base, route, body, headers = {}) {
  let resp;
  try {
    resp = await fetch(`${base}${route}`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body:    JSON.stringify(body),
    });
  } catch (err) {
    surfaceFetchError(err, base);
    process.exit(3);
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const errCode = data?.error?.code;
    if (errCode && errCode in RECOVERABLE_EXIT_CODES) {
      return exitWithStructuredError({
        code:    errCode,
        message: data.error.message ?? `HTTP ${resp.status}`,
        data:    data.error.data,
      });
    }
    console.error(`POST ${route} failed: ${resp.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }
  return data;
}

async function postImportFolderToDaemon(base, body, baseDir) {
  const headers = {};
  const importToken = await mintCliImportToken(baseDir);
  if (importToken != null) {
    headers['x-od-desktop-import-token'] = importToken;
  }
  return postJsonToDaemon(base, '/api/import/folder', body, headers);
}

async function runProject(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od project create [--name "<title>"] [--skill <id>]
                    [--metadata-json <path|->]
                    [--mode design|chat|plan]
  od project duplicate <id> [--name "<title>"] [--json]
                    Duplicate a project and copy its Design Files.
  od project import <baseDir> [--name "<title>"]
  od project import-folder <path> [--name "<title>"] [--skill <id>] [--json]
  od project list                         List projects.
  od project info <id>                    Print one project.
  od project editor-workspace <id> [--json]
                    Prepare the named OpenVSCode workspace (stable data path).
  od project delete <id>                  Delete a project.
  od project editors                      List locally-installed editors that
                                          can open a project (hand-off targets).
  od project open-in <id> --editor <slug> Open the project's working directory
                                          in the chosen editor (cursor, zed,
                                          vscode, finder, terminal, …).

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}/api/projects`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const projects = data?.projects ?? [];
      if (projects.length === 0) {
        console.log('No projects. Create one with `od project create --name "..."`.');
        return;
      }
      for (const p of projects) console.log(`${p.id}\t${p.name}\t${p.skillId ?? '-'}`);
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od project info <id>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    case 'editor-workspace': {
      const id = positionalArgs(rest, PROJECT_STRING_FLAGS)[0];
      if (!id) {
        console.error('Usage: od project editor-workspace <id> [--json]');
        process.exit(2);
      }
      const data = await postJsonToDaemon(base, `/api/projects/${encodeURIComponent(id)}/editor-workspace`, {});
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(data.workspacePath);
      return;
    }
    case 'create': {
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
      const name = typeof flags.name === 'string' && flags.name.length > 0
        ? flags.name
        : 'Untitled project';
      const body = {
        id,
        name,
        skillId:        flags.skill ?? null,
      };
      const conversationMode = normalizeChatSessionModeFlag(flags.mode);
      if (conversationMode) body.conversationMode = conversationMode;
      if (flags['pending-prompt']) body.pendingPrompt = flags['pending-prompt'];
      if (flags['metadata-json']) {
        const mj = safeReadJsonFile(flags['metadata-json']);
        if (mj && typeof mj === 'object') body.metadata = mj;
      }
      if (!(typeof flags.name === 'string' && flags.name.trim())) {
        body.metadata = { kind: 'prototype', ...body.metadata, nameSource: 'untitled' };
      }
      const resp = await fetch(`${base}/api/projects`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status === 409 && data?.error?.code === 'capabilities-required') {
          return exitWithStructuredError({
            code:    'capabilities-required',
            message: data.error.message,
            data:    data.error.data,
          });
        }
        console.error(`POST /api/projects failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] created ${data.project?.id ?? id} (conversation ${data.conversationId})`);
      return;
    }
    case 'duplicate': {
      const sourceProjectId = positionalArgs(rest, PROJECT_STRING_FLAGS)[0];
      if (!sourceProjectId) {
        console.error('Usage: od project duplicate <id> [--name "<title>"] [--json]');
        process.exit(2);
      }
      const body = {};
      if (typeof flags.name === 'string' && flags.name.length > 0) body.name = flags.name;
      const data = await postJsonToDaemon(
        base,
        `/api/projects/${encodeURIComponent(sourceProjectId)}/duplicate`,
        body,
      );
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(
        `[project] duplicated ${sourceProjectId} as ${data.project?.id ?? '-'} `
        + `(conversation ${data.conversationId ?? '-'})`,
      );
      return;
    }
    case 'import': {
      const [baseDir] = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const importBaseDir = typeof baseDir === 'string' ? baseDir.trim() : '';
      if (!importBaseDir) {
        console.error('Usage: od project import <baseDir> [--name "<title>"]');
        process.exit(2);
      }
      const body = { baseDir: importBaseDir };
      if (typeof flags.name === 'string' && flags.name.length > 0) body.name = flags.name;
      if (typeof flags.skill === 'string' && flags.skill.length > 0) body.skillId = flags.skill;
      const headers = { 'content-type': 'application/json' };
      const importToken = await mintCliImportToken(importBaseDir);
      if (importToken != null) {
        headers['x-od-desktop-import-token'] = importToken;
      }
      const resp = await fetch(`${base}/api/import/folder`, {
        method:  'POST',
        headers,
        body:    JSON.stringify(body),
      });
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] imported ${data.project?.id ?? '-'} (conversation ${data.conversationId ?? '-'})`);
      return;
    }
    case 'import-folder': {
      const parts = collectCliPositionals(rest, PROJECT_STRING_FLAGS);
      const folderArg = flags.path ?? flags.dir ?? parts[0];
      if (!folderArg) {
        console.error('Usage: od project import-folder <path> [--skill <id>]');
        process.exit(2);
      }
      const folderPath = await resolveFolderPathForCli(folderArg);
      const body = {
        baseDir:        folderPath,
        name:           typeof flags.name === 'string' && flags.name.length > 0
          ? flags.name
          : await basenameForCli(folderPath),
        skillId:        flags.skill ?? null,
      };
      const data = await postImportFolderToDaemon(base, body, folderPath);
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] imported ${data.project?.id ?? '-'} from ${folderPath} (conversation ${data.conversationId ?? '-'})`);
      return;
    }
    case 'delete': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od project delete <id>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      console.log(`[project] deleted ${id}`);
      return;
    }
    case 'editors': {
      const resp = await fetch(`${base}/api/editors`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const editors = data?.editors ?? [];
      for (const ed of editors) {
        const status = ed.available ? 'available' : 'missing';
        console.log(`${ed.id}\t${ed.label}\t${status}`);
      }
      return;
    }
    case 'open-in': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od project open-in <id> --editor <slug>');
        process.exit(2);
      }
      const editor = typeof flags.editor === 'string' ? flags.editor : '';
      if (!editor) {
        console.error('--editor <slug> is required. Run `od project editors` to list options.');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/open-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editorId: editor }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (flags.json) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
        else console.error(`POST /api/projects/${id}/open-in failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[project] opened ${id} in ${editor} (${data.path ?? ''})`);
      return;
    }
    default:
      console.error(`unknown subcommand: od project ${sub}`);
      process.exit(2);
  }
}

async function runRun(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od run start --project <projectId> [--conversation <id>] [--message "<text>"]
               [--agent matos] [--model <id>] [--follow] [--json]
  od run redesign [--path <folder>] [--message "<text>" | --prompt-file <path|->]
               [--agent matos] [--model <id>] [--follow] [--json]
  od run watch  <runId>                     ND-JSON event stream on stdout.
  od run cancel <runId>                     Request cancellation.
  od run list   [--project <id>]            List recent runs.
  od run info   <runId>                     One run's status.
  od run result-package <runId> [--json]    Inspect run outputs and workspace
                                            provenance without applying them.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'list': {
      const url = flags.project
        ? `${base}/api/runs?projectId=${encodeURIComponent(flags.project)}`
        : `${base}/api/runs`;
      const resp = await fetch(url);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const runs = data?.runs ?? [];
      for (const r of runs) {
        console.log(`${r.id}\t${r.status}\tproject=${r.projectId ?? '-'}`);
      }
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od run info <runId>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/runs/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'run-not-found');
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    case 'result-package': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od run result-package <runId> [--json]');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/runs/${encodeURIComponent(id)}/result-package`);
      if (!resp.ok) return structuredHttpFailure(resp, 'run-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const run = data?.run ?? {};
      const workspace = data?.workspace ?? {};
      const storage = workspace.storage ?? {};
      const provenance = workspace.provenance ?? null;
      console.log(`run\t${run.id ?? id}\t${run.status ?? '-'}`);
      console.log(`workspace\t${storage.kind ?? '-'}\t${storage.baseDir ?? '-'}`);
      console.log(`provenance\t${provenance?.kind ?? '-'}\twriteback=${provenance?.writeback ?? '-'}`);
      console.log(`project\t${data?.project?.id ?? '-'}\tfiles=${data?.project?.fileCount ?? 0}`);
      const artifacts = Array.isArray(data?.artifacts) ? data.artifacts : [];
      for (const artifact of artifacts) {
        console.log(`artifact\t${artifact.file ?? '-'}\t${artifact.kind ?? '-'}\t${artifact.title ?? '-'}`);
      }
      return;
    }
    case 'cancel': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od run cancel <runId>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (!resp.ok) return structuredHttpFailure(resp, 'run-not-found');
      console.log(`[run] cancelled ${id}`);
      return;
    }
    case 'watch': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od run watch <runId>');
        process.exit(2);
      }
      await streamRunEvents(base, id);
      return;
    }
    case 'redesign': {
      const parts = collectCliPositionals(rest, PROJECT_STRING_FLAGS);
      const promptFromArgs = parts.join(' ').trim();
      const defaultMessage =
        'Use the redesign-existing-projects skill. Audit the current UI first, then redesign it to premium quality without breaking functionality. Preserve the existing product structure, routes, and behavior.';
      const message = await readRunMessageFromFlags(
        flags,
        promptFromArgs || defaultMessage,
      );
      const skillId = flags.skill ?? 'redesign-existing-projects';
      let projectId = flags.project;
      let conversationId = flags.conversation;
      let imported = null;

      if (!projectId) {
        const folderPath = await resolveFolderPathForCli(flags.path ?? flags.dir);
        imported = await postImportFolderToDaemon(base, {
          baseDir:        folderPath,
          name:           typeof flags.name === 'string' && flags.name.length > 0
            ? flags.name
            : await basenameForCli(folderPath),
          skillId,
        }, folderPath);
        projectId = imported.project?.id;
        conversationId = conversationId ?? imported.conversationId;
        if (!projectId) {
          console.error('POST /api/import/folder did not return project.id');
          process.exit(1);
        }
        if (!flags.json || flags.follow) {
          console.log(`[project] imported ${projectId} from ${folderPath} (conversation ${conversationId ?? '-'})`);
        }
      }

      const body = {
        projectId,
        ...(conversationId ? { conversationId } : {}),
        ...(message ? { message } : {}),
        skillId,
        ...(flags.agent ? { agentId: flags.agent } : {}),
        ...(flags.model ? { model: flags.model } : {}),
      };
      const data = await postJsonToDaemon(base, '/api/runs', body);
      if (flags.json && !flags.follow) {
        return process.stdout.write(JSON.stringify({
          ...data,
          project: imported?.project ?? null,
          conversationId: conversationId ?? null,
        }, null, 2) + '\n');
      }
      console.log(`[run] started ${data.runId}`);
      if (flags.follow) await streamRunEvents(base, data.runId);
      return;
    }
    case 'start': {
      if (!flags.project) {
        console.error('--project <projectId> is required');
        process.exit(2);
      }
      const body = { projectId: flags.project };
      if (flags.conversation) body.conversationId = flags.conversation;
      const message = await readRunMessageFromFlags(flags);
      if (message) body.message = message;
      if (flags.skill) body.skillId = flags.skill;
      if (flags.agent) body.agentId = flags.agent;
      if (flags.model) body.model = flags.model;
      const resp = await fetch(`${base}/api/runs`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        if (resp.status === 409 && data?.error?.code === 'capabilities-required') {
          return exitWithStructuredError({
            code:    'capabilities-required',
            message: data.error.message,
            data:    data.error.data,
          });
        }
        if (resp.status === 422 && data?.error?.code === 'missing-input') {
          return exitWithStructuredError({
            code:    'missing-input',
            message: data.error.message,
            data:    data.error.data,
          });
        }
        console.error(`POST /api/runs failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json && !flags.follow) {
        return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      }
      console.log(`[run] started ${data.runId}`);
      if (flags.follow) await streamRunEvents(base, data.runId);
      return;
    }
    default:
      console.error(`unknown subcommand: od run ${sub}`);
      process.exit(2);
  }
}

// Stream the SSE events at /api/runs/:id/events as ND-JSON on stdout.
// Each line is one event: { event, data } so a code agent can parse it
// without needing an SSE library.
async function streamRunEvents(base, runId) {
  const resp = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!resp.ok || !resp.body) {
    console.error(`run watch failed: ${resp.status}`);
    process.exit(1);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const lines = block.split('\n');
      const eventLine = lines.find((l) => l.startsWith('event: '));
      const dataLine  = lines.find((l) => l.startsWith('data: '));
      const event = eventLine ? eventLine.slice('event: '.length) : 'message';
      const dataRaw = dataLine ? dataLine.slice('data: '.length) : '';
      let parsed;
      try { parsed = JSON.parse(dataRaw); } catch { parsed = dataRaw; }
      process.stdout.write(JSON.stringify({ event, data: parsed }) + '\n');
      if (event === 'end') {
        return;
      }
    }
  }
}



function parseProjectFileVersionSourceFlag(raw) {
  if (raw == null) return null;
  if (raw === 'ai' || raw === 'manual' || raw === 'restore') return raw;
  console.error(`Invalid --source "${String(raw)}". Expected one of: ai, manual, restore.`);
  process.exit(2);
}

async function runFiles(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od files list   <projectId>                  List files in a project.
  od files read   <projectId> <relpath>        Stream file bytes to stdout.
  od files write  <projectId> <relpath> [< stdin]
                                               Write content from stdin.
  od files upload <projectId> <localpath> [--as <relpath>]
                                               Upload a local file.
  od files delete <projectId> <name>           Delete a project file.
  od files diff   <projectId> <relpathA> [<relpathB> | --against -]
                                               Print a unified diff.
  od files versions <projectId> <relpath>      List saved HTML versions.
  od files version-read <projectId> <relpath> <versionId>
                                               Stream one saved HTML version.
  od files version-create <projectId> <relpath>
                                               Save the current HTML as a version.
  od files version-restore <projectId> <relpath> <versionId>
                                               Restore a saved HTML as a new current version.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --prompt-file <path|->  Read a version prompt from file/stdin where supported.
  --source <ai|manual|restore>
                       Version provenance where supported.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'list': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od files list <projectId>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/files`);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const files = Array.isArray(data?.files) ? data.files : [];
      for (const f of files) console.log(`${f.size}\t${f.name ?? f.path}`);
      return;
    }
    case 'read': {
      const positional = rest.filter((a) => !a.startsWith('-'));
      const [id, rel] = positional;
      if (!id || !rel) {
        console.error('Usage: od files read <projectId> <relpath>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/files/${rel.split('/').map(encodeURIComponent).join('/')}`);
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const buf = Buffer.from(await resp.arrayBuffer());
      process.stdout.write(buf);
      return;
    }
    case 'upload': {
      const positional = rest.filter((a) => !a.startsWith('-')
        && a !== flags.as);
      const [id, localPath] = positional;
      if (!id || !localPath) {
        console.error('Usage: od files upload <projectId> <localpath> [--as <relpath>]');
        process.exit(2);
      }
      const buf = readFileSync(localPath);
      const desiredName = typeof flags.as === 'string' && flags.as.length > 0
        ? flags.as
        : basename(localPath);
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/files`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          name: desiredName,
          content: buf.toString('base64'),
          encoding: 'base64',
        }),
      });
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      if (data?.versionWarning?.message) console.error(`[files] warning: ${data.versionWarning.message}`);
      console.log(`[files] uploaded ${data?.file?.name ?? desiredName}`);
      return;
    }
    case 'write': {
      const positional = rest.filter((a) => !a.startsWith('-'));
      const [id, rel] = positional;
      if (!id || !rel) {
        console.error('Usage: od files write <projectId> <relpath> [< stdin]');
        process.exit(2);
      }
      // Read stdin synchronously into a buffer.
      let chunks = [];
      try {
        const stdin = readFileSync(0);
        chunks = [stdin];
      } catch (err) {
        console.error(`stdin read failed: ${err.message ?? err}`);
        process.exit(1);
      }
      const body = Buffer.concat(chunks);
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/files`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          name: rel,
          content: body.toString('utf8'),
          encoding: 'utf8',
        }),
      });
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      if (data?.versionWarning?.message) console.error(`[files] warning: ${data.versionWarning.message}`);
      console.log(`[files] wrote ${data?.file?.name ?? rel}`);
      return;
    }
    case 'delete': {
      const positional = rest.filter((a) => !a.startsWith('-'));
      const [id, name] = positional;
      if (!id || !name) {
        console.error('Usage: od files delete <projectId> <name>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/files/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!resp.ok) return structuredHttpFailure(resp);
      console.log(`[files] deleted ${name}`);
      return;
    }
    case 'diff': {
      const positional = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const [id, relA, relB] = positional;
      const against = typeof flags.against === 'string' ? flags.against : null;
      if (!id || !relA || (!relB && !against) || (relB && against)) {
        console.error('Usage: od files diff <projectId> <relpathA> [<relpathB> | --against -]');
        process.exit(2);
      }
      const left = await fetchProjectFileText(base, id, relA);
      const rightLabel = against ?? relB;
      const right = against === '-'
        ? await readStdinUtf8()
        : await fetchProjectFileText(base, id, rightLabel);
      const diff = createUnifiedDiff(`a/${relA}`, `b/${rightLabel}`, left, right);
      if (flags.json) return process.stdout.write(JSON.stringify({ diff }, null, 2) + '\n');
      process.stdout.write(diff);
      return;
    }
    case 'versions': {
      const positional = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const [id, rel] = positional;
      if (!id || !rel) {
        console.error('Usage: od files versions <projectId> <relpath>');
        process.exit(2);
      }
      const resp = await fetch(
        `${base}/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}/versions`,
      );
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const versions = Array.isArray(data?.versions) ? data.versions : [];
      for (const version of versions) {
        const marker = version.current ? '*' : ' ';
        const prompt = typeof version.prompt === 'string' && version.prompt.trim()
          ? version.prompt.trim().replace(/\s+/g, ' ').slice(0, 96)
          : '-';
        const createdAt = Number.isFinite(Number(version.createdAt))
          ? new Date(Number(version.createdAt)).toISOString()
          : '-';
        console.log(`${marker}\tv${version.version ?? '-'}\t${version.source ?? '-'}\t${createdAt}\t${version.id ?? '-'}\t${prompt}`);
      }
      return;
    }
    case 'version-read': {
      const positional = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const [id, rel, versionId] = positional;
      if (!id || !rel || !versionId) {
        console.error('Usage: od files version-read <projectId> <relpath> <versionId>');
        process.exit(2);
      }
      const resp = await fetch(
        `${base}/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}/versions/${encodeURIComponent(versionId)}`,
      );
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      process.stdout.write(String(data?.content ?? ''));
      return;
    }
    case 'version-create': {
      const positional = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const [id, rel] = positional;
      if (!id || !rel) {
        console.error('Usage: od files version-create <projectId> <relpath> [--prompt <text> | --prompt-file <path|->] [--label <text>] [--source <ai|manual|restore>]');
        process.exit(2);
      }
      const source = parseProjectFileVersionSourceFlag(flags.source);
      const prompt = await readPromptFromFlags(flags);
      const body = {};
      if (prompt !== null) body.prompt = prompt;
      if (typeof flags.label === 'string' && flags.label.length > 0) body.label = flags.label;
      if (source) body.source = source;
      const resp = await fetch(
        `${base}/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}/versions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      console.log(`[files] saved ${rel} as version ${data?.version?.version ?? data?.version?.id ?? '-'}`);
      return;
    }
    case 'version-restore': {
      const positional = positionalArgs(rest, PROJECT_STRING_FLAGS);
      const [id, rel, versionId] = positional;
      if (!id || !rel || !versionId) {
        console.error('Usage: od files version-restore <projectId> <relpath> <versionId> [--prompt <text> | --prompt-file <path|->]');
        process.exit(2);
      }
      const prompt = await readPromptFromFlags(flags);
      const body = {};
      if (prompt !== null) body.prompt = prompt;
      const resp = await fetch(
        `${base}/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}/versions/${encodeURIComponent(versionId)}/restore`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      if (data?.versionWarning?.message) console.error(`[files] warning: ${data.versionWarning.message}`);
      console.log(`[files] restored ${rel} as version ${data?.version?.version ?? data?.version?.id ?? '-'}`);
      return;
    }
    default:
      console.error(`unknown subcommand: od files ${sub}`);
      process.exit(2);
  }
}

function encodeProjectRelpath(rel) {
  return String(rel).split('/').map(encodeURIComponent).join('/');
}

async function fetchProjectFileText(base, id, rel) {
  const resp = await fetch(
    `${base}/api/projects/${encodeURIComponent(id)}/files/${encodeProjectRelpath(rel)}`,
  );
  if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString('utf8');
}

async function readStdinUtf8() {
  const fs = await import('node:fs');
  return fs.readFileSync(0, 'utf8');
}

async function mintCliImportToken(baseDir) {
  const socketPath = process.env[SIDECAR_ENV.IPC_PATH];
  if (typeof socketPath !== 'string' || socketPath.length === 0) return null;
  let result;
  try {
    result = await requestJsonIpc(
      socketPath,
      { type: SIDECAR_MESSAGES.MINT_IMPORT_TOKEN, input: { baseDir } },
      { timeoutMs: 800 },
    );
  } catch {
    return null;
  }
  if (result?.ok === true && typeof result.token === 'string' && result.token.length > 0) {
    return result.token;
  }
  if (result?.ok === false && result.code === 'DESKTOP_AUTH_PENDING') {
    exitWithStructuredError({
      code: 'desktop-auth-pending',
      message: result.message ?? 'desktop auth required but secret not yet registered',
      data: { retryable: result.retryable === true },
    });
  }
  return null;
}

function createUnifiedDiff(leftLabel, rightLabel, leftText, rightText) {
  if (leftText === rightText) return '';
  const leftLines = splitDiffLines(leftText);
  const rightLines = splitDiffLines(rightText);
  let prefix = 0;
  while (
    prefix < leftLines.length
    && prefix < rightLines.length
    && leftLines[prefix] === rightLines[prefix]
  ) {
    prefix++;
  }
  let leftEnd = leftLines.length;
  let rightEnd = rightLines.length;
  while (
    leftEnd > prefix
    && rightEnd > prefix
    && leftLines[leftEnd - 1] === rightLines[rightEnd - 1]
  ) {
    leftEnd--;
    rightEnd--;
  }
  const oldMid = leftLines.slice(prefix, leftEnd);
  const newMid = rightLines.slice(prefix, rightEnd);
  const body = diffLineBody(oldMid, newMid);
  if (body.length === 0) {
    body.push(...oldMid.map((line) => diffLine('-', line)), ...newMid.map((line) => diffLine('+', line)));
  }
  const oldStart = oldMid.length === 0 ? prefix : prefix + 1;
  const newStart = newMid.length === 0 ? prefix : prefix + 1;
  return [
    `--- ${leftLabel}`,
    `+++ ${rightLabel}`,
    `@@ -${formatDiffRange(oldStart, oldMid.length)} +${formatDiffRange(newStart, newMid.length)} @@`,
    ...body,
  ].join('\n') + '\n';
}

function splitDiffLines(text) {
  const value = String(text);
  if (value.length === 0) return [];
  return value.match(/.*?(?:\r\n|\n|\r|$)/gs).filter((line) => line.length > 0);
}

function formatDiffRange(start, length) {
  return length === 1 ? String(start) : `${start},${length}`;
}

function diffLineBody(oldLines, newLines) {
  if (oldLines.length === 0) return newLines.map((line) => diffLine('+', line));
  if (newLines.length === 0) return oldLines.map((line) => diffLine('-', line));
  if (oldLines.length * newLines.length > 1_000_000) {
    return [...oldLines.map((line) => diffLine('-', line)), ...newLines.map((line) => diffLine('+', line))];
  }
  const width = newLines.length + 1;
  const lcs = Array.from(
    { length: oldLines.length + 1 },
    () => new Uint32Array(width),
  );
  for (let i = oldLines.length - 1; i >= 0; i--) {
    for (let j = newLines.length - 1; j >= 0; j--) {
      lcs[i][j] = oldLines[i] === newLines[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      out.push(diffLine(' ', oldLines[i]));
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(diffLine('-', oldLines[i]));
      i++;
    } else {
      out.push(diffLine('+', newLines[j]));
      j++;
    }
  }
  while (i < oldLines.length) out.push(diffLine('-', oldLines[i++]));
  while (j < newLines.length) out.push(diffLine('+', newLines[j++]));
  return out;
}

function diffLine(prefix, line) {
  const value = String(line);
  if (value.endsWith('\r\n')) return `${prefix}${renderDiffLineContent(value.slice(0, -1))}`;
  if (value.endsWith('\n')) return `${prefix}${renderDiffLineContent(value.slice(0, -1))}`;
  if (value.endsWith('\r')) return `${prefix}${renderDiffLineContent(value)}`;
  return `${prefix}${renderDiffLineContent(value)}\n\\ No newline at end of file`;
}

function renderDiffLineContent(value) {
  return String(value).replace(/\r/g, '\\r');
}

// `od templates …` is the headless face of NewProjectPanel /
// ExamplesTab — same /api/templates store, same DTO shapes. External
// external agents use these to snapshot a
// project as a reusable starting point, list everything the user has
// saved, or drop one that is no longer needed. The web UI and the CLI
// share the daemon HTTP layer so neither can drift out of step.
async function runTemplates(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od templates list                                  List user-saved templates.
  od templates save  <projectId> --name <name>      Snapshot a project's current
                                                    files as a new template.
                     [--description <text>]
  od templates delete <id>                          Delete a saved template by id.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, { string: TEMPLATES_STRING_FLAGS, boolean: TEMPLATES_BOOLEAN_FLAGS });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = (await cliDaemonBaseUrl(flags));
  // Extract positional arguments while stepping past `--flag value`
  // pairs for any string-valued template flag. Without this the id has
  // to be the very first token after the sub-verb, so a headless caller
  // that prefixes shared options (`od templates save --daemon-url ...
  // proj-1 --name Cards`) would hit the missing-id usage path before
  // ever reaching the daemon. Mirrors the `positionalArgs` helper in
  // `runAutomation`.
  const positionalArgs = (values) => {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!value) continue;
      if (value.startsWith('--')) {
        const eq = value.indexOf('=');
        const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
        if (eq < 0 && TEMPLATES_STRING_FLAGS.has(key)) i++;
        continue;
      }
      if (value.startsWith('-')) continue;
      out.push(value);
    }
    return out;
  };
  switch (sub) {
    case 'list': {
      // Wrap every fetch in try/catch so the user sees a clean
      // "failed to reach daemon at <url>: <code>" error from
      // surfaceFetchError when the daemon isn't running. Without
      // this Node throws a raw `TypeError: fetch failed`, which
      // matches the pattern the rest of the CLI uses
      // (runAutomation, the project verbs, runResearch).
      let resp;
      try {
        resp = await fetch(`${base}/api/templates`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const templates = Array.isArray(data?.templates) ? data.templates : [];
      if (templates.length === 0) {
        console.log('No templates. Save one with `od templates save <projectId> --name "..."`.');
        return;
      }
      for (const t of templates) console.log(`${t.id}\t${t.name}`);
      return;
    }
    case 'save': {
      // Pull <projectId> from anywhere among the positional args
      // (`positionalArgs` already skipped past `--flag value` pairs)
      // so callers can put shared options before or after the id.
      const projectId = positionalArgs(rest)[0] ?? '';
      if (!projectId) {
        console.error('Usage: od templates save <projectId> --name <name> [--description <text>]');
        process.exit(2);
      }
      const name = typeof flags.name === 'string' ? flags.name.trim() : '';
      if (!name) {
        console.error('--name required');
        process.exit(2);
      }
      const body = { name, sourceProjectId: projectId };
      if (typeof flags.description === 'string' && flags.description.length > 0) {
        body.description = flags.description;
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/templates`, {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify(body),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      // Templates POST returns 404 when sourceProjectId is unknown,
      // and 400 for body validation failures (missing name, too-long
      // fields). Both are reachable user errors with the daemon
      // already running, so default-classifying them as
      // `daemon-not-running` would send agents down the wrong recovery
      // branch. Map 404 → project-not-found and 400 → missing-input,
      // keep the default for 5xx so genuine daemon trouble still
      // surfaces as `daemon-not-running`.
      if (!resp.ok) {
        if (resp.status === 404) return structuredHttpFailure(resp, 'project-not-found');
        if (resp.status === 400) return structuredHttpFailure(resp, 'missing-input');
        return structuredHttpFailure(resp);
      }
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const id = data?.template?.id ?? '';
      const savedName = data?.template?.name ?? name;
      console.log(`[templates] saved ${savedName}${id ? ` (${id})` : ''}`);
      return;
    }
    case 'delete': {
      const id = positionalArgs(rest)[0] ?? '';
      if (!id) {
        console.error('Usage: od templates delete <id>');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      // The daemon route `DELETE /api/templates/:id` is intentionally
      // idempotent (returns `{ ok: true }` for unknown ids), so this
      // CLI verb mirrors that contract instead of inventing a
      // template-not-found exit code the production route never emits.
      // Any unexpected non-2xx still falls through to the generic
      // structured-failure envelope.
      if (!resp.ok) return structuredHttpFailure(resp);
      if (flags.json) {
        const data = await resp.json().catch(() => ({ ok: true }));
        return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      }
      console.log(`[templates] deleted ${id}`);
      return;
    }
    default:
      console.error(`unknown subcommand: od templates ${sub}`);
      process.exit(2);
  }
}

async function runConversation(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od conversation new  <projectId> [--title "<title>"] [--seed-from <cid>] [--fork-after <mid>] [--mode design|chat|plan]
                                           Create a conversation in a project.
                                           --seed-from copies another
                                           conversation's messages in (Side Chat).
                                           --fork-after stops the copy at one
                                           source message.
  od conversation list <projectId>           List conversations in a project.
  od conversation info <conversationId>      Print one conversation.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'new': {
      const [id] = positionalArgs(rest, PROJECT_STRING_FLAGS);
      if (!id) {
        console.error('Usage: od conversation new <projectId> [--title "<title>"] [--seed-from <cid>] [--fork-after <mid>]');
        process.exit(2);
      }
      const body = {};
      if (typeof flags.title === 'string') body.title = flags.title;
      const sessionMode = normalizeChatSessionModeFlag(flags.mode);
      if (sessionMode) body.sessionMode = sessionMode;
      if (typeof flags['seed-from'] === 'string' && flags['seed-from']) {
        body.seedFromConversationId = flags['seed-from'];
      }
      if (typeof flags['fork-after'] === 'string' && flags['fork-after']) {
        if (!body.seedFromConversationId) {
          console.error('--fork-after requires --seed-from');
          process.exit(2);
        }
        body.forkAfterMessageId = flags['fork-after'];
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/conversations`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const conv = data.conversation;
      console.log(`[conversation] created ${conv?.id ?? '-'} (mode ${conv?.sessionMode ?? sessionMode ?? 'design'})`);
      return;
    }
    case 'list': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od conversation list <projectId>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/conversations`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    case 'info': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error('Usage: od conversation info <conversationId>');
        process.exit(2);
      }
      const resp = await fetch(`${base}/api/conversations/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    default:
      console.error(`unknown subcommand: od conversation ${sub}`);
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: od chat  (Side Chat — context-seeded conversations)
//
// `od chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<t>"] [--json]`
//   Creates a new conversation that inherits another conversation's context
//   by copying its messages, optionally truncating at one source message.
//   Mirrors the web chat fork action and POSTs to the same
//   /api/projects/:id/conversations endpoint the UI uses. This is the CLI half
//   of the dual-track surface for context-seeded conversations.
// ---------------------------------------------------------------------------

async function runChat(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<title>"] [--mode design|chat|plan] [--json]
                                           Create a Side Chat — a new conversation
                                           that copies in another conversation's
                                           context (--seed-from). Use
                                           --fork-after to stop at one source
                                           message.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: PROJECT_STRING_FLAGS, boolean: PROJECT_BOOLEAN_FLAGS });
  const base = (await projectDaemonUrl(flags)).replace(/\/$/, '');
  switch (sub) {
    case 'new': {
      // Accept --project for parity with the rest of the project-scoped CLI,
      // or a bare positional id for convenience.
      const id = typeof flags.project === 'string' && flags.project
        ? flags.project
        : positionalArgs(rest, PROJECT_STRING_FLAGS)[0];
      if (!id) {
        console.error('Usage: od chat new --project <id> [--seed-from <cid>] [--fork-after <mid>] [--title "<title>"]');
        process.exit(2);
      }
      const body = {};
      if (typeof flags.title === 'string') body.title = flags.title;
      const sessionMode = normalizeChatSessionModeFlag(flags.mode);
      if (sessionMode) body.sessionMode = sessionMode;
      if (typeof flags['seed-from'] === 'string' && flags['seed-from']) {
        body.seedFromConversationId = flags['seed-from'];
      }
      if (typeof flags['fork-after'] === 'string' && flags['fork-after']) {
        if (!body.seedFromConversationId) {
          console.error('--fork-after requires --seed-from');
          process.exit(2);
        }
        body.forkAfterMessageId = flags['fork-after'];
      }
      const resp = await fetch(`${base}/api/projects/${encodeURIComponent(id)}/conversations`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!resp.ok) return structuredHttpFailure(resp, 'project-not-found');
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const conv = data.conversation;
      const seeded = body.seedFromConversationId
        ? ` (seeded from ${body.seedFromConversationId})`
        : '';
      const forked = body.forkAfterMessageId
        ? ` through ${body.forkAfterMessageId}`
        : '';
      console.log(`[chat] created ${conv?.id ?? '-'}${conv?.title ? ` "${conv.title}"` : ''}${seeded}${forked} (mode ${conv?.sessionMode ?? sessionMode ?? 'design'})`);
      return;
    }
    default:
      console.error(`unknown subcommand: od chat ${sub}`);
      process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Subcommand: od daemon  (Phase 1.5 lifecycle, plan §6 / §3.F2)
//
// `od daemon start [--headless] [--serve-web] [--port <n>] [--host <addr>]`
//   - --headless: implies --no-open, never tries to launch a browser.
//                 The default `od` (no subcommand) keeps its
//                 desktop-friendly behaviour for back-compat.
//   - --serve-web: same as --headless but allows the Next.js bundle to
//                  serve over the existing port. v1 doesn't bundle a
//                  separate web port; the flag is reserved so downstream
//                  packaged callers can branch on it.
//
// `od daemon status [--json] [--daemon-url <url>]` calls /api/daemon/status.
// `od daemon stop   [--daemon-url <url>]`         calls POST /api/daemon/shutdown.
// ---------------------------------------------------------------------------

async function runDaemon(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od daemon start [--headless] [--serve-web] [--port <n>] [--host <addr>] [--no-open]
                                          Start the daemon (Phase 1.5 headless mode).
  od daemon status [--json] [--daemon-url <url>]
                                          Print the daemon's runtime snapshot.
  od daemon stop   [--daemon-url <url>]   Send a graceful shutdown signal.
  od daemon db     status                 Print SQLite path + size + table row counts.
  od daemon db     verify [--quick]       Run integrity_check + foreign_key_check.
  od daemon db     vacuum                 Run SQLite VACUUM to reclaim space after deletes.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --headless           No browser auto-open; aliased --no-open.
  --serve-web          Serve the web UI over the existing port (no electron).
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: DAEMON_STRING_FLAGS, boolean: DAEMON_BOOLEAN_FLAGS });
  switch (sub) {
    case 'start':   return runDaemonStart(flags);
    case 'status':  return runDaemonStatus(flags);
    case 'stop':    return runDaemonStop(flags);
    case 'db':      return runDaemonDb(rest, flags);
    default:
      console.error(`unknown subcommand: od daemon ${sub}`);
      process.exit(2);
  }
}

// Plan §3.GG1 — `od daemon db status`. Prints a SQLite inventory
// (file path, size on disk, schema version, per-table row counts).
async function runDaemonDb(rest, flags) {
  const sub = rest[0];
  if (!sub || sub === 'help' || rest.includes('--help') || rest.includes('-h')) {
    console.log(`Usage:
  od daemon db status [--json] [--daemon-url <url>]
  od daemon db verify [--quick] [--json] [--daemon-url <url>]
  od daemon db vacuum [--json] [--daemon-url <url>]

status:
  Prints a structured inventory of the daemon's SQLite backend:
    - file path (under .od/ by default; OD_DATA_DIR overrides)
    - size on disk (primary + WAL + SHM)
    - schema version (user_version PRAGMA)
    - per-table row counts (system tables excluded)

verify:
  Runs SQLite PRAGMA integrity_check (or quick_check with --quick)
  + foreign_key_check, returns a structured issues[] report.
  Exit 0 when ok=true, 4 when any issue is found.

vacuum:
  Runs SQLite VACUUM to reclaim space after large delete batches
  (snapshot prune, etc.). Reports before/after
  sizes + elapsed ms.`);
    process.exit(sub ? 0 : 2);
  }
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  if (sub === 'vacuum') {
    const resp = await fetch(`${base}/api/daemon/db/vacuum`, { method: 'POST' });
    if (!resp.ok) {
      console.error(`POST /api/daemon/db/vacuum failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (flags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    console.log(`[db vacuum] reclaimed ${formatBytes(data.reclaimedBytes ?? 0)} (`
      + `${formatBytes(data.beforeBytes ?? 0)} \u2192 ${formatBytes(data.afterBytes ?? 0)}, `
      + `${data.elapsedMs ?? 0}ms)`);
    return;
  }
  if (sub === 'verify') {
    const verifyFlags = parseFlags(rest.slice(1), {
      string:  new Set(['daemon-url']),
      boolean: new Set(['help', 'h', 'json', 'quick']),
    });
    const url = `${base}/api/daemon/db/verify${verifyFlags.quick ? '?quick=1' : ''}`;
    const resp = await fetch(url, { method: 'POST' });
    if (!resp.ok) {
      console.error(`POST ${url} failed: ${resp.status} ${await resp.text()}`);
      process.exit(1);
    }
    const data = await resp.json();
    if (flags.json) {
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    } else {
      const issueCount = Array.isArray(data.issues) ? data.issues.length : 0;
      console.log(`[db verify] mode=${data.mode}  ok=${data.ok}  issues=${issueCount}  ${data.elapsedMs ?? 0}ms`);
      if (issueCount > 0) {
        for (const issue of data.issues) {
          console.error(`  [${issue.kind}] ${issue.message}`);
        }
      }
    }
    process.exit(data.ok ? 0 : 4);
  }
  if (sub !== 'status') {
    console.error(`unknown subcommand: od daemon db ${sub}`);
    process.exit(2);
  }
  const resp = await fetch(`${base}/api/daemon/db`);
  if (!resp.ok) {
    console.error(`GET /api/daemon/db failed: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  const data = await resp.json();
  if (flags.json) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    return;
  }
  console.log(`# Daemon DB`);
  console.log(`  kind:           ${data.kind ?? 'unknown'}`);
  console.log(`  location:       ${data.location ?? '?'}`);
  console.log(`  size on disk:   ${formatBytes(data.sizeBytes ?? 0)}`);
  console.log(`  schema version: ${data.schemaVersion ?? '(none)'}`);
  console.log(`  tables:`);
  const tables = Array.isArray(data.tables) ? data.tables : [];
  if (tables.length === 0) {
    console.log('    (none)');
  } else {
    const longest = Math.max(...tables.map((t) => t.name.length));
    for (const t of tables) {
      console.log(`    ${t.name.padEnd(longest)}  ${t.rowCount}`);
    }
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

async function runDaemonStart(flags) {
  const port = Number(flags.port ?? process.env.OD_PORT ?? 7456);
  const host = String(flags.host ?? process.env.OD_BIND_HOST ?? '127.0.0.1').trim() || '127.0.0.1';
  const headless = Boolean(flags.headless || flags['no-open'] || flags['serve-web']);
  const runtime = await startDaemonRuntime({
    host,
    logListening: false,
    openBrowser: !headless,
    port,
  });
  console.log(`[od] listening on ${runtime.url} (${headless ? 'headless' : 'desktop'})`);

  await new Promise((resolve) => {
    let shuttingDown = false;
    const stop = () => {
      if (shuttingDown) process.exit(0);
      shuttingDown = true;
      void runtime.stop().finally(() => {
        cleanup();
        resolve();
      });
    };
    const cleanup = () => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

async function runDaemonStatus(flags) {
  const base = await cliDaemonBaseUrl(flags);
  let resp;
  try {
    resp = await fetch(`${base}/api/daemon/status`);
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  console.log(`[daemon] ${data.bindHost}:${data.port} v${data.version} pid=${data.pid}`);
}

async function runDaemonStop(flags) {
  const base = await cliDaemonBaseUrl(flags);
  let resp;
  try {
    resp = await fetch(`${base}/api/daemon/shutdown`, { method: 'POST' });
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  console.log(`[daemon] shutdown scheduled`);
}

// ---------------------------------------------------------------------------
// Subcommand: od skills / od status
//
// Plan §3.H2 / §3.H3 / spec §12.2 — design-library + status introspection
// CLI parity. Every UI feature reachable via /api/* gets a CLI mirror
// (the §11.7 "headless = canonical" invariant).
// ---------------------------------------------------------------------------

async function libraryDaemonUrl(flags) {
  return cliDaemonUrl(flags);
}

async function runLibraryList(name, args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od ${name} list           List ${name}.
  od ${name} show <id>      Print one entry.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: LIBRARY_STRING_FLAGS, boolean: LIBRARY_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const apiPath = `/api/${name}`;
  switch (sub) {
    case 'list': {
      const resp = await fetch(`${base}${apiPath}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      const rows = data?.[name] ?? [];
      for (const row of rows) {
        const label = row.title ?? row.name ?? row.id ?? row.label;
        console.log(`${row.id}\t${label}`);
      }
      return;
    }
    case 'show': {
      const id = rest.find((a) => !a.startsWith('-'));
      if (!id) {
        console.error(`Usage: od ${name} show <id>`);
        process.exit(2);
      }
      const resp = await fetch(`${base}${apiPath}/${encodeURIComponent(id)}`);
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      return;
    }
    default:
      console.error(`unknown subcommand: od ${name} ${sub}`);
      process.exit(2);
  }
}

async function runSkills(args) { return runLibraryList('skills', args); }

async function runStatus(args) {
  // Alias of `od daemon status`.
  return runDaemon(['status', ...args]);
}

// ---------------------------------------------------------------------------
// Subcommand: od diagnostics export <path> [--json]
//
// CLI surface for the Settings → About “Export diagnostics” feature. The
// daemon already exposes the bundle behind a local-loopback HTTP endpoint;
// this command is a thin shell over that endpoint so headless callers (CI,
// `od doctor` follow-ups, shell scripts) can collect a support bundle
// without driving the web UI.
// ---------------------------------------------------------------------------

async function runDiagnostics(args) {
  const sub = args[0];
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od diagnostics export [<path>] [--output <path>] [--json] [--daemon-url <url>]

Bundles daemon/web/desktop logs, machine info, and recent crash reports
into a zip. The bundle is the same one Settings → About → Export
diagnostics produces.

  <path>                 Where to write the zip. Defaults to
                         ./open-design-diagnostics-<timestamp>.zip in the
                         current working directory. Alias: --output <path>.
  --json                 Print {path, sizeBytes} on stdout instead of a
                         human-readable summary. The file is still written
                         to <path>.
  --daemon-url <url>     Override the daemon HTTP base URL.`);
    process.exit(0);
  }
  if (sub !== 'export') {
    console.error(`unknown subcommand: od diagnostics ${sub}`);
    process.exit(2);
  }

  const flags = parseFlags(args.slice(1), {
    string: DIAGNOSTICS_STRING_FLAGS,
    boolean: DIAGNOSTICS_BOOLEAN_FLAGS,
  });
  const positional = args.slice(1).filter((a) => !a.startsWith('-'));
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');

  const { DIAGNOSTICS_EXPORT_PATH, DIAGNOSTICS_FILENAME_PREFIX, diagnosticsFileName } =
    await import('@open-design/diagnostics');
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const explicitOutput = typeof flags.output === 'string' && flags.output.length > 0
    ? flags.output
    : positional[0];
  const targetPath = path.resolve(explicitOutput ?? diagnosticsFileName(DIAGNOSTICS_FILENAME_PREFIX));

  let resp;
  try {
    resp = await fetch(`${base}${DIAGNOSTICS_EXPORT_PATH}`);
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);

  const buf = Buffer.from(await resp.arrayBuffer());
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buf);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ path: targetPath, sizeBytes: buf.length }) + '\n');
    return;
  }
  console.log(`Wrote diagnostics bundle to ${targetPath} (${buf.length} bytes).`);
}

async function runVersion(args) {
  const flags = parseFlags(args, { string: LIBRARY_STRING_FLAGS, boolean: LIBRARY_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  let resp;
  try {
    resp = await fetch(`${base}/api/version`);
  } catch (err) {
    return exitWithStructuredError({
      code:    'daemon-not-running',
      message: `Cannot reach daemon at ${base}: ${err?.message ?? err}`,
    });
  }
  if (!resp.ok) return structuredHttpFailure(resp);
  const data = await resp.json();
  if (flags.json) return process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  const version = typeof data?.version === 'string'
    ? data.version
    : (data?.version?.version ?? JSON.stringify(data));
  console.log(version);
}

// ---------------------------------------------------------------------------
// Subcommand: od doctor / od config (Phase 4 CLI parity tail).
//
// Plan §3.I2 / spec §12.2.
//
// `od doctor` — repo-wide diagnostics. Hits /api/daemon/status, lists
// skills. Useful in CI.
//
// `od config get/set/list/unset` — wraps GET/PUT /api/app-config so a
// code agent can flip provider keys / media settings
// without leaving the terminal. JSON values pass through unchanged;
// scalar strings/numbers/booleans are coerced.
// ---------------------------------------------------------------------------

async function runDoctor(args) {
  const flags = parseFlags(args, { string: CONFIG_STRING_FLAGS, boolean: CONFIG_BOOLEAN_FLAGS });
  if (flags.help || flags.h) {
    console.log(`Usage:
  od doctor [--json]   Print a daemon + skills health summary.

Exit code is non-zero when the daemon cannot be reached.`);
    process.exit(0);
  }
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');
  const report = {
    daemon:        null,
    skills:        [],
    issues:        [],
  };

  // Daemon status
  try {
    const resp = await fetch(`${base}/api/daemon/status`);
    if (!resp.ok) {
      report.issues.push({ severity: 'error', code: 'daemon-status', message: `HTTP ${resp.status}` });
    } else {
      report.daemon = await resp.json();
    }
  } catch (err) {
    report.issues.push({ severity: 'error', code: 'daemon-not-running', message: String(err?.message ?? err) });
    if (flags.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      console.error('[doctor] daemon unreachable:', String(err?.message ?? err));
    }
    process.exit(64);
  }

  // Library inventory
  try {
    const [skillsResp] = await Promise.all([
      fetch(`${base}/api/skills`),
    ]);
    if (skillsResp.ok) {
      const data = await skillsResp.json();
      report.skills = data?.skills ?? [];
    }
  } catch (err) {
    report.issues.push({ severity: 'warn', code: 'library-list-failed', message: String(err?.message ?? err) });
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    console.log(`[doctor] daemon ${report.daemon?.bindHost ?? '?'}:${report.daemon?.port ?? '?'} pid=${report.daemon?.pid ?? '?'}`);
    console.log(`[doctor] skills ${report.skills.length}`);
    if (report.issues.length === 0) {
      console.log('[doctor] no issues');
    } else {
      for (const i of report.issues) {
        console.log(`  [${i.severity}] ${i.code}: ${i.message}`);
      }
    }
  }
  const hasError = report.issues.some((i) => i.severity === 'error');
  process.exit(hasError ? 1 : 0);
}

function coerceCliValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

async function runConfig(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od config list                      Print the full app config as JSON.
  od config get <key>                 Print one top-level key.
  od config set <key> <value>         Set a top-level key (string / number / boolean).
  od config set <key> --value-json '<json>'
                                       Set a key to a JSON value.
  od config unset <key>               Remove a top-level key.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.
  --json               Emit raw JSON.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  const flags = parseFlags(rest, { string: CONFIG_STRING_FLAGS, boolean: CONFIG_BOOLEAN_FLAGS });
  const base = (await libraryDaemonUrl(flags)).replace(/\/$/, '');

  const fetchConfig = async () => {
    const resp = await fetch(`${base}/api/app-config`);
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    return data?.config ?? {};
  };
  const writeConfig = async (next) => {
    const resp = await fetch(`${base}/api/app-config`, {
      method:  'PUT',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(next),
    });
    if (!resp.ok) return structuredHttpFailure(resp);
    return (await resp.json())?.config ?? next;
  };

  switch (sub) {
    case 'list': {
      const cfg = await fetchConfig();
      process.stdout.write(JSON.stringify(cfg, null, 2) + '\n');
      return;
    }
    case 'get': {
      const key = rest.find((a) => !a.startsWith('-'));
      if (!key) {
        console.error('Usage: od config get <key>');
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const value = cfg?.[key];
      if (flags.json) {
        process.stdout.write(JSON.stringify(value ?? null, null, 2) + '\n');
      } else {
        console.log(value === undefined ? '' : (typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
      }
      return;
    }
    case 'set': {
      const positional = rest.filter((a) => !a.startsWith('-')
        && a !== flags.value
        && a !== flags['value-json']);
      const [key, scalarValue] = positional;
      if (!key) {
        console.error('Usage: od config set <key> <value> | od config set <key> --value-json <json>');
        process.exit(2);
      }
      let parsed;
      if (typeof flags['value-json'] === 'string') {
        try { parsed = JSON.parse(flags['value-json']); } catch (err) {
          console.error(`--value-json must be valid JSON: ${err.message}`);
          process.exit(2);
        }
      } else if (typeof flags.value === 'string') {
        parsed = coerceCliValue(flags.value);
      } else if (scalarValue !== undefined) {
        parsed = coerceCliValue(scalarValue);
      } else {
        console.error('Provide a value (positional, --value, or --value-json).');
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const next = { ...cfg, [key]: parsed };
      const written = await writeConfig(next);
      if (flags.json) {
        process.stdout.write(JSON.stringify(written, null, 2) + '\n');
      } else {
        console.log(`[config] set ${key}`);
      }
      return;
    }
    case 'unset': {
      const key = rest.find((a) => !a.startsWith('-'));
      if (!key) {
        console.error('Usage: od config unset <key>');
        process.exit(2);
      }
      const cfg = await fetchConfig();
      const next = { ...cfg };
      delete next[key];
      const written = await writeConfig(next);
      if (flags.json) {
        process.stdout.write(JSON.stringify(written, null, 2) + '\n');
      } else {
        console.log(`[config] unset ${key}`);
      }
      return;
    }
    default:
      console.error(`unknown subcommand: od config ${sub}`);
      process.exit(2);
  }
}

async function readBodyFromFlags(flags) {
  if (typeof flags.body === 'string') return flags.body;
  if (typeof flags['body-file'] !== 'string') return undefined;
  const path = flags['body-file'];
  if (path === '-') {
    let body = '';
    for await (const chunk of process.stdin) body += chunk;
    return body;
  }
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, 'utf8');
}

// Read verbatim prose from `--prompt-file <path>` or `--prompt-file -` (stdin).
// Returns undefined when the flag is absent so callers can fall back to flags.
async function readPromptFileFromFlags(flags) {
  if (typeof flags['prompt-file'] !== 'string' || flags['prompt-file'].length === 0) {
    return undefined;
  }
  const path = flags['prompt-file'];
  if (path === '-') {
    return await new Promise((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf));
      process.stdin.on('error', reject);
    });
  }
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, 'utf8');
}

function repeatedFeedbackFlagValues(args, flagName) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === `--${flagName}`) {
      const value = args[index + 1];
      if (value != null && !value.startsWith('--')) values.push(value);
      index += 1;
      continue;
    }
    if (arg?.startsWith(`--${flagName}=`)) {
      values.push(arg.slice(flagName.length + 3));
    }
  }
  return values;
}

async function runFeedback(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(`Usage:
  od feedback list [--json] [--daemon-url <url>]
  od feedback submit --title <title> [--kind bug|suggestion]
                     [--severity low|normal|high|blocking]
                     [--body <text> | --prompt-file <path|->]
                     [--context <text>] [--contact <text>]
                     [--image <path> ...] [--json]
  od feedback status <report-id> <open|triaged|in_progress|resolved|closed|rejected> [--json]  (administrator only)

The web page and CLI use the same /api/matos/feedback endpoints. Images must
be PNG, JPEG, GIF, or WebP; up to four files, 5 MB each.`);
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, {
      string: FEEDBACK_STRING_FLAGS,
      boolean: FEEDBACK_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = await cliDaemonBaseUrl(flags);
  let resp;
  if (sub === 'list') {
    try {
      resp = await fetch(`${base}/api/matos/feedback`);
    } catch (err) {
      surfaceFetchError(err, base);
      process.exit(3);
    }
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    if (flags.json) return process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    console.log(`# ${data.summary?.total ?? 0} reports · ${data.summary?.fixedTotal ?? 0} fixed`);
    for (const issue of data.issues ?? []) {
      console.log([
        issue.id,
        issue.status,
        issue.kind,
        issue.createdAt,
        issue.title,
      ].join('\t'));
    }
    return;
  }
  if (sub === 'submit' || sub === 'create') {
    const title = typeof flags.title === 'string' ? flags.title.trim() : '';
    const fromFile = await readPromptFileFromFlags(flags);
    const body = typeof fromFile === 'string'
      ? fromFile.trim()
      : typeof flags.body === 'string'
        ? flags.body.trim()
        : '';
    if (!title || !body) {
      console.error('--title and either --body or --prompt-file are required');
      process.exit(2);
    }
    const form = new FormData();
    form.set('title', title);
    form.set('message', body);
    form.set('kind', typeof flags.kind === 'string' ? flags.kind : 'bug');
    form.set('severity', typeof flags.severity === 'string' ? flags.severity : 'normal');
    if (typeof flags.contact === 'string') form.set('contact', flags.contact);
    form.set('context', JSON.stringify({
      source: 'od-cli',
      ...(typeof flags.context === 'string' ? { note: flags.context } : {}),
    }));
    for (const imagePath of repeatedFeedbackFlagValues(rest, 'image')) {
      const buffer = readFileSync(imagePath);
      const mimeType = ({
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
      })[extname(imagePath).toLowerCase()] ?? 'application/octet-stream';
      form.append('images', new Blob([buffer], { type: mimeType }), basename(imagePath));
    }
    try {
      resp = await fetch(`${base}/api/matos/feedback`, { method: 'POST', body: form });
    } catch (err) {
      surfaceFetchError(err, base);
      process.exit(3);
    }
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    if (flags.json) return process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    console.log(`[feedback] submitted ${data.issue?.id ?? '(unknown id)'}`);
    console.log(`${data.issue?.status ?? 'open'}\t${data.issue?.title ?? title}`);
    return;
  }
  if (sub === 'status') {
    const positionals = positionalArgs(rest, FEEDBACK_STRING_FLAGS);
    const reportId = positionals[0];
    const status = positionals[1];
    if (!reportId || !status) {
      console.error('Usage: od feedback status <report-id> <status> [--json]');
      process.exit(2);
    }
    try {
      resp = await fetch(`${base}/api/matos/feedback/${encodeURIComponent(reportId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status }),
      });
    } catch (err) {
      surfaceFetchError(err, base);
      process.exit(3);
    }
    if (!resp.ok) return structuredHttpFailure(resp);
    const data = await resp.json();
    if (flags.json) return process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    console.log(`[feedback] ${reportId} -> ${data.issue?.status ?? status}`);
    return;
  }
  console.error(`unknown subcommand: od feedback ${sub}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Subcommand: od automation …
//
// Headless surface for the Automations tab. This is the dual-track contract:
// every capability the Automations UI exposes is reachable here so an
// external agents can run
// the full lifecycle — list, create, fire, harvest, retire — without
// rendering a page. Storage is /api/routines on the local daemon; the
// "routine" name is the implementation detail, "automation" is the user-
// facing surface.
// ---------------------------------------------------------------------------

function parseScheduleFlag(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error(
      '--schedule is required. Forms: hourly:<minute> | daily:HH:MM[:TZ] | weekdays:HH:MM[:TZ] | weekly:DAY:HH:MM[:TZ]',
    );
  }
  const parts = raw.split(':');
  const kind = parts[0];
  if (kind === 'hourly') {
    const minute = Number(parts[1]);
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
      throw new Error('--schedule hourly requires :<minute>, 0-59');
    }
    return { kind: 'hourly', minute };
  }
  if (kind === 'daily' || kind === 'weekdays') {
    if (parts.length < 3) {
      throw new Error(`--schedule ${kind} requires :HH:MM[:TZ]`);
    }
    const hh = parts[1];
    const mm = parts[2];
    const time = `${hh.padStart(2, '0')}:${mm.padStart(2, '0')}`;
    if (!/^[0-2]\d:[0-5]\d$/.test(time)) {
      throw new Error(`--schedule ${kind} time must be HH:MM (24h)`);
    }
    const timezone = parts.slice(3).join(':') || 'UTC';
    return { kind, time, timezone };
  }
  if (kind === 'weekly') {
    if (parts.length < 4) {
      throw new Error('--schedule weekly requires :DAY:HH:MM[:TZ] (DAY is 0-6 or sun/mon/...)');
    }
    const dayToken = String(parts[1]).toLowerCase();
    let weekday;
    if (/^[0-6]$/.test(dayToken)) {
      weekday = Number(dayToken);
    } else if (AUTOMATION_WEEKDAY_TOKENS[dayToken] !== undefined) {
      weekday = AUTOMATION_WEEKDAY_TOKENS[dayToken];
    } else {
      throw new Error(`--schedule weekly day must be 0-6 or sun..sat (got "${parts[1]}")`);
    }
    const time = `${parts[2].padStart(2, '0')}:${parts[3].padStart(2, '0')}`;
    if (!/^[0-2]\d:[0-5]\d$/.test(time)) {
      throw new Error('--schedule weekly time must be HH:MM (24h)');
    }
    const timezone = parts.slice(4).join(':') || 'UTC';
    return { kind: 'weekly', weekday, time, timezone };
  }
  throw new Error(`--schedule kind must be hourly|daily|weekdays|weekly (got "${kind}")`);
}

function parseAutomationTarget(flags) {
  const raw = flags.target;
  if (raw == null) {
    if (flags.project) return { mode: 'reuse', projectId: String(flags.project) };
    return { mode: 'create_each_run' };
  }
  const value = String(raw);
  if (
    value === 'worktree' ||
    value === 'new-project' ||
    value === 'create-each-run' ||
    value === 'create_each_run'
  ) {
    return { mode: 'create_each_run' };
  }
  if (value === 'reuse') {
    if (!flags.project) {
      throw new Error('--target reuse needs --project <id>');
    }
    return { mode: 'reuse', projectId: String(flags.project) };
  }
  const eq = value.indexOf('=');
  if ((value.startsWith('reuse=') || value.startsWith('reuse:')) && eq > 0) {
    const projectId = value.slice(eq + 1).trim();
    if (!projectId) throw new Error('--target reuse=<projectId> needs a non-empty id');
    return { mode: 'reuse', projectId };
  }
  throw new Error(
    `--target must be "new-project" or "reuse=<projectId>" (got "${value}")`,
  );
}

function describeAutomationScheduleForCli(schedule) {
  if (!schedule) return '-';
  if (schedule.kind === 'hourly') {
    return `hourly:${String(schedule.minute).padStart(2, '0')}`;
  }
  if (schedule.kind === 'weekly') {
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    return `weekly:${days[schedule.weekday] ?? schedule.weekday}:${schedule.time}:${schedule.timezone}`;
  }
  return `${schedule.kind}:${schedule.time}:${schedule.timezone}`;
}

function describeAutomationTargetForCli(target) {
  if (!target) return '-';
  if (target.mode === 'reuse') return `reuse=${target.projectId}`;
  return 'new-project';
}

function splitAutomationIds(value) {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const part of value.split(',')) {
    const id = part.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function automationContextFromFlags(flags) {
  const skillIds = splitAutomationIds(flags.skill);
  const mcpServerIds = splitAutomationIds(flags.mcp);
  const context = {
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
  };
  return Object.keys(context).length > 0 ? context : null;
}

function formatAutomationRow(r) {
  const next = r.nextRunAt
    ? new Date(r.nextRunAt).toISOString()
    : (r.enabled ? '-' : 'paused');
  return [
    r.id,
    r.name,
    describeAutomationScheduleForCli(r.schedule),
    describeAutomationTargetForCli(r.target),
    r.enabled ? 'enabled' : 'paused',
    next,
  ].join('\t');
}

async function readPromptFromFlags(flags) {
  if (typeof flags.prompt === 'string' && flags.prompt.length > 0) {
    return flags.prompt;
  }
  if (typeof flags['prompt-file'] === 'string' && flags['prompt-file'].length > 0) {
    const path = flags['prompt-file'];
    if (path === '-') {
      return await new Promise((resolve, reject) => {
        let buf = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', (chunk) => { buf += chunk; });
        process.stdin.on('end', () => resolve(buf));
        process.stdin.on('error', reject);
      });
    }
    const { readFile } = await import('node:fs/promises');
    return await readFile(path, 'utf8');
  }
  return null;
}

function printAutomationHelp() {
  console.log(`Usage:
  od automation template list                                List built-in automation templates.
  od automation template get <id>                            Print one built-in automation template.
  od automation source ingest --source-kind <kind> --title <title>
                              [--source-ref <ref>] [--template <id>]
                              [--body <markdown> | --body-file <path|->]
                              [--compression off|balanced|aggressive]
                              [--json]
  od automation source list [--limit 20] [--json]             List ingested source packets.
  od automation source get <id> [--json]                      Print one source packet.
  od automation proposal list [--status pending-review]       List self-evolution proposals.
  od automation proposal get <id>                             Print one proposal.
  od automation proposal apply <id>                           Apply a reviewable proposal.
  od automation proposal reject <id> [--reason "<why>"]       Reject a reviewable proposal.
  od automation list                                         List automations.
  od automation get <id>                                     Print one automation.
  od automation create --name "<title>" --prompt "<text>"
                       --schedule <spec>
                       [--target new-project|reuse=<projectId>]
                       [--disabled] [--json]
                       [--prompt-file <path|->] (alternative to --prompt)
                       [--skill <id>[,<id>]]
                       [--mcp <id>[,<id>]]
                       [--agent <id>]
  od automation update <id> [--name ...] [--prompt ...]
                            [--schedule ...] [--target ...]
                            [--skill ...] [--mcp ...]
                            [--enabled|--disabled]
                            Patch fields.
  od automation run <id>                                       Trigger a manual run; prints projectId/conversationId.
  od automation runs <id> [--limit 10]                         Print run history.
  od automation crystallize-run <routineId> <runId> [--json]    Turn a succeeded run into skill proposals.
  od automation pause <id>                                     Mark disabled.
  od automation resume <id>                                    Mark enabled.
  od automation delete <id>                                    Remove the automation (history retained).

Schedule formats:
  hourly:<minute>                    Every hour at :MM.
  daily:HH:MM[:TZ]                   Daily at HH:MM in TZ (default UTC).
  weekdays:HH:MM[:TZ]                Mon-Fri at HH:MM.
  weekly:DAY:HH:MM[:TZ]              DAY = 0-6 or sun|mon|...|sat.

Output:
  Plain text: tab-separated rows for list, human-readable lines for get / runs.
  --json     Raw JSON for any subcommand.
  Designed so external agents (bots, scripted jobs)
  can drive the full automation lifecycle headlessly.

Common options:
  --daemon-url <url>   MatOS daemon HTTP base.`);
}

async function runAutomation(args) {
  if (args.length === 0 || args[0] === 'help' || args.includes('--help') || args.includes('-h')) {
    printAutomationHelp();
    process.exit(args.length === 0 ? 2 : 0);
  }
  const sub = args[0];
  const rest = args.slice(1);
  let flags;
  try {
    flags = parseFlags(rest, {
      string: AUTOMATION_STRING_FLAGS,
      boolean: AUTOMATION_BOOLEAN_FLAGS,
    });
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const base = await cliDaemonBaseUrl(flags);

  const writeJson = (data) =>
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');

  const positionalArgs = (values) => {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      if (!value) continue;
      if (value.startsWith('--')) {
        const eq = value.indexOf('=');
        const key = eq >= 0 ? value.slice(2, eq) : value.slice(2);
        if (eq < 0 && AUTOMATION_STRING_FLAGS.has(key)) i++;
        continue;
      }
      out.push(value);
    }
    return out;
  };

  const requireId = (label) => {
    const id = positionalArgs(rest)[0];
    if (!id) {
      console.error(`Usage: od automation ${label} <id>`);
      process.exit(2);
    }
    return id;
  };

  const readAutomationIngestBody = async () => {
    const direct = await readBodyFromFlags(flags);
    if (typeof direct === 'string') return direct;
    return await readPromptFromFlags(flags);
  };

  switch (sub) {
    case 'template':
    case 'templates': {
      const parts = positionalArgs(rest);
      const action = parts[0] ?? 'list';
      if (action === 'list') {
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-templates`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        const templates = data.templates ?? [];
        if (templates.length === 0) {
          console.log('No automation templates available.');
          return;
        }
        console.log('# id\ttitle\ttriggers\tsources\toutputs\tcompression\treview');
        for (const template of templates) {
          console.log([
            template.id,
            template.title,
            (template.triggerKinds ?? []).join(','),
            (template.sourceKinds ?? []).join(','),
            (template.outputSinks ?? []).join(','),
            template.tokenCompression,
            template.reviewPolicy,
          ].join('\t'));
        }
        return;
      }
      if (action === 'get') {
        const id = parts[1];
        if (!id) {
          console.error('Usage: od automation template get <id>');
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-templates/${encodeURIComponent(id)}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        return writeJson(flags.json ? data : (data.template ?? data));
      }
      console.error(`unknown subcommand: od automation template ${action}`);
      printAutomationHelp();
      process.exit(2);
    }
    case 'ingest':
    case 'source':
    case 'sources': {
      const parts = positionalArgs(rest);
      const action = sub === 'ingest' ? 'ingest' : (parts[0] ?? 'list');
      if (action === 'ingest') {
        const sourceKind = flags['source-kind'] ?? (sub === 'ingest' ? parts[0] : parts[1]);
        if (!sourceKind) {
          console.error('Usage: od automation source ingest --source-kind <kind> --body-file <path|->');
          process.exit(2);
        }
        const bodyMarkdown = await readAutomationIngestBody();
        if (!bodyMarkdown) {
          console.error('--body, --body-file, --prompt, or --prompt-file is required');
          process.exit(2);
        }
        const candidateSinks = typeof flags['candidate-sinks'] === 'string'
          ? flags['candidate-sinks'].split(',').map((item) => item.trim()).filter(Boolean)
          : undefined;
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-ingestions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              templateId: flags.template,
              sourceKind,
              sourceRef: flags['source-ref'],
              title: flags.title ?? flags.name,
              bodyMarkdown,
              projectId: flags.project,
              sensitivity: flags.sensitivity,
              tokenCompression: flags.compression,
              candidateSinks,
            }),
          });
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        console.log(`[automation source] ingested ${data.packet?.id}`);
        console.log(`compression: ${data.compressionReport?.status ?? 'unknown'} (${data.compressionReport?.beforeTokens ?? 0} -> ${data.compressionReport?.afterTokens ?? 0} tokens)`);
        const proposals = data.proposals ?? [];
        if (proposals.length > 0) {
          console.log('# proposals');
          for (const proposal of proposals) {
            console.log([
              proposal.id,
              proposal.targetKind,
              proposal.action,
              proposal.status,
              proposal.title,
            ].join('\t'));
          }
        }
        return;
      }
      if (action === 'list') {
        const query = flags.limit ? `?limit=${encodeURIComponent(String(flags.limit))}` : '';
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-source-packets${query}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        const packets = data.packets ?? [];
        if (packets.length === 0) {
          console.log('No automation source packets.');
          return;
        }
        console.log('# id\tkind\tcapturedAt\ttokens\ttitle');
        for (const packet of packets) {
          console.log([
            packet.id,
            packet.sourceKind,
            packet.capturedAt,
            packet.tokenStats?.originalTokens ?? 0,
            packet.title,
          ].join('\t'));
        }
        return;
      }
      if (action === 'get') {
        const id = parts[1];
        if (!id) {
          console.error('Usage: od automation source get <id>');
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-source-packets/${encodeURIComponent(id)}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        return writeJson(await resp.json());
      }
      console.error(`unknown subcommand: od automation source ${action}`);
      printAutomationHelp();
      process.exit(2);
    }
    case 'proposal':
    case 'proposals': {
      const parts = positionalArgs(rest);
      const action = parts[0] ?? 'list';
      if (action === 'list') {
        const query = flags.status ? `?status=${encodeURIComponent(String(flags.status))}` : '';
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-proposals${query}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        const proposals = data.proposals ?? [];
        if (proposals.length === 0) {
          console.log('No automation proposals.');
          return;
        }
        console.log('# id\tstatus\ttarget\taction\tupdatedAt\ttitle');
        for (const proposal of proposals) {
          console.log([
            proposal.id,
            proposal.status,
            proposal.targetKind,
            proposal.action,
            proposal.updatedAt,
            proposal.title,
          ].join('\t'));
        }
        return;
      }
      if (action === 'get') {
        const id = parts[1];
        if (!id) {
          console.error('Usage: od automation proposal get <id>');
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(`${base}/api/automation-proposals/${encodeURIComponent(id)}`);
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        return writeJson(await resp.json());
      }
      if (action === 'apply' || action === 'reject') {
        const id = parts[1];
        if (!id) {
          console.error(`Usage: od automation proposal ${action} <id>`);
          process.exit(2);
        }
        let resp;
        try {
          resp = await fetch(
            `${base}/api/automation-proposals/${encodeURIComponent(id)}/${action}`,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: action === 'reject'
                ? JSON.stringify({ reason: flags.reason ?? '' })
                : '{}',
            },
          );
        } catch (err) {
          surfaceFetchError(err, base);
          process.exit(3);
        }
        if (!resp.ok) return structuredHttpFailure(resp);
        const data = await resp.json();
        if (flags.json) return writeJson(data);
        console.log(`[automation proposal] ${action === 'apply' ? 'applied' : 'rejected'} ${data.proposal?.id ?? id}`);
        return;
      }
      console.error(`unknown subcommand: od automation proposal ${action}`);
      printAutomationHelp();
      process.exit(2);
    }
    case 'list': {
      let resp;
      try {
        resp = await fetch(`${base}/api/routines`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      const routines = data.routines ?? [];
      if (routines.length === 0) {
        console.log('No automations. Create one with `od automation create --name "..." --prompt "..." --schedule daily:09:00`.');
        return;
      }
      console.log('# id\tname\tschedule\ttarget\tstatus\tnextRun');
      for (const r of routines) console.log(formatAutomationRow(r));
      return;
    }
    case 'get': {
      const id = requireId('get');
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`);
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      writeJson(data.routine ?? data);
      return;
    }
    case 'runs': {
      const id = requireId('runs');
      const limit = Number(flags.limit) > 0 ? Number(flags.limit) : 20;
      let resp;
      try {
        resp = await fetch(
          `${base}/api/routines/${encodeURIComponent(id)}/runs?limit=${limit}`,
        );
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      const runs = data.runs ?? [];
      if (runs.length === 0) {
        console.log(`No runs yet for ${id}.`);
        return;
      }
      console.log('# runId\tstatus\ttrigger\tstartedAt\tprojectId\tconversationId');
      for (const r of runs) {
        console.log([
          r.id,
          r.status,
          r.trigger,
          new Date(r.startedAt).toISOString(),
          r.projectId,
          r.conversationId,
        ].join('\t'));
      }
      return;
    }
    case 'crystallize-run': {
      const parts = positionalArgs(rest);
      const routineId = parts[0];
      const runId = parts[1];
      if (!routineId || !runId) {
        console.error('Usage: od automation crystallize-run <routineId> <runId> [--json]');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(
          `${base}/api/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(runId)}/crystallize`,
          { method: 'POST' },
        );
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      const data = await resp.json();
      if (flags.json) return writeJson(data);
      console.log(`[automation] crystallized ${runId}`);
      console.log(`sourcePacket\t${data.packet?.id ?? ''}`);
      console.log(`compression\t${data.compressionReport?.status ?? 'unknown'}\t${data.compressionReport?.beforeTokens ?? 0}->${data.compressionReport?.afterTokens ?? 0}`);
      const proposals = data.proposals ?? [];
      if (proposals.length > 0) {
        console.log('# proposals');
        for (const proposal of proposals) {
          console.log([
            proposal.id,
            proposal.targetKind,
            proposal.action,
            proposal.status,
            proposal.title,
          ].join('\t'));
        }
      }
      return;
    }
    case 'create': {
      const name = typeof flags.name === 'string' ? flags.name.trim() : '';
      if (!name) {
        console.error('--name is required');
        process.exit(2);
      }
      const prompt = (await readPromptFromFlags(flags)) || '';
      if (!prompt.trim()) {
        console.error('--prompt or --prompt-file is required');
        process.exit(2);
      }
      let schedule;
      let target;
      try {
        schedule = parseScheduleFlag(flags.schedule);
        target = parseAutomationTarget(flags);
      } catch (err) {
        console.error(err.message);
        process.exit(2);
      }
      const body = {
        name,
        prompt: prompt.trim(),
        schedule,
        target,
        enabled: !flags.disabled,
      };
      const context = automationContextFromFlags(flags);
      const skillIds = splitAutomationIds(flags.skill);
      if (skillIds.length > 0) body.skillId = skillIds[0];
      if (context) body.context = context;
      if (flags.agent) body.agentId = String(flags.agent);
      let resp;
      try {
        resp = await fetch(`${base}/api/routines`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`POST /api/routines failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] created ${data.routine?.id}`);
      console.log(formatAutomationRow(data.routine));
      return;
    }
    case 'update': {
      const id = requireId('update');
      const patch = {};
      if (typeof flags.name === 'string') patch.name = flags.name.trim();
      const promptPatch = await readPromptFromFlags(flags);
      if (promptPatch != null) patch.prompt = promptPatch.trim();
      if (flags.schedule) {
        try {
          patch.schedule = parseScheduleFlag(flags.schedule);
        } catch (err) {
          console.error(err.message);
          process.exit(2);
        }
      }
      if (flags.target || flags.project) {
        try {
          patch.target = parseAutomationTarget(flags);
        } catch (err) {
          console.error(err.message);
          process.exit(2);
        }
      }
      if (flags.disabled) patch.enabled = false;
      if (flags.enabled) patch.enabled = true;
      const context = automationContextFromFlags(flags);
      if (context) {
        const skillIds = splitAutomationIds(flags.skill);
        if (skillIds.length > 0) patch.skillId = skillIds[0];
        patch.context = context;
      }
      if (Object.keys(patch).length === 0) {
        console.error('update needs at least one of --name --prompt(--prompt-file) --schedule --target --skill --mcp --enabled --disabled');
        process.exit(2);
      }
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`PATCH /api/routines/${id} failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] updated ${id}`);
      console.log(formatAutomationRow(data.routine));
      return;
    }
    case 'pause':
    case 'resume': {
      const id = requireId(sub);
      const enabled = sub === 'resume';
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled }),
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`PATCH /api/routines/${id} failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] ${sub}d ${id}`);
      return;
    }
    case 'run': {
      const id = requireId('run');
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}/run`, {
          method: 'POST',
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok && resp.status !== 202) {
        console.error(`POST /api/routines/${id}/run failed: ${resp.status} ${JSON.stringify(data)}`);
        process.exit(1);
      }
      if (flags.json) return writeJson(data);
      console.log(`[automation] triggered ${id}`);
      if (data.projectId) console.log(`projectId\t${data.projectId}`);
      if (data.conversationId) console.log(`conversationId\t${data.conversationId}`);
      if (data.agentRunId) console.log(`agentRunId\t${data.agentRunId}`);
      return;
    }
    case 'delete': {
      const id = requireId('delete');
      let resp;
      try {
        resp = await fetch(`${base}/api/routines/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      } catch (err) {
        surfaceFetchError(err, base);
        process.exit(3);
      }
      if (!resp.ok) return structuredHttpFailure(resp);
      if (flags.json) return writeJson({ ok: true, id });
      console.log(`[automation] deleted ${id}`);
      return;
    }
    default:
      console.error(`unknown subcommand: od automation ${sub}`);
      printAutomationHelp();
      process.exit(2);
  }
}
