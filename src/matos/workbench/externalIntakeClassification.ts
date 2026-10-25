import { createHash } from 'node:crypto'
import { lstat,readFile,readdir } from 'node:fs/promises'
import { basename,extname,join,resolve } from 'node:path'

/**
 * Deterministic, file-based classification for external intake sources
 * (repo2asset / paper2asset V1).
 *
 * The classifier never calls a model. Its output shape reserves an
 * `llmAssist` block so a later LLM-assisted refinement pass can annotate or
 * re-rank proposals without changing the deterministic evidence layer.
 */

export const MATOS_EXTERNAL_INTAKE_CLASSIFIER = {
  id: 'matos-intake-file-heuristics',
  version: 1,
  deterministic: true as const,
}

export const MATOS_EXTERNAL_INTAKE_PROPOSAL_TYPES = [
  'tool',
  'knowledge',
  'workflow',
  'data',
  'skill',
  'role',
  'mcp',
  'plugin',
  'benchmark',
  'evaluation',
] as const

export type MatOSExternalIntakeProposalType =
  (typeof MATOS_EXTERNAL_INTAKE_PROPOSAL_TYPES)[number]

export type MatOSExternalIntakeSourceKind = 'repository' | 'paper' | 'document'

export type MatOSExternalIntakeClassificationIssue = {
  code: string
  severity: 'error' | 'warning'
  message: string
}

export type MatOSExternalIntakeSignal = {
  code: string
  assetType: MatOSExternalIntakeProposalType
  weight: number
  summary: string
  evidence: string[]
}

export type MatOSExternalIntakeProposal = {
  type: MatOSExternalIntakeProposalType
  id: string
  ref: string
  version: string
  primary: boolean
  score: number
  confidence: number
  reasons: string[]
  evidence: string[]
}

export type MatOSExternalIntakeScannedFile = {
  path: string
  bytes: number
}

export type MatOSExternalIntakeClassification = {
  mode: 'external-intake-classification'
  classifier: typeof MATOS_EXTERNAL_INTAKE_CLASSIFIER & {
    llmAssist: {
      enabled: false
      reason: string
    }
  }
  source: {
    path: string
    kind: MatOSExternalIntakeSourceKind
    name: string
    slug: string
    exists: boolean
    fileCount: number
    scannedFileCount: number
    truncated: boolean
    fingerprint?: string
  }
  signals: MatOSExternalIntakeSignal[]
  proposals: MatOSExternalIntakeProposal[]
  primaryType?: MatOSExternalIntakeProposalType
  files: MatOSExternalIntakeScannedFile[]
  validation: {
    ok: boolean
    issues: MatOSExternalIntakeClassificationIssue[]
  }
}

const SCAN_MAX_DEPTH = 6
const SCAN_MAX_FILES = 4000
const HASH_MAX_FILE_BYTES = 1024 * 1024
const HASH_MAX_FILES = 256
const PAPER_HASH_MAX_BYTES = 64 * 1024 * 1024
const EVIDENCE_LIMIT = 8
const PROPOSAL_MIN_SCORE = 10
const PROPOSAL_VERSION = '0.1.0'

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.idea',
  '.vscode',
  'dist',
  'build',
  'site-packages',
  '.eggs',
])

const PAPER_FILE_EXTENSIONS = new Set(['.pdf'])
const DOCUMENT_FILE_EXTENSIONS = new Set(['.md', '.markdown', '.rst', '.txt'])
const DOC_CORPUS_EXTENSIONS = new Set(['.md', '.markdown', '.rst'])
const STRUCTURE_DATA_EXTENSIONS = new Set(['.cif', '.xyz', '.extxyz', '.poscar', '.vasp'])
const TABULAR_DATA_EXTENSIONS = new Set(['.csv', '.tsv', '.parquet', '.h5', '.hdf5', '.npz', '.npy', '.jsonl'])
const WORKFLOW_FILE_NAMES = new Set(['snakefile', 'nextflow.config'])
const WORKFLOW_EXTENSIONS = new Set(['.cwl', '.smk'])

// Deterministic tie-break order when scores are equal.
const TYPE_PRIORITY: MatOSExternalIntakeProposalType[] = [
  'tool',
  'mcp',
  'plugin',
  'workflow',
  'data',
  'benchmark',
  'evaluation',
  'knowledge',
  'skill',
  'role',
]

export function slugifyMatOSExternalIntakeName(value: string, fallback = 'external-source'): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || fallback
}

function sha256Hex(payload: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`
}

async function statKind(path: string): Promise<'file' | 'directory' | 'other' | 'missing'> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      return 'other'
    }
    if (info.isDirectory()) {
      return 'directory'
    }
    if (info.isFile()) {
      return 'file'
    }
    return 'other'
  } catch {
    return 'missing'
  }
}

type ScanResult = {
  files: MatOSExternalIntakeScannedFile[]
  truncated: boolean
}

async function scanSourceTree(root: string): Promise<ScanResult> {
  const files: MatOSExternalIntakeScannedFile[] = []
  let truncated = false

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (truncated || depth > SCAN_MAX_DEPTH) {
      if (depth > SCAN_MAX_DEPTH) {
        truncated = true
      }
      return
    }
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) {
        return
      }
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) {
        continue
      }
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.endsWith('.egg-info')) {
          continue
        }
        await walk(join(dir, entry.name), relPath, depth + 1)
        continue
      }
      if (!entry.isFile()) {
        continue
      }
      if (files.length >= SCAN_MAX_FILES) {
        truncated = true
        return
      }
      let bytes = 0
      try {
        bytes = (await lstat(join(dir, entry.name))).size
      } catch {
        continue
      }
      files.push({ path: relPath, bytes })
    }
  }

  await walk(root, '', 0)
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files, truncated }
}

async function readSmallText(path: string, maxBytes = 256 * 1024): Promise<string | undefined> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > maxBytes) {
      return undefined
    }
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Deterministic combined fingerprint over the scanned file list. Small files
 * contribute content hashes; large files contribute path+size only.
 */
export async function fingerprintMatOSExternalIntakeSource(input: {
  rootPath: string
  files: MatOSExternalIntakeScannedFile[]
}): Promise<{ fingerprint: string; hashedFiles: Array<{ path: string; bytes: number; sha256?: string }> }> {
  const hashedFiles: Array<{ path: string; bytes: number; sha256?: string }> = []
  let hashedCount = 0
  for (const file of input.files) {
    if (hashedCount < HASH_MAX_FILES && file.bytes <= HASH_MAX_FILE_BYTES) {
      try {
        const payload = await readFile(join(input.rootPath, file.path))
        hashedFiles.push({ path: file.path, bytes: file.bytes, sha256: sha256Hex(payload) })
        hashedCount += 1
        continue
      } catch {
        // fall through to size-only record
      }
    }
    hashedFiles.push({ path: file.path, bytes: file.bytes })
  }
  const fingerprint = sha256Hex(JSON.stringify(hashedFiles))
  return { fingerprint, hashedFiles }
}

function fileName(path: string): string {
  return basename(path).toLowerCase()
}

function fileExt(path: string): string {
  return extname(path).toLowerCase()
}

function isInsideGithubDir(path: string): boolean {
  return path === '.github' || path.startsWith('.github/')
}

function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|testing)(\/|$)/.test(path)
}

function evidenceList(paths: string[]): string[] {
  return [...paths].sort((a, b) => a.localeCompare(b)).slice(0, EVIDENCE_LIMIT)
}

type SignalDraft = {
  code: string
  assetType: MatOSExternalIntakeProposalType
  weight: number
  summary: string
  evidence: string[]
}

async function repositorySignals(
  rootPath: string,
  files: MatOSExternalIntakeScannedFile[],
): Promise<SignalDraft[]> {
  const signals: SignalDraft[] = []
  const paths = files.map(file => file.path)
  const byName = (name: string) => paths.filter(path => fileName(path) === name)
  const add = (signal: SignalDraft) => {
    if (signal.evidence.length > 0) {
      signals.push({ ...signal, evidence: evidenceList(signal.evidence) })
    }
  }

  // --- tool signals -------------------------------------------------------
  const pythonManifests = paths.filter(path =>
    ['pyproject.toml', 'setup.py', 'setup.cfg'].includes(fileName(path)) && !path.includes('/'),
  )
  add({
    code: 'python-package-manifest',
    assetType: 'tool',
    weight: 30,
    summary: 'Top-level Python packaging manifest indicates an installable tool/library.',
    evidence: pythonManifests,
  })
  const pyprojectPath = pythonManifests.find(path => fileName(path) === 'pyproject.toml')
  if (pyprojectPath) {
    const pyproject = await readSmallText(join(rootPath, pyprojectPath))
    if (pyproject && (/\[project\.scripts\]/.test(pyproject) || /console_scripts/.test(pyproject))) {
      add({
        code: 'python-cli-entrypoints',
        assetType: 'tool',
        weight: 25,
        summary: 'Declared console/script entry points indicate a runnable CLI tool.',
        evidence: [pyprojectPath],
      })
    }
  }
  add({
    code: 'compiled-build-system',
    assetType: 'tool',
    weight: 20,
    summary: 'Native build system files indicate a buildable tool or library.',
    evidence: paths.filter(path =>
      ['cmakelists.txt', 'makefile', 'configure.ac', 'meson.build'].includes(fileName(path)) &&
      !path.includes('/'),
    ),
  })
  add({
    code: 'rust-or-go-package',
    assetType: 'tool',
    weight: 25,
    summary: 'Rust/Go module manifests indicate an installable tool.',
    evidence: paths.filter(path => ['cargo.toml', 'go.mod'].includes(fileName(path)) && !path.includes('/')),
  })
  const rootPackageJsonPath = byName('package.json').find(path => !path.includes('/'))
  if (rootPackageJsonPath) {
    const raw = await readSmallText(join(rootPath, rootPackageJsonPath))
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
    } catch {
      parsed = undefined
    }
    if (parsed) {
      add({
        code: 'node-package-manifest',
        assetType: 'tool',
        weight: parsed.bin ? 30 : 15,
        summary: parsed.bin
          ? 'Node package declares executable bin entries.'
          : 'Node package manifest present.',
        evidence: [rootPackageJsonPath],
      })
      const dependencyNames = [
        ...Object.keys((parsed.dependencies as Record<string, unknown> | undefined) ?? {}),
        ...Object.keys((parsed.devDependencies as Record<string, unknown> | undefined) ?? {}),
      ]
      if (dependencyNames.some(name => name.startsWith('@modelcontextprotocol/'))) {
        add({
          code: 'mcp-sdk-dependency',
          assetType: 'mcp',
          weight: 40,
          summary: 'Model Context Protocol SDK dependency indicates an MCP server.',
          evidence: [rootPackageJsonPath],
        })
      }
    }
  }
  add({
    code: 'executable-script-dir',
    assetType: 'tool',
    weight: 10,
    summary: 'bin/ or scripts/ directory contains runnable scripts.',
    evidence: paths.filter(path => /^(bin|scripts)\//.test(path) && !isTestPath(path)),
  })

  // --- mcp signals --------------------------------------------------------
  const mcpConfigCandidates = paths.filter(path =>
    ['mcp.json', '.mcp.json', 'mcp-config.json', 'mcp.config.json'].includes(fileName(path)),
  )
  const mcpConfigs: string[] = []
  for (const candidate of mcpConfigCandidates) {
    mcpConfigs.push(candidate)
  }
  for (const candidate of paths.filter(
    path => !path.includes('/') && fileExt(path) === '.json' && !mcpConfigCandidates.includes(path),
  )) {
    const raw = await readSmallText(join(rootPath, candidate), 64 * 1024)
    if (raw && raw.includes('"mcpServers"')) {
      mcpConfigs.push(candidate)
    }
  }
  add({
    code: 'mcp-server-config',
    assetType: 'mcp',
    weight: 45,
    summary: 'MCP server configuration file found.',
    evidence: mcpConfigs,
  })

  // --- plugin signals -----------------------------------------------------
  add({
    code: 'claude-plugin-manifest',
    assetType: 'plugin',
    weight: 50,
    summary: 'Claude plugin manifest (.claude-plugin/plugin.json) found.',
    evidence: paths.filter(path => /(^|\/)\.claude-plugin\/plugin\.json$/.test(path)),
  })

  // --- skill signals (explicit only; repositories are not flattened) ------
  add({
    code: 'skill-instruction-file',
    assetType: 'skill',
    weight: 35,
    summary: 'Explicit SKILL.md instruction files found.',
    evidence: paths.filter(path => basename(path) === 'SKILL.md'),
  })

  // --- role signals -------------------------------------------------------
  add({
    code: 'legacy-roles-manifest',
    assetType: 'role',
    weight: 35,
    summary: 'Legacy roles.json role definitions found.',
    evidence: byName('roles.json').filter(path => !path.includes('/')),
  })

  // --- knowledge signals --------------------------------------------------
  const readmeFiles = paths.filter(path => !path.includes('/') && /^readme\.(md|rst|txt)$/.test(fileName(path)))
  add({
    code: 'readme-overview',
    assetType: 'knowledge',
    weight: 12,
    summary: 'Top-level README provides reference documentation.',
    evidence: readmeFiles,
  })
  const docFiles = paths.filter(path =>
    !isInsideGithubDir(path) &&
    DOC_CORPUS_EXTENSIONS.has(fileExt(path)) &&
    !readmeFiles.includes(path) &&
    basename(path) !== 'SKILL.md',
  )
  add({
    code: 'markdown-doc-corpus',
    assetType: 'knowledge',
    weight: Math.min(30, docFiles.length * 4),
    summary: `${docFiles.length} markdown/rst documentation file(s) form a knowledge corpus.`,
    evidence: docFiles,
  })
  const pdfFiles = paths.filter(path => PAPER_FILE_EXTENSIONS.has(fileExt(path)))
  add({
    code: 'paper-pdf-documents',
    assetType: 'knowledge',
    weight: Math.min(30, pdfFiles.length * 15),
    summary: `${pdfFiles.length} PDF document(s) found.`,
    evidence: pdfFiles,
  })
  add({
    code: 'notebook-examples',
    assetType: 'knowledge',
    weight: 6,
    summary: 'Jupyter notebooks provide worked examples.',
    evidence: paths.filter(path => fileExt(path) === '.ipynb'),
  })

  // --- data signals -------------------------------------------------------
  const structureFiles = paths.filter(
    path => STRUCTURE_DATA_EXTENSIONS.has(fileExt(path)) || /^(poscar|contcar)/.test(fileName(path)),
  )
  add({
    code: 'structure-data-files',
    assetType: 'data',
    weight: Math.min(40, 10 + structureFiles.length * 3),
    summary: `${structureFiles.length} atomistic structure file(s) (.cif/.xyz/POSCAR...).`,
    evidence: structureFiles,
  })
  const tabularFiles = paths.filter(
    path => TABULAR_DATA_EXTENSIONS.has(fileExt(path)) && !isInsideGithubDir(path),
  )
  add({
    code: 'tabular-data-files',
    assetType: 'data',
    weight: Math.min(30, 5 + tabularFiles.length * 3),
    summary: `${tabularFiles.length} tabular/array data file(s) (.csv/.parquet/.h5...).`,
    evidence: tabularFiles,
  })

  // --- workflow signals (CI configs under .github are excluded) -----------
  const workflowFiles = paths.filter(path => {
    if (isInsideGithubDir(path) || isTestPath(path)) {
      return false
    }
    const name = fileName(path)
    if (WORKFLOW_FILE_NAMES.has(name) || WORKFLOW_EXTENSIONS.has(fileExt(path))) {
      return true
    }
    if ((fileExt(path) === '.yaml' || fileExt(path) === '.yml') &&
      (/^workflows?\//.test(path) || /workflow/.test(name))) {
      return true
    }
    return false
  })
  add({
    code: 'workflow-definitions',
    assetType: 'workflow',
    weight: Math.min(40, 20 + workflowFiles.length * 5),
    summary: `${workflowFiles.length} workflow/pipeline definition file(s).`,
    evidence: workflowFiles,
  })

  // --- benchmark / evaluation signals --------------------------------------
  const benchmarkFiles = paths.filter(
    path => /(^|\/)benchmarks?(\/|$)/.test(path.toLowerCase()) || /^benchmark/.test(fileName(path)),
  )
  add({
    code: 'benchmark-suite-files',
    assetType: 'benchmark',
    weight: Math.min(35, 15 + benchmarkFiles.length * 3),
    summary: `${benchmarkFiles.length} benchmark file(s) or benchmark directory entries.`,
    evidence: benchmarkFiles,
  })
  const evaluationFiles = paths.filter(
    path => /(^|\/)evals?(\/|$)|(^|\/)evaluations?(\/|$)/.test(path.toLowerCase()) ||
      /^eval(uate|uation)?[._-]/.test(fileName(path)),
  )
  add({
    code: 'evaluation-harness-files',
    assetType: 'evaluation',
    weight: Math.min(30, 12 + evaluationFiles.length * 3),
    summary: `${evaluationFiles.length} evaluation harness file(s) or directories.`,
    evidence: evaluationFiles,
  })

  return signals
}

function paperSignals(path: string, kind: MatOSExternalIntakeSourceKind): SignalDraft[] {
  const name = basename(path)
  return [
    {
      code: kind === 'paper' ? 'paper-pdf-document' : 'paper-text-document',
      assetType: 'knowledge',
      weight: 100,
      summary:
        kind === 'paper'
          ? 'Source is a single PDF paper/document; papers become knowledge assets.'
          : 'Source is a single markdown/text document; documents become knowledge assets.',
      evidence: [name],
    },
  ]
}

function buildProposals(input: {
  slug: string
  signals: MatOSExternalIntakeSignal[]
}): MatOSExternalIntakeProposal[] {
  const totals = new Map<MatOSExternalIntakeProposalType, number>()
  for (const signal of input.signals) {
    totals.set(signal.assetType, (totals.get(signal.assetType) ?? 0) + signal.weight)
  }
  const totalWeight = [...totals.values()].reduce((sum, value) => sum + value, 0)
  if (totalWeight === 0) {
    return []
  }
  const ranked = [...totals.entries()]
    .filter(([, score]) => score > 0)
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1]
      }
      return TYPE_PRIORITY.indexOf(a[0]) - TYPE_PRIORITY.indexOf(b[0])
    })
  return ranked
    .filter(([, score], index) => index === 0 || score >= PROPOSAL_MIN_SCORE)
    .map(([type, score], index) => {
      const typeSignals = input.signals.filter(signal => signal.assetType === type)
      return {
        type,
        id: input.slug,
        ref: `${type}:${input.slug}@${PROPOSAL_VERSION}`,
        version: PROPOSAL_VERSION,
        primary: index === 0,
        score,
        confidence: Math.round((score / totalWeight) * 1000) / 1000,
        reasons: typeSignals.map(signal => signal.code),
        evidence: evidenceList(typeSignals.flatMap(signal => signal.evidence)),
      }
    })
}

export async function classifyMatOSExternalIntakeSource(input: {
  cwd: string
  path: string
}): Promise<MatOSExternalIntakeClassification> {
  const resolvedPath = resolve(input.cwd, input.path)
  const kindOnDisk = await statKind(resolvedPath)
  const issues: MatOSExternalIntakeClassificationIssue[] = []
  const name = basename(resolvedPath)
  const slug = slugifyMatOSExternalIntakeName(name)

  const base = {
    mode: 'external-intake-classification' as const,
    classifier: {
      ...MATOS_EXTERNAL_INTAKE_CLASSIFIER,
      llmAssist: {
        enabled: false as const,
        reason:
          'V1 classification is deterministic and file-based; an LLM-assisted refinement pass may later annotate or re-rank these proposals.',
      },
    },
  }

  if (kindOnDisk === 'missing' || kindOnDisk === 'other') {
    issues.push({
      code: kindOnDisk === 'missing' ? 'source_missing' : 'source_unsupported',
      severity: 'error',
      message:
        kindOnDisk === 'missing'
          ? `External intake source does not exist: ${input.path}`
          : `External intake source must be a regular file or directory: ${input.path}`,
    })
    return {
      ...base,
      source: {
        path: resolvedPath,
        kind: 'repository',
        name,
        slug,
        exists: false,
        fileCount: 0,
        scannedFileCount: 0,
        truncated: false,
      },
      signals: [],
      proposals: [],
      files: [],
      validation: { ok: false, issues },
    }
  }

  if (kindOnDisk === 'file') {
    const ext = fileExt(resolvedPath)
    const kind: MatOSExternalIntakeSourceKind = PAPER_FILE_EXTENSIONS.has(ext)
      ? 'paper'
      : 'document'
    if (!PAPER_FILE_EXTENSIONS.has(ext) && !DOCUMENT_FILE_EXTENSIONS.has(ext)) {
      issues.push({
        code: 'unsupported_paper_format',
        severity: 'error',
        message: `Paper/document intake supports PDF, markdown, rst, and txt files; got "${ext || 'no extension'}".`,
      })
      return {
        ...base,
        source: {
          path: resolvedPath,
          kind,
          name,
          slug,
          exists: true,
          fileCount: 1,
          scannedFileCount: 1,
          truncated: false,
        },
        signals: [],
        proposals: [],
        files: [],
        validation: { ok: false, issues },
      }
    }
    const info = await lstat(resolvedPath)
    let fingerprint: string | undefined
    if (info.size <= PAPER_HASH_MAX_BYTES) {
      fingerprint = sha256Hex(await readFile(resolvedPath))
    } else {
      issues.push({
        code: 'paper_hash_skipped',
        severity: 'warning',
        message: `Paper file is larger than ${PAPER_HASH_MAX_BYTES} bytes; provenance records size only.`,
      })
    }
    const signals = paperSignals(resolvedPath, kind)
    const proposals = buildProposals({ slug, signals })
    return {
      ...base,
      source: {
        path: resolvedPath,
        kind,
        name,
        slug,
        exists: true,
        fileCount: 1,
        scannedFileCount: 1,
        truncated: false,
        ...(fingerprint ? { fingerprint } : {}),
      },
      signals,
      proposals,
      primaryType: proposals[0]?.type,
      files: [{ path: name, bytes: info.size }],
      validation: { ok: issues.every(issue => issue.severity !== 'error'), issues },
    }
  }

  const scan = await scanSourceTree(resolvedPath)
  if (scan.truncated) {
    issues.push({
      code: 'scan_truncated',
      severity: 'warning',
      message: `Source tree scan stopped at ${SCAN_MAX_FILES} files / depth ${SCAN_MAX_DEPTH}; classification used the scanned subset.`,
    })
  }
  if (scan.files.length === 0) {
    issues.push({
      code: 'source_empty',
      severity: 'error',
      message: 'External intake source directory contains no classifiable files.',
    })
    return {
      ...base,
      source: {
        path: resolvedPath,
        kind: 'repository',
        name,
        slug,
        exists: true,
        fileCount: 0,
        scannedFileCount: 0,
        truncated: scan.truncated,
      },
      signals: [],
      proposals: [],
      files: [],
      validation: { ok: false, issues },
    }
  }

  const signals = (await repositorySignals(resolvedPath, scan.files)).sort((a, b) => {
    if (b.weight !== a.weight) {
      return b.weight - a.weight
    }
    return a.code.localeCompare(b.code)
  })
  let proposals = buildProposals({ slug, signals })
  if (proposals.length === 0) {
    issues.push({
      code: 'unclassified_source',
      severity: 'warning',
      message:
        'No deterministic classification signals matched; defaulting to a knowledge reference asset.',
    })
    proposals = [
      {
        type: 'knowledge',
        id: slug,
        ref: `knowledge:${slug}@${PROPOSAL_VERSION}`,
        version: PROPOSAL_VERSION,
        primary: true,
        score: 0,
        confidence: 0,
        reasons: ['fallback-unclassified'],
        evidence: evidenceList(scan.files.map(file => file.path)),
      },
    ]
  }

  return {
    ...base,
    source: {
      path: resolvedPath,
      kind: 'repository',
      name,
      slug,
      exists: true,
      fileCount: scan.files.length,
      scannedFileCount: scan.files.length,
      truncated: scan.truncated,
    },
    signals,
    proposals,
    primaryType: proposals[0]?.type,
    files: scan.files,
    validation: { ok: issues.every(issue => issue.severity !== 'error'), issues },
  }
}
