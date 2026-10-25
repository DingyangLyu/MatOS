import { describe, expect, test } from 'bun:test'

import { redactMatOSAssetOutput } from './outputRedaction'

describe('redactMatOSAssetOutput host path redaction', () => {
  test('redacts container-internal /root harness paths from user-visible prose', () => {
    const value = {
      description:
        'Ran the script from /root/.claude/session-env/61d483a1-aaaa-bbbb and cached pip in /root/.cache/pip',
      examples: [
        { excerpt: 'python interpreter at /root/miniconda3/bin/python3' },
      ],
    }
    const redacted = redactMatOSAssetOutput(value) as typeof value
    const serialized = JSON.stringify(redacted)
    expect(serialized).not.toContain('/root/.claude')
    expect(serialized).not.toContain('/root/.cache')
    expect(serialized).not.toContain('/root/miniconda3')
    expect(serialized).toContain('<redacted-path>')
  })

  test('redacts host/private roots while preserving container-visible asset roots', () => {
    const value = {
      a: 'see /srv/matos-test-fixtures/secret',
      b: 'home dir /home/workspace/.cache',
      c: 'tool path /opt/matos-tools/conda',
      d: 'scratch /tmp/claude-tmp/x',
      e: 'group data /workspace/group/private',
      f: 'knowledge data /workspace/knowledge/material-bench-datasets',
    }
    const serialized = JSON.stringify(redactMatOSAssetOutput(value))
    expect(serialized).not.toContain('/vepfs-mlp2')
    expect(serialized).not.toContain('/home/workspace')
    expect(serialized).not.toContain('/tmp/claude-tmp')
    expect(serialized).not.toContain('/workspace/group')
    expect(serialized).toContain('/opt/matos-tools/conda')
    expect(serialized).toContain('/workspace/knowledge/material-bench-datasets')
  })

  test('preserves shell parameter expansion braces and container-visible default paths', () => {
    const value = {
      command:
        'PYBIN="${MATOS_MLIP_PYTHON:-/opt/matos-tools/conda/envs/matos-compute/bin/python}"',
    }
    const redacted = redactMatOSAssetOutput(value) as typeof value
    expect(redacted.command).toBe(
      'PYBIN="${MATOS_MLIP_PYTHON:-/opt/matos-tools/conda/envs/matos-compute/bin/python}"',
    )
  })

  test('redacts secret values by key and token-like assignments', () => {
    const value = {
      api_key: 'sk-abcdefgh12345678',
      note: 'authorization: Bearer abcdef.ghijkl.mnopqr',
    }
    const redacted = redactMatOSAssetOutput(value) as Record<string, string>
    expect(redacted.api_key).toBe('<redacted>')
    expect(JSON.stringify(redacted)).not.toContain('abcdef.ghijkl.mnopqr')
  })

  test('keeps asset identifiers that merely contain sk- and still redacts bare keys', () => {
    const value = {
      ref: 'knowledge:materials-benchmark-task-pitfalls',
      note: 'key sk-abcdefgh12345678 was used',
    }
    const redacted = redactMatOSAssetOutput(value) as typeof value
    expect(redacted.ref).toBe('knowledge:materials-benchmark-task-pitfalls')
    expect(redacted.note).toBe('key <redacted> was used')
  })

  test('preserves repeated workflow compile objects as data, not circular markers', () => {
    const budgetEstimate = {
      agentCalls: 0,
      toolCalls: 1,
      backendJobs: 0,
      childRuns: 0,
      dynamicPatches: 0,
    }
    const contracts = {
      nodes: {
        prepare: {
          outputs: {
            stdout: { type: 'string' },
          },
        },
      },
    }
    const value = {
      definition: {
        compiled: {
          budgetEstimate,
          contracts,
        },
      },
      metadata: {
        budgetEstimate,
      },
      contracts,
    }
    const redacted = redactMatOSAssetOutput(value) as typeof value
    expect(redacted.contracts.nodes.prepare.outputs.stdout.type).toBe('string')
    expect(redacted.metadata.budgetEstimate.toolCalls).toBe(1)
    expect(JSON.stringify(redacted)).not.toContain('[circular]')
  })
})
