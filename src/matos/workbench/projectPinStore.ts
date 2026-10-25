import { appendFile,mkdir,readFile,writeFile } from 'node:fs/promises'
import { dirname,resolve } from 'node:path'
import type {
MatOSWorkbenchProjectPinAction
} from './types.js'

import { recordValue,stringValue,unknownArray } from './projectSearchUtils.js'

export const PROJECT_PINS_RELATIVE_PATH = '.matos/workbench/project-pins.json'
export const PROJECT_PIN_EVENTS_RELATIVE_PATH = '.matos/workbench/project-pins-events.jsonl'

export type ProjectPinRecord = {
  ref: string
  label?: string
  reason?: string
  pinnedAt: string
  updatedAt: string
}

export type ProjectPinStore = {
  schemaVersion: 1
  updatedAt?: string
  pins: ProjectPinRecord[]
}

export function projectPinsPath(cwd: string): string {
  return resolve(cwd, PROJECT_PINS_RELATIVE_PATH)
}

export function projectPinEventsPath(cwd: string): string {
  return resolve(cwd, PROJECT_PIN_EVENTS_RELATIVE_PATH)
}

export function projectPinStoreRef(): string {
  return `workbench-store:${PROJECT_PINS_RELATIVE_PATH}`
}

export function projectPinEventsRef(): string {
  return `workbench-audit:${PROJECT_PIN_EVENTS_RELATIVE_PATH}`
}

export function normalizePinRecord(value: unknown): ProjectPinRecord | undefined {
  const record = recordValue(value)
  const ref = stringValue(record.ref)
  if (!ref) {
    return undefined
  }
  const now = new Date().toISOString()
  return {
    ref,
    ...(stringValue(record.label) ? { label: stringValue(record.label) } : {}),
    ...(stringValue(record.reason) ? { reason: stringValue(record.reason) } : {}),
    pinnedAt: stringValue(record.pinnedAt) ?? stringValue(record.createdAt) ?? now,
    updatedAt: stringValue(record.updatedAt) ?? now,
  }
}

export async function readProjectPinStore(cwd: string): Promise<ProjectPinStore> {
  try {
    const parsed = JSON.parse(await readFile(projectPinsPath(cwd), 'utf8')) as unknown
    const record = recordValue(parsed)
    const pins = unknownArray(record.pins)
      .map(normalizePinRecord)
      .filter((item): item is ProjectPinRecord => Boolean(item))
    return {
      schemaVersion: 1,
      ...(stringValue(record.updatedAt) ? { updatedAt: stringValue(record.updatedAt) } : {}),
      pins,
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { schemaVersion: 1, pins: [] }
    }
    throw error
  }
}

export async function writeProjectPinStore(cwd: string, store: ProjectPinStore): Promise<void> {
  await mkdir(dirname(projectPinsPath(cwd)), { recursive: true })
  await writeFile(projectPinsPath(cwd), `${JSON.stringify(store, null, 2)}\n`, 'utf8')
}

export async function appendProjectPinEvent(
  cwd: string,
  event: MatOSWorkbenchProjectPinAction['audit']['event'],
): Promise<void> {
  await mkdir(dirname(projectPinEventsPath(cwd)), { recursive: true })
  await appendFile(projectPinEventsPath(cwd), `${JSON.stringify(event)}\n`, 'utf8')
}
