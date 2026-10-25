/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { getMatOSDir } from '../../project.js'

const execFileAsync = promisify(execFile)

export type MatOSGitRunOptions = {
  cwd: string
  indexFile?: string
}

export function assetHistoryGitDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'asset-history.git')
}

export function assetHistoryWorkTree(cwd: string): string {
  return resolve(cwd)
}

export async function ensureAssetHistoryGitRepo(cwd: string): Promise<string> {
  const gitDir = assetHistoryGitDir(cwd)
  // Skip re-init once the bare repo exists (HEAD present). A single snapshot
  // forks git up to 5 times; repeating `git init` on every call adds process
  // churn that made asset-history snapshots flaky under heavy concurrent load.
  try {
    await stat(join(gitDir, 'HEAD'))
    return gitDir
  } catch {
    // repo not initialized yet
  }
  await mkdir(getMatOSDir(cwd), { recursive: true })
  await execFileAsync('git', ['init', '--bare', gitDir], {
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
    },
  })
  return gitDir
}

export async function gitRaw(
  args: string[],
  options: MatOSGitRunOptions,
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'MatOS Asset History',
    GIT_AUTHOR_EMAIL: 'matos-asset-history@localhost',
    GIT_COMMITTER_NAME: 'MatOS Asset History',
    GIT_COMMITTER_EMAIL: 'matos-asset-history@localhost',
    GIT_WORK_TREE: assetHistoryWorkTree(options.cwd),
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
  }
  const result = await execFileAsync('git', args, {
    cwd: options.cwd,
    env,
    maxBuffer: 20 * 1024 * 1024,
  })
  return String(result.stdout ?? '')
}

export async function gitRawBuffer(
  args: string[],
  options: MatOSGitRunOptions,
): Promise<Buffer> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'MatOS Asset History',
    GIT_AUTHOR_EMAIL: 'matos-asset-history@localhost',
    GIT_COMMITTER_NAME: 'MatOS Asset History',
    GIT_COMMITTER_EMAIL: 'matos-asset-history@localhost',
    GIT_WORK_TREE: assetHistoryWorkTree(options.cwd),
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
  }
  const result = await execFileAsync('git', args, {
    cwd: options.cwd,
    env,
    encoding: 'buffer',
    maxBuffer: 100 * 1024 * 1024,
  })
  const stdout = result.stdout
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? ''), 'utf8')
}

export async function gitRawWithInput(
  args: string[],
  input: string | Buffer,
  options: MatOSGitRunOptions,
): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'MatOS Asset History',
    GIT_AUTHOR_EMAIL: 'matos-asset-history@localhost',
    GIT_COMMITTER_NAME: 'MatOS Asset History',
    GIT_COMMITTER_EMAIL: 'matos-asset-history@localhost',
    GIT_WORK_TREE: assetHistoryWorkTree(options.cwd),
    ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
  }
  return await new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    child.stdout.on('data', chunk => {
      stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', chunk => {
      stderr.push(Buffer.from(chunk))
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString('utf8'))
        return
      }
      const error = new Error(
        `Command failed: git ${args.join(' ')}\n${Buffer.concat(stderr).toString('utf8')}`,
      ) as Error & { code?: number | null; stdout?: string; stderr?: string }
      error.code = code
      error.stdout = Buffer.concat(stdout).toString('utf8')
      error.stderr = Buffer.concat(stderr).toString('utf8')
      reject(error)
    })
    child.stdin.end(input)
  })
}

export async function git(
  cwd: string,
  args: string[],
  options: Omit<MatOSGitRunOptions, 'cwd'> = {},
): Promise<string> {
  const gitDir = await ensureAssetHistoryGitRepo(cwd)
  return gitRaw(['--git-dir', gitDir, ...args], { cwd, ...options })
}

export async function gitWithInput(
  cwd: string,
  args: string[],
  input: string | Buffer,
  options: Omit<MatOSGitRunOptions, 'cwd'> = {},
): Promise<string> {
  const gitDir = await ensureAssetHistoryGitRepo(cwd)
  return gitRawWithInput(['--git-dir', gitDir, ...args], input, {
    cwd,
    ...options,
  })
}

export async function gitBuffer(
  cwd: string,
  args: string[],
  options: Omit<MatOSGitRunOptions, 'cwd'> = {},
): Promise<Buffer> {
  const gitDir = await ensureAssetHistoryGitRepo(cwd)
  return gitRawBuffer(['--git-dir', gitDir, ...args], { cwd, ...options })
}

export async function withTemporaryGitIndex<T>(
  cwd: string,
  operationId: string,
  fn: (indexFile: string) => Promise<T>,
): Promise<T> {
  const indexDir = join(getMatOSDir(cwd), 'tmp', 'asset-history')
  await mkdir(indexDir, { recursive: true })
  const uniqueOperationId = `${operationId}-${process.pid}-${Date.now()}-${randomUUID()}`
  const indexFile = join(indexDir, `${uniqueOperationId}.index`)
  await rm(indexFile, { force: true })
  await rm(`${indexFile}.lock`, { force: true })
  try {
    return await fn(indexFile)
  } finally {
    await rm(indexFile, { force: true })
    await rm(`${indexFile}.lock`, { force: true })
  }
}
