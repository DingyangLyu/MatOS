import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { LogSource } from "./sources.js";

const DEFAULT_RUN_EVENT_TAIL_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RUN_EVENT_LOGS = 20;

const SAFE_DIR_ENTRY = /^[A-Za-z0-9._-]+$/u;

async function statSafe(path: string): Promise<{ mtimeMs: number; isFile: boolean } | null> {
  try {
    const info = await stat(path);
    return { mtimeMs: info.mtimeMs, isFile: info.isFile() };
  } catch {
    return null;
  }
}

/**
 * Collect the most-recent per-run event logs (`<runsDir>/<runId>/events.jsonl`).
 *
 * These are the daemon's capture of each agent CLI's own stdout/stderr/stream
 * for a run — the single richest, agent-agnostic diagnostic signal for "the
 * run failed / produced nothing". Shared so both the daemon HTTP export and the
 * desktop IPC export bundle the same data.
 */
export async function buildRunEventLogSources(
  runsDir: string | null | undefined,
  options: { maxRuns?: number; tailBytes?: number } = {},
): Promise<LogSource[]> {
  if (!runsDir) return [];
  const maxRuns = options.maxRuns ?? DEFAULT_MAX_RUN_EVENT_LOGS;
  const tailBytes = options.tailBytes ?? DEFAULT_RUN_EVENT_TAIL_BYTES;

  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<{ runId: string; absolutePath: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!SAFE_DIR_ENTRY.test(entry.name)) continue;
    const absolutePath = join(runsDir, entry.name, "events.jsonl");
    const info = await statSafe(absolutePath);
    if (!info || !info.isFile) continue;
    candidates.push({ runId: entry.name, absolutePath, mtimeMs: info.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, maxRuns).map(({ runId, absolutePath }) => ({
    name: `runs/${runId}/events.jsonl`,
    absolutePath,
    kind: "text",
    tailBytes,
  }));
}
