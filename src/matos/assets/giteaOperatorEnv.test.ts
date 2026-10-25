import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  matOSGiteaEnvValue,
  matOSGiteaEnvValueWithProcessFallback,
  matOSGiteaOperatorEnvFileCandidates,
  matOSScopedGiteaEnvValue,
  parseMatOSGiteaOperatorEnvFile,
} from './giteaOperatorEnv.js'

const savedEnv = { ...process.env }
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
})

describe('MatOS Gitea operator env', () => {
  test('parses only known Gitea operator keys from shell env files', () => {
    const parsed = parseMatOSGiteaOperatorEnvFile(`
export MATOS_GITEA_ADMIN_USER=matos-admin
export MATOS_GITEA_TOKEN='token-123'
UNRELATED_SECRET=must-not-load
MATOS_GITEA_BASE_URL="http://127.0.0.1:3001"
MATOS_OPTIMIZER_REVIEW_OPERATOR=1
MATOS_OPTIMIZER_REVIEWER_PUBLIC_KEY_FILE=/operator/reviewer.pub
`)

    expect(parsed.MATOS_GITEA_ADMIN_USER).toBe('matos-admin')
    expect(parsed.MATOS_GITEA_TOKEN).toBe('token-123')
    expect(parsed.MATOS_GITEA_BASE_URL).toBe('http://127.0.0.1:3001')
    expect(parsed.MATOS_OPTIMIZER_REVIEW_OPERATOR).toBe('1')
    expect(parsed.MATOS_OPTIMIZER_REVIEWER_PUBLIC_KEY_FILE).toBe(
      '/operator/reviewer.pub',
    )
    expect(parsed.UNRELATED_SECRET).toBeUndefined()
  })

  test('falls back to the configured operator env file', async () => {
    const root = join(tmpdir(), `matos-gitea-env-${Date.now()}-${process.pid}`)
    const envFile = join(root, 'operator.env')
    await mkdir(root, { recursive: true })
    await writeFile(
      envFile,
      'export MATOS_GITEA_TOKEN=file-token\nexport MATOS_GITEA_ADMIN_USER=file-admin\n',
      'utf8',
    )

    expect(
      matOSGiteaEnvValue(['MATOS_GITEA_TOKEN'], {
        MATOS_GITEA_OPERATOR_ENV_FILE: envFile,
      } as NodeJS.ProcessEnv),
    ).toBe('file-token')
  })

  test('resolves token values from token files without embedding the secret in env', async () => {
    const root = join(tmpdir(), `matos-gitea-token-file-${Date.now()}-${process.pid}`)
    const tokenFile = join(root, 'token')
    await mkdir(root, { recursive: true })
    await writeFile(tokenFile, 'scoped-token-from-file\n', 'utf8')

    expect(
      matOSGiteaEnvValue(['MATOS_GITEA_TOKEN'], {
        MATOS_GITEA_TOKEN_FILE: tokenFile,
      } as NodeJS.ProcessEnv),
    ).toBe('scoped-token-from-file')
  })

  test('does not read deployment defaults unless an operator env path is explicit', () => {
    expect(matOSGiteaEnvValue(['MATOS_GITEA_TOKEN'], {} as NodeJS.ProcessEnv)).toBe(
      undefined,
    )
  })

  test('explicitly falls back from a narrow operation env to the workspace token file', async () => {
    const root = join(
      tmpdir(),
      `matos-gitea-process-token-file-${Date.now()}-${process.pid}`,
    )
    const tokenFile = join(root, 'token')
    await mkdir(root, { recursive: true })
    await writeFile(tokenFile, 'workspace-scoped-token\n', 'utf8')
    const previousToken = process.env.MATOS_GITEA_TOKEN
    const previousTokenFile = process.env.MATOS_GITEA_TOKEN_FILE
    delete process.env.MATOS_GITEA_TOKEN
    process.env.MATOS_GITEA_TOKEN_FILE = tokenFile
    try {
      expect(
        matOSGiteaEnvValueWithProcessFallback(
          ['MATOS_GITEA_TOKEN'],
          { MATOS_SCOPE_ID: 'user:admin' },
        ),
      ).toBe('workspace-scoped-token')
    } finally {
      if (previousToken === undefined) delete process.env.MATOS_GITEA_TOKEN
      else process.env.MATOS_GITEA_TOKEN = previousToken
      if (previousTokenFile === undefined) {
        delete process.env.MATOS_GITEA_TOKEN_FILE
      } else {
        process.env.MATOS_GITEA_TOKEN_FILE = previousTokenFile
      }
    }
  })

  test('does not auto-discover operator env when the caller disables it', () => {
    expect(
      matOSGiteaOperatorEnvFileCandidates({
        MATOS_DEPLOY_ROOT: '/operator/deploy',
        MATOS_GITEA_OPERATOR_ENV_FILE: '/operator/operator.env',
        MATOS_GITEA_DISABLE_OPERATOR_ENV: '1',
      }),
    ).toEqual([])
  })

  test('scoped resolution never loads a deployment operator token', async () => {
    const root = join(tmpdir(), `matos-gitea-scoped-env-${Date.now()}-${process.pid}`)
    const envFile = join(root, 'operator.env')
    await mkdir(root, { recursive: true })
    await writeFile(envFile, 'MATOS_GITEA_TOKEN=operator-token\n', 'utf8')

    expect(
      matOSScopedGiteaEnvValue(['MATOS_GITEA_TOKEN'], {
        MATOS_GITEA_OPERATOR_ENV_FILE: envFile,
      } as NodeJS.ProcessEnv),
    ).toBeUndefined()
  })

  test('a missing explicit token file does not fall back to operator credentials', async () => {
    const root = join(tmpdir(), `matos-gitea-no-escalation-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const file = join(root, 'operator.env')
    await writeFile(file, 'MATOS_GITEA_TOKEN=operator-fixture\n')
    expect(matOSGiteaEnvValue(['MATOS_GITEA_TOKEN'], {
      MATOS_GITEA_TOKEN_FILE: join(root, 'missing-token'),
      MATOS_GITEA_OPERATOR_ENV_FILE: file,
    })).toBeUndefined()
  })

  test('private runtime scope never auto-loads an operator token', async () => {
    const root = join(tmpdir(), `matos-gitea-private-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const file = join(root, 'operator.env')
    await writeFile(file, 'MATOS_GITEA_TOKEN=operator-fixture\n')
    for (const scope of ['user:alice', 'team:chemistry', 'project:electrolyte']) {
      expect(matOSGiteaEnvValue(['MATOS_GITEA_TOKEN'], {
        MATOS_SCOPE_REF: scope, MATOS_GITEA_OPERATOR_ENV_FILE: file,
      })).toBeUndefined()
    }
  })

  test('operation aliases precede ambient credentials and missing files fail closed', () => {
    process.env.MATOS_GITEA_TOKEN = 'ambient-fixture'
    const keys = ['MATOS_GITEA_TOKEN', 'MATOS_GATEWAY_GITEA_TOKEN']
    expect(matOSGiteaEnvValueWithProcessFallback(keys, {
      MATOS_GATEWAY_GITEA_TOKEN: 'operation-fixture',
    })).toBe('operation-fixture')
    expect(matOSGiteaEnvValueWithProcessFallback(keys, {
      MATOS_GITEA_TOKEN_FILE: '/nonexistent/matos-explicit-token',
    })).toBeUndefined()
  })

  test('process fallback honors disabled operator discovery and user identity', async () => {
    const root = join(tmpdir(), `matos-gitea-fallback-policy-${Date.now()}`)
    await mkdir(root, { recursive: true })
    const file = join(root, 'operator.env')
    await writeFile(file, 'MATOS_GITEA_TOKEN=operator-fixture\n')
    delete process.env.MATOS_GITEA_TOKEN
    delete process.env.MATOS_GITEA_TOKEN_FILE
    process.env.MATOS_GITEA_OPERATOR_ENV_FILE = file
    expect(matOSGiteaEnvValueWithProcessFallback(['MATOS_GITEA_TOKEN'], {
      MATOS_GITEA_DISABLE_OPERATOR_ENV: '1',
    })).toBeUndefined()
    process.env.MATOS_GITEA_TOKEN = 'alice-fixture'
    process.env.MATOS_USER_ID = 'alice'
    expect(matOSGiteaEnvValueWithProcessFallback(['MATOS_GITEA_TOKEN'], {
      MATOS_USER_ID: 'bob', MATOS_SCOPE_REF: 'user:bob',
    })).toBeUndefined()
  })
})
