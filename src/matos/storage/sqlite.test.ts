import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { openMatOSSqliteDatabase } from './sqlite.js'

describe('openMatOSSqliteDatabase', () => {
  test('stays usable after BEGIN fails on a locked database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-sqlite-'))
    const path = join(root, 'ledger.sqlite')
    const holder = await openMatOSSqliteDatabase(path)
    const writer = await openMatOSSqliteDatabase(path)
    try {
      holder.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY)')
      writer.exec('PRAGMA busy_timeout = 0')
      holder.exec('BEGIN IMMEDIATE')
      expect(() =>
        writer.transaction(() => writer.query('INSERT INTO rows DEFAULT VALUES').run()),
      ).toThrow(/locked|busy/i)
      holder.exec('COMMIT')

      writer.transaction(() => writer.query('INSERT INTO rows DEFAULT VALUES').run())
      expect(writer.query('SELECT COUNT(*) AS n FROM rows').get()).toEqual({ n: 1 })
    } finally {
      holder.close()
      writer.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps the original error when the callback throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'matos-sqlite-'))
    const db = await openMatOSSqliteDatabase(join(root, 'ledger.sqlite'))
    try {
      db.exec('CREATE TABLE rows (id INTEGER PRIMARY KEY)')
      expect(() =>
        db.transaction(() => {
          db.query('INSERT INTO rows DEFAULT VALUES').run()
          throw new Error('boom')
        }),
      ).toThrow('boom')
      expect(db.query('SELECT COUNT(*) AS n FROM rows').get()).toEqual({ n: 0 })
    } finally {
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
