import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as lockfile from 'proper-lockfile';

const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export function isMissingOutcomeStorePath(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isWithinOrEqual(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function directChild(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  if (
    dirname(resolvedCandidate) !== resolvedRoot ||
    !isWithinOrEqual(resolvedRoot, resolvedCandidate)
  ) {
    throw new Error(`Outcome store path escaped its root: ${candidate}`);
  }
  return resolvedCandidate;
}

export async function assertRealOutcomeStoreDirectory(
  path: string,
  boundaryDir: string = path,
): Promise<string> {
  const resolved = resolve(path);
  const boundary = resolve(boundaryDir);
  if (!isWithinOrEqual(boundary, resolved)) {
    throw new Error(`Outcome store directory escaped its boundary: ${path}`);
  }
  let current = boundary;
  const components = relative(boundary, resolved).split(sep).filter(Boolean);
  const boundaryInfo = await lstat(boundary);
  if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) {
    throw new Error(
      `Outcome store directory component must be a real directory: ${boundary}`,
    );
  }
  for (const component of components) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(
        `Outcome store directory component must be a real directory: ${current}`,
      );
    }
  }
  const canonicalBoundary = await realpath(boundary);
  const canonical = await realpath(resolved);
  if (!isWithinOrEqual(canonicalBoundary, canonical)) {
    throw new Error(`Outcome store directory escaped its boundary: ${path}`);
  }
  return canonical;
}

export async function ensureRealOutcomeStoreRoot(
  path: string,
  boundaryDir: string = path,
): Promise<string> {
  const resolved = resolve(path);
  const boundary = resolve(boundaryDir);
  if (!isWithinOrEqual(boundary, resolved)) {
    throw new Error(`Outcome store directory escaped its boundary: ${path}`);
  }
  await mkdir(boundary, { recursive: true, mode: 0o700 });
  const boundaryInfo = await lstat(boundary);
  if (boundaryInfo.isSymbolicLink() || !boundaryInfo.isDirectory()) {
    throw new Error(
      `Outcome store directory component must be a real directory: ${boundary}`,
    );
  }
  let current = boundary;
  const components = relative(boundary, resolved).split(sep).filter(Boolean);
  for (const component of components) {
    current = join(current, component);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(
          `Outcome store directory component must be a real directory: ${current}`,
        );
      }
    } catch (error) {
      if (!isMissingOutcomeStorePath(error)) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (
          !mkdirError ||
          typeof mkdirError !== "object" ||
          !("code" in mkdirError) ||
          mkdirError.code !== "EEXIST"
        ) {
          throw mkdirError;
        }
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new Error(
          `Outcome store directory component must be a real directory: ${current}`,
        );
      }
    }
  }
  return assertRealOutcomeStoreDirectory(resolved, boundary);
}

export async function ensureContainedOutcomeStoreDirectory(input: {
  rootDir: string;
  path: string;
  create?: boolean;
}): Promise<string> {
  const resolvedRoot = resolve(input.rootDir);
  const resolvedPath = directChild(resolvedRoot, input.path);
  const canonicalRoot = await assertRealOutcomeStoreDirectory(resolvedRoot);
  if (input.create !== false) {
    try {
      await mkdir(resolvedPath, { mode: 0o700 });
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }
  }
  const info = await lstat(resolvedPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(
      `Outcome store path must be a real directory: ${resolvedPath}`,
    );
  }
  const canonicalPath = await realpath(resolvedPath);
  if (!isWithinOrEqual(canonicalRoot, canonicalPath)) {
    throw new Error(
      `Outcome store directory escaped its root: ${resolvedPath}`,
    );
  }
  return canonicalPath;
}

async function assertContainedRegularFile(input: {
  rootDir: string;
  path: string;
}): Promise<{ path: string; size: number }> {
  const canonicalRoot = await assertRealOutcomeStoreDirectory(input.rootDir);
  const path = directChild(input.rootDir, input.path);
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`Outcome store path must be a regular file: ${path}`);
  }
  const canonicalPath = await realpath(path);
  if (!isWithinOrEqual(canonicalRoot, canonicalPath)) {
    throw new Error(`Outcome store file escaped its root: ${path}`);
  }
  return { path, size: info.size };
}

async function assertWritableTarget(input: {
  rootDir: string;
  path: string;
  exclusive?: boolean;
}): Promise<void> {
  const path = directChild(input.rootDir, input.path);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error(`Outcome store target must be a regular file: ${path}`);
    }
    if (input.exclusive) {
      const error = new Error(
        `Outcome store target already exists: ${path}`,
      ) as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
  } catch (error) {
    if (isMissingOutcomeStorePath(error)) return;
    throw error;
  }
}

export async function readOutcomeStoreFile(input: {
  rootDir: string;
  path: string;
  maxBytes: number;
}): Promise<string> {
  const checked = await assertContainedRegularFile(input);
  if (checked.size > input.maxBytes) {
    throw new Error(`Outcome store file is too large: ${checked.path}`);
  }
  const handle = await open(checked.path, constants.O_RDONLY | O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > input.maxBytes) {
      throw new Error(
        `Outcome store file is invalid or too large: ${checked.path}`,
      );
    }
    const content = await handle.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(content, "utf8") > input.maxBytes) {
      throw new Error(`Outcome store file is too large: ${checked.path}`);
    }
    return content;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } catch {
    // Some platforms do not support fsync on directories. The file itself was
    // still synced before publication, so retain the atomic rename/link result.
  } finally {
    await handle.close();
  }
}

export async function writeOutcomeStoreFileAtomic(input: {
  rootDir: string;
  path: string;
  content: string;
  exclusive?: boolean;
}): Promise<void> {
  const canonicalRoot = await assertRealOutcomeStoreDirectory(input.rootDir);
  const path = directChild(canonicalRoot, input.path);
  await assertWritableTarget({
    rootDir: canonicalRoot,
    path,
    exclusive: input.exclusive,
  });
  const temporaryPath = directChild(
    canonicalRoot,
    `${path}.tmp.${process.pid}.${randomUUID()}`,
  );
  let published = false;
  const handle = await open(
    temporaryPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(input.content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await assertRealOutcomeStoreDirectory(canonicalRoot);
    await assertWritableTarget({
      rootDir: canonicalRoot,
      path,
      exclusive: input.exclusive,
    });
    if (input.exclusive) {
      // link(2) publishes a complete immutable record without replacing any
      // file that appeared after the preflight check.
      await link(temporaryPath, path);
      await rm(temporaryPath);
    } else {
      await rename(temporaryPath, path);
    }
    published = true;
    await assertContainedRegularFile({ rootDir: canonicalRoot, path });
    await syncDirectory(canonicalRoot);
  } finally {
    if (!published) {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}

async function ensureLockAnchor(
  rootDir: string,
  name: string,
): Promise<string> {
  if (!/^\.[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`Invalid outcome store lock name: ${name}`);
  }
  const anchor = directChild(rootDir, resolve(rootDir, name));
  const handle = await open(
    anchor,
    constants.O_WRONLY | constants.O_CREAT | O_NOFOLLOW,
    0o600,
  );
  await handle.close();
  await assertContainedRegularFile({ rootDir, path: anchor });
  return anchor;
}

export async function withOutcomeStoreFileLock<T>(input: {
  rootDir: string;
  name: string;
  run: (canonicalRoot: string) => Promise<T>;
}): Promise<T> {
  const canonicalRoot = await assertRealOutcomeStoreDirectory(input.rootDir);
  const anchor = await ensureLockAnchor(canonicalRoot, input.name);
  const lockPath = `${anchor}.lock`;
  try {
    const info = await lstat(lockPath);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Outcome store lock path is unsafe: ${lockPath}`);
    }
  } catch (error) {
    if (!isMissingOutcomeStorePath(error)) throw error;
  }
  const release = await lockfile.lock(anchor, {
    realpath: false,
    stale: 30_000,
    retries: {
      retries: 100,
      factor: 1.2,
      minTimeout: 10,
      maxTimeout: 100,
    },
  });
  try {
    await assertRealOutcomeStoreDirectory(canonicalRoot);
    const lockInfo = await lstat(lockPath);
    if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) {
      throw new Error(`Outcome store lock path is unsafe: ${lockPath}`);
    }
    return await input.run(canonicalRoot);
  } finally {
    await release();
  }
}
