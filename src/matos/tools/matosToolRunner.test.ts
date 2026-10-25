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

import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  callMatOSTool,
  loadMatOSToolDefinitions,
  normalizeMatOSToolName,
  type MatOSToolDefinition,
} from './matosToolRunner.js'
import { withMatOSWorkflowExecutionContext } from '../workflows/executionContext.js'

const NATIVE_TOOLS_ROOT = join(
  process.cwd(),
  'distribution', 'benchmark-minimal', 'assets',
  'packs',
  'matos-core',
  'tools',
)
const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
})

function snapshotEnv(keys: readonly string[]): () => void {
  const saved = keys.map(key => [key, process.env[key]] as const)
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('test server did not bind to a TCP port')
  }
  return address.port
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  )
}

const QE_PSEUDO_CONTAINER_ROOT = '/opt/matos-tools/qe/pseudopotentials'

function pathUnderRoot(root: string, path: string): string | null {
  if (path === root) {
    return ''
  }
  const prefix = `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : null
}

function qePseudoOutputPath(root: string, path: string): string {
  const relative = pathUnderRoot(root, path)
  if (relative !== null && root.startsWith('/vepfs-mlp2/')) {
    return relative ? join(QE_PSEUDO_CONTAINER_ROOT, relative) : QE_PSEUDO_CONTAINER_ROOT
  }
  return path
}

function createTinyMpDatabase(path: string): void {
  const db = new Database(path)
  try {
    db.exec(`
      CREATE TABLE materials (
        material_id TEXT PRIMARY KEY,
        formula TEXT,
        elements TEXT,
        nsites INTEGER,
        space_group_symbol TEXT,
        space_group_number INTEGER,
        crystal_system TEXT,
        band_gap REAL,
        is_metal INTEGER,
        is_magnetic INTEGER,
        ordering TEXT,
        formation_energy_per_atom REAL,
        energy_above_hull REAL,
        is_stable INTEGER,
        density REAL,
        volume REAL,
        oxide_type TEXT,
        is_theoretical INTEGER,
        deprecated INTEGER,
        formula_anonymous TEXT,
        chemsys TEXT,
        nelements INTEGER,
        point_group TEXT,
        cbm REAL,
        vbm REAL,
        efermi REAL,
        is_gap_direct INTEGER,
        energy_per_atom REAL,
        equilibrium_reaction_energy_per_atom REAL,
        total_magnetization REAL,
        total_magnetization_normalized_vol REAL,
        structure_json TEXT,
        cif_text TEXT,
        database_IDs TEXT
      );
      CREATE TABLE elastic (
        material_id TEXT PRIMARY KEY,
        bulk_modulus_vrh REAL,
        shear_modulus_vrh REAL,
        youngs_modulus REAL,
        poisson_ratio REAL,
        debye_temperature REAL,
        elastic_anisotropy REAL,
        elastic_tensor TEXT
      );
      CREATE TABLE dielectric (
        material_id TEXT PRIMARY KEY,
        e_total REAL,
        n REAL,
        dielectric_tensor TEXT
      );
      CREATE TABLE piezoelectric (material_id TEXT PRIMARY KEY);
      CREATE TABLE thermo (material_id TEXT PRIMARY KEY);
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT);
    `)
    db.query(`
      INSERT INTO materials (
        material_id, formula, elements, nsites, space_group_symbol,
        space_group_number, crystal_system, band_gap, is_metal, is_magnetic,
        ordering, formation_energy_per_atom, energy_above_hull, is_stable,
        density, volume, oxide_type, is_theoretical, deprecated,
        formula_anonymous, chemsys, nelements, point_group, cbm, vbm, efermi,
        is_gap_direct, energy_per_atom, equilibrium_reaction_energy_per_atom,
        total_magnetization, total_magnetization_normalized_vol,
        structure_json, cif_text, database_IDs
      ) VALUES (
        'mp-149', 'Si', 'Si', 2, 'Fd-3m', 227, 'cubic', 1.1, 0, 0,
        NULL, -0.4, 0.0, 1, 2.33, 40.0, NULL, 0, 0,
        'A', 'Si', 1, 'm-3m', 1.2, 0.1, 5.4, 0, -5.0, 0.0,
        0.0, 0.0,
        '{"lattice":{"a":5.43,"b":5.43,"c":5.43,"alpha":90,"beta":90,"gamma":90},"sites":[{"species":[{"element":"Si"}],"abc":[0,0,0]}]}',
        'data_mp-149\\n_symmetry_space_group_name_H-M Fd-3m\\n',
        '{"icsd_ids":[12345]}'
      );
    `).run()
    db.query(
      "INSERT INTO elastic VALUES ('mp-149', 98.0, 53.0, 130.0, 0.22, 645.0, 0.1, '[]')",
    ).run()
    db.query(
      "INSERT INTO dielectric VALUES ('mp-149', 11.7, 3.42, '[]')",
    ).run()
    db.query(
      "INSERT INTO metadata VALUES ('last_download', '2026-06-01')",
    ).run()
  } finally {
    db.close()
  }
}

describe('MatOS native tool runner', () => {
  test('loads and calls a native executable tool asset without a legacy manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-native-tool-'))
    const toolDir = join(root, 'tools', 'native-echo')
    await mkdir(toolDir, { recursive: true })
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'native-echo',
      type: 'tool',
      name: 'Native Echo',
      version: '0.1.0',
      description: 'Echoes structured input through a native tool asset.',
      entry: 'tool.py',
      metadata: {
        kind: 'external-tool',
        inputSchemaPath: 'input.schema.json',
        promptPath: 'prompt.md',
        isReadOnly: true,
        isDestructive: false,
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: 'tool.py',
          timeoutMs: 5000,
          mcpName: 'native_echo',
        },
      },
    })
    await writeJson(join(toolDir, 'input.schema.json'), {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
    })
    await writeFile(join(toolDir, 'prompt.md'), 'Echo structured input.\n')
    await writeFile(
      join(toolDir, 'tool.py'),
      [
        'import json',
        'import sys',
        'payload = json.load(sys.stdin)',
        'print(json.dumps({"ok": True, "input": payload.get("input", {})}))',
      ].join('\n'),
      'utf8',
    )

    const tools = await loadMatOSToolDefinitions([toolDir])
    const tool = tools.find(item => item.id === 'native-echo')

    expect(tool?.mcpName).toBe('native_echo')
    expect(tool?.inputSchema).toMatchObject({ type: 'object' })
    expect(tool?.prompt).toContain('Echo structured input')
    expect(tool?.isReadOnly).toBe(true)

    const result = await callMatOSTool(tool!, { message: 'hello' })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      input: { message: 'hello' },
    })
  })

  test('runs a tool in its declared managed Python environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-managed-python-tool-'))
    const envRoot = join(root, 'envs')
    const envName = 'matos-test-py'
    const envBin = join(envRoot, envName, 'bin')
    const toolDir = join(root, 'tool')
    await mkdir(envBin, { recursive: true })
    await mkdir(toolDir, { recursive: true })
    const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim()
    expect(python).not.toBe('')
    await symlink(python, join(envBin, 'python'))
    process.env.MATOS_SYSTEM_CONDA_ENVS_PATH = envRoot
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'managed-python-tool',
      type: 'tool',
      name: 'Managed Python Tool',
      entry: 'tool.py',
      metadata: {
        kind: 'external-tool',
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: 'tool.py',
          pythonEnvironment: {
            kind: 'managed-python',
            name: envName,
            pythonVersion: '3',
            packages: {},
            imports: ['json'],
          },
        },
      },
    })
    await writeFile(
      join(toolDir, 'tool.py'),
      [
        'import json',
        'import os',
        'import sys',
        'print(json.dumps({',
        '  "ok": True,',
        '  "executable": sys.executable,',
        '  "environment": os.environ.get("MATOS_TOOL_PYTHON_ENVIRONMENT"),',
        '  "pythonNoUserSite": os.environ.get("PYTHONNOUSERSITE"),',
        '}))',
      ].join('\n'),
      'utf8',
    )

    const [tool] = await loadMatOSToolDefinitions([toolDir])
    expect(tool?.runtime).toBe(join(envBin, 'python'))
    expect(tool?.pythonEnvironment).toMatchObject({
      kind: 'managed-python',
      name: envName,
      pythonVersion: '3',
      imports: ['json'],
    })
    const result = await callMatOSTool(tool!, {})
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      environment: envName,
      pythonNoUserSite: '1',
    })
  })

  test('rejects a managed Python environment with drifting package versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-managed-python-drift-'))
    const envRoot = join(root, 'envs')
    const envName = 'matos-drift-py'
    const envBin = join(envRoot, envName, 'bin')
    const toolDir = join(root, 'tool')
    await mkdir(envBin, { recursive: true })
    await mkdir(toolDir, { recursive: true })
    const python = spawnSync('which', ['python3'], { encoding: 'utf8' }).stdout.trim()
    await symlink(python, join(envBin, 'python'))
    process.env.MATOS_SYSTEM_CONDA_ENVS_PATH = envRoot
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'managed-python-drift',
      type: 'tool',
      name: 'Managed Python Drift',
      entry: 'tool.py',
      metadata: {
        kind: 'external-tool',
        executor: {
          type: 'matos-python',
          entry: 'tool.py',
          pythonEnvironment: {
            kind: 'managed-python',
            name: envName,
            packages: {
              'matos-package-that-does-not-exist': '1.0.0',
            },
          },
        },
      },
    })
    await writeFile(join(toolDir, 'tool.py'), 'print("should not run")\n', 'utf8')
    const [tool] = await loadMatOSToolDefinitions([toolDir])

    await expect(callMatOSTool(tool!, {})).rejects.toThrow(
      `MatOS managed Python environment "${envName}" is incompatible`,
    )
  })

  test('rejects unsafe managed Python environment names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-managed-python-invalid-'))
    const toolDir = join(root, 'tool')
    await mkdir(toolDir, { recursive: true })
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'managed-python-invalid',
      type: 'tool',
      name: 'Managed Python Invalid',
      entry: 'tool.py',
      metadata: {
        kind: 'external-tool',
        executor: {
          type: 'matos-python',
          entry: 'tool.py',
          pythonEnvironment: {
            kind: 'managed-python',
            name: '../other-user-env',
          },
        },
      },
    })
    await writeFile(join(toolDir, 'tool.py'), 'print("unsafe")\n', 'utf8')

    await expect(loadMatOSToolDefinitions([toolDir])).rejects.toThrow(
      'invalid managed Python environment name',
    )
  })

  test('projects the active workflow scope into native tool subprocesses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-native-tool-workflow-env-'))
    const toolDir = join(root, 'tool')
    const runDir = join(root, '.matos', 'workflows', 'runs', 'run-1')
    await mkdir(toolDir, { recursive: true })
    await writeJson(join(toolDir, 'asset.json'), {
      id: 'workflow-env',
      type: 'tool',
      name: 'Workflow Env',
      version: '0.1.0',
      entry: 'tool.py',
      metadata: {
        kind: 'external-tool',
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: 'tool.py',
          mcpName: 'workflow_env',
        },
      },
    })
    await writeFile(
      join(toolDir, 'tool.py'),
      [
        'import json',
        'import os',
        'print(json.dumps({',
        '  "runId": os.environ.get("MATOS_WORKFLOW_RUN_ID"),',
        '  "runDir": os.environ.get("MATOS_WORKFLOW_RUN_DIR"),',
        '  "nodeId": os.environ.get("MATOS_WORKFLOW_NODE_ID"),',
        '  "attempt": os.environ.get("MATOS_WORKFLOW_ATTEMPT"),',
        '  "scopeRef": os.environ.get("MATOS_SCOPE_REF"),',
        '}))',
      ].join('\n'),
      'utf8',
    )
    const [tool] = await loadMatOSToolDefinitions([toolDir])

    const result = await withMatOSWorkflowExecutionContext(
      {
        runId: 'run-1',
        runDir,
        workflowNodeId: 'fixture',
        attempt: 2,
        projectCwd: root,
        scopeRef: 'user:alice',
      },
      () => callMatOSTool(tool!, {}),
    )

    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      runId: 'run-1',
      runDir,
      nodeId: 'fixture',
      attempt: '2',
      scopeRef: 'user:alice',
    })
  })

  test('web-read tool can reuse the managed container proxy relay env', () => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, json, os',
          'spec = importlib.util.spec_from_file_location("web_read_tool", "tool.py")',
          'module = importlib.util.module_from_spec(spec)',
          'assert spec.loader is not None',
          'spec.loader.exec_module(module)',
          'os.environ.pop("MATOS_WEB_READ_HTTP_PROXY", None)',
          'os.environ.pop("MATOS_WEB_READ_HTTPS_PROXY", None)',
          'os.environ["MATOS_PAPER_DB_HTTP_PROXY"] = "http://198.51.100.15:7892"',
          'os.environ["MATOS_PAPER_DB_HTTPS_PROXY"] = "http://198.51.100.15:7892"',
          'print(json.dumps(module.web_read_proxy_env(), sort_keys=True))',
        ].join('\n'),
      ],
      {
        cwd: join(NATIVE_TOOLS_ROOT, 'web-read'),
        env: {
          PATH: process.env.PATH ?? '',
        },
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      http: 'http://198.51.100.15:7892',
      https: 'http://198.51.100.15:7892',
    })
  })

  test('web-read classifies raw network failures for agents and evolution', () => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, json',
          'spec = importlib.util.spec_from_file_location("web_read_tool", "tool.py")',
          'module = importlib.util.module_from_spec(spec)',
          'assert spec.loader is not None',
          'spec.loader.exec_module(module)',
          'print(json.dumps(module.classify_fetch_error(OSError(99, "Cannot assign requested address")), sort_keys=True))',
        ].join('\n'),
      ],
      {
        cwd: join(NATIVE_TOOLS_ROOT, 'web-read'),
        env: {
          PATH: process.env.PATH ?? '',
        },
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      errorKind: 'network_address_unavailable',
      retryable: true,
    })
  })

  test('web-read falls back once after bounded Jina route failures', () => {
    const result = spawnSync(
      'python3',
      [
        '-c',
        [
          'import importlib.util, json',
          'spec = importlib.util.spec_from_file_location("web_read_tool", "tool.py")',
          'module = importlib.util.module_from_spec(spec)',
          'assert spec.loader is not None',
          'spec.loader.exec_module(module)',
          'class DummyOpener: pass',
          'calls = []',
          'module.web_read_opener = lambda: DummyOpener()',
          'module.direct_web_opener = lambda: DummyOpener()',
          'def fail_jina(url, headers, opener):',
          '  calls.append("jina")',
          '  raise TimeoutError("timed out")',
          'def read_direct(url, headers, opener):',
          '  calls.append("direct")',
          '  return ("# Direct fallback\\n\\nReadable public content.", url)',
          'module.fetch_jina_once = fail_jina',
          'module.fetch_direct_once = read_direct',
          'try:',
          '  module.fetch_jina("https://arxiv.org/abs/2503.23491", {})',
          '  raise AssertionError("Jina routes should fail")',
          'except module.FetchRoutesError as error:',
          '  content, source_url, attempts, route = module.fetch_direct(',
          '    "https://arxiv.org/abs/2503.23491", {}, error.attempts',
          '  )',
          'private_rejected = False',
          'try:',
          '  module.validate_public_http_url("http://127.0.0.1/secret")',
          'except module.DirectReadRejected:',
          '  private_rejected = True',
          'print(json.dumps({',
          '  "calls": calls,',
          '  "content": content,',
          '  "sourceUrl": source_url,',
          '  "attempts": attempts,',
          '  "route": route,',
          '  "privateRejected": private_rejected,',
          '  "worstCaseNetworkSeconds": 2 * (',
          '    module.JINA_TIMEOUT_SECONDS + module.DIRECT_TIMEOUT_SECONDS',
          '  ),',
          '  "arxivPdfFallback": module.canonical_direct_url(',
          '    "https://arxiv.org/pdf/2503.23491.pdf"',
          '  ),',
          '}, sort_keys=True))',
        ].join('\n'),
      ],
      {
        cwd: join(NATIVE_TOOLS_ROOT, 'web-read'),
        env: {
          PATH: process.env.PATH ?? '',
        },
        encoding: 'utf8',
      },
    )

    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      calls: ['jina', 'jina', 'direct'],
      content: '# Direct fallback\n\nReadable public content.',
      sourceUrl: 'https://arxiv.org/abs/2503.23491',
      route: 'origin-proxy',
      privateRejected: true,
      worstCaseNetworkSeconds: 40,
      arxivPdfFallback: 'https://arxiv.org/abs/2503.23491',
      attempts: [
        { route: 'jina-proxy', errorKind: 'timeout' },
        { route: 'jina-direct', errorKind: 'timeout' },
      ],
    })
  })

  test('loads paper database env file before spawning the tool process', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-paper-env-'))
    const toolDir = join(root, 'paper-database')
    await mkdir(toolDir, { recursive: true })
    const envFile = join(root, 'paper-db.env')
    await writeFile(
      envFile,
      [
        'export MATOS_PAPER_DB_BASE_URL=http://data.example',
        'export MATOS_PAPER_DB_HTTP_PROXY=http://198.51.100.15:7892',
        'export MATOS_PAPER_DB_HTTPS_PROXY=http://198.51.100.15:7892',
      ].join('\n'),
      'utf8',
    )
    await writeJson(join(toolDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'paper-database',
      type: 'tool',
      name: 'Paper Database',
      version: '0.1.0',
      description: 'Paper database env smoke.',
      entry: './tool.py',
      metadata: {
        kind: 'external-tool',
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: 'tool.py',
          timeoutMs: 5000,
          mcpName: 'paper_database',
        },
      },
    })
    await writeFile(
      join(toolDir, 'tool.py'),
      [
        'import json',
        'import os',
        'print(json.dumps({',
        '  "baseUrl": os.environ.get("MATOS_PAPER_DB_BASE_URL"),',
        '  "httpProxy": os.environ.get("MATOS_PAPER_DB_HTTP_PROXY"),',
        '  "httpsProxy": os.environ.get("MATOS_PAPER_DB_HTTPS_PROXY"),',
        '}))',
      ].join('\n'),
      'utf8',
    )
    process.env.MATOS_PAPER_DB_ENV_FILE = envFile
    delete process.env.MATOS_PAPER_DB_BASE_URL
    delete process.env.MATOS_PAPER_DB_HTTP_PROXY
    delete process.env.MATOS_PAPER_DB_HTTPS_PROXY

    const [tool] = await loadMatOSToolDefinitions([toolDir])
    const result = await callMatOSTool(tool!, {})
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      baseUrl: 'http://data.example',
      httpProxy: 'http://198.51.100.15:7892',
      httpsProxy: 'http://198.51.100.15:7892',
    })
  })

  test('finds paper database deploy env by walking up from the tool directory', async () => {
    const outerRoot = await mkdtemp(join(tmpdir(), 'matos-paper-ancestor-env-'))
    const root = join(outerRoot, 'nearest-deployment')
    const toolDir = join(
      root,
      'matos-assets',
      'packs',
      'matos-core',
      'tools',
      'paper-database',
    )
    await mkdir(toolDir, { recursive: true })
    await writeFile(
      join(outerRoot, '.env.deploy'),
      [
        'export MATOS_PAPER_DB_BASE_URL=http://wrong-outer.example',
        'export MATOS_PAPER_DB_HTTP_PROXY=http://127.0.0.1:1',
      ].join('\n'),
      'utf8',
    )
    await writeFile(
      join(root, '.env.deploy'),
      [
        'export MATOS_PAPER_DB_BASE_URL=http://data.example',
        'export MATOS_PAPER_DB_HTTP_PROXY=http://198.51.100.15:7892',
      ].join('\n'),
      'utf8',
    )
    await writeJson(join(toolDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'paper-database',
      type: 'tool',
      name: 'Paper Database',
      version: '0.1.0',
      description: 'Paper database ancestor env smoke.',
      entry: './tool.py',
      metadata: {
        kind: 'external-tool',
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: 'tool.py',
          timeoutMs: 5000,
          mcpName: 'paper_database',
        },
      },
    })
    await writeFile(
      join(toolDir, 'tool.py'),
      [
        'import json',
        'import os',
        'print(json.dumps({',
        '  "baseUrl": os.environ.get("MATOS_PAPER_DB_BASE_URL"),',
        '  "httpProxy": os.environ.get("MATOS_PAPER_DB_HTTP_PROXY"),',
        '}))',
      ].join('\n'),
      'utf8',
    )
    delete process.env.MATOS_PAPER_DB_ENV_FILE
    delete process.env.MATOS_DEPLOY_ENV_FILE
    delete process.env.MATOS_PAPER_DB_BASE_URL
    delete process.env.MATOS_PAPER_DB_HTTP_PROXY

    const [tool] = await loadMatOSToolDefinitions([toolDir])
    const result = await callMatOSTool(tool!, {})
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      baseUrl: 'http://data.example',
      httpProxy: 'http://198.51.100.15:7892',
    })
  })

  test('document parse falls back to Python PDF parser when pdftotext is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-document-parse-fallback-'))
    const toolDir = join(root, 'document-parse')
    const binDir = join(root, 'bin')
    await mkdir(toolDir, { recursive: true })
    await mkdir(binDir, { recursive: true })
    await writeFile(
      join(toolDir, 'asset.json'),
      JSON.stringify({
        schemaVersion: 1,
        id: 'document-parse',
        type: 'tool',
        name: 'Document Parse',
        entry: './tool.py',
        metadata: {
          kind: 'external-tool',
          inputSchemaPath: 'input.schema.json',
          promptPath: 'prompt.md',
          executor: {
            type: 'matos-python',
            runtime: 'python3',
            entry: './tool.py',
            timeoutMs: 15000,
            mcpName: 'document_parse',
          },
        },
      }),
      'utf8',
    )
    await writeFile(join(toolDir, 'input.schema.json'), '{"type":"object"}', 'utf8')
    await writeFile(join(toolDir, 'prompt.md'), 'parse documents', 'utf8')
    await writeFile(
      join(toolDir, 'tool.py'),
      await readFile(join(NATIVE_TOOLS_ROOT, 'document-parse', 'tool.py'), 'utf8'),
      'utf8',
    )
    await writeFile(
      join(toolDir, 'fitz.py'),
      [
        'class Page:',
        '    def get_text(self, kind):',
        '        return "fallback pdf text"',
        'class Document:',
        '    def __enter__(self):',
        '        return [Page()]',
        '    def __exit__(self, *args):',
        '        return False',
        'def open(path):',
        '    return Document()',
      ].join('\n'),
      'utf8',
    )
    await writeFile(join(root, 'paper.pdf'), '%PDF-1.4\nfake\n', 'utf8')
    const pythonPath = spawnSync('which', ['python3'], {
      encoding: 'utf8',
    }).stdout.trim()
    expect(pythonPath).not.toBe('')
    await symlink(pythonPath, join(binDir, 'python3'))

    const originalPath = process.env.PATH
    process.env.PATH = binDir
    try {
      const tools = await loadMatOSToolDefinitions([toolDir])
      const result = await callMatOSTool(tools[0]!, {
        path: join(root, 'paper.pdf'),
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        type: 'pdf',
        text: 'fallback pdf text',
      })
    } finally {
      process.env.PATH = originalPath
    }
  }, 15_000)

  test('ignores builtin tool packs when loading executable MCP tool assets', async () => {
    const tools = await loadMatOSToolDefinitions([
      join(NATIVE_TOOLS_ROOT, 'web-research'),
      join(NATIVE_TOOLS_ROOT, 'conda-environment-catalog'),
    ])

    expect(tools.map(tool => tool.id)).toContain('conda-environment-catalog')
    expect(tools.map(tool => tool.id)).not.toContain('web-research')
  })

  test('loads and calls the MLIP model catalog tool against mounted model data assets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-mlip-catalog-'))
    const assetDir = join(
      root,
      'packs',
      'mlip-foundation-models',
      'data',
      'mlip-mace-medium-mpa-0',
    )
    await mkdir(join(assetDir, 'files'), { recursive: true })
    await writeJson(join(assetDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'mlip-mace-medium-mpa-0',
      type: 'data',
      name: 'MACE MPA medium',
      version: '1.0.0',
      description: 'Local MACE model fixture.',
      entry: 'MODEL.md',
      tags: ['mlip-model', 'mace'],
      metadata: {
        kind: 'mlip-model',
        group: 'mlip-models',
        family: 'mace',
        framework: 'mace',
        modelName: 'medium-mpa-0',
        package: 'mace-torch',
        packageImport: 'mace',
        loader: 'mace_mp(model=<localPath>)',
        files: [{ path: 'files/model.model' }],
      },
    })
    await writeFile(join(assetDir, 'MODEL.md'), 'MACE model fixture.\n', 'utf8')
    await writeFile(join(assetDir, 'files', 'model.model'), 'fixture\n', 'utf8')
    process.env.MATOS_ASSET_ROOTS = root
    process.env.MATOS_DEPLOY_ROOT = join(root, 'empty-deploy-root')

    const tools = await loadMatOSToolDefinitions([
      join(NATIVE_TOOLS_ROOT, 'mlip-model-catalog'),
    ])
    const tool = tools.find(item => item.id === 'mlip-model-catalog')

    expect(tool?.mcpName).toBe('mlip_model_catalog')
    expect(tool?.isReadOnly).toBe(true)

    const result = await callMatOSTool(tool!, { family: 'mace' })
    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.ok).toBe(true)
    expect(payload.models).toEqual([
      expect.objectContaining({
        id: 'mlip-mace-medium-mpa-0',
        family: 'mace',
        modelName: 'medium-mpa-0',
        status: 'available',
        localPath: join(assetDir, 'files', 'model.model'),
      }),
    ])
    expect(payload.packages.mace.import).toBe('mace')
  })

  test('discovers MLIP model assets from MATOS_DEPLOY_ROOT when explicit asset roots are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-mlip-deploy-root-'))
    const deployRoot = join(root, 'deploy')
    const assetDir = join(
      deployRoot,
      'assets',
      'global',
      'packs',
      'mlip-foundation-models',
      'data',
      'mlip-mace-medium-mpa-0',
    )
    await mkdir(join(assetDir, 'files'), { recursive: true })
    await writeJson(join(assetDir, 'asset.json'), {
      schemaVersion: 1,
      id: 'mlip-mace-medium-mpa-0',
      type: 'data',
      name: 'MACE MPA medium',
      version: '1.0.0',
      description: 'Local MACE model fixture.',
      entry: 'MODEL.md',
      tags: ['mlip-model', 'mace'],
      metadata: {
        kind: 'mlip-model',
        family: 'mace',
        modelName: 'medium-mpa-0',
        files: [{ path: 'files/model.model' }],
      },
    })
    await writeFile(join(assetDir, 'MODEL.md'), 'MACE model fixture.\n', 'utf8')
    await writeFile(join(assetDir, 'files', 'model.model'), 'fixture\n', 'utf8')
    delete process.env.MATOS_ASSET_ROOTS
    delete process.env.MATOS_DEFAULT_ASSET_ROOTS
    process.env.MATOS_DEPLOY_ROOT = deployRoot

    const tools = await loadMatOSToolDefinitions([
      join(NATIVE_TOOLS_ROOT, 'mlip-model-catalog'),
    ])
    const tool = tools.find(item => item.id === 'mlip-model-catalog')

    const result = await callMatOSTool(tool!, { family: 'mace' })
    expect(result.exitCode).toBe(0)
    const payload = JSON.parse(result.stdout)
    expect(payload.assetRoots).toContain(join(deployRoot, 'assets', 'global'))
    expect(payload.models).toEqual([
      expect.objectContaining({
        id: 'mlip-mace-medium-mpa-0',
        status: 'available',
      }),
    ])
  })


})

describe('MatOS tool runner process/disk stability', () => {
  function stabilityToolDefinition(
    dir: string,
    entry: string,
    timeoutMs: number,
  ): MatOSToolDefinition {
    return {
      id: 'stability-tool',
      label: 'Stability Tool',
      description: 'stability test tool',
      dir,
      entry: join(dir, entry),
      runtime: 'python3',
      timeoutMs,
      mcpName: 'stability_tool',
      inputSchema: { type: 'object' },
      prompt: undefined,
      isReadOnly: true,
      isDestructive: false,
    }
  }

  function processGone(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return false
    } catch {
      return true
    }
  }

  test('timeout kills the whole tool process tree, including SIGTERM-ignoring children', async () => {
    // Regression: the timeout path sent a single SIGTERM to the direct child
    // only. A tool that ignored SIGTERM (or had spawned helpers) leaked its
    // whole subtree past the timeout.
    const root = await mkdtemp(join(tmpdir(), 'matos-tool-kill-tree-'))
    await writeFile(
      join(root, 'stubborn.py'),
      [
        'import json, os, signal, subprocess, sys, time',
        'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
        "grandchild = subprocess.Popen(['sleep', '120'])",
        'print(json.dumps({"pid": os.getpid(), "grandchildPid": grandchild.pid}), flush=True)',
        'time.sleep(120)',
      ].join('\n'),
      'utf8',
    )
    const previousGrace = process.env.MATOS_TOOL_KILL_GRACE_MS
    process.env.MATOS_TOOL_KILL_GRACE_MS = '150'
    try {
      const tool = stabilityToolDefinition(root, 'stubborn.py', 1500)
      const result = await callMatOSTool(tool, {})
      expect(result.exitCode).toBeNull()
      expect(result.stderr).toContain('Timed out after 1500ms')
      const pids = JSON.parse(result.stdout) as {
        pid: number
        grandchildPid: number
      }

      // SIGTERM (ignored) then SIGKILL to the process group after the grace.
      let treeGone = false
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (processGone(pids.pid) && processGone(pids.grandchildPid)) {
          treeGone = true
          break
        }
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(treeGone).toBe(true)
    } finally {
      if (previousGrace === undefined) {
        delete process.env.MATOS_TOOL_KILL_GRACE_MS
      } else {
        process.env.MATOS_TOOL_KILL_GRACE_MS = previousGrace
      }
    }
  }, 15000)

  test('caps runaway tool stdout instead of buffering it without bound', async () => {
    // Regression: non-component tools accumulated stdout into one string with
    // no limit, so a runaway tool could OOM the asset MCP server process.
    const root = await mkdtemp(join(tmpdir(), 'matos-tool-stdout-cap-'))
    await writeFile(
      join(root, 'flood.py'),
      [
        'import sys',
        "data = 'x' * 65536",
        'while True:',
        '    sys.stdout.write(data)',
        '    sys.stdout.flush()',
      ].join('\n'),
      'utf8',
    )
    const previousCap = process.env.MATOS_TOOL_STDOUT_MAX_BYTES
    process.env.MATOS_TOOL_STDOUT_MAX_BYTES = '131072'
    try {
      const tool = stabilityToolDefinition(root, 'flood.py', 30000)
      const started = Date.now()
      const result = await callMatOSTool(tool, {})
      expect(result.exitCode).toBeNull()
      expect(result.stderr).toContain('stdout exceeded the 131072 byte limit')
      expect(result.stdout.length).toBeLessThanOrEqual(131072)
      // The flood must be stopped by the cap, not by the 30s tool timeout.
      expect(Date.now() - started).toBeLessThan(10000)
    } finally {
      if (previousCap === undefined) {
        delete process.env.MATOS_TOOL_STDOUT_MAX_BYTES
      } else {
        process.env.MATOS_TOOL_STDOUT_MAX_BYTES = previousCap
      }
    }
  }, 15000)
})
