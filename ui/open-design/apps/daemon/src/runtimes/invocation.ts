import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { createCommandInvocation } from '@open-design/platform';
import type { RuntimeExecOptions } from './types.js';

const execFileP = promisify(execFile);

// Agent probes (model-list / version / help / auth-status) are short read-only
// metadata calls that never need the caller's project files. Default them to a
// neutral working directory instead of inheriting the daemon process cwd.
//
// Some agent CLIs run package-manager setup on startup in their cwd. When the
// daemon is launched from a pnpm workspace (e.g. a dev checkout), inheriting
// that cwd let a metadata probe drop a workspace `bun.lock` + `node_modules/.bun`
// over the repo, wiping its pnpm store. A probe writing a stray lockfile under
// the OS temp dir is harmless. Actual agent runs spawn elsewhere with an
// explicit project cwd and are unaffected.
export function execAgentFile(
  command: string,
  args: string[],
  options: RuntimeExecOptions = {},
) {
  const invocation = createCommandInvocation(
    options.env
      ? {
          command,
          args,
          env: options.env,
        }
      : {
          command,
          args,
        },
  );
  return execFileP(invocation.command, invocation.args, {
    ...options,
    cwd: options.cwd ?? os.tmpdir(),
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}
