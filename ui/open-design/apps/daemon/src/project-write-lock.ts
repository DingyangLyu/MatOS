import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

type LockRecord = {
  token: string;
  pid: number;
  runId: string;
  createdAt: string;
};

type LockOwnerIsActive = (owner: LockRecord) => boolean | Promise<boolean>;

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

async function readLock(file: string): Promise<LockRecord | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LockRecord;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function orphanedLockDirectory(lockDir: string): Promise<boolean> {
  try {
    const info = await stat(lockDir);
    return Date.now() - info.mtimeMs > 5_000;
  } catch {
    return false;
  }
}

export async function acquireProjectWriteLock(input: {
  projectCwd: string;
  runId: string;
  timeoutMs?: number;
  ownerIsActive?: LockOwnerIsActive;
}): Promise<() => Promise<void>> {
  const lockDir = path.join(input.projectCwd, '.matos', 'workbench', 'project-write.lock');
  const lockFile = path.join(lockDir, 'owner.json');
  const token = randomUUID();
  const timeoutAt = Date.now() + (input.timeoutMs ?? 30 * 60_000);
  await mkdir(path.dirname(lockDir), { recursive: true });

  while (true) {
    try {
      await mkdir(lockDir);
      try {
        await writeFile(lockFile, JSON.stringify({
          token,
          pid: process.pid,
          runId: input.runId,
          createdAt: new Date().toISOString(),
        } satisfies LockRecord), { encoding: 'utf8', mode: 0o600 });
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      const owner = await readLock(lockFile);
      let ownerIsStale = false;
      if (owner) {
        if (!pidAlive(owner.pid)) {
          ownerIsStale = true;
        } else if (input.ownerIsActive) {
          try {
            ownerIsStale = !await input.ownerIsActive(owner);
          } catch {
            ownerIsStale = false;
          }
        }
      }
      if (ownerIsStale || (!owner && await orphanedLockDirectory(lockDir))) {
        const stalePath = `${lockDir}.stale.${randomUUID()}`;
        try {
          await rename(lockDir, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        } catch (renameError: any) {
          if (renameError?.code !== 'ENOENT') await sleep(50);
          continue;
        }
      }
      if (Date.now() >= timeoutAt) {
        throw new Error(
          `Timed out waiting for project writer ${owner?.runId ?? 'unknown'} in ${input.projectCwd}`,
        );
      }
      await sleep(100);
    }
  }

  return async () => {
    const owner = await readLock(lockFile);
    if (owner?.token === token) {
      await rm(lockDir, { recursive: true, force: true });
    }
  };
}
