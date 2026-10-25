import { afterEach, expect, test } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkflowRunEvents } from './workflowStore.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(text: string) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-event-tail-'))
  roots.push(root)
  await writeFile(join(root, 'events.jsonl'), text)
  return root
}
const event = (id: string, text = '') => JSON.stringify({ id, type: 'workflow.node.completed', data: { text } })

test('bounded tail returns recent valid records in order across UTF-8 chunk boundaries', async () => {
  const text = '\u6c49'.repeat(24_000)
  const root = await fixture(event('old') + '\n' + event('wide', text) + '\n\n{bad}\n' + event('last') + '\n{"partial":')
  expect((await readWorkflowRunEvents(root, { tail: 2 })).map(x => x.id)).toEqual(['wide', 'last'])
  expect((await readWorkflowRunEvents(root, { tail: 2 }))[0]?.data).toEqual({ text })
  await appendFile(join(root, 'events.jsonl'), 'true}\n' + event('appended'))
  expect((await readWorkflowRunEvents(root, { tail: 1 })).map(x => x.id)).toEqual(['appended'])
})

test('tail reads do not inherit the 64 MiB CLI whole-log limit', async () => {
  const line = event('old', 'x'.repeat(4096)) + '\n'
  const root = await fixture(line.repeat(Math.ceil(65 * 1024 ** 2 / line.length)) + event('last') + '\n')
  expect((await readWorkflowRunEvents(root, { tail: 1 })).map(x => x.id)).toEqual(['last'])
})

test('missing logs are empty but unreadable logs and invalid limits are errors', async () => {
  const root = await fixture('')
  await rm(join(root, 'events.jsonl'))
  expect(await readWorkflowRunEvents(root, { tail: 1 })).toEqual([])
  await mkdir(join(root, 'events.jsonl'))
  await expect(readWorkflowRunEvents(root, { tail: 1 })).rejects.toThrow()
  await expect(readWorkflowRunEvents(root)).rejects.toThrow()
  for (const tail of [0, -1, 1.5, 1001, NaN]) {
    await expect(readWorkflowRunEvents(root, { tail })).rejects.toThrow(/tail/i)
  }
})

test('a huge damaged final record fails with a bounded read error', async () => {
  const root = await fixture(event('old') + '\n{"unfinished":"' + 'x'.repeat(9 * 1024 ** 2))
  await expect(readWorkflowRunEvents(root, { tail: 1 })).rejects.toThrow('read budget')
})
