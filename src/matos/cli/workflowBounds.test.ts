import { expect, test } from 'bun:test'
import { containerLifecycleArgv, parseArgs } from './workflowCliShared.js'

test('event tail limits survive CLI parsing and container forwarding', () => {
  for (const flags of [['--tail', '2'], ['--tail=2']]) {
    const parsed = parseArgs(['run-123', '--scope', 'user:test', ...flags, '--json'])
    expect(parsed.tail).toBe('2')
    const forwarded = containerLifecycleArgv('events', parsed)
    const flag = forwarded.indexOf('--tail')
    expect(flag).toBeGreaterThan(0)
    expect(forwarded[flag + 1]).toBe('2')
  }
})

test('publication revision checks survive both CLI argument forms', () => {
  const digest = 'sha256:' + 'a'.repeat(64)
  expect(parseArgs(['--expected-definition', digest]).expectedDefinition).toBe(digest)
  expect(parseArgs([`--expected-definition=${digest}`]).expectedDefinition).toBe(digest)
  expect(parseArgs(['--expected-definition']).expectedDefinition).toBe('')
})
