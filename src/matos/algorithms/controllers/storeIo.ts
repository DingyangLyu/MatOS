import { constants } from 'node:fs'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'

export class MatOSControllerStoreIoError extends Error {
  readonly code: 'unsafe-path' | 'too-large' | 'lock-timeout'

  constructor(code: MatOSControllerStoreIoError['code'], message: string) {
    super(message)
    this.name = 'MatOSControllerStoreIoError'
    this.code = code
  }
}

function ioError(
  code: MatOSControllerStoreIoError['code'],
  message: string,
): never {
  throw new MatOSControllerStoreIoError(code, message)
}

export async function ensureControllerStoreDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    ioError('unsafe-path', `Controller store directory is not a real directory: ${path}`)
  }
}

export async function assertControllerPathHasNoSymlinks(input: {
  root: string
  path: string
}): Promise<void> {
  const root = resolve(input.root)
  const path = resolve(input.path)
  const child = relative(root, path)
  if (child === '..' || child.startsWith(`..${sep}`)) {
    ioError('unsafe-path', 'Controller store path escapes its trusted root')
  }
  let cursor = root
  for (const component of child.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, component)
    const metadata = await lstat(cursor)
    if (metadata.isSymbolicLink()) {
      ioError('unsafe-path', `Controller store path contains a symlink: ${cursor}`)
    }
  }
}

export async function readBoundedControllerFile(input: {
  path: string
  maxBytes: number
  missingOk?: boolean
}): Promise<string | undefined> {
  let handle
  try {
    handle = await open(
      input.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    )
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' && input.missingOk) return undefined
    if (code === 'ELOOP') {
      ioError('unsafe-path', `Controller store file must not be a symlink: ${input.path}`)
    }
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      ioError('unsafe-path', `Controller store path is not a regular file: ${input.path}`)
    }
    if (metadata.size > input.maxBytes) {
      ioError('too-large', `Controller store file exceeds ${input.maxBytes} bytes`)
    }
    const raw = await handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(raw, 'utf8') > input.maxBytes) {
      ioError('too-large', `Controller store file exceeds ${input.maxBytes} bytes`)
    }
    return raw
  } finally {
    await handle.close()
  }
}

export async function appendBoundedControllerFile(input: {
  path: string
  data: string
  maxBytes: number
}): Promise<void> {
  await ensureControllerStoreDirectory(dirname(input.path))
  let handle
  try {
    handle = await open(
      input.path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      ioError('unsafe-path', `Controller store file must not be a symlink: ${input.path}`)
    }
    throw error
  }
  try {
    const metadata = await handle.stat()
    if (!metadata.isFile()) {
      ioError('unsafe-path', `Controller store path is not a regular file: ${input.path}`)
    }
    const bytes = Buffer.byteLength(input.data, 'utf8')
    if (metadata.size + bytes > input.maxBytes) {
      ioError('too-large', `Controller store file exceeds ${input.maxBytes} bytes`)
    }
    await handle.writeFile(input.data, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function wait(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

export async function withControllerFileLock<T>(input: {
  path: string
  operation: () => Promise<T>
  timeoutMs?: number
}): Promise<T> {
  const lockPath = `${input.path}.lock`
  await ensureControllerStoreDirectory(dirname(lockPath))
  const deadline = Date.now() + (input.timeoutMs ?? 5_000)
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const metadata = await lstat(lockPath).catch(() => undefined)
      if (metadata && (metadata.isSymbolicLink() || !metadata.isDirectory())) {
        ioError('unsafe-path', `Controller store lock is unsafe: ${lockPath}`)
      }
      if (Date.now() >= deadline) {
        ioError('lock-timeout', `Timed out acquiring controller store lock: ${lockPath}`)
      }
      await wait(5)
    }
  }
  try {
    return await input.operation()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}
