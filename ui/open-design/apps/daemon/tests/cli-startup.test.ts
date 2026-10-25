import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const daemonRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

describe('CLI startup boundaries', () => {
  it.each([
    ['doctor', ['doctor', '--help']],
    ['config', ['config', 'get', 'agentId', '--daemon-url', 'http://127.0.0.1:9']],
    ['diagnostics', ['diagnostics', 'export', '--daemon-url', 'http://127.0.0.1:9']],
  ])('initializes flag constants before dispatching od %s', async (_name, args) => {
    let output = '';
    try {
      const result = await execFileAsync(
        process.execPath,
        ['--import', 'tsx', cliEntry, ...args],
        {
          cwd: daemonRoot,
          env: { ...process.env },
        },
      );
      output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    } catch (error: unknown) {
      const failed = error as { stdout?: string; stderr?: string };
      output = `${failed.stdout ?? ''}${failed.stderr ?? ''}`;
    }

    expect(output).not.toContain('ReferenceError');
    expect(output).not.toContain('before initialization');
    expect(output).not.toContain('CONFIG_STRING_FLAGS');
    expect(output).not.toContain('DIAGNOSTICS_STRING_FLAGS');
  });

  // Booting the full daemon through a cold `--import tsx` spawn transpiles the
  // whole daemon source before the first log line appears. On slow or shared
  // filesystems under full-suite load that silent phase alone can take tens of
  // seconds, so give the startup wait real headroom; the assertions below are
  // unchanged and still fail fast when the daemon exits or misreports.
  it('keeps od daemon start alive until SIGTERM and reports the actual listening port', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-cli-daemon-start-'));
    const dataDir = join(root, 'data');
    await mkdir(dataDir);
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        cliEntry,
        'daemon',
        'start',
        '--headless',
        '--port',
        '0',
      ],
      {
        cwd: daemonRoot,
        env: {
          ...process.env,
          OD_BIND_HOST: '127.0.0.1',
          OD_DATA_DIR: dataDir,
        },
      },
    );

    try {
      const line = await waitForStdoutLine(
        child,
        /\[od\] listening on (http:\/\/[^\s]+) \(headless\)/u,
        90_000,
      );
      const match = line.match(/(http:\/\/[^\s]+)/u);
      const daemonUrl = match?.[1];
      expect(daemonUrl).toBeTruthy();
      const parsed = new URL(daemonUrl!);
      expect(Number(parsed.port)).toBeGreaterThan(0);

      const healthResp = await fetch(`${daemonUrl}/api/health`);
      expect(healthResp.status).toBe(200);

      const statusResp = await fetch(`${daemonUrl}/api/daemon/status`);
      expect(statusResp.status).toBe(200);
      const status = await statusResp.json() as { bindHost: string; port: number };
      expect(status.bindHost).toBe('127.0.0.1');
      expect(status.port).toBe(Number(parsed.port));
      expect(child.exitCode).toBeNull();
    } finally {
      await terminateChild(child);
      await rm(root, { recursive: true, force: true });
    }
  });

});

function waitForStdoutLine(
  child: ChildProcessWithoutNullStreams,
  pattern: RegExp,
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stdout ${pattern}; output:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const line = output.split(/\r?\n/u).find((candidate) => pattern.test(candidate));
      if (line) {
        cleanup();
        resolve(line);
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited before stdout matched ${pattern}: code=${code} signal=${signal}; output:\n${output}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', onError);
    child.on('exit', onExit);
  });
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  child.kill('SIGTERM');
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 5_000);
    timer.unref?.();
  });
  await Promise.race([exited, timeout]);
}
