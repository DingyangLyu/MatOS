import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MatOSWorkflowNode } from '../types.js'

export async function writeWorkflowHumanPrompt(
  runDir: string,
  node: MatOSWorkflowNode,
): Promise<void> {
  const messagesDir = join(runDir, 'messages')
  await mkdir(messagesDir, { recursive: true })
  await writeFile(
    join(messagesDir, `${node.id}.json`),
    `${JSON.stringify(
      {
        nodeId: node.id,
        prompt: typeof node.prompt === 'string' ? node.prompt : '',
        responseSchema: node.responseSchema,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
}

export async function writeWorkflowHumanResponse(
  runDir: string,
  nodeId: string,
  response: unknown,
): Promise<void> {
  const messagesDir = join(runDir, 'messages')
  await mkdir(messagesDir, { recursive: true })
  await writeFile(
    join(messagesDir, `${nodeId}.response.json`),
    `${JSON.stringify({ nodeId, response }, null, 2)}\n`,
    'utf8',
  )
}
