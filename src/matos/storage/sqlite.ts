export type MatOSSqliteStatement = {
  run: (...params: unknown[]) => unknown
  get: (...params: unknown[]) => unknown
  all: (...params: unknown[]) => unknown[]
}

export type MatOSSqliteDatabase = {
  exec: (sql: string) => unknown
  query: (sql: string) => MatOSSqliteStatement
  transaction: <T>(fn: () => T) => T
  close: () => void
}

type BunSqliteModule = {
  Database: new (
    path: string,
    options?: { create?: boolean },
  ) => {
    exec: (sql: string) => unknown
    query: (sql: string) => MatOSSqliteStatement
    close: () => void
  }
}

type NodeSqliteModule = {
  DatabaseSync: new (path: string) => {
    exec: (sql: string) => unknown
    prepare: (sql: string) => {
      run: (...params: unknown[]) => unknown
      get: (...params: unknown[]) => unknown
      all: (...params: unknown[]) => unknown[]
    }
    close: () => void
  }
}

function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined'
}

export async function openMatOSSqliteDatabase(
  path: string,
): Promise<MatOSSqliteDatabase> {
  const wrap = (db: Omit<MatOSSqliteDatabase, 'transaction'>): MatOSSqliteDatabase => {
    // The gateway process and MatOS CLI commands (`matos gateway users ...`)
    // open the same database file from separate processes. Without a busy
    // timeout, a write that collides with another process's write transaction
    // fails immediately with SQLITE_BUSY instead of waiting for the lock.
    db.exec('PRAGMA busy_timeout = 5000')
    let inTransaction = false
    return {
      exec: sql => db.exec(sql),
      query: sql => db.query(sql),
      transaction: fn => {
        if (inTransaction) {
          throw new Error('Nested MatOS SQLite transactions are not supported')
        }
        // BEGIN can fail with SQLITE_BUSY once busy_timeout expires. Set the
        // flag only after it succeeds so the connection stays usable.
        db.exec('BEGIN IMMEDIATE')
        inTransaction = true
        try {
          const result = fn()
          db.exec('COMMIT')
          return result
        } catch (error) {
          // SQLite may already have rolled back (e.g. SQLITE_FULL); keep the
          // original error instead of a 'no transaction is active' one.
          try {
            db.exec('ROLLBACK')
          } catch {}
          throw error
        } finally {
          inTransaction = false
        }
      },
      close: () => db.close(),
    }
  }

  if (isBunRuntime()) {
    const specifier = 'bun:sqlite'
    const { Database } = (await import(specifier)) as BunSqliteModule
    return wrap(new Database(path, { create: true }))
  }

  const specifier = 'node:sqlite'
  const { DatabaseSync } = (await import(specifier)) as NodeSqliteModule
  const db = new DatabaseSync(path)
  return wrap({
    exec: sql => db.exec(sql),
    query: sql => {
      const statement = db.prepare(sql)
      return {
        run: (...params) => statement.run(...params),
        get: (...params) => statement.get(...params),
        all: (...params) => statement.all(...params),
      }
    },
    close: () => db.close(),
  })
}
