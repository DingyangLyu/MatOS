/*
 * Copyright 2025 coze-dev Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Context-budget guard for the mounted-workflows prompt section. The full
// per-workflow descriptions once made this the single largest
// appendSystemPrompt section (11.3K chars for 30 workflows on role:compute);
// these tests pin the capped-summary behavior so it cannot silently regress.

import { describe, expect, test } from 'bun:test'
import {
  buildMountedWorkflowsPrompt,
  buildToolPrompt,
  knowledgeSummary,
  workflowSummary,
} from './runtimeComposition.js'
import { capPromptSummary } from './promptBudget.js'
import type { MatOSAsset } from './types.js'

function workflowAsset(fields: {
  id: string
  description?: string
}): MatOSAsset {
  return {
    id: fields.id,
    type: 'workflow',
    version: '0.1.0',
    canonicalKey: `workflow:${fields.id}@0.1.0`,
    ...(fields.description !== undefined
      ? { description: fields.description }
      : {}),
  } as unknown as MatOSAsset
}

describe('workflowSummary description capping', () => {
  test('keeps short descriptions intact', () => {
    const line = workflowSummary(
      workflowAsset({ id: 'relax', description: 'Relax a structure.' }),
    )
    expect(line).toBe('- workflow:relax@0.1.0: Relax a structure.')
  })

  test('cuts at the first sentence boundary (english and chinese)', () => {
    const english = workflowSummary(
      workflowAsset({
        id: 'eos',
        description:
          'Run the EOS workchain. Then it does many other things across a very long pipeline with details nobody needs upfront.',
      }),
    )
    expect(english).toBe('- workflow:eos@0.1.0: Run the EOS workchain.')

    const chinese = workflowSummary(
      workflowAsset({
        id: 'vasp-gate',
        description:
          '轻量级 VASP 任务提交前门禁工作流。按顺序执行赝势族发现、POTCAR 验证、元素可用性检查以及更多细节步骤。',
      }),
    )
    expect(chinese).toBe(
      '- workflow:vasp-gate@0.1.0: 轻量级 VASP 任务提交前门禁工作流。',
    )
  })

  test('hard-caps a long first sentence with an ellipsis', () => {
    const line = workflowSummary(
      workflowAsset({ id: 'long', description: 'x'.repeat(600) }),
    )
    expect(line.length).toBeLessThanOrEqual(
      '- workflow:long@0.1.0: '.length + 160,
    )
    expect(line.endsWith('…')).toBe(true)
  })

  test('collapses internal newlines and whitespace', () => {
    const line = workflowSummary(
      workflowAsset({ id: 'multi', description: 'First\n  line   only' }),
    )
    expect(line).toBe('- workflow:multi@0.1.0: First line only')
  })
})

describe('buildMountedWorkflowsPrompt budget', () => {
  test('returns undefined without mounted workflows', () => {
    expect(buildMountedWorkflowsPrompt([])).toBeUndefined()
  })

  test('lists every workflow ref and points to workflow_query for details', () => {
    const prompt = buildMountedWorkflowsPrompt([
      workflowAsset({ id: 'alpha', description: 'A. Long tail.' }),
      workflowAsset({ id: 'beta' }),
    ])
    expect(prompt).toContain('workflow:alpha@0.1.0')
    expect(prompt).toContain('workflow:beta@0.1.0')
    expect(prompt).toContain('workflow_query')
    expect(prompt).toContain('action=show')
  })

  test('stays within the per-entry budget even for verbose descriptions', () => {
    const workflows = Array.from({ length: 30 }, (_, index) =>
      workflowAsset({
        id: `wf-${index}`,
        description:
          `Verbose workflow ${index} ` +
          'with an extremely long description that repeats itself endlessly '.repeat(
            12,
          ),
      }),
    )
    const prompt = buildMountedWorkflowsPrompt(workflows)!
    // 30 capped entries + guidance must stay far below the old ~11.3K chars.
    expect(prompt.length).toBeLessThan(30 * 230 + 600)
    for (const workflow of workflows) {
      expect(prompt).toContain(workflow.canonicalKey!)
    }
  })

  test('drops descriptions for entries beyond the described-entry cap', () => {
    const workflows = Array.from({ length: 45 }, (_, index) =>
      workflowAsset({
        id: `wf-${String(index).padStart(2, '0')}`,
        description: `Description ${index}.`,
      }),
    )
    const prompt = buildMountedWorkflowsPrompt(workflows)!
    expect(prompt).toContain('- workflow:wf-00@0.1.0: Description 0.')
    expect(prompt).toContain('- workflow:wf-39@0.1.0: Description 39.')
    // Tail entries stay discoverable by ref but carry no description.
    expect(prompt).toContain('- workflow:wf-44@0.1.0')
    expect(prompt).not.toContain('Description 44.')
  })
})

function toolAsset(fields: { id: string; description?: string }): MatOSAsset {
  return {
    id: fields.id,
    type: 'tool',
    version: '1.0.0',
    canonicalKey: `tool:${fields.id}@1.0.0`,
    name: fields.id,
    metadata: {},
    ...(fields.description !== undefined
      ? { description: fields.description }
      : {}),
  } as unknown as MatOSAsset
}

describe('buildToolPrompt budget', () => {
  test('caps mounted tool descriptions to first-sentence summaries', () => {
    const prompt = buildToolPrompt([
      {
        legacyName: 'matos_tool__probe',
        runtimeName: 'mcp__matos_asset__probe',
        asset: toolAsset({
          id: 'probe',
          description:
            'Summarize the runtime inventory. Then this second sentence enumerates every mounted toolchain in exhausting detail that only the tool definition itself needs to carry.',
        }),
      },
      {
        legacyName: undefined,
        runtimeName: 'mcp__matos_asset__bare',
        asset: toolAsset({ id: 'bare' }),
      },
    ])!
    expect(prompt).toContain(
      '- matos_tool__probe -> mcp__matos_asset__probe: Summarize the runtime inventory.',
    )
    expect(prompt).not.toContain('exhausting detail')
    expect(prompt).toContain('- mcp__matos_asset__bare')
  })

  test('hard-caps run-on descriptions', () => {
    const prompt = buildToolPrompt([
      {
        legacyName: undefined,
        runtimeName: 'mcp__matos_asset__runon',
        asset: toolAsset({ id: 'runon', description: 'x'.repeat(600) }),
      },
    ])!
    const line = prompt
      .split('\n')
      .find(entry => entry.startsWith('- mcp__matos_asset__runon'))!
    expect(line.length).toBeLessThanOrEqual(
      '- mcp__matos_asset__runon: '.length + 160,
    )
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('knowledgeSummary budget', () => {
  test('caps the summary line while keeping key and path', () => {
    const summaryText =
      'Use this runbook when submissions fail. ' +
      'It then goes on for paragraphs about scheduler internals that belong in the asset entry file. '.repeat(
        5,
      )
    const line = knowledgeSummary({
      id: 'runbook',
      type: 'knowledge',
      version: '1.0.0',
      name: 'Runbook',
      metadata: { summary: summaryText },
      absolutePath: '/workspace/assets/runbook',
      lifecycle: { status: 'active' },
    } as unknown as MatOSAsset)
    expect(line).toContain('- knowledge:runbook@1.0.0 (Runbook)')
    expect(line).toContain('Summary: Use this runbook when submissions fail.')
    expect(line).not.toContain('scheduler internals')
    expect(line).toContain('Path: /workspace/assets/runbook')
  })
})

describe('capPromptSummary', () => {
  test('caps at sentence boundaries and hard limit', () => {
    expect(capPromptSummary('Short one.')).toBe('Short one.')
    expect(capPromptSummary('第一句话。第二句话很长。')).toBe('第一句话。')
    expect(capPromptSummary('No boundary ' + 'y'.repeat(300)).length).toBe(160)
    expect(capPromptSummary('A. B. C.')).toBe('A.')
  })
})
