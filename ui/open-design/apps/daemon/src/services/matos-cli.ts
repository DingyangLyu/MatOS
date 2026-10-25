// Shared MatOS CLI transport for the daemon's product bridges.
//
// Both the Assets workbench (`routes/matos-assets.ts`) and the Workflow
// Studio canvas (`routes/matos-workflow.ts`) are thin adapters over the same
// `matos ... --json` CLI surfaces. This module owns the one process boundary
// they share: how the daemon locates the `matos` binary, which MatOS project
// cwd/scope it runs in, and how it turns a `--json` stdout into a parsed
// payload. No product/business logic lives here.

import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `MATOS_BIN` overrides the binary. Source checkouts use the sibling repo
 * entrypoint when it exists; packaged/runtime installs continue to use PATH.
 */
function resolveMatOSBin(): string {
  const configured = process.env.MATOS_BIN?.trim();
  if (configured) return configured;
  const repositoryBin = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../../../../bin/matos',
  );
  return existsSync(repositoryBin) ? repositoryBin : 'matos';
}

export const MATOS_BIN = resolveMatOSBin();

// Cold `bun` starts plus asset-graph composition can take tens of seconds, so
// the CLI timeout is generous. Override with `MATOS_CLI_BRIDGE_TIMEOUT_MS`
// (kept back-compatible with the older `MATOS_ASSETS_BRIDGE_TIMEOUT_MS`).
export const EXEC_TIMEOUT_MS = Number(
  process.env.MATOS_CLI_BRIDGE_TIMEOUT_MS ||
    process.env.MATOS_ASSETS_BRIDGE_TIMEOUT_MS ||
    120_000,
);

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

function operatorActionsEnabled(env: NodeJS.ProcessEnv): boolean {
  return (
    /^(1|true|yes|on)$/i.test(env.OD_MATOS_OPERATOR_ACTIONS?.trim() ?? '') &&
    env.MATOS_SCOPE_REF?.trim() === 'deployment'
  );
}

const WORKSPACE_SCOPED_GITEA_TOKEN_FILE = '/workspace/ipc/matos-gitea.token';

/**
 * Product daemons are scoped user processes. Strip every operator credential
 * before crossing the CLI process boundary; retain only a PAT explicitly
 * marked as scoped or supplied through the per-user token file.
 */
export function matosCliEnv(env: NodeJS.ProcessEnv = process.env, cwd?: string): NodeJS.ProcessEnv {
  const child = { ...env };
  // bin/matos restores this directory after entering its source checkout.
  // Preserve the user's asset root, but never let inherited cwd override an
  // explicitly resolved project in the subprocess options.
  if (cwd) child.MATOS_ORIGINAL_CWD = cwd;
  if (cwd) {
    const canonical = (value: string) => {
      try { return realpathSync(value); } catch { return path.resolve(value); }
    };
    // Workflow records stay in the user's one mounted run store. A project
    // view must filter that store natively, not reinterpret it as project-local
    // merely because the subprocess cwd changed.
    const workspaceCwd = env.MATOS_ASSETS_CWD?.trim() || process.cwd();
    if (canonical(cwd) !== canonical(workspaceCwd)) {
      child.MATOS_WORKFLOW_PROJECT_CWD = canonical(cwd);
    } else {
      delete child.MATOS_WORKFLOW_PROJECT_CWD;
    }
  }
  if (operatorActionsEnabled(env)) return child;
  delete child.MATOS_GATEWAY_GITEA_TOKEN;
  delete child.MATOS_GATEWAY_GITEA_TOKEN_FILE;
  delete child.MATOS_GITEA_ADMIN_USER;
  delete child.MATOS_GITEA_OPERATOR_ENV;
  delete child.MATOS_GITEA_OPERATOR_ENV_FILE;
  if (child.MATOS_GITEA_TOKEN_IS_SCOPED !== '1') {
    delete child.MATOS_GITEA_TOKEN;
  }
  const scopeRef = (child.MATOS_SCOPE_REF ?? child.MATOS_SCOPE_ID)?.trim() ?? '';
  const tokenFileIsScoped =
    child.MATOS_GITEA_TOKEN_IS_SCOPED === '1' ||
    (/^(user|team|project):/.test(scopeRef) &&
      child.MATOS_GITEA_TOKEN_FILE?.trim() === WORKSPACE_SCOPED_GITEA_TOKEN_FILE);
  if (!tokenFileIsScoped) {
    delete child.MATOS_GITEA_TOKEN_FILE;
  }
  child.MATOS_GITEA_DISABLE_OPERATOR_ENV = '1';
  return child;
}

/**
 * The MatOS project root the CLI runs in. `MATOS_ASSETS_CWD` selects the
 * per-user scope workspace (where gateway asset provisioning wrote
 * `.matos/matos.json`); it falls back to the daemon process cwd.
 */
export function matosCwd(): string {
  return process.env.MATOS_ASSETS_CWD?.trim() || process.cwd();
}

// ---- User BYOK env for MatOS CLI bridge calls ----
//
// Chat runs already inject the user's Settings-configured MatOS provider env
// (agentCliEnv.matos) through the spawn path. The daemon's own matos CLI
// bridge calls (model catalog, side-question forks) must see the same env so
// a BYOK user's catalog and /btw answers use THEIR provider, not the
// deployment default. The loader is registered by the server at startup —
// this module stays free of app-config/data-dir knowledge.

type MatOSUserEnvLoader = () => Promise<Record<string, string>>;

let matosUserEnvLoader: MatOSUserEnvLoader | null = null;

export function setMatOSUserEnvLoader(loader: MatOSUserEnvLoader | null): void {
  matosUserEnvLoader = loader;
}

/**
 * `process.env` overlaid with the user's configured MatOS provider env.
 * Returns plain `process.env` when no loader is registered or loading fails —
 * bridge calls must keep working on the deployment default in that case.
 */
export async function matosUserCliEnv(): Promise<NodeJS.ProcessEnv> {
  if (!matosUserEnvLoader) return process.env;
  try {
    const userEnv = await matosUserEnvLoader();
    if (!userEnv || Object.keys(userEnv).length === 0) return process.env;
    return { ...process.env, ...userEnv };
  } catch {
    return process.env;
  }
}

export function execMatOS(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      MATOS_BIN,
      args,
      {
        cwd: options.cwd?.trim() || matosCwd(),
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: matosCliEnv(options.env ?? process.env, options.cwd?.trim() || matosCwd()),
      },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(
            new Error(
              `matos ${args.slice(0, 3).join(' ')} failed: ${String(stderr || error.message).slice(0, 2000)}`,
            ),
          );
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * Extract the JSON object from a `matos ... --json` stdout. The CLI may emit
 * incidental leading log lines before the payload, so scan to the first `{`.
 */
export function parseMatOSJson(stdout: string): unknown {
  const trimmed = String(stdout || '').trim();
  const start = trimmed.indexOf('{');
  if (start < 0) {
    throw new Error('matos command returned no JSON payload');
  }
  return JSON.parse(trimmed.slice(start));
}

export async function execMatOSJson(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  const { stdout } = await execMatOS(args, options);
  try {
    return parseMatOSJson(stdout);
  } catch {
    throw new Error(`matos ${args[0]} returned no JSON payload`);
  }
}

/**
 * Like {@link execMatOSJson}, but tolerates a non-zero CLI exit as long as
 * stdout still carries the JSON payload. Report-style commands such as
 * `matos contribute check|submit --json` exit 1 when findings contain
 * errors while printing the full structured result — the bridge should
 * surface those findings, not a generic process failure.
 */
export function execMatOSJsonReport(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      MATOS_BIN,
      args,
      {
        cwd: options.cwd?.trim() || matosCwd(),
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: matosCliEnv(options.env ?? process.env, options.cwd?.trim() || matosCwd()),
      },
      (error, stdout, stderr) => {
        try {
          resolvePromise(parseMatOSJson(String(stdout)));
          return;
        } catch {
          // No JSON payload — fall through to the process error below.
        }
        rejectPromise(
          new Error(
            `matos ${args.slice(0, 3).join(' ')} failed: ${String(stderr || error?.message || 'no JSON payload').slice(0, 2000)}`,
          ),
        );
      },
    );
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
