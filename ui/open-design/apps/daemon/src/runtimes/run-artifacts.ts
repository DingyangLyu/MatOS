// Daemon-side helper that counts how many distinct artifact files this
// run produced or modified. Fed into v2 `run_finished.artifact_count`.
//
// "Artifact" = a user-facing output file: HTML (prototypes / slide decks all
// render from `.html`), plus generated media — images, video,
// and audio — so media-kind projects no longer report a false zero. Supporting
// assets an HTML run happens to write (e.g. `assets/*.png`) are also counted;
// the metric's primary use is the boolean "did this run produce any artifact?"
// funnel, where over-counting the exact number is harmless and under-counting
// (the old HTML-only behaviour) was not.
//
// Semantics (per product spec, 2026-05-21; widened beyond HTML 2026-06-15):
//   - Count is incremental for THIS run only, not cumulative across the
//     project. If the run touched no artifact files, the count is 0.
//   - A file written multiple times within the same run counts once
//     (dedup by path) so a Write-then-Edit cycle on the same file
//     reports one artifact, not two.
//   - Both Write (create_file) and Edit / MultiEdit count, because the
//     agent often writes a skeleton then edits to fill it in; both end
//     in a new file state at run end.
//   - Read-only ops never count.
//   - Failed ops never count. A `tool_use` whose matching `tool_result`
//     reports `isError: true` (permission denied, path outside cwd,
//     parent missing, etc.) does NOT produce an artifact even though
//     the tool name and path were correct. Earlier the helper skipped
//     this join, so a "Write index.html" that errored still bumped
//     `artifact_count` to 1 and corrupted the
//     "generation_success → artifact_produced" funnel (mrcfps review
//     on PR #2590).
//
// Earlier `server.ts` hard-coded `artifact_count: 0`, which produced
// uniform zero in the run outcome and made the same artifact signal useless from the
// other direction.

// Tool names cover the stream-json and MCP tool shapes
// the daemon proxies. Keep aligned with the web-side `WRITE_NAMES` /
// `EDIT_NAMES` sets in `apps/web/src/runtime/file-ops.ts`.
const WRITE_OR_EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Write',
  'create_file',
  'Edit',
  'str_replace_edit',
  'MultiEdit',
  'multi_edit',
]);

function extractToolFilePath(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as { file_path?: unknown; path?: unknown };
  if (typeof obj.file_path === 'string' && obj.file_path) return obj.file_path;
  if (typeof obj.path === 'string' && obj.path) return obj.path;
  return null;
}

// Artifact-output file extensions. HTML covers prototypes / slide decks; the
// media sets mirror the canonical kind classifier in
// `projects.ts` (`.image` / `.video` / `.audio` buckets) so the counter agrees
// with how the rest of the app classifies generated files.
const ARTIFACT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.html',
  '.htm',
  // image
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  // SVG renders as a user-facing artifact (`kindFor` buckets it as `sketch`,
  // and the daemon / web artifact manifests treat `image/svg+xml` as a
  // renderable output), so a run that writes only `logo.svg` must not report
  // artifact_count: 0.
  '.svg',
  // video
  '.mp4',
  '.mov',
  '.webm',
  // audio
  '.mp3',
  '.wav',
  '.m4a',
]);

// Exported so the agent-agnostic filesystem artifact counter
// (`run-artifact-fs.ts`) classifies files by the exact same extension set the
// tool-stream counter uses, keeping the two definitions of "artifact" aligned.
export function isArtifactPath(path: string): boolean {
  const lower = path.toLowerCase();
  const dot = lower.lastIndexOf('.');
  if (dot < 0) return false;
  return ARTIFACT_EXTENSIONS.has(lower.slice(dot));
}

export interface RunEventLike {
  event?: string;
  data?: unknown;
}

// Join key the daemon-stream uses for tool_use → tool_result pairing.
// Structured streams stamp the same `id` onto the `tool_use`
// event and reference it via `toolUseId` on the subsequent
// `tool_result`; see the run artifact collector below.
function readToolUseId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as { id?: unknown };
  return typeof obj.id === 'string' && obj.id ? obj.id : null;
}

function readToolResultId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as { toolUseId?: unknown };
  return typeof obj.toolUseId === 'string' && obj.toolUseId
    ? obj.toolUseId
    : null;
}

function readToolResultIsError(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  return (data as { isError?: unknown }).isError === true;
}

// Generic write counter shared by all three predicates. Returns the
// set of distinct paths the run successfully wrote / edited that
// match `predicate`. Failure-pairing semantics match
// `countNewArtifacts` so the counters stay aligned.
function collectWrittenPathsMatching(
  events: readonly RunEventLike[],
  predicate: (path: string) => boolean,
): Set<string> {
  if (!events || events.length === 0) return new Set();
  const resultByToolUseId = new Map<string, { isError: boolean }>();
  for (const rec of events) {
    if (rec?.event !== 'agent') continue;
    const data = rec.data as { type?: string } | null | undefined;
    if (data?.type !== 'tool_result') continue;
    const id = readToolResultId(rec.data);
    if (!id) continue;
    resultByToolUseId.set(id, { isError: readToolResultIsError(rec.data) });
  }
  const writtenPaths = new Set<string>();
  for (const rec of events) {
    if (rec?.event !== 'agent') continue;
    const data = rec.data as
      | { type?: string; name?: unknown; input?: unknown }
      | null
      | undefined;
    if (data?.type !== 'tool_use') continue;
    if (typeof data.name !== 'string') continue;
    if (!WRITE_OR_EDIT_TOOL_NAMES.has(data.name)) continue;
    const path = extractToolFilePath(data.input);
    if (!path) continue;
    if (!predicate(path)) continue;
    const toolUseId = readToolUseId(rec.data);
    if (!toolUseId) continue;
    const outcome = resultByToolUseId.get(toolUseId);
    if (!outcome) continue;
    if (outcome.isError) continue;
    writtenPaths.add(path);
  }
  return writtenPaths;
}

// Count of distinct artifact files (HTML + image/video/audio) the run
// successfully wrote or edited. Fed into `run_finished.artifact_count`.
// Failure-pairing + path-dedup semantics come from the shared
// `collectWrittenPathsMatching` helper (a tool_use whose tool_result reports
// `isError` does not count; a file written then edited counts once).
export function countNewArtifacts(events: readonly RunEventLike[]): number {
  return collectWrittenPathsMatching(events, isArtifactPath).size;
}
