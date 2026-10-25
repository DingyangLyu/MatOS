// MatOS operations view data: resource monitoring, workflow runs, and
// self-evolution status for the Tasks/Automations surface.
//
// Real sources only: `nvidia-smi` GPU samples, node `os` counters (CPU load /
// memory), the scope's workflow
// run records (`<scope>/workflows/runs/run_*/run.json`), and
// `matos evolve status --json`. Each block degrades independently so a
// slow CLI never blanks the whole page; results are cached briefly.

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import { execMatOSJson, isRecord, matosCwd } from '../services/matos-cli.js';
import { createStaleWhileRevalidateCache } from '../services/stale-while-revalidate.js';

const OPS_CACHE_TTL_MS = Number(process.env.MATOS_OPS_CACHE_MS || 120_000);
const OPS_CACHE_STALE_MS = Number(process.env.MATOS_OPS_STALE_MS || 15 * 60_000);

export interface WorkflowRunSummary {
  runId: string;
  workflowRef: string | null;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/**
 * The scope's workflow runs live beside (not inside) the assets cwd:
 * `<scopeRoot>/workspace-state/shared` (assets cwd) sits next to
 * `<scopeRoot>/workflows/runs`. Repo-root fallbacks use `.matos/workflows`.
 */
function workflowRunsDirCandidates(): string[] {
  const cwd = matosCwd();
  const explicit = process.env.MATOS_WORKFLOW_RUNS_DIR?.trim();
  const out: string[] = [];
  if (explicit) out.push(path.resolve(explicit));
  out.push(path.resolve(cwd, '..', '..', 'workflows', 'runs'));
  out.push(path.join(cwd, '.matos', 'workflows', 'runs'));
  return out;
}

async function listWorkflowRuns(limit = 25): Promise<WorkflowRunSummary[]> {
  const dir = workflowRunsDirCandidates().find((candidate) => existsSync(candidate));
  if (!dir) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: WorkflowRunSummary[] = [];
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('run_'))
      .map(async (entry) => {
        try {
          const raw = JSON.parse(
            await readFile(path.join(dir, entry.name, 'run.json'), 'utf8'),
          ) as Record<string, unknown>;
          runs.push({
            runId: typeof raw.runId === 'string' ? raw.runId : entry.name,
            workflowRef: typeof raw.workflowRef === 'string' ? raw.workflowRef : null,
            status: typeof raw.status === 'string' ? raw.status : 'unknown',
            createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
          });
        } catch {
          // Skip malformed run dirs.
        }
      }),
  );
  runs.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  return runs.slice(0, limit);
}

interface GpuSample {
  index: number;
  memoryUsedMib: number | null;
  util: number | null;
}

type MatOSJsonExecutor = typeof execMatOSJson;

const NVIDIA_SMI_TIMEOUT_MS = 5_000;

function parseNvidiaSmiCsv(stdout: string): GpuSample[] {
  const samples: GpuSample[] = [];
  for (const line of stdout.split('\n')) {
    const [index, memoryUsed, util] = line.split(',').map((part) => part.trim());
    if (!index || !/^\d+$/.test(index)) continue;
    const memory = Number(memoryUsed);
    const utilization = Number(util);
    samples.push({
      index: Number(index),
      memoryUsedMib: Number.isFinite(memory) ? memory : null,
      util: Number.isFinite(utilization) ? utilization : null,
    });
  }
  return samples;
}

/** GPU samples from `nvidia-smi`; null when the host has no NVIDIA tooling. */
function gpuStatus(): Promise<{ ok: boolean; samples: GpuSample[] } | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=index,memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
      { timeout: NVIDIA_SMI_TIMEOUT_MS },
      (error, stdout) => {
        if (error) return resolve(null);
        resolve({ ok: true, samples: parseNvidiaSmiCsv(String(stdout)) });
      },
    );
  });
}

async function evolveStatus(execute: MatOSJsonExecutor): Promise<Record<string, unknown> | null> {
  try {
    const payload = await execute(['evolve', 'status', '--json']);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function systemStatus() {
  const load = os.loadavg();
  return {
    cpuCount: os.cpus().length,
    load1: load[0] ?? 0,
    load5: load[1] ?? 0,
    load15: load[2] ?? 0,
    totalMemBytes: os.totalmem(),
    freeMemBytes: os.freemem(),
  };
}

export interface RegisterMatOSOpsRoutesOptions {
  execute?: MatOSJsonExecutor;
  now?: () => number;
  freshMs?: number;
  staleMs?: number;
  loadWorkflowRuns?: () => Promise<WorkflowRunSummary[]>;
  readSystemStatus?: typeof systemStatus;
  readGpuStatus?: typeof gpuStatus;
}

export function registerMatOSOpsRoutes(
  app: Express,
  options: RegisterMatOSOpsRoutesOptions = {},
): void {
  const execute = options.execute ?? execMatOSJson;
  const now = options.now ?? Date.now;
  const cache = createStaleWhileRevalidateCache({
    freshMs: options.freshMs ?? OPS_CACHE_TTL_MS,
    staleMs: options.staleMs ?? OPS_CACHE_STALE_MS,
    now,
    load: async () => {
      const [gpu, evolve, workflowRuns] = await Promise.all([
        (options.readGpuStatus ?? gpuStatus)(),
        evolveStatus(execute),
        (options.loadWorkflowRuns ?? listWorkflowRuns)(),
      ]);
      return {
        system: (options.readSystemStatus ?? systemStatus)(),
        gpu,
        evolve,
        workflowRuns,
        generatedAt: new Date(now()).toISOString(),
      };
    },
  });

  app.get('/api/matos/ops', (_req: Request, res: Response) => {
    void (async () => {
      res.json(await cache.get());
    })().catch((error) => {
      res.status(502).json({
        error: {
          code: 'MATOS_OPS',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
  });
}
