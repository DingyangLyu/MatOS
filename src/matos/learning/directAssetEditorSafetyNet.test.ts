import { describe, expect, test } from 'bun:test'
import type { MatOSAssetHistoryValidationResult } from '../assets/history/index.js'
import {
  defaultDirectEditorRunId,
  evaluateDirectEditorUsability,
} from './directAssetEditor.js'
import { assertSafeEvolutionRecordId } from './evolutionRecordPaths.js'

function validationResult(
  overrides: Partial<MatOSAssetHistoryValidationResult>,
): MatOSAssetHistoryValidationResult {
  return {
    ok: true,
    gateProfile: 'smoke',
    assetValidation: { ok: true, errors: [] },
    secretScan: { ok: true, findings: [] },
    workflowValidation: [],
    ...overrides,
  }
}

describe('direct editor run id entropy', () => {
  test('millisecond sortable prefix plus random suffix avoids concurrent collisions', () => {
    const ids = Array.from({ length: 64 }, () => defaultDirectEditorRunId())
    expect(new Set(ids).size).toBe(64)
    for (const id of ids) {
      expect(id).toMatch(/^direct-editor-\d{8}T\d{9}Z-[0-9a-f]{8}$/)
      expect(assertSafeEvolutionRecordId(id, 'direct editor run id')).toBe(id)
    }
  })
})

describe('direct editor usability gate', () => {
  test('secret findings are reported as the introduced errors', () => {
    const result = evaluateDirectEditorUsability(
      undefined,
      validationResult({
        ok: false,
        assetValidation: {
          ok: false,
          errors: [{ code: 'pre_existing', message: 'environmental breakage' }],
        },
        secretScan: {
          ok: false,
          findings: [{ path: 'skills/x/.env', reason: 'secret-looking value' }],
        },
      }),
    )
    expect(result.usable).toBe(false)
    expect(result.introducedErrors).toEqual([
      {
        code: 'secret_finding',
        path: 'skills/x/.env',
        message: 'secret-looking value',
      },
    ])
  })

  test('an unavailable baseline cannot classify invalid after errors as pre-existing', () => {
    const result = evaluateDirectEditorUsability(
      undefined,
      validationResult({
        ok: false,
        assetValidation: {
          ok: false,
          errors: [
            { code: 'missing_dependency', message: 'environmental breakage' },
          ],
        },
      }),
      { baselineUnavailable: true },
    )
    expect(result.usable).toBe(false)
    expect(result.introducedErrors).toMatchObject([
      { code: 'baseline_validation_unavailable' },
      { code: 'missing_dependency' },
    ])
  })

  test('secret findings still hard-fail even when the baseline is unavailable', () => {
    const result = evaluateDirectEditorUsability(
      undefined,
      validationResult({
        ok: false,
        secretScan: {
          ok: false,
          findings: [{ path: 'roles/y/.env', reason: 'secret-looking value' }],
        },
      }),
      { baselineUnavailable: true },
    )
    expect(result.usable).toBe(false)
    expect(result.introducedErrors).toHaveLength(1)
  })

  test('a merely-missing baseline (not crashed) still runs the differential gate', () => {
    const result = evaluateDirectEditorUsability(
      undefined,
      validationResult({
        ok: false,
        assetValidation: {
          ok: false,
          errors: [{ code: 'broken_manifest', message: 'introduced breakage' }],
        },
      }),
    )
    expect(result.usable).toBe(false)
    expect(result.introducedErrors).toHaveLength(1)
  })
})
