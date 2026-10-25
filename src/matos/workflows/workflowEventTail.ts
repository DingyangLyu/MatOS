import { open } from 'node:fs/promises'
import type { MatOSWorkflowEvent } from './types.js'

const CHUNK_BYTES = 64 * 1024
const MAX_SCAN_BYTES = 8 * 1024 * 1024

/** Read complete recent records backwards, without materializing the log. */
export async function readWorkflowEventTail(file: string, tail: number): Promise<MatOSWorkflowEvent[]> {
  if (!Number.isSafeInteger(tail) || tail < 1 || tail > 1000) {
    throw new Error('Workflow event tail must be an integer between 1 and 1000')
  }
  const handle = await open(file, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!handle) return []
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Workflow event log is not a regular file')
    let position = info.size
    let scanned = 0
    let suffix: Buffer = Buffer.alloc(0)
    const events: MatOSWorkflowEvent[] = []
    const accept = (line: Buffer) => {
      if (!line.length) return
      try {
        const event = JSON.parse(line.toString('utf8')) as MatOSWorkflowEvent
        if (event && typeof event.type === 'string') events.push(event)
      } catch {
        // A partially appended or crash-truncated record is retried next poll.
      }
    }
    while (position > 0 && events.length < tail) {
      const length = Math.min(CHUNK_BYTES, position, MAX_SCAN_BYTES - scanned)
      if (length === 0) throw new Error('Workflow event tail exceeds the 8 MiB read budget; request fewer events')
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, position)
      if (bytesRead !== length) throw new Error('Workflow event log changed during read; retry')
      scanned += bytesRead
      const bytes = Buffer.concat([chunk, suffix])
      let end = bytes.length
      for (let index = end - 1; index >= 0; index--) {
        if (bytes[index] !== 10) continue
        accept(bytes.subarray(index + 1, end))
        end = index
        if (events.length === tail) return events.reverse()
      }
      // Preserve raw bytes until a full line is available, including UTF-8
      // characters split across chunks.
      suffix = Buffer.from(bytes.subarray(0, end))
    }
    if (position === 0 && events.length < tail) accept(suffix)
    return events.reverse()
  } finally { await handle.close() }
}
