import { randomBytes } from 'node:crypto'
import { mkdir,readFile,readdir,writeFile } from 'node:fs/promises'
import { basename,join } from 'node:path'
import { getMatOSDir } from '../project.js'

export type MatOSWorkbenchEvolutionAuditAction = 'reject'

export type MatOSWorkbenchEvolutionAuditActionRecord = {
  schemaVersion: 1
  actionId: string
  action: MatOSWorkbenchEvolutionAuditAction
  status: 'recorded'
  recordRef: string
  targetRef?: string
  reason?: string
  fingerprint?: string
  createdAt: string
  source: 'matos-workbench'
  provenance: {
    operation: 'evolution.action'
    nativeAction: MatOSWorkbenchEvolutionAuditAction
    detailKind: string
    detailStatus?: string
  }
  validation: {
    ok: true
    errors: []
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function auditActionRecordsDir(cwd: string): string {
  return join(getMatOSDir(cwd), 'evolution', 'audit-actions')
}

function actionId(action: string, recordRef: string): string {
  const safe = `${action}-${recordRef}`
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
  return `evolution-audit-${safe || 'action'}-${randomBytes(4).toString('hex')}`
}

function normalizeRecord(value: unknown): MatOSWorkbenchEvolutionAuditActionRecord | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  if (
    record.schemaVersion !== 1 ||
    typeof record.actionId !== 'string' ||
    record.action !== 'reject' ||
    record.status !== 'recorded' ||
    typeof record.recordRef !== 'string' ||
    typeof record.createdAt !== 'string'
  ) {
    return undefined
  }
  return record as MatOSWorkbenchEvolutionAuditActionRecord
}

export async function recordMatOSWorkbenchEvolutionAuditAction(input: {
  cwd: string
  action: MatOSWorkbenchEvolutionAuditAction
  recordRef: string
  targetRef?: string
  reason?: string
  fingerprint?: string
  detailKind: string
  detailStatus?: string
}): Promise<MatOSWorkbenchEvolutionAuditActionRecord> {
  const record: MatOSWorkbenchEvolutionAuditActionRecord = {
    schemaVersion: 1,
    actionId: actionId(input.action, input.recordRef),
    action: input.action,
    status: 'recorded',
    recordRef: input.recordRef,
    ...(input.targetRef ? { targetRef: input.targetRef } : {}),
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.fingerprint ? { fingerprint: input.fingerprint } : {}),
    createdAt: nowIso(),
    source: 'matos-workbench',
    provenance: {
      operation: 'evolution.action',
      nativeAction: input.action,
      detailKind: input.detailKind,
      ...(input.detailStatus ? { detailStatus: input.detailStatus } : {}),
    },
    validation: {
      ok: true,
      errors: [],
    },
  }
  const dir = auditActionRecordsDir(input.cwd)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, `${record.actionId}.json`),
    `${JSON.stringify(record, null, 2)}\n`,
    'utf8',
  )
  return record
}

export async function listMatOSWorkbenchEvolutionAuditActions(
  cwd: string,
): Promise<MatOSWorkbenchEvolutionAuditActionRecord[]> {
  let entries: string[]
  try {
    entries = await readdir(auditActionRecordsDir(cwd))
  } catch {
    return []
  }
  const records = await Promise.all(
    entries
      .filter(entry => entry.endsWith('.json'))
      .map(async entry => {
        try {
          const raw = await readFile(join(auditActionRecordsDir(cwd), entry), 'utf8')
          return normalizeRecord(JSON.parse(raw))
        } catch {
          return undefined
        }
      }),
  )
  return records
    .filter((record): record is MatOSWorkbenchEvolutionAuditActionRecord => Boolean(record))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readMatOSWorkbenchEvolutionAuditAction(
  cwd: string,
  ref: string,
): Promise<MatOSWorkbenchEvolutionAuditActionRecord | undefined> {
  return (await listMatOSWorkbenchEvolutionAuditActions(cwd)).find(
    record =>
      record.actionId === ref ||
      basename(record.actionId) === ref,
  )
}
