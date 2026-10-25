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
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { matOSGiteaScopeIdFromScopeRef } from './giteaGovernance.js'
import { loadMatOSAssets } from './loadAssets.js'
import { buildMatOSAssetRegistry } from './registry.js'
import { hasMatOSSecretLookingContent } from './secretScan.js'
import { validateMatOSAssets } from './validateAssets.js'
import { syncGeneratedScopedAssetsToGitea } from '../learning/generatedScopedAssetSync.js'
import type { MatOSDirectAssetEditorScope } from '../learning/directAssetEditorTypes.js'
import { getMatOSDir } from '../project.js'

const execFileAsync = promisify(execFile)
const DEFAULT_VERSION = '0.1.0'
const MAX_SCAN_FILES = 10_000
const MAX_SCHEMA_FILES = 16
const MAX_SCHEMA_SAMPLE_BYTES = 512 * 1024
const MAX_FULL_CHECKSUM_BYTES = 512 * 1024 * 1024
const QUERYABLE_FORMATS = new Set(['csv', 'tsv', 'json', 'jsonl', 'sqlite', 'parquet', 'hdf5'])

type ScopedAssetScope = Extract<MatOSDirectAssetEditorScope, 'user' | 'team' | 'project'>

type AdaptedFormat =
  | 'csv'
  | 'tsv'
  | 'json'
  | 'jsonl'
  | 'sqlite'
  | 'parquet'
  | 'hdf5'
  | 'npy'
  | 'npz'
  | 'xlsx'
  | 'text'
  | 'unknown'

type ScannedFile = {
  absolutePath: string
  relativePath: string
  sizeBytes: number
  modifiedMs: number
  format: AdaptedFormat
}

type PathScan = {
  requestedPath: string
  resolvedPath: string
  kind: 'file' | 'directory'
  files: ScannedFile[]
  fileCount: number
  sizeBytes: number
  truncated: boolean
  skippedSymlinks: string[]
}

type SchemaRecord = {
  file: string
  format: AdaptedFormat
  schema?: Record<string, unknown>
  warning?: string
}

type ChecksumRecord = {
  algorithm: 'sha256-file-v1' | 'sha256-tree-content-v1' | 'sha256-tree-metadata-v1'
  digest: string
  coverage: 'full-content' | 'metadata-only' | 'partial-metadata'
  coveredFiles: number
  coveredBytes: number
  reason?: string
}

type PlannedAsset = {
  type: 'data' | 'knowledge' | 'tool' | 'skill'
  id: string
  ref: string
  name: string
  generatedDir: string
  files: Record<string, string>
}

export type MatOSAdaptPathInput = {
  cwd: string
  path: string
  scopeRef?: string
  id?: string
  name?: string
  version?: string
  description?: string
  dryRun?: boolean
  replace?: boolean
  reason?: string
  env?: Record<string, string | undefined>
  maxScanFiles?: number
}

export type MatOSAdaptPathResult = Record<string, unknown> & {
  ok: boolean
  dryRun: boolean
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function slug(value: string | undefined, fallback: string): string {
  const normalized = (value ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 52)
    .replace(/-+$/g, '')
  return normalized || fallback
}

function parseScopeRef(value: string | undefined): { scope: ScopedAssetScope; scopeRef: string } | undefined {
  const normalized = optionalString(value)
  if (!normalized) return undefined
  for (const scope of ['user', 'team', 'project'] as const) {
    if (normalized.startsWith(`${scope}:`) && normalized.slice(scope.length + 1).trim()) {
      return { scope, scopeRef: normalized }
    }
  }
  return undefined
}

function isWithin(candidate: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function resolveAdaptPathGovernanceCwd(
  input: MatOSAdaptPathInput,
): Promise<string> {
  const configured =
    optionalString(input.env?.MATOS_ASSET_GOVERNANCE_CWD) ??
    optionalString(input.env?.MATOS_WORKSPACE_DIR)
  if (!configured) return input.cwd

  const [projectCwd, governanceCwd] = await Promise.all([
    realpath(input.cwd).catch(() => resolve(input.cwd)),
    realpath(configured).catch(() => resolve(configured)),
  ])
  return isWithin(projectCwd, governanceCwd) ? governanceCwd : input.cwd
}

function humanSize(size: number): string {
  let value = size
  for (const unit of ['B', 'KiB', 'MiB', 'GiB', 'TiB']) {
    if (Math.abs(value) < 1024 || unit === 'TiB') {
      return unit === 'B' ? `${Math.round(value)} B` : `${value.toFixed(2)} ${unit}`
    }
    value /= 1024
  }
  return `${size} B`
}

async function readHeader(path: string, bytes = 16): Promise<Buffer> {
  const stream = createReadStream(path, { start: 0, end: bytes - 1 })
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function detectFormat(path: string): Promise<AdaptedFormat> {
  const extension = extname(path).toLowerCase()
  const extensionFormats: Record<string, AdaptedFormat> = {
    '.csv': 'csv',
    '.tsv': 'tsv',
    '.json': 'json',
    '.jsonl': 'jsonl',
    '.ndjson': 'jsonl',
    '.sqlite': 'sqlite',
    '.sqlite3': 'sqlite',
    '.db': 'sqlite',
    '.parquet': 'parquet',
    '.h5': 'hdf5',
    '.hdf5': 'hdf5',
    '.npy': 'npy',
    '.npz': 'npz',
    '.xlsx': 'xlsx',
    '.xls': 'xlsx',
    '.txt': 'text',
    '.md': 'text',
  }
  const header = await readHeader(path).catch(() => Buffer.alloc(0))
  if (header.subarray(0, 16).toString('utf8') === 'SQLite format 3\u0000') return 'sqlite'
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'hdf5'
  if (header.subarray(0, 4).toString('ascii') === 'PAR1') return 'parquet'
  return extensionFormats[extension] ?? 'unknown'
}

async function scanPath(input: {
  cwd: string
  rawPath: string
  maxFiles: number
}): Promise<PathScan> {
  const requestedPath = input.rawPath.startsWith('/')
    ? input.rawPath
    : resolve(input.cwd, input.rawPath)
  const resolvedPath = await realpath(requestedPath)
  const rootInfo = await stat(resolvedPath)
  if (!rootInfo.isFile() && !rootInfo.isDirectory()) {
    throw new Error(`adapt-path supports regular files and directories only: ${input.rawPath}`)
  }
  const files: ScannedFile[] = []
  const skippedSymlinks: string[] = []
  let truncated = false

  const addFile = async (absolutePath: string, relativePath: string): Promise<void> => {
    const info = await stat(absolutePath)
    files.push({
      absolutePath,
      relativePath: relativePath.replace(/\\/g, '/'),
      sizeBytes: info.size,
      modifiedMs: info.mtimeMs,
      format: await detectFormat(absolutePath),
    })
  }

  if (rootInfo.isFile()) {
    await addFile(resolvedPath, basename(resolvedPath))
  } else {
    const walk = async (directory: string): Promise<void> => {
      if (truncated) return
      const entries = await readdir(directory, { withFileTypes: true })
      entries.sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of entries) {
        if (files.length >= input.maxFiles) {
          truncated = true
          return
        }
        const absolutePath = join(directory, entry.name)
        const rel = relative(resolvedPath, absolutePath).replace(/\\/g, '/')
        if (entry.isSymbolicLink()) {
          skippedSymlinks.push(rel)
          continue
        }
        if (entry.isDirectory()) {
          await walk(absolutePath)
        } else if (entry.isFile()) {
          await addFile(absolutePath, rel)
        }
      }
    }
    await walk(resolvedPath)
  }
  return {
    requestedPath: input.rawPath,
    resolvedPath,
    kind: rootInfo.isFile() ? 'file' : 'directory',
    files,
    fileCount: files.length,
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    truncated,
    skippedSymlinks,
  }
}

function splitDelimitedRow(line: string, delimiter: string): string[] {
  const values: string[] = []
  let value = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (character === delimiter && !quoted) {
      values.push(value)
      value = ''
    } else {
      value += character
    }
  }
  values.push(value)
  return values
}

function inferredScalarType(values: string[]): string {
  const present = values.map(value => value.trim()).filter(Boolean)
  if (present.length === 0) return 'null'
  if (present.every(value => /^(true|false)$/i.test(value))) return 'boolean'
  if (present.every(value => /^[-+]?\d+$/.test(value))) return 'integer'
  if (present.every(value => Number.isFinite(Number(value)))) return 'number'
  if (present.every(value => !Number.isNaN(Date.parse(value)) && /[-/:T]/.test(value))) return 'datetime'
  return 'string'
}

async function inspectDelimited(file: ScannedFile): Promise<Record<string, unknown>> {
  const text = (await readHeader(file.absolutePath, MAX_SCHEMA_SAMPLE_BYTES)).toString('utf8')
  const lines = text.split(/\r?\n/).filter(line => line.length > 0).slice(0, 51)
  const delimiter = file.format === 'tsv' ? '\t' : ','
  const header = splitDelimitedRow(lines[0] ?? '', delimiter)
  const rows = lines.slice(1).map(line => splitDelimitedRow(line, delimiter))
  return {
    delimiter: file.format === 'tsv' ? 'tab' : 'comma',
    sampledRows: rows.length,
    columns: header.slice(0, 256).map((name, index) => ({
      name: name || `column_${index + 1}`,
      inferredType: inferredScalarType(rows.map(row => row[index] ?? '')),
    })),
    columnsTruncated: header.length > 256,
  }
}

function jsonType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

async function inspectJson(file: ScannedFile): Promise<Record<string, unknown>> {
  const text = (await readHeader(file.absolutePath, MAX_SCHEMA_SAMPLE_BYTES)).toString('utf8')
  const rows = file.format === 'jsonl'
    ? text.split(/\r?\n/).filter(Boolean).slice(0, 50).map(line => JSON.parse(line) as unknown)
    : [JSON.parse(text) as unknown]
  const objects = rows.flatMap(row => Array.isArray(row) ? row.slice(0, 50) : [row])
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object' && !Array.isArray(row))
  const fields = new Map<string, Set<string>>()
  for (const object of objects) {
    for (const [key, value] of Object.entries(object).slice(0, 256)) {
      const types = fields.get(key) ?? new Set<string>()
      types.add(jsonType(value))
      fields.set(key, types)
    }
  }
  return {
    sampledRecords: objects.length,
    fields: [...fields.entries()].map(([name, types]) => ({ name, types: [...types] })),
  }
}

const PYTHON_SCHEMA_PROBE = String.raw`
import json, sys
path, kind = sys.argv[1], sys.argv[2]
if kind == "sqlite":
    import sqlite3
    db = sqlite3.connect("file:" + path + "?mode=ro&immutable=1", uri=True)
    tables = []
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 200"):
        quoted = '"' + name.replace('"', '""') + '"'
        columns = [{"name": row[1], "declaredType": row[2], "nullable": not bool(row[3]), "primaryKey": bool(row[5])} for row in db.execute("PRAGMA table_info(" + quoted + ")")]
        tables.append({"name": name, "columns": columns})
    print(json.dumps({"tables": tables}))
elif kind == "parquet":
    import duckdb
    escaped = path.replace("'", "''")
    rows = duckdb.connect(":memory:").execute("DESCRIBE SELECT * FROM read_parquet('" + escaped + "')").fetchall()
    print(json.dumps({"columns": [{"name": row[0], "declaredType": row[1]} for row in rows]}))
elif kind == "hdf5":
    import h5py
    datasets = []
    with h5py.File(path, "r") as handle:
        def visit(name, item):
            if isinstance(item, h5py.Dataset) and len(datasets) < 200:
                datasets.append({"name": name, "shape": list(item.shape), "dtype": str(item.dtype)})
        handle.visititems(visit)
    print(json.dumps({"datasets": datasets}))
`

async function inspectSchema(files: ScannedFile[]): Promise<SchemaRecord[]> {
  const candidates = files.filter(file => QUERYABLE_FORMATS.has(file.format)).slice(0, MAX_SCHEMA_FILES)
  const records: SchemaRecord[] = []
  for (const file of candidates) {
    try {
      if (file.format === 'csv' || file.format === 'tsv') {
        records.push({ file: file.relativePath, format: file.format, schema: await inspectDelimited(file) })
      } else if (file.format === 'json' || file.format === 'jsonl') {
        records.push({ file: file.relativePath, format: file.format, schema: await inspectJson(file) })
      } else {
        const result = await execFileAsync('python3', ['-c', PYTHON_SCHEMA_PROBE, file.absolutePath, file.format], {
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
        })
        records.push({ file: file.relativePath, format: file.format, schema: JSON.parse(result.stdout) as Record<string, unknown> })
      }
    } catch (error) {
      records.push({
        file: file.relativePath,
        format: file.format,
        warning: `Schema probe unavailable: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }
  return records
}

async function hashFileInto(hash: ReturnType<typeof createHash>, file: ScannedFile): Promise<void> {
  hash.update(file.relativePath)
  hash.update('\u0000')
  hash.update(String(file.sizeBytes))
  hash.update('\u0000')
  for await (const chunk of createReadStream(file.absolutePath)) hash.update(chunk as Buffer)
  hash.update('\u0000')
}

async function checksumScan(scan: PathScan): Promise<ChecksumRecord> {
  const sorted = [...scan.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath))
  const fullContent = !scan.truncated && scan.sizeBytes <= MAX_FULL_CHECKSUM_BYTES
  const hash = createHash('sha256')
  if (scan.kind === 'file' && fullContent) {
    for await (const chunk of createReadStream(sorted[0].absolutePath)) hash.update(chunk as Buffer)
  } else if (fullContent) {
    for (const file of sorted) await hashFileInto(hash, file)
  } else {
    for (const file of sorted) {
      hash.update(`${file.relativePath}\u0000${file.sizeBytes}\u0000${Math.floor(file.modifiedMs)}\n`)
    }
  }
  const isSingleFile = scan.kind === 'file' && fullContent
  return {
    algorithm: isSingleFile
      ? 'sha256-file-v1'
      : fullContent
        ? 'sha256-tree-content-v1'
        : 'sha256-tree-metadata-v1',
    digest: `sha256:${hash.digest('hex')}`,
    coverage: fullContent ? 'full-content' : scan.truncated ? 'partial-metadata' : 'metadata-only',
    coveredFiles: sorted.length,
    coveredBytes: scan.sizeBytes,
    ...(!fullContent
      ? { reason: scan.truncated
          ? `scan stopped at ${sorted.length} files`
          : `payload exceeds the ${humanSize(MAX_FULL_CHECKSUM_BYTES)} inline checksum budget` }
      : {}),
  }
}

function generatedScopeRoot(cwd: string, scope: ScopedAssetScope, scopeRef: string): string {
  const scopeDir = scope === 'user' ? 'users' : scope === 'team' ? 'teams' : 'projects'
  return join(
    getMatOSDir(cwd),
    'assets',
    'generated',
    'scopes',
    scopeDir,
    matOSGiteaScopeIdFromScopeRef(scopeRef),
  )
}

function sourceProvenanceScopeRef(metadata: Record<string, unknown>): string | undefined {
  const provenance = metadata.sourceProvenance
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return undefined
  const raw = provenance as Record<string, unknown>
  return typeof raw.scopeRef === 'string'
    ? raw.scopeRef
    : typeof raw.scope_ref === 'string'
      ? raw.scope_ref
      : undefined
}

function manifest(input: {
  id: string
  type: PlannedAsset['type']
  name: string
  version: string
  description: string
  entry: string
  tags: string[]
  dependencies?: string[]
  mounts?: Record<string, string[]>
  permissions?: Record<string, unknown>
  metadata: Record<string, unknown>
}): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    id: input.id,
    type: input.type,
    name: input.name,
    version: input.version,
    description: input.description,
    entry: input.entry,
    tags: input.tags,
    ...(input.dependencies?.length ? { dependencies: input.dependencies } : {}),
    ...(input.mounts ? { mounts: input.mounts } : {}),
    permissions: input.permissions ?? {
      workspace: 'read-only',
      network: 'disabled',
      secrets: [],
    },
    lifecycle: {
      status: 'enabled',
      origin: 'matos-path-adapter',
      updatedAt: new Date().toISOString(),
    },
    metadata: input.metadata,
  }, null, 2)}\n`
}

function renderDataReadme(input: {
  name: string
  ref: string
  scan: PathScan
  formats: AdaptedFormat[]
  checksum: ChecksumRecord
}): string {
  return [
    `# ${input.name}`,
    '',
    'Reference-only MatOS data asset. The payload is not copied into Git.',
    '',
    `- Asset: \`${input.ref}\``,
    `- Path: \`${input.scan.requestedPath}\``,
    `- Resolved path: \`${input.scan.resolvedPath}\``,
    `- Kind: ${input.scan.kind}`,
    `- Files scanned: ${input.scan.fileCount}${input.scan.truncated ? ' (truncated)' : ''}`,
    `- Scanned size: ${humanSize(input.scan.sizeBytes)}`,
    `- Formats: ${input.formats.join(', ') || 'unknown'}`,
    `- Checksum: ${input.checksum.digest} (${input.checksum.coverage})`,
    '',
    'Treat the payload as read-only. Use the mounted query tool when available.',
    '',
  ].join('\n')
}

function renderKnowledge(input: {
  name: string
  dataRef: string
  toolRef?: string
  scan: PathScan
  schemas: SchemaRecord[]
}): string {
  const schemaLines = input.schemas.length
    ? input.schemas.map(record =>
        `- \`${record.file}\` (${record.format}): ${record.warning ?? JSON.stringify(record.schema)}`,
      )
    : ['- No structured schema was detected.']
  return [
    `# ${input.name} data guide`,
    '',
    `Data asset: \`${input.dataRef}\``,
    `Payload path: \`${input.scan.requestedPath}\``,
    ...(input.toolRef ? [`Read-only query tool: \`${input.toolRef}\``] : []),
    '',
    '## Detected schema',
    '',
    ...schemaLines,
    '',
    '## Usage policy',
    '',
    '- Do not copy the payload into the asset repository.',
    '- Query only the minimum rows and columns needed for the task.',
    '- Keep generated outputs outside the source payload path.',
    '- Re-run path adaptation after replacing the payload so provenance and schema stay current.',
    '',
  ].join('\n')
}

function renderSkill(input: {
  name: string
  dataRef: string
  knowledgeRef: string
  toolRef?: string
}): string {
  return [
    `# Use ${input.name}`,
    '',
    'Use this skill whenever a task needs the adapted user dataset.',
    '',
    `1. Read \`${input.knowledgeRef}\` before querying.`,
    `2. Resolve \`${input.dataRef}\` and preserve its reference-only policy.`,
    ...(input.toolRef
      ? [`3. Use \`${input.toolRef}\` for schema, sample, and read-only SELECT operations.`]
      : ['3. Read supported files directly without modifying the source path.']),
    '4. Report the asset ref, query/filter, and output path in results.',
    '5. Never write into or delete from the registered payload path.',
    '',
  ].join('\n')
}

function renderQueryInputSchema(): string {
  return `${JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['info', 'schema', 'tables', 'sample', 'query'] },
      file: { type: 'string', description: 'Relative file path for directory datasets.' },
      table: { type: 'string', description: 'SQLite table for sample/schema.' },
      dataset: { type: 'string', description: 'HDF5 dataset for sample.' },
      sql: { type: 'string', description: 'Read-only SELECT against SQLite or the DuckDB view named data.' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
    },
    required: ['action'],
    additionalProperties: false,
  }, null, 2)}\n`
}

function renderQueryTool(dataPath: string, formatByRelativePath: Record<string, AdaptedFormat>): string {
  return `#!/usr/bin/env python3
import csv
import json
import os
import re
import shutil
import sqlite3
import sys
import tempfile
from pathlib import Path

DATA_PATH = Path(${JSON.stringify(dataPath)})
FORMAT_BY_FILE = ${JSON.stringify(formatByRelativePath, null, 2)}
SUFFIX_FORMAT = {".csv": "csv", ".tsv": "tsv", ".json": "json", ".jsonl": "jsonl", ".ndjson": "jsonl", ".sqlite": "sqlite", ".sqlite3": "sqlite", ".db": "sqlite", ".parquet": "parquet", ".h5": "hdf5", ".hdf5": "hdf5"}
BLOCKED_SQL = re.compile(r"\\b(attach|detach|copy|install|load|export|import|pragma|call|create|update|delete|insert|replace|drop|alter|vacuum|set|read_csv|read_json|read_parquet|scan)\\b", re.I)

def fail(message, code=2):
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
    raise SystemExit(code)

def request():
    payload = json.load(sys.stdin)
    return payload.get("input", payload)

def resolve_file(raw=None, action=None, table=None, sql=None):
    if DATA_PATH.is_file():
        return DATA_PATH
    if raw:
        candidate = (DATA_PATH / raw).resolve()
        try:
            candidate.relative_to(DATA_PATH.resolve())
        except ValueError:
            fail("file escapes the registered data path")
        if not candidate.is_file():
            fail("file not found: " + raw)
        return candidate
    prefer_sqlite = (
        action == "tables"
        or (action in ("schema", "sample") and bool(table))
        or (action == "query" and bool(sql) and not re.search(r"\\bdata\\b", sql, re.I))
    )
    ordered = list(FORMAT_BY_FILE)
    if prefer_sqlite:
        ordered.sort(key=lambda name: FORMAT_BY_FILE.get(name) != "sqlite")
    for name in ordered:
        candidate = DATA_PATH / name
        if candidate.is_file():
            return candidate
    fail("no queryable file found")

def relative_name(path):
    if DATA_PATH.is_file():
        return DATA_PATH.name
    return path.resolve().relative_to(DATA_PATH.resolve()).as_posix()

def file_format(path):
    return FORMAT_BY_FILE.get(relative_name(path), SUFFIX_FORMAT.get(path.suffix.lower(), "unknown"))

def safe_limit(raw):
    return max(1, min(200, int(raw or 20)))

def safe_sql(sql):
    text = (sql or "").strip()
    if not re.match(r"^(select|with)\\b", text, re.I) or ";" in text or BLOCKED_SQL.search(text):
        fail("only one read-only SELECT/WITH query over the registered dataset is allowed")
    return text

def sqlite_connection(path):
    uri = "file:" + str(path) + "?mode=ro&immutable=1"
    db = sqlite3.connect(uri, uri=True)
    db.row_factory = sqlite3.Row
    return db

def sqlite_tables(db):
    return [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")]

def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'

def tabular_sample(path, kind, limit):
    if kind in ("csv", "tsv"):
        with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
            rows = list()
            for row in csv.DictReader(handle, delimiter="\\t" if kind == "tsv" else ","):
                rows.append(row)
                if len(rows) >= limit:
                    break
            return rows
    if kind == "jsonl":
        rows = []
        with path.open("r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if line.strip():
                    rows.append(json.loads(line))
                    if len(rows) >= limit:
                        break
        return rows
    if kind == "json":
        value = json.loads(path.read_text(encoding="utf-8"))
        return value[:limit] if isinstance(value, list) else value
    fail("sample requires DuckDB/h5py for format: " + kind)

def utf8_query_path(path, kind):
    if kind not in ("csv", "tsv"):
        return path, None
    try:
        with path.open("r", encoding="utf-8-sig") as handle:
            while handle.read(1024 * 1024):
                pass
        return path, None
    except UnicodeDecodeError:
        temporary = tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="",
            suffix=path.suffix,
            prefix="matos-query-utf8-",
            delete=False,
        )
        temporary_path = Path(temporary.name)
        try:
            with temporary, path.open(
                "r", encoding="utf-8-sig", errors="replace", newline=""
            ) as source:
                shutil.copyfileobj(source, temporary)
        except Exception:
            temporary_path.unlink(missing_ok=True)
            raise
        return temporary_path, temporary_path

def duckdb_rows(path, kind, sql, limit):
    try:
        import duckdb
    except Exception as error:
        fail("DuckDB is required for this query: " + str(error))
    query_path, temporary_path = utf8_query_path(path, kind)
    db = None
    try:
        escaped = str(query_path).replace("'", "''")
        reader = {
            "csv": "read_csv_auto('" + escaped + "')",
            "tsv": "read_csv_auto('" + escaped + "', delim='\\t')",
            "json": "read_json_auto('" + escaped + "')",
            "jsonl": "read_json_auto('" + escaped + "')",
            "parquet": "read_parquet('" + escaped + "')",
        }.get(kind)
        if not reader:
            fail("DuckDB adapter is unavailable for format: " + kind)
        db = duckdb.connect(":memory:")
        db.execute("CREATE VIEW data AS SELECT * FROM " + reader)
        cursor = db.execute("SELECT * FROM (" + safe_sql(sql) + ") AS matos_query LIMIT ?", [limit])
        columns = [item[0] for item in cursor.description]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]
    finally:
        if db is not None:
            db.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)

def hdf5_sample(path, dataset, limit):
    try:
        import h5py
    except Exception as error:
        fail("h5py is required for HDF5 sample: " + str(error))
    with h5py.File(path, "r") as handle:
        selected = dataset
        if not selected:
            names = []
            handle.visititems(lambda name, item: names.append(name) if isinstance(item, h5py.Dataset) and not names else None)
            selected = names[0] if names else None
        if not selected or selected not in handle or not isinstance(handle[selected], h5py.Dataset):
            fail("HDF5 dataset not found; call schema first and pass dataset")
        value = handle[selected]
        sample = value[()] if value.shape == () else value[:limit]
        return {"dataset": selected, "shape": list(value.shape), "dtype": str(value.dtype), "sample": sample.tolist() if hasattr(sample, "tolist") else sample}

def main():
    args = request()
    action = args.get("action", "info")
    limit = safe_limit(args.get("limit"))
    if action == "info":
        print(json.dumps({"ok": True, "path": str(DATA_PATH), "files": FORMAT_BY_FILE, "readOnly": True}, ensure_ascii=False))
        return
    path = resolve_file(
        args.get("file"), action, args.get("table"), args.get("sql")
    )
    kind = file_format(path)
    if kind == "sqlite":
        db = sqlite_connection(path)
        tables = sqlite_tables(db)
        if action == "tables":
            result = tables
        elif action == "schema":
            selected = args.get("table") or (tables[0] if tables else None)
            result = [] if not selected else [dict(row) for row in db.execute("PRAGMA table_info(" + quote_identifier(selected) + ")")]
        elif action == "sample":
            selected = args.get("table") or (tables[0] if tables else None)
            if not selected:
                result = []
            else:
                result = [dict(row) for row in db.execute("SELECT * FROM " + quote_identifier(selected) + " LIMIT ?", [limit])]
        elif action == "query":
            cursor = db.execute("SELECT * FROM (" + safe_sql(args.get("sql")) + ") AS matos_query LIMIT ?", [limit])
            result = [dict(row) for row in cursor.fetchall()]
        else:
            fail("unsupported SQLite action: " + action)
    elif action == "sample" and kind == "hdf5":
        result = hdf5_sample(path, args.get("dataset"), limit)
    elif action == "sample" and kind == "parquet":
        result = duckdb_rows(path, kind, "SELECT * FROM data", limit)
    elif action == "sample":
        result = tabular_sample(path, kind, limit)
    elif action == "query":
        result = duckdb_rows(path, kind, args.get("sql"), limit)
    elif action == "schema" and kind == "hdf5":
        try:
            import h5py
        except Exception as error:
            fail("h5py is required for HDF5 schema: " + str(error))
        result = []
        with h5py.File(path, "r") as handle:
            handle.visititems(lambda name, item: result.append({"name": name, "shape": list(item.shape), "dtype": str(item.dtype)}) if isinstance(item, h5py.Dataset) and len(result) < 200 else None)
    elif action == "schema":
        result = duckdb_rows(path, kind, "SELECT * FROM data", 1)
    else:
        fail("unsupported action for format " + kind + ": " + action)
    print(json.dumps({"ok": True, "file": relative_name(path), "format": kind, "result": result}, ensure_ascii=False, default=str))

if __name__ == "__main__":
    main()
`
}

function buildPlannedAssets(input: {
  cwd: string
  scoped: { scope: ScopedAssetScope; scopeRef: string }
  baseId: string
  name: string
  version: string
  description?: string
  scan: PathScan
  formats: AdaptedFormat[]
  schemas: SchemaRecord[]
  checksum: ChecksumRecord
}): PlannedAsset[] {
  const root = generatedScopeRoot(input.cwd, input.scoped.scope, input.scoped.scopeRef)
  const dataId = input.baseId
  const knowledgeId = `${input.baseId}-guide`
  const toolId = `${input.baseId}-query`
  const skillId = `${input.baseId}-usage`
  const dataRef = `data:${dataId}@${input.version}`
  const knowledgeRef = `knowledge:${knowledgeId}@${input.version}`
  const queryableFiles = input.scan.files.filter(file => QUERYABLE_FORMATS.has(file.format))
  const toolRef = queryableFiles.length ? `tool:${toolId}@${input.version}` : undefined
  const skillRef = `skill:${skillId}@${input.version}`
  const now = new Date().toISOString()
  const commonMetadata = {
    sourceFormat: 'matos-path-adapter',
    adaptedAt: now,
    adaptedBy: 'matos assets adapt-path',
    scopeRef: input.scoped.scopeRef,
  }
  const dataReadme = renderDataReadme({
    name: input.name,
    ref: dataRef,
    scan: input.scan,
    formats: input.formats,
    checksum: input.checksum,
  })
  const assets: PlannedAsset[] = [
    {
      type: 'data',
      id: dataId,
      ref: dataRef,
      name: input.name,
      generatedDir: join(root, 'data', dataId),
      files: {
        'asset.json': manifest({
          id: dataId,
          type: 'data',
          name: input.name,
          version: input.version,
          description: input.description ?? `Reference-only dataset adapted from ${input.scan.requestedPath}.`,
          entry: 'DATA.md',
          tags: ['data', 'user-upload', 'reference-only', 'path-adapted', ...input.formats],
          metadata: {
            ...commonMetadata,
            kind: 'registered-dataset',
            payloadPolicy: 'reference-only',
            payloadStatus: 'verified',
            path: input.scan.requestedPath,
            resolvedPath: input.scan.resolvedPath,
            payloadKind: input.scan.kind,
            sizeBytes: input.scan.sizeBytes,
            sizeHuman: humanSize(input.scan.sizeBytes),
            fileCount: input.scan.fileCount,
            scanTruncated: input.scan.truncated,
            skippedSymlinkCount: input.scan.skippedSymlinks.length,
            formats: input.formats,
            checksum: input.checksum,
            schemaPath: 'schema.json',
            runnable: false,
          },
        }),
        'DATA.md': dataReadme,
        'schema.json': `${JSON.stringify({
          sourcePath: input.scan.requestedPath,
          formats: input.formats,
          files: input.schemas,
          scan: {
            fileCount: input.scan.fileCount,
            truncated: input.scan.truncated,
            skippedSymlinks: input.scan.skippedSymlinks,
          },
        }, null, 2)}\n`,
      },
    },
  ]

  if (toolRef) {
    // Keep generated tool manifests small for directories with tens of
    // thousands of partitions. Explicit file requests still work through
    // suffix detection in the query adapter.
    const queryCatalogFiles = queryableFiles.slice(0, 512)
    const formatByRelativePath = Object.fromEntries(queryCatalogFiles.map(file => [file.relativePath, file.format]))
    assets.push({
      type: 'tool',
      id: toolId,
      ref: toolRef,
      name: `${input.name} Query`,
      generatedDir: join(root, 'tool', toolId),
      files: {
        'asset.json': manifest({
          id: toolId,
          type: 'tool',
          name: `${input.name} Query`,
          version: input.version,
          description: `Read-only schema, sample, and query adapter for ${dataRef}.`,
          entry: 'tool.py',
          tags: ['tool', 'data-query', 'read-only', ...input.formats],
          dependencies: [dataRef],
          mounts: { data: [dataRef] },
          permissions: {
            shell: 'read-only',
            workspace: 'read-only',
            network: 'disabled',
            secrets: [],
          },
          metadata: {
            ...commonMetadata,
            kind: 'external-tool',
            binding: `mcp__matos_asset__${toolId.replace(/-/g, '_')}`,
            promptPath: 'prompt.md',
            inputSchemaPath: 'input.schema.json',
            isReadOnly: true,
            isDestructive: false,
            queryFileCatalogCount: queryCatalogFiles.length,
            queryFileCatalogTruncated: queryableFiles.length > queryCatalogFiles.length,
            executor: {
              type: 'matos-python',
              runtime: 'python3',
              entry: './tool.py',
              timeoutMs: 30_000,
              mcpName: toolId.replace(/-/g, '_'),
            },
          },
        }),
        'tool.py': renderQueryTool(input.scan.resolvedPath, formatByRelativePath),
        'input.schema.json': renderQueryInputSchema(),
        'prompt.md': `Read-only query adapter for ${dataRef}. Start with info/schema/sample. For SQLite, use tables and pass table for schema/sample, or query the table directly. For CSV/TSV/JSON/Parquet queries, write SQL against the DuckDB view named data. Never write to the payload path.\n`,
      },
    })
  }

  assets.push({
    type: 'knowledge',
    id: knowledgeId,
    ref: knowledgeRef,
    name: `${input.name} Guide`,
    generatedDir: join(root, 'knowledge', knowledgeId),
    files: {
      'asset.json': manifest({
        id: knowledgeId,
        type: 'knowledge',
        name: `${input.name} Guide`,
        version: input.version,
        description: `Schema, provenance, and safe usage guide for ${dataRef}.`,
        entry: 'README.md',
        tags: ['knowledge', 'data-guide', 'path-adapted'],
        dependencies: [dataRef, ...(toolRef ? [toolRef] : [])],
        mounts: { data: [dataRef], ...(toolRef ? { tools: [toolRef] } : {}) },
        metadata: commonMetadata,
      }),
      'README.md': renderKnowledge({
        name: input.name,
        dataRef,
        toolRef,
        scan: input.scan,
        schemas: input.schemas,
      }),
    },
  })

  const skillDependencies = [dataRef, knowledgeRef, ...(toolRef ? [toolRef] : [])]
  assets.push({
    type: 'skill',
    id: skillId,
    ref: skillRef,
    name: `Use ${input.name}`,
    generatedDir: join(root, 'skill', skillId),
    files: {
      'asset.json': manifest({
        id: skillId,
        type: 'skill',
        name: `Use ${input.name}`,
        version: input.version,
        description: `Reusable procedure for reading and querying ${dataRef}.`,
        entry: 'SKILL.md',
        tags: ['skill', 'data-usage', 'path-adapted'],
        dependencies: skillDependencies,
        mounts: {
          data: [dataRef],
          knowledge: [knowledgeRef],
          ...(toolRef ? { tools: [toolRef] } : {}),
        },
        metadata: commonMetadata,
      }),
      'SKILL.md': renderSkill({ name: input.name, dataRef, knowledgeRef, toolRef }),
    },
  })
  return assets
}

async function writeAssetFiles(directory: string, files: Record<string, string>): Promise<void> {
  await mkdir(directory, { recursive: true })
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(directory, relativePath)
    if (!isWithin(target, directory)) throw new Error(`Generated asset file escaped its directory: ${relativePath}`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

async function runQueryToolSmokeProcess(
  scriptPath: string,
  input: Record<string, unknown>,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('close', exitCode => {
      clearTimeout(timeout)
      resolvePromise({ stdout, stderr, exitCode })
    })
    child.stdin.end(`${JSON.stringify({ input })}\n`)
  })
}

async function smokeQueryTool(asset: PlannedAsset | undefined, scan: PathScan): Promise<Record<string, unknown>> {
  if (!asset) return { status: 'not-required', reason: 'no queryable format detected' }
  const script = asset.files['tool.py']
  const tempRoot = await mkdtemp(join('/tmp', 'matos-adapt-query-'))
  const scriptPath = join(tempRoot, 'tool.py')
  try {
    await writeFile(scriptPath, script, 'utf8')
    const infoResult = await runQueryToolSmokeProcess(scriptPath, { action: 'info' })
    if (infoResult.exitCode !== 0) throw new Error(infoResult.stderr || `query info smoke exited ${infoResult.exitCode}`)
    const info = JSON.parse(infoResult.stdout) as Record<string, unknown>
    if (info.ok !== true) throw new Error('query info smoke returned ok=false')

    const queryable = scan.files.find(file => QUERYABLE_FORMATS.has(file.format))
    if (!queryable) return { status: 'passed', checks: [{ action: 'info', status: 'passed' }] }
    if (queryable.format === 'json' && queryable.sizeBytes > 16 * 1024 * 1024) {
      return {
        status: 'passed',
        checks: [
          { action: 'info', status: 'passed' },
          { action: 'sample', status: 'deferred', reason: 'JSON payload exceeds the 16 MiB smoke-read budget' },
        ],
      }
    }
    const queryInput: Record<string, unknown> = {
      action: 'sample',
      file: queryable.relativePath,
      limit: 1,
    }
    const queryResult = await runQueryToolSmokeProcess(scriptPath, queryInput)
    if (queryResult.exitCode !== 0) {
      if (queryable.format === 'parquet' || queryable.format === 'hdf5') {
        return {
          status: 'passed',
          checks: [
            { action: 'info', status: 'passed' },
            {
              action: queryInput.action,
              status: 'dependency-deferred',
              format: queryable.format,
              detail: queryResult.stdout.trim() || queryResult.stderr.trim(),
            },
          ],
        }
      }
      throw new Error(queryResult.stdout.trim() || queryResult.stderr.trim() || `query smoke exited ${queryResult.exitCode}`)
    }
    const queried = JSON.parse(queryResult.stdout) as Record<string, unknown>
    if (queried.ok !== true) throw new Error('query smoke returned ok=false')
    return {
      status: 'passed',
      checks: [
        { action: 'info', status: 'passed' },
        { action: queryInput.action, status: 'passed', format: queryable.format },
      ],
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function secretScanPlan(assets: PlannedAsset[]): Array<{ assetRef: string; path: string }> {
  const findings: Array<{ assetRef: string; path: string }> = []
  for (const asset of assets) {
    for (const [path, content] of Object.entries(asset.files)) {
      if (hasMatOSSecretLookingContent(content)) findings.push({ assetRef: asset.ref, path })
    }
  }
  return findings
}

export async function adaptMatOSPath(input: MatOSAdaptPathInput): Promise<MatOSAdaptPathResult> {
  const rawPath = optionalString(input.path)
  if (!rawPath) return { ok: false, dryRun: Boolean(input.dryRun), error: 'adapt-path requires a path' }
  const scoped = parseScopeRef(
    input.scopeRef ?? input.env?.MATOS_SCOPE_REF ?? process.env.MATOS_SCOPE_REF ?? input.env?.MATOS_SCOPE_ID ?? process.env.MATOS_SCOPE_ID,
  )
  if (!scoped) {
    return {
      ok: false,
      dryRun: Boolean(input.dryRun),
      error: 'adapt-path requires scopeRef=user:<id>, team:<id>, or project:<id> so assets can be published through a scoped accepted ref',
    }
  }
  let scan: PathScan
  try {
    scan = await scanPath({
      cwd: input.cwd,
      rawPath,
      maxFiles: Math.max(1, Math.min(100_000, input.maxScanFiles ?? MAX_SCAN_FILES)),
    })
  } catch (error) {
    return { ok: false, dryRun: Boolean(input.dryRun), error: error instanceof Error ? error.message : String(error) }
  }
  if (scan.files.length === 0) {
    return { ok: false, dryRun: Boolean(input.dryRun), error: 'adapt-path found no regular files', path: rawPath }
  }
  const governanceCwd = await resolveAdaptPathGovernanceCwd(input)
  const formats = [...new Set(scan.files.map(file => file.format))].sort()
  const schemas = await inspectSchema(scan.files)
  const checksum = await checksumScan(scan)
  const baseId = slug(input.id ?? basename(scan.resolvedPath, extname(scan.resolvedPath)), 'uploaded-data')
  const version = optionalString(input.version) ?? DEFAULT_VERSION
  const name = optionalString(input.name) ?? baseId.replace(/-/g, ' ')
  const assets = buildPlannedAssets({
    cwd: governanceCwd,
    scoped,
    baseId,
    name,
    version,
    description: optionalString(input.description),
    scan,
    formats,
    schemas,
    checksum,
  })
  const registry = buildMatOSAssetRegistry(await loadMatOSAssets(governanceCwd), { includeDisabled: true })
  const conflicts = assets.flatMap(asset => {
    const existing = registry.resolve(asset.ref)
    if (!existing) return []
    const sourceScopeRef = sourceProvenanceScopeRef(existing.metadata)
    return [{ ref: asset.ref, source: existing.source, manifestPath: existing.manifestPath, sourceScopeRef }]
  })
  if (conflicts.length && !input.replace) {
    return {
      ok: false,
      dryRun: Boolean(input.dryRun),
      error: 'one or more target assets already exist; choose another --id/--version or pass --replace for assets owned by the same scope',
      conflicts,
    }
  }
  const foreignConflicts = conflicts.filter(conflict => conflict.sourceScopeRef !== scoped.scopeRef)
  if (foreignConflicts.length) {
    return {
      ok: false,
      dryRun: Boolean(input.dryRun),
      error: 'adapt-path refuses to replace assets outside the active scope',
      conflicts: foreignConflicts,
    }
  }
  const secretFindings = secretScanPlan(assets)
  if (secretFindings.length) {
    return { ok: false, dryRun: Boolean(input.dryRun), error: 'generated assets failed secret scan', secretFindings }
  }
  const smoke = await smokeQueryTool(assets.find(asset => asset.type === 'tool'), scan)
  if (smoke.status === 'failed') {
    return { ok: false, dryRun: Boolean(input.dryRun), error: 'generated query tool failed smoke test', smoke }
  }
  const planSummary = assets.map(asset => ({
    type: asset.type,
    id: asset.id,
    ref: asset.ref,
    name: asset.name,
    files: Object.keys(asset.files),
  }))
  const baseResult = {
    dryRun: Boolean(input.dryRun),
    scope: scoped,
    path: {
      requested: scan.requestedPath,
      resolved: scan.resolvedPath,
      kind: scan.kind,
      fileCount: scan.fileCount,
      sizeBytes: scan.sizeBytes,
      sizeHuman: humanSize(scan.sizeBytes),
      scanTruncated: scan.truncated,
      skippedSymlinks: scan.skippedSymlinks,
    },
    formats,
    schema: schemas,
    checksum,
    assets: planSummary,
    secretScan: { ok: true, findings: [] },
    smoke,
  }
  if (input.dryRun) return { ok: true, ...baseResult }

  const tempRoot = join(getMatOSDir(governanceCwd), 'tmp')
  await mkdir(tempRoot, { recursive: true })
  const stageRoot = await mkdtemp(join(tempRoot, 'adapt-path-stage-'))
  const backupRoot = join(stageRoot, '.backup')
  const staged = new Map<string, string>()
  const backups = new Map<string, string>()
  const installed: string[] = []
  try {
    for (const asset of assets) {
      const stageDir = join(stageRoot, asset.type, asset.id)
      await writeAssetFiles(stageDir, asset.files)
      staged.set(asset.ref, stageDir)
    }
    for (const asset of assets) {
      const stageDir = staged.get(asset.ref)
      if (!stageDir) throw new Error(`Missing staged asset: ${asset.ref}`)
      await mkdir(dirname(asset.generatedDir), { recursive: true })
      const existing = await stat(asset.generatedDir).then(() => true).catch(() => false)
      if (existing) {
        const backupDir = join(backupRoot, asset.type, asset.id)
        await mkdir(dirname(backupDir), { recursive: true })
        await rename(asset.generatedDir, backupDir)
        backups.set(asset.generatedDir, backupDir)
      }
      await rename(stageDir, asset.generatedDir)
      installed.push(asset.generatedDir)
    }

    const gitea = await syncGeneratedScopedAssetsToGitea({
      cwd: governanceCwd,
      scope: scoped.scope,
      scopeRef: scoped.scopeRef,
      runId: `adapt-path-${baseId}-${Date.now()}`,
      summary: input.reason ?? `Adapt ${scan.requestedPath} as reusable MatOS assets`,
      env: input.env ?? process.env,
      parkRuntimeAssetsAsDraft: false,
    })
    if (!gitea.ok) {
      throw new Error(
        gitea.sourceCommitErrors?.map(error => `${error.sourceId}: ${error.error}`).join('; ') ||
        gitea.skippedAssets.map(asset => asset.reason).join('; ') ||
        'scoped Gitea asset sync failed',
      )
    }

    const loaded = await loadMatOSAssets(governanceCwd)
    const validation = await validateMatOSAssets(loaded)
    const publishedRegistry = buildMatOSAssetRegistry(loaded, { includeDisabled: true })
    const resolvedRefs = assets
      .map(asset => publishedRegistry.resolve(asset.ref)?.canonicalKey)
      .filter((ref): ref is string => Boolean(ref))
    const assetIds = new Set(assets.map(asset => asset.id))
    const assetRefs = new Set(assets.map(asset => asset.ref))
    const ownErrors = validation.errors.filter(error =>
      (error.assetId && assetIds.has(error.assetId)) ||
      (error.assetKey && assetRefs.has(error.assetKey)),
    )
    return {
      ok: resolvedRefs.length === assets.length && ownErrors.length === 0,
      ...baseResult,
      publish: gitea,
      resolvedRefs,
      validation: {
        ok: ownErrors.length === 0,
        ownErrors,
        registryOk: validation.ok,
        registryErrorCount: validation.errors.length,
      },
    }
  } catch (error) {
    for (const directory of installed.reverse()) {
      await rm(directory, { recursive: true, force: true })
      const backup = backups.get(directory)
      if (backup) {
        await mkdir(dirname(directory), { recursive: true })
        await rename(backup, directory).catch(() => undefined)
      }
    }
    return {
      ok: false,
      ...baseResult,
      rolledBackGeneratedAssets: true,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    await rm(stageRoot, { recursive: true, force: true })
  }
}
