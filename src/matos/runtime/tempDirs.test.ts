import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import {
  isRootTmpPath,
  resolveMatOSTmpRoot,
} from './tempDirs.js'

describe('MatOS temp directory policy', () => {
  test('classifies root tmp paths as forbidden defaults', () => {
    expect(isRootTmpPath('/tmp')).toBe(true)
    expect(isRootTmpPath('/tmp/matos-runtime')).toBe(true)
    expect(isRootTmpPath('/workspace/caches/tmp')).toBe(false)
    expect(isRootTmpPath('/home/workspace/.cache/tmp')).toBe(false)
  })

  test('ignores host TMPDIR=/tmp and uses deploy-root temp', () => {
    expect(
      resolveMatOSTmpRoot('/repo', {
        TMPDIR: '/tmp',
        MATOS_DEPLOY_ROOT: '/srv/matos-state',
      }),
    ).toBe('/srv/matos-state/tmp/host')
  })

  test('falls back to project-local temporary storage', () => {
    expect(resolveMatOSTmpRoot('/repo', { TMPDIR: '/tmp' })).toBe(
      '/repo/.matos/tmp',
    )
  })

  test('uses persistent home cache inside workspace containers', () => {
    expect(
      resolveMatOSTmpRoot('/workspace/group/shared', {
        HOME: '/home/workspace',
        TMPDIR: '/tmp',
      }),
    ).toBe(join('/home/workspace', '.cache', 'tmp'))
  })
})
