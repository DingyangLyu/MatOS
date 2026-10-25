// Bounded in-memory capture for local node child stdout/stderr.
//
// Exec and agent children can legitimately produce very large output (hours
// of solver logs); accumulating it unbounded in the orchestrator both risks
// OOM and bloats node-run.json, which every scheduling round re-reads. The
// runtime therefore retains only a bounded tail in memory / run records and
// spills the full stream to a file in the node-run dir.
//
// Note for failure-signature scans: close-time scans now see this retained
// tail (not the full stream). The retained window is deliberately much larger
// than the 64 KiB streaming scan window, and the complete stream remains
// available in the spill file for forensics.

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs'
import { join } from 'node:path'

export const MAX_RETAINED_STREAM_CHARS = 128_000

/**
 * Append a chunk to a retained tail, keeping at most
 * MAX_RETAINED_STREAM_CHARS of the most recent output.
 */
export function retainBoundedStreamTail(previous: string, chunk: string): string {
  const combined = `${previous}${chunk}`
  return combined.length <= MAX_RETAINED_STREAM_CHARS
    ? combined
    : combined.slice(-MAX_RETAINED_STREAM_CHARS)
}

export type NodeStreamSpill = {
  write: (chunk: string) => void
  end: () => void
}

/**
 * Best-effort full-stream spill file under the node-run dir (for example
 * `node-runs/<nodeId>/live-stdout.log`), truncated at the start of each
 * attempt. Spill failures never break node execution; the bounded in-memory
 * tail is still captured.
 */
export function createNodeStreamSpill(
  runDir: string | undefined,
  nodeId: string,
  fileName: string,
): NodeStreamSpill | undefined {
  if (!runDir) {
    return undefined
  }
  let stream: WriteStream | undefined
  try {
    const dir = join(runDir, 'node-runs', nodeId)
    mkdirSync(dir, { recursive: true })
    stream = createWriteStream(join(dir, fileName), { flags: 'w' })
    stream.on('error', () => {
      stream = undefined
    })
  } catch {
    return undefined
  }
  return {
    write: chunk => {
      try {
        stream?.write(chunk)
      } catch {
        stream = undefined
      }
    },
    end: () => {
      try {
        stream?.end()
      } catch {
        // Best-effort.
      }
    },
  }
}
