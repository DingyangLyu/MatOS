import { readFile } from 'node:fs/promises'
import { join,relative,resolve } from 'node:path'
import { normalizeMatOSToolName } from '../tools/toolNames.js'
import type {
MatOSExternalIntakeClassification,
MatOSExternalIntakeProposal,
MatOSExternalIntakeProposalType,
} from './externalIntakeClassification.js'
import type { MatOSExternalIntakeLlmAssist } from './externalIntakeLlmAssist.js'
import type {
MatOSExternalIntakePaperExtraction,
MatOSExternalIntakePaperSummary,
} from './externalIntakePaperExtract.js'

/**
 * repo2asset / paper2asset executable entry planning.
 *
 * The reference draft pack only registers sources (REFERENCE.md pointers).
 * Executable mode upgrades the generated pack into assets agents can actually
 * load and run:
 *
 * - tool      -> generated `tool.py` wrapper over a detected source
 *                entrypoint, executable through the existing MatOS tool
 *                runner (`metadata.executor`), with preflight + dry-run.
 * - knowledge -> KNOWLEDGE.md with real extracted content (README digest or
 *                parsed paper summary/abstract/citation), still
 *                fingerprint-referenced to the source.
 * - skill     -> SKILL.md procedure guide (repo usage or paper protocol).
 * - workflow  -> minimal runnable workflow.yaml (preflight -> run) over the
 *                detected entrypoint.
 * - benchmark -> pack-integrity artifact-check and tool dry-run smoke cases
 *                written as real benchmark assets.
 *
 * Planning is deterministic given its inputs. LLM assist and paper summaries
 * are optional inputs computed by the caller (both cached), and every planned
 * file is rendered purely from the plan so preview and apply stay consistent
 * under the confirmation fingerprint.
 */

export const MATOS_EXTERNAL_INTAKE_EXECUTABLE_PLANNER = {
  id: 'matos-intake-executable-entries',
  version: 1,
}

const ASSET_VERSION = '0.1.0'
const REFERENCE_FILE = 'REFERENCE.md'
const TOOL_TIMEOUT_MS = 120_000
const ARG_PATTERN = '^[A-Za-z0-9@%+=:,./_-]+$'
const SAFE_ENTRY_RUNTIMES: Record<string, string> = {
  '.py': 'python3',
  '.sh': 'bash',
  '.js': 'node',
  '.mjs': 'node',
}
const ROOT_ENTRY_NAMES = ['main.py', 'cli.py', 'run.py', 'app.py', '__main__.py']
const README_DIGEST_MAX_CHARS = 1_200
const DOC_LIST_LIMIT = 12

export type MatOSExternalIntakeToolWrapperPlan = {
  sourceEntry: string
  runtime: string
  origin: 'llm-assist' | 'deterministic'
  description?: string
}

export type MatOSExternalIntakeExecutablePlannedAsset = {
  type: MatOSExternalIntakeProposalType
  id: string
  ref: string
  version: string
  primary: boolean
  score: number
  confidence: number
  manifestRelativePath: string
  entryRelativePath: string
  role:
    | 'classified'
    | 'derived-skill-protocol'
    | 'derived-benchmark-integrity'
    | 'derived-benchmark-tool-smoke'
  entryFile: string
  files: string[]
  executable: boolean
}

export type MatOSExternalIntakeExecutablePlan = {
  mode: 'executable'
  planner: typeof MATOS_EXTERNAL_INTAKE_EXECUTABLE_PLANNER
  proposedAssets: MatOSExternalIntakeExecutablePlannedAsset[]
  toolWrapper?: MatOSExternalIntakeToolWrapperPlan
  readmeDigest?: string
  paper?: {
    extraction: MatOSExternalIntakePaperExtraction
    summary?: MatOSExternalIntakePaperSummary
  }
  llmAssist?: MatOSExternalIntakeLlmAssist
  notes: string[]
}

function fileExt(path: string): string {
  const index = path.lastIndexOf('.')
  return index >= 0 ? path.slice(index).toLowerCase() : ''
}

function isSafeSourceRelPath(path: string): boolean {
  return (
    !!path &&
    !path.startsWith('/') &&
    !path.split('/').some(part => part === '..' || part === '') &&
    !/[\s;|&$<>`'"\\]/.test(path)
  )
}

/**
 * Picks the runnable entrypoint for a repository source. LLM-assist
 * entrypoints are used only when they name a real scanned file with a safe
 * extension; otherwise deterministic filename heuristics apply.
 */
export function chooseMatOSExternalIntakeToolEntrypoint(input: {
  classification: MatOSExternalIntakeClassification
  llmAssist?: MatOSExternalIntakeLlmAssist
}): MatOSExternalIntakeToolWrapperPlan | undefined {
  const files = new Set(input.classification.files.map(file => file.path))

  if (input.llmAssist?.enabled) {
    for (const entrypoint of input.llmAssist.entrypoints) {
      const path = entrypoint.path.replace(/^\.\//, '')
      const runtime = SAFE_ENTRY_RUNTIMES[fileExt(path)]
      if (runtime && files.has(path) && isSafeSourceRelPath(path)) {
        return {
          sourceEntry: path,
          runtime,
          origin: 'llm-assist',
          ...(entrypoint.description
            ? { description: entrypoint.description }
            : {}),
        }
      }
    }
  }

  const candidates: string[] = []
  for (const name of ROOT_ENTRY_NAMES) {
    if (files.has(name)) {
      candidates.push(name)
    }
  }
  const binScripts = [...files]
    .filter(path => /^(bin|scripts)\//.test(path))
    .filter(path => SAFE_ENTRY_RUNTIMES[fileExt(path)])
    .sort()
  candidates.push(...binScripts)
  const rootScripts = [...files]
    .filter(path => !path.includes('/') && SAFE_ENTRY_RUNTIMES[fileExt(path)])
    .sort()
  if (rootScripts.length === 1) {
    candidates.push(rootScripts[0])
  }
  for (const candidate of candidates) {
    if (isSafeSourceRelPath(candidate)) {
      const runtime = SAFE_ENTRY_RUNTIMES[fileExt(candidate)]
      if (runtime) {
        return { sourceEntry: candidate, runtime, origin: 'deterministic' }
      }
    }
  }
  return undefined
}

async function readmeDigestFor(
  classification: MatOSExternalIntakeClassification,
): Promise<string | undefined> {
  if (classification.source.kind !== 'repository') {
    return undefined
  }
  const readme = classification.files.find(
    file => !file.path.includes('/') && /^readme\.(md|rst|txt)$/i.test(file.path),
  )
  if (!readme || readme.bytes > 512 * 1024) {
    return undefined
  }
  try {
    const raw = await readFile(
      join(classification.source.path, readme.path),
      'utf8',
    )
    const digest = raw.replace(/\r\n/g, '\n').trim().slice(0, README_DIGEST_MAX_CHARS)
    return digest || undefined
  } catch {
    return undefined
  }
}

function slugAssetId(base: string, suffix: string): string {
  const slug = `${base}-${suffix}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug.slice(0, 64).replace(/-+$/, '')
}

function entryFileFor(input: {
  type: MatOSExternalIntakeProposalType
  executableTool: boolean
}): { entryFile: string; files: string[]; executable: boolean } {
  if (input.type === 'tool' && input.executableTool) {
    return {
      entryFile: './tool.py',
      files: ['tool.py', 'input.schema.json', 'prompt.md', REFERENCE_FILE],
      executable: true,
    }
  }
  if (input.type === 'knowledge') {
    return {
      entryFile: 'KNOWLEDGE.md',
      files: ['KNOWLEDGE.md', REFERENCE_FILE],
      executable: false,
    }
  }
  if (input.type === 'skill') {
    return {
      entryFile: 'SKILL.md',
      files: ['SKILL.md', REFERENCE_FILE],
      executable: false,
    }
  }
  if (input.type === 'workflow' && input.executableTool) {
    return {
      entryFile: 'workflow.yaml',
      files: ['workflow.yaml', REFERENCE_FILE],
      executable: true,
    }
  }
  return {
    entryFile: REFERENCE_FILE,
    files: [REFERENCE_FILE],
    executable: false,
  }
}

export async function planMatOSExternalIntakeExecutableAssets(input: {
  classification: MatOSExternalIntakeClassification
  targetPackRelativePath: string
  llmAssist?: MatOSExternalIntakeLlmAssist
  paperExtraction?: MatOSExternalIntakePaperExtraction
  paperSummary?: MatOSExternalIntakePaperSummary
  withBenchmark?: boolean
}): Promise<MatOSExternalIntakeExecutablePlan> {
  const { classification } = input
  const notes: string[] = []
  const toolProposed = classification.proposals.some(
    proposal => proposal.type === 'tool',
  )
  const toolWrapper = toolProposed
    ? chooseMatOSExternalIntakeToolEntrypoint({
        classification,
        ...(input.llmAssist ? { llmAssist: input.llmAssist } : {}),
      })
    : undefined
  if (toolProposed && !toolWrapper) {
    notes.push(
      'No safe runnable entrypoint was detected; the tool asset stays a reference draft. Re-run with --llm-assist or add a root main.py/cli.py/run.py/app.py, bin/ or scripts/ script.',
    )
  }
  const readmeDigest = await readmeDigestFor(classification)

  const planned: MatOSExternalIntakeExecutablePlannedAsset[] = []
  const plannedFor = (
    proposal: MatOSExternalIntakeProposal,
  ): MatOSExternalIntakeExecutablePlannedAsset => {
    const entry = entryFileFor({
      type: proposal.type,
      executableTool: Boolean(toolWrapper),
    })
    const assetDir = `${input.targetPackRelativePath}/${proposal.type}/${proposal.id}`
    return {
      type: proposal.type,
      id: proposal.id,
      ref: proposal.ref,
      version: proposal.version,
      primary: proposal.primary,
      score: proposal.score,
      confidence: proposal.confidence,
      manifestRelativePath: `${assetDir}/asset.json`,
      entryRelativePath: `${assetDir}/${entry.entryFile.replace(/^\.\//, '')}`,
      role: 'classified',
      entryFile: entry.entryFile,
      files: entry.files,
      executable: entry.executable,
    }
  }
  for (const proposal of classification.proposals) {
    planned.push(plannedFor(proposal))
  }

  const slug = classification.source.slug
  const usedRefs = new Set(planned.map(item => item.ref))
  const derived = (
    type: MatOSExternalIntakeProposalType,
    id: string,
    role: MatOSExternalIntakeExecutablePlannedAsset['role'],
    entryFile: string,
    files: string[],
  ): MatOSExternalIntakeExecutablePlannedAsset | undefined => {
    const ref = `${type}:${id}@${ASSET_VERSION}`
    if (usedRefs.has(ref)) {
      return undefined
    }
    usedRefs.add(ref)
    const assetDir = `${input.targetPackRelativePath}/${type}/${id}`
    return {
      type,
      id,
      ref,
      version: ASSET_VERSION,
      primary: false,
      score: 0,
      confidence: 0,
      manifestRelativePath: `${assetDir}/asset.json`,
      entryRelativePath: `${assetDir}/${entryFile.replace(/^\.\//, '')}`,
      role,
      entryFile,
      files,
      executable: false,
    }
  }

  // Paper protocol skill: only when the summary extracted a real procedure.
  if (
    input.paperSummary?.enabled &&
    input.paperSummary.protocolSteps.length >= 2
  ) {
    const skill = derived(
      'skill',
      slugAssetId(slug, 'protocol'),
      'derived-skill-protocol',
      'SKILL.md',
      ['SKILL.md'],
    )
    if (skill) {
      planned.push(skill)
      notes.push(
        'Paper summary extracted a repeatable procedure; drafted a protocol skill asset.',
      )
    }
  }

  if (input.withBenchmark) {
    const integrity = derived(
      'benchmark',
      slugAssetId(slug, 'pack-integrity'),
      'derived-benchmark-integrity',
      'case.json',
      ['case.json'],
    )
    if (integrity) {
      planned.push(integrity)
    }
    if (toolWrapper) {
      const smoke = derived(
        'benchmark',
        slugAssetId(slug, 'tool-smoke'),
        'derived-benchmark-tool-smoke',
        'case.json',
        ['case.json'],
      )
      if (smoke) {
        planned.push(smoke)
        notes.push(
          'Tool dry-run smoke benchmark drafted; run it with MATOS_RUN_REAL_BENCHMARKS=1 after review.',
        )
      }
    }
  }

  if (input.paperExtraction && !input.paperExtraction.ok) {
    notes.push(
      `Paper text extraction unavailable (${input.paperExtraction.reason ?? 'unknown reason'}); knowledge entry falls back to reference metadata.`,
    )
  }
  if (input.paperSummary && input.paperSummary.enabled === false) {
    notes.push(`Paper LLM summary unavailable (${input.paperSummary.reason}).`)
  }

  return {
    mode: 'executable',
    planner: MATOS_EXTERNAL_INTAKE_EXECUTABLE_PLANNER,
    proposedAssets: planned,
    ...(toolWrapper ? { toolWrapper } : {}),
    ...(readmeDigest ? { readmeDigest } : {}),
    ...(input.paperExtraction
      ? {
          paper: {
            extraction: input.paperExtraction,
            ...(input.paperSummary ? { summary: input.paperSummary } : {}),
          },
        }
      : {}),
    ...(input.llmAssist ? { llmAssist: input.llmAssist } : {}),
    notes,
  }
}

// ---------------------------------------------------------------------------
// Rendering (pure functions of the plan; used by draft-pack apply)
// ---------------------------------------------------------------------------

export type MatOSExternalIntakeRenderContext = {
  cwd: string
  classification: MatOSExternalIntakeClassification
  plan: MatOSExternalIntakeExecutablePlan
  intake: {
    intakeId: string
    intakeRef: string
    sourcePath: string
    sourceKind: string
    fingerprint?: string
    fileCount: number
    scannedFileCount: number
    truncated: boolean
  }
  now: string
}

function sourceReferenceLines(context: MatOSExternalIntakeRenderContext): string[] {
  const { intake, classification } = context
  return [
    '## Source reference',
    '',
    `- Source path: ${intake.sourcePath}`,
    `- Source kind: ${intake.sourceKind}`,
    ...(intake.fingerprint ? [`- Source fingerprint: ${intake.fingerprint}`] : []),
    `- Files scanned: ${intake.scannedFileCount} (truncated: ${intake.truncated})`,
    `- Classifier: ${classification.classifier.id} v${classification.classifier.version} (deterministic)`,
    `- Executable planner: ${MATOS_EXTERNAL_INTAKE_EXECUTABLE_PLANNER.id} v${MATOS_EXTERNAL_INTAKE_EXECUTABLE_PLANNER.version}`,
    `- Intake ref: ${intake.intakeRef}`,
    `- Drafted at: ${context.now}`,
    '',
  ]
}

function llmAssistLines(plan: MatOSExternalIntakeExecutablePlan): string[] {
  const assist = plan.llmAssist
  if (!assist?.enabled) {
    return []
  }
  return [
    '## LLM-assisted extraction',
    '',
    `- Model: ${assist.model}`,
    `- Summary: ${assist.summary}`,
    ...(assist.license ? [`- License: ${assist.license}`] : []),
    ...(assist.dependencies.length > 0
      ? [`- Dependencies: ${assist.dependencies.join(', ')}`]
      : []),
    ...(assist.preflight.length > 0
      ? ['- Preflight checks:', ...assist.preflight.map(item => `  - ${item}`)]
      : []),
    ...(assist.exampleIo.length > 0
      ? ['- Example I/O:', ...assist.exampleIo.map(item => `  - ${item}`)]
      : []),
    '',
  ]
}

export function renderExternalIntakeKnowledgeEntry(
  context: MatOSExternalIntakeRenderContext,
): string {
  const { plan, classification } = context
  const paper = plan.paper
  const summary = paper?.summary?.enabled ? paper.summary : undefined
  const extraction = paper?.extraction.ok ? paper.extraction : undefined
  const title =
    extraction?.title ?? classification.source.name.replace(/\.[a-z0-9]+$/i, '')
  const docFiles = classification.files
    .filter(file => /\.(md|markdown|rst|txt|pdf|ipynb)$/i.test(file.path))
    .slice(0, DOC_LIST_LIMIT)
  const lines = [
    `# ${title}`,
    '',
    ...(summary
      ? [
          '## Summary',
          '',
          summary.summary,
          '',
          ...(summary.citation ? [`Citation: ${summary.citation}`, ''] : []),
          ...(summary.keyFindings.length > 0
            ? [
                '## Key findings',
                '',
                ...summary.keyFindings.map(item => `- ${item}`),
                '',
              ]
            : []),
          ...(summary.methods.length > 0
            ? ['## Methods', '', ...summary.methods.map(item => `- ${item}`), '']
            : []),
          ...(summary.reproducibility.length > 0
            ? [
                '## Reproducibility hooks',
                '',
                ...summary.reproducibility.map(item => `- ${item}`),
                '',
              ]
            : []),
        ]
      : []),
    ...(extraction?.abstract && !summary
      ? ['## Abstract (heuristic extraction)', '', extraction.abstract, '']
      : []),
    ...(extraction?.headings && extraction.headings.length > 0
      ? [
          '## Document outline',
          '',
          ...extraction.headings.map(item => `- ${item}`),
          '',
        ]
      : []),
    ...(extraction?.excerpt
      ? [
          '## Opening excerpt',
          '',
          '```text',
          extraction.excerpt,
          '```',
          '',
          `Extraction: ${extraction.method}, ${extraction.chars ?? 0}/${extraction.totalChars ?? 0} chars` +
            `${extraction.textDigest ? `, digest ${extraction.textDigest}` : ''}.`,
          '',
        ]
      : []),
    ...(plan.readmeDigest
      ? ['## README digest', '', '```text', plan.readmeDigest, '```', '']
      : []),
    ...(!summary && !extraction && !plan.readmeDigest
      ? [
          'No readable text could be extracted from this source; this knowledge asset references the source by path and fingerprint.',
          '',
        ]
      : []),
    ...(docFiles.length > 0
      ? [
          '## Referenced documents',
          '',
          ...docFiles.map(file => `- ${file.path}`),
          '',
        ]
      : []),
    ...llmAssistLines(plan),
    ...sourceReferenceLines(context),
  ]
  return `${lines.join('\n')}\n`
}

export function renderExternalIntakeSkillEntry(
  context: MatOSExternalIntakeRenderContext,
  planned: MatOSExternalIntakeExecutablePlannedAsset,
): string {
  const { plan, classification } = context
  const summary = plan.paper?.summary?.enabled ? plan.paper.summary : undefined
  if (planned.role === 'derived-skill-protocol' && summary) {
    const lines = [
      `# ${classification.source.name.replace(/\.[a-z0-9]+$/i, '')} protocol`,
      '',
      summary.summary,
      '',
      '## When to use',
      '',
      `Use this protocol when reproducing the procedure described by the source paper (${context.intake.sourcePath}).`,
      '',
      '## Steps',
      '',
      ...summary.protocolSteps.map((step, index) => `${index + 1}. ${step}`),
      '',
      ...(summary.reproducibility.length > 0
        ? [
            '## Validation hooks',
            '',
            ...summary.reproducibility.map(item => `- ${item}`),
            '',
          ]
        : []),
      ...(summary.citation ? [`Citation: ${summary.citation}`, ''] : []),
      ...sourceReferenceLines(context),
    ]
    return `${lines.join('\n')}\n`
  }
  const assist = plan.llmAssist?.enabled ? plan.llmAssist : undefined
  const skillFiles = classification.files
    .filter(file => file.path.endsWith('SKILL.md'))
    .map(file => file.path)
  const lines = [
    `# ${classification.source.name} usage skill`,
    '',
    assist?.summary ??
      `Procedural guidance for using the external ${classification.source.kind} "${classification.source.name}".`,
    '',
    '## When to use',
    '',
    `Use this skill when a task needs the capabilities of ${classification.source.name} (source at ${context.intake.sourcePath}).`,
    '',
    '## Steps',
    '',
    ...(assist && assist.entrypoints.length > 0
      ? assist.entrypoints.map(
          (entrypoint, index) =>
            `${index + 1}. ${entrypoint.description ?? `Run ${entrypoint.path}`}${
              entrypoint.command ? ` — \`${entrypoint.command}\`` : ''
            } (entry: ${entrypoint.path})`,
        )
      : [
          `1. Read the source documentation under ${context.intake.sourcePath}.`,
          ...(skillFiles.length > 0
            ? skillFiles
                .slice(0, 6)
                .map(
                  (path, index) =>
                    `${index + 2}. Follow the source skill instructions in ${path}.`,
                )
            : [
                '2. Identify the runnable entrypoints and required environment.',
                '3. Run the smallest end-to-end example before larger tasks.',
              ]),
        ]),
    '',
    ...(assist && assist.preflight.length > 0
      ? [
          '## Preflight',
          '',
          ...assist.preflight.map(item => `- ${item}`),
          '',
        ]
      : []),
    ...(assist && assist.dependencies.length > 0
      ? [
          '## Dependencies',
          '',
          ...assist.dependencies.map(item => `- ${item}`),
          '',
        ]
      : []),
    ...sourceReferenceLines(context),
  ]
  return `${lines.join('\n')}\n`
}

export function renderExternalIntakeToolWrapperScript(
  context: MatOSExternalIntakeRenderContext,
): string {
  const wrapper = context.plan.toolWrapper
  if (!wrapper) {
    throw new Error('Executable plan has no tool wrapper to render.')
  }
  const primaryTool = context.plan.proposedAssets.find(
    asset => asset.type === 'tool' && asset.role === 'classified',
  )
  if (!primaryTool) {
    throw new Error('Executable plan has no tool asset to render.')
  }
  const toolDirAbsolute = resolve(
    context.cwd,
    primaryTool.manifestRelativePath.replace(/\/asset\.json$/, ''),
  )
  const sourceDirRel = relative(
    toolDirAbsolute,
    context.classification.source.path,
  )
  return `#!/usr/bin/env python3
"""MatOS generated source-runner wrapper for ${context.intake.intakeRef}.

Runs the detected entrypoint of the external source through the MatOS asset
tool runner contract. Draft asset: review before enabling. The wrapper never
uses a shell; arguments are passed as an argv list and validated against a
conservative character allowlist.

Contract (MatOS asset tool runner):
  stdin : {"input": {"args"?: [str], "timeoutSeconds"?: int, "dryRun"?: bool}}
  stdout: one JSON object {"ok": bool, "mode": "run"|"dry-run",
          "exitCode"?: int, "stdout"?: str, "stderr"?: str,
          "command": [str], "cwd": str, "preflight": [...]}
"""
import json
import os
import re
import subprocess
import sys
from shutil import which

SOURCE_DIR = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 ${JSON.stringify(sourceDirRel)})
)
SOURCE_ENTRY = ${JSON.stringify(wrapper.sourceEntry)}
RUNTIME = ${JSON.stringify(wrapper.runtime)}
ARG_PATTERN = re.compile(${JSON.stringify(ARG_PATTERN)})
OUTPUT_CAP = 60000
DEFAULT_TIMEOUT_SECONDS = 90
MAX_TIMEOUT_SECONDS = 600


def read_input() -> dict:
    raw = sys.stdin.read() or "{}"
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    if isinstance(payload, dict) and isinstance(payload.get("input"), dict):
        return payload["input"]
    return payload if isinstance(payload, dict) else {}


def preflight() -> list:
    checks = []

    def check(key: str, ok: bool, message: str) -> None:
        checks.append({"key": key, "ok": bool(ok), "message": message})

    check("source-dir", os.path.isdir(SOURCE_DIR),
          f"source directory exists: {SOURCE_DIR}")
    entry_path = os.path.join(SOURCE_DIR, SOURCE_ENTRY)
    check("entry-file", os.path.isfile(entry_path),
          f"entrypoint exists: {entry_path}")
    check("runtime", which(RUNTIME) is not None,
          f"runtime resolvable on PATH: {RUNTIME}")
    return checks


def main() -> int:
    data = read_input()
    raw_args = data.get("args") or []
    args = []
    if isinstance(raw_args, list):
        for item in raw_args:
            text = str(item)
            if not ARG_PATTERN.match(text):
                print(json.dumps({
                    "ok": False, "mode": "run", "command": [], "cwd": SOURCE_DIR,
                    "preflight": [],
                    "error": f"argument rejected by safety allowlist: {text[:80]}",
                }, ensure_ascii=False))
                return 0
            args.append(text)
    try:
        timeout = int(data.get("timeoutSeconds") or DEFAULT_TIMEOUT_SECONDS)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT_SECONDS
    timeout = max(1, min(MAX_TIMEOUT_SECONDS, timeout))

    checks = preflight()
    ok = all(item["ok"] for item in checks)
    command = [RUNTIME, os.path.join(SOURCE_DIR, SOURCE_ENTRY), *args]
    if data.get("dryRun") is True:
        print(json.dumps({
            "ok": bool(ok), "mode": "dry-run", "command": command,
            "cwd": SOURCE_DIR, "preflight": checks,
        }, ensure_ascii=False))
        return 0
    if not ok:
        print(json.dumps({
            "ok": False, "mode": "run", "command": command,
            "cwd": SOURCE_DIR, "preflight": checks,
            "error": "preflight failed; not executing",
        }, ensure_ascii=False))
        return 0
    try:
        result = subprocess.run(
            command, cwd=SOURCE_DIR, capture_output=True, text=True,
            timeout=timeout,
        )
        print(json.dumps({
            "ok": result.returncode == 0, "mode": "run",
            "exitCode": result.returncode,
            "stdout": (result.stdout or "")[:OUTPUT_CAP],
            "stderr": (result.stderr or "")[:OUTPUT_CAP],
            "command": command, "cwd": SOURCE_DIR, "preflight": checks,
        }, ensure_ascii=False))
    except subprocess.TimeoutExpired:
        print(json.dumps({
            "ok": False, "mode": "run", "command": command, "cwd": SOURCE_DIR,
            "preflight": checks, "error": f"timed out after {timeout}s",
        }, ensure_ascii=False))
    except Exception as exc:  # noqa: BLE001 - report, never crash the agent
        print(json.dumps({
            "ok": False, "mode": "run", "command": command, "cwd": SOURCE_DIR,
            "preflight": checks, "error": str(exc)[:400],
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
`
}

export function renderExternalIntakeToolInputSchema(): string {
  return `${JSON.stringify(
    {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string', pattern: ARG_PATTERN },
          description:
            'Extra CLI arguments appended to the entry command (conservative character allowlist; no shell metacharacters).',
        },
        timeoutSeconds: {
          type: 'number',
          minimum: 1,
          maximum: 600,
          description: 'Execution timeout in seconds (default 90).',
        },
        dryRun: {
          type: 'boolean',
          description:
            'When true, only run preflight checks and echo the command without executing the source.',
        },
      },
      additionalProperties: false,
    },
    null,
    2,
  )}\n`
}

export function renderExternalIntakeToolPrompt(
  context: MatOSExternalIntakeRenderContext,
): string {
  const wrapper = context.plan.toolWrapper
  const assist = context.plan.llmAssist?.enabled ? context.plan.llmAssist : undefined
  return [
    `Runs the external source "${context.classification.source.name}" through its detected entrypoint.`,
    '',
    `- Entry: ${wrapper?.sourceEntry ?? 'unknown'} (runtime: ${wrapper?.runtime ?? 'unknown'}, detected via ${wrapper?.origin ?? 'unknown'})`,
    `- Source: ${context.intake.sourcePath}`,
    ...(wrapper?.description ? [`- Purpose: ${wrapper.description}`] : []),
    ...(assist?.summary ? [`- Source summary: ${assist.summary}`] : []),
    '',
    'Call with `{"dryRun": true}` first to verify preflight (source dir, entry file, runtime) without executing the source.',
    'Then call with `{"args": [...]}` for a real run. Output is JSON with ok/exitCode/stdout/stderr.',
    'This is a draft asset generated by repo2asset; review the source before enabling it outside draft scope.',
    '',
  ].join('\n')
}

export function renderExternalIntakeWorkflowEntry(
  context: MatOSExternalIntakeRenderContext,
): string {
  const wrapper = context.plan.toolWrapper
  if (!wrapper) {
    throw new Error('Executable plan has no tool wrapper for the workflow entry.')
  }
  const sourcePath = context.intake.sourcePath
  const isRelative = !sourcePath.startsWith('/')
  const resolveSrc = isRelative
    ? `src="\${MATOS_PROJECT_CWD:-$PWD}/${sourcePath}"`
    : `src="${sourcePath}"`
  const slug = context.classification.source.slug
  return [
    'schemaVersion: 1',
    `name: ${slug}-source-run`,
    `version: "${ASSET_VERSION}"`,
    'description: >-',
    `  Draft run workflow generated by repo2asset for the external source`,
    `  "${context.classification.source.name}". Preflight checks the source and`,
    '  interpreter, then runs the detected entrypoint. Review before enabling.',
    'nodes:',
    '  preflight:',
    '    type: exec',
    '    dependsOn: []',
    '    command: |',
    '      set -eu',
    `      ${resolveSrc}`,
    '      test -d "$src" || { echo "source dir missing: $src" >&2; exit 66; }',
    `      test -f "$src/${wrapper.sourceEntry}" || { echo "entry missing: ${wrapper.sourceEntry}" >&2; exit 66; }`,
    `      command -v ${wrapper.runtime} >/dev/null 2>&1 || { echo "${wrapper.runtime} not found" >&2; exit 127; }`,
    '      echo "preflight ok"',
    '  run:',
    '    type: exec',
    '    dependsOn:',
    '      - preflight',
    '    command: |',
    '      set -eu',
    `      ${resolveSrc}`,
    '      cd "$src"',
    `      ${wrapper.runtime} "${wrapper.sourceEntry}"`,
    'outputs:',
    '  preflight:',
    '    value: "{{ nodes.preflight.outputs.stdout }}"',
    '  runOutput:',
    '    value: "{{ nodes.run.outputs.stdout }}"',
    '',
  ].join('\n')
}

export function renderExternalIntakeBenchmarkCase(
  context: MatOSExternalIntakeRenderContext,
  planned: MatOSExternalIntakeExecutablePlannedAsset,
): string {
  const primary =
    context.plan.proposedAssets.find(asset => asset.primary) ??
    context.plan.proposedAssets[0]
  if (planned.role === 'derived-benchmark-tool-smoke') {
    const tool = context.plan.proposedAssets.find(
      asset => asset.type === 'tool' && asset.role === 'classified',
    )
    const benchmarkCase = {
      schemaVersion: 2,
      id: planned.id,
      kind: 'tool-call',
      subjectRefs: tool ? [tool.ref] : [],
      task: { toolRef: tool?.ref ?? '', input: { dryRun: true } },
      checks: [
        { type: 'stdout-contains', value: '"ok": true' },
        { type: 'stdout-contains', value: '"mode": "dry-run"' },
        { type: 'secret-scan', allow: false },
      ],
      costRisk: 'cheap',
      approvalPolicy: 'bypass-safe',
      timeoutMs: 60_000,
      description:
        `Dry-run smoke over the generated ${context.classification.source.name} tool wrapper: preflight must pass without executing the source.`,
      provenance: {
        intakeRef: context.intake.intakeRef,
        ...(context.intake.fingerprint
          ? { sourceFingerprint: context.intake.fingerprint }
          : {}),
      },
    }
    return `${JSON.stringify(benchmarkCase, null, 2)}\n`
  }
  const benchmarkCase = {
    schemaVersion: 1,
    id: planned.id,
    kind: 'artifact-check',
    subjectRefs: context.plan.proposedAssets
      .filter(asset => asset.role === 'classified')
      .map(asset => asset.ref),
    costRisk: 'free',
    approvalPolicy: 'bypass-safe',
    timeoutMs: 30_000,
    description:
      `Verify the intake-generated pack persisted the primary ${primary?.type ?? 'asset'} manifest and intake provenance.`,
    task: { input: { path: primary?.manifestRelativePath ?? '' } },
    checks: [
      { type: 'stdout-contains', value: primary?.id ?? '' },
      ...(context.intake.fingerprint
        ? [{ type: 'stdout-contains', value: context.intake.fingerprint }]
        : []),
    ],
    provenance: {
      intakeRef: context.intake.intakeRef,
      ...(context.intake.fingerprint
        ? { sourceFingerprint: context.intake.fingerprint }
        : {}),
    },
  }
  return `${JSON.stringify(benchmarkCase, null, 2)}\n`
}

export function externalIntakeExecutableManifestExtras(
  context: MatOSExternalIntakeRenderContext,
  planned: MatOSExternalIntakeExecutablePlannedAsset,
): {
  entry: string
  tags: string[]
  runtime?: Record<string, unknown>
  metadata: Record<string, unknown>
} {
  const wrapper = context.plan.toolWrapper
  const assist = context.plan.llmAssist?.enabled ? context.plan.llmAssist : undefined
  const paperSummary = context.plan.paper?.summary?.enabled
    ? context.plan.paper.summary
    : undefined
  const extraction = context.plan.paper?.extraction
  const base: Record<string, unknown> = {
    executablePlanner: MATOS_EXTERNAL_INTAKE_EXECUTABLE_PLANNER,
    ...(assist
      ? {
          llmAssist: {
            model: assist.model,
            summary: assist.summary,
            ...(assist.license ? { license: assist.license } : {}),
            dependencies: assist.dependencies,
            preflight: assist.preflight,
          },
        }
      : {}),
  }
  if (planned.type === 'tool' && planned.executable && wrapper) {
    return {
      entry: './tool.py',
      tags: ['executable'],
      metadata: {
        ...base,
        kind: 'external-tool',
        binding: `mcp__matos_asset__${normalizeMatOSToolName(planned.id)}`,
        promptPath: 'prompt.md',
        inputSchemaPath: 'input.schema.json',
        isReadOnly: false,
        isDestructive: false,
        executor: {
          type: 'matos-python',
          runtime: 'python3',
          entry: './tool.py',
          timeoutMs: TOOL_TIMEOUT_MS,
          mcpName: normalizeMatOSToolName(planned.id),
        },
        execution: {
          sourcePath: context.intake.sourcePath,
          sourceEntry: wrapper.sourceEntry,
          runtime: wrapper.runtime,
          entrypointOrigin: wrapper.origin,
          dryRunSupported: true,
        },
      },
    }
  }
  if (planned.type === 'workflow' && planned.executable && wrapper) {
    return {
      entry: 'workflow.yaml',
      tags: ['executable'],
      runtime: {
        workflow: { kind: 'executable', engine: 'cmatos-native-workflow' },
      },
      metadata: {
        ...base,
        executable: true,
        execution: {
          sourcePath: context.intake.sourcePath,
          sourceEntry: wrapper.sourceEntry,
          runtime: wrapper.runtime,
        },
      },
    }
  }
  if (planned.type === 'knowledge') {
    return {
      entry: 'KNOWLEDGE.md',
      tags: ['summarized'],
      metadata: {
        ...base,
        ...(extraction
          ? {
              paperExtraction: {
                ok: extraction.ok,
                method: extraction.method,
                ...(extraction.title ? { title: extraction.title } : {}),
                ...(extraction.textDigest
                  ? { textDigest: extraction.textDigest }
                  : {}),
                ...(extraction.totalChars !== undefined
                  ? { totalChars: extraction.totalChars }
                  : {}),
                ...(extraction.reason ? { reason: extraction.reason } : {}),
              },
            }
          : {}),
        ...(paperSummary
          ? {
              paperSummary: {
                model: paperSummary.model,
                ...(paperSummary.citation
                  ? { citation: paperSummary.citation }
                  : {}),
                tags: paperSummary.tags,
              },
            }
          : {}),
      },
    }
  }
  if (planned.type === 'skill') {
    return {
      entry: 'SKILL.md',
      tags: planned.role === 'derived-skill-protocol' ? ['protocol'] : [],
      metadata: {
        ...base,
        ...(paperSummary?.citation ? { citation: paperSummary.citation } : {}),
      },
    }
  }
  if (planned.type === 'benchmark') {
    return {
      entry: 'case.json',
      tags: ['generated-benchmark'],
      metadata: {
        ...base,
        benchmarkRole: planned.role,
      },
    }
  }
  return {
    entry: planned.entryFile,
    tags: [],
    metadata: base,
  }
}

/**
 * Renders the non-manifest entry files for one planned asset. The manifest
 * itself is rendered by the draft-pack layer (shared provenance shape plus
 * `externalIntakeExecutableManifestExtras`).
 */
export function renderExternalIntakeExecutableFiles(
  context: MatOSExternalIntakeRenderContext,
  planned: MatOSExternalIntakeExecutablePlannedAsset,
  referenceEntry: string,
): Array<{ fileName: string; content: string }> {
  const files: Array<{ fileName: string; content: string }> = []
  for (const fileName of planned.files) {
    if (fileName === REFERENCE_FILE) {
      files.push({ fileName, content: referenceEntry })
      continue
    }
    if (fileName === 'KNOWLEDGE.md') {
      files.push({ fileName, content: renderExternalIntakeKnowledgeEntry(context) })
      continue
    }
    if (fileName === 'SKILL.md') {
      files.push({
        fileName,
        content: renderExternalIntakeSkillEntry(context, planned),
      })
      continue
    }
    if (fileName === 'tool.py') {
      files.push({
        fileName,
        content: renderExternalIntakeToolWrapperScript(context),
      })
      continue
    }
    if (fileName === 'input.schema.json') {
      files.push({ fileName, content: renderExternalIntakeToolInputSchema() })
      continue
    }
    if (fileName === 'prompt.md') {
      files.push({
        fileName,
        content: renderExternalIntakeToolPrompt(context),
      })
      continue
    }
    if (fileName === 'workflow.yaml') {
      files.push({
        fileName,
        content: renderExternalIntakeWorkflowEntry(context),
      })
      continue
    }
    if (fileName === 'case.json') {
      files.push({
        fileName,
        content: renderExternalIntakeBenchmarkCase(context, planned),
      })
      continue
    }
    throw new Error(`Unknown executable intake file: ${fileName}`)
  }
  return files
}
