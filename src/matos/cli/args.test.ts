import { describe, expect, test } from 'bun:test'
import {
  buildAgentArgsForMatOS,
  buildAgentArgsForMatOSRun,
} from './args.js'

describe('MatOS CLI argument defaults', () => {
  test('interactive args default to bypassPermissions without replacing explicit mode', () => {
    expect(buildAgentArgsForMatOS([])).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ])

    // An explicit safer mode must NOT be accompanied by the bypass flag:
    // --dangerously-skip-permissions is only armed when the effective mode
    // is bypassPermissions.
    expect(buildAgentArgsForMatOS(['--permission-mode', 'default'])).toEqual([
      '--permission-mode',
      'default',
    ])
    expect(buildAgentArgsForMatOS(['--permission-mode', 'plan'])).toEqual([
      '--permission-mode',
      'plan',
    ])
    expect(
      buildAgentArgsForMatOS(['--permission-mode', 'bypassPermissions']),
    ).toEqual([
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ])
  })

  test('run args use existing print mode with stream-json verbose output', () => {
    expect(buildAgentArgsForMatOSRun('hello', ['--max-turns', '1'])).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
      '--max-turns',
      '1',
      '-p',
      'hello',
    ])
  })

  test('run args do not force bypass when an explicit safer permission mode is supplied', () => {
    expect(
      buildAgentArgsForMatOSRun('hello', [
        '--permission-mode',
        'dontAsk',
        '--allowed-tools',
        'Read(/tmp/matos-direct-editor-abc/**),Write(/tmp/matos-direct-editor-abc/**)',
      ]),
    ).toEqual([
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--allowed-tools',
      'Read(/tmp/matos-direct-editor-abc/**),Write(/tmp/matos-direct-editor-abc/**)',
      '-p',
      'hello',
    ])
  })
})
