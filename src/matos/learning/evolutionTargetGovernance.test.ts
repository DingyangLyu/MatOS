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

import { describe, expect, test } from 'bun:test'
import {
  buildMatOSEvolutionTargetContract,
  evaluateMatOSEvolutionHighRiskAssetPolicy,
  evaluateMatOSEvolutionTargetConformance,
} from './evolutionTargetGovernance.js'

test('actual snapshot targets override fabricated editor claims', () => {
  const result = evaluateMatOSEvolutionTargetConformance({
    contract: { schemaVersion: 1, mode: 'strict', expectedTypes: ['tool'], preferredRefs: ['tool:submit'] },
    editorOutput: { targetDecision: { selectedTypes: ['tool'], selectedRefs: ['tool:submit'] }, updatedAssets: ['tool:submit'] },
    actualRefs: ['knowledge:runbook@1.0.0'],
  })
  expect(result.allowed).toBe(false)
  expect(result.actualTypes).toEqual(['knowledge'])
})

test('supporting knowledge alone cannot satisfy a behavioral repair contract', () => {
  const result = evaluateMatOSEvolutionTargetConformance({
    contract: { schemaVersion: 1, mode: 'strict', expectedTypes: ['tool', 'knowledge'], requiredAnyTypes: ['tool'], preferredRefs: ['tool:submit', 'knowledge:runbook'] },
    editorOutput: {}, actualRefs: ['knowledge:runbook@1.0.0'],
  })
  expect(result.allowed).toBe(false)
})

describe('MatOS evolution target governance', () => {
  test('defaults explicit tool feedback to a strict behavioral target', () => {
    const contract = buildMatOSEvolutionTargetContract({
      feedbackAnalysis: {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'The submit tool needs a deterministic preflight.',
        signals: [
          {
            id: 'submit-preflight',
            kind: 'correction',
            severity: 'high',
            explicitness: 'explicit',
            claim: 'Prevent duplicate active task submissions.',
            target: {
              assetTypes: ['tool'],
              roleRefs: [],
              toolNames: ['hpc_submit'],
              toolRefs: ['tool:hpc-submit@1.0.0'],
              workflowRefs: [],
            },
            evidenceExcerpt: 'The same submit was attempted again.',
            sourceEventRefs: ['event:tool-1'],
            confidence: 0.95,
          },
        ],
        decisions: [
          {
            signalId: 'submit-preflight',
            reasonableness: 'strong',
            evidenceSupport: 'supported',
            generalizability: 'global',
            risk: 'low',
            recommendedAction: 'direct_edit',
            why: 'A deterministic guard belongs in the tool.',
            counterArguments: [],
            confidence: 0.95,
          },
        ],
      },
    })

    expect(contract).toMatchObject({
      mode: 'strict',
      expectedTypes: ['tool'],
    })
    expect(contract?.preferredRefs).toContain('tool:hpc-submit@1.0.0')

    const conformance = evaluateMatOSEvolutionTargetConformance({
      contract,
      editorOutput: {
        updatedAssets: ['knowledge:hpc-submit-runbook@1.0.0'],
      },
    })
    expect(conformance).toMatchObject({
      status: 'deviated',
      allowed: false,
      severity: 'high',
    })
  })

  test('bare tool-name mentions without the tool asset type stay advisory', () => {
    const contract = buildMatOSEvolutionTargetContract({
      feedbackAnalysis: {
        schemaVersion: 1,
        shouldUseFeedback: true,
        summary: 'The Bash usage guidance should mention the sandbox flag.',
        signals: [
          {
            id: 'bash-guidance',
            kind: 'correction',
            severity: 'medium',
            explicitness: 'explicit',
            claim: 'Document the sandbox flag before running Bash.',
            target: {
              assetTypes: ['knowledge'],
              roleRefs: [],
              toolNames: ['Bash'],
              toolRefs: [],
              workflowRefs: [],
              knowledgeRefs: ['knowledge:bash-usage@1.0.0'],
            },
            evidenceExcerpt: 'User corrected the Bash invocation twice.',
            sourceEventRefs: ['event:turn-1'],
            confidence: 0.9,
          },
        ],
        decisions: [
          {
            signalId: 'bash-guidance',
            reasonableness: 'strong',
            evidenceSupport: 'supported',
            generalizability: 'global',
            risk: 'low',
            recommendedAction: 'direct_edit',
            why: 'The runbook should carry the correction.',
            counterArguments: [],
            confidence: 0.9,
          },
        ],
      },
    })

    // Critic prose naming a built-in tool must not mint strict contracts at
    // nonexistent tool: refs (deterministic rollback after paid LLM calls).
    expect(contract?.mode).toBe('advisory')
    expect(contract?.expectedTypes).not.toContain('tool')
    expect(contract?.preferredRefs ?? []).not.toContain('tool:bash')
    expect(contract?.preferredRefs).toContain('knowledge:bash-usage@1.0.0')
  })

  test('blocks advisory role fallback when a workflow target contract exists', () => {
    const contract = {
      schemaVersion: 1 as const,
      mode: 'advisory' as const,
      expectedTypes: ['workflow' as const],
      preferredRefs: ['workflow:image-to-xrd-phase@2.0.0'],
      disallowedFallbackTypes: ['role' as const],
    }
    const editorOutput = {
      targetDecision: {
        selectedTypes: ['role' as const],
        selectedRefs: ['role:experimental-xrd@1.0.0'],
        fallbackUsed: true,
      },
      createdAssets: [],
      updatedAssets: ['role:experimental-xrd@1.0.0'],
      disabledAssets: [],
    }
    const targetConformance = evaluateMatOSEvolutionTargetConformance({
      contract,
      editorOutput,
    })
    const policy = evaluateMatOSEvolutionHighRiskAssetPolicy({
      contract,
      targetConformance,
      editorOutput,
    })

    expect(targetConformance.status).toBe('deviated')
    expect(targetConformance.allowed).toBe(true)
    expect(policy).toMatchObject({
      status: 'blocked',
      blocked: true,
      highRiskActualTypes: ['role'],
      highRiskExpectedTypes: ['workflow'],
    })
  })

  test('blocks new role or workflow assets without an explicit matching contract', () => {
    const editorOutput = {
      createdAssets: ['workflow:auto-generated-workflow@0.1.0'],
      updatedAssets: [],
      disabledAssets: [],
    }
    const targetConformance = evaluateMatOSEvolutionTargetConformance({
      editorOutput,
    })
    const policy = evaluateMatOSEvolutionHighRiskAssetPolicy({
      targetConformance,
      editorOutput,
    })

    expect(policy).toMatchObject({
      status: 'blocked',
      blocked: true,
      highRiskCreatedTypes: ['workflow'],
    })
    expect(policy.reason).toContain('requires an explicit target contract')
  })

  test('allows a new workflow only when it matches the explicit workflow contract', () => {
    const contract = {
      schemaVersion: 1 as const,
      mode: 'strict' as const,
      expectedTypes: ['workflow' as const],
      preferredRefs: ['workflow:auto-generated-workflow@0.1.0'],
    }
    const editorOutput = {
      targetDecision: {
        selectedTypes: ['workflow' as const],
        selectedRefs: ['workflow:auto-generated-workflow@0.1.0'],
        fallbackUsed: false,
      },
      createdAssets: ['workflow:auto-generated-workflow@0.1.0'],
      updatedAssets: [],
      disabledAssets: [],
    }
    const targetConformance = evaluateMatOSEvolutionTargetConformance({
      contract,
      editorOutput,
    })
    const policy = evaluateMatOSEvolutionHighRiskAssetPolicy({
      contract,
      targetConformance,
      editorOutput,
    })

    expect(targetConformance.status).toBe('matched')
    expect(policy).toMatchObject({
      status: 'clear',
      blocked: false,
      highRiskCreatedTypes: ['workflow'],
      highRiskExpectedTypes: ['workflow'],
    })
  })

  test('allows an explicitly expected role alongside a narrower skill target', () => {
    const contract = {
      schemaVersion: 1 as const,
      mode: 'strict' as const,
      expectedTypes: ['role' as const, 'skill' as const],
      preferredRefs: [],
      disallowedFallbackTypes: ['role' as const],
    }
    const editorOutput = {
      targetDecision: {
        selectedTypes: ['role' as const, 'skill' as const],
        selectedRefs: [
          'role:cu-diffusion-benchmark@0.1.1',
          'skill:cu-vacancy-self-diffusion@0.1.0',
        ],
        fallbackUsed: false,
      },
      createdAssets: [],
      updatedAssets: [
        'role:cu-diffusion-benchmark@0.1.1',
        'skill:cu-vacancy-self-diffusion@0.1.0',
      ],
      disabledAssets: [],
    }
    const targetConformance = evaluateMatOSEvolutionTargetConformance({
      contract,
      editorOutput,
    })
    const policy = evaluateMatOSEvolutionHighRiskAssetPolicy({
      contract,
      targetConformance,
      editorOutput,
    })

    expect(targetConformance).toMatchObject({
      status: 'matched',
      allowed: true,
      actualTypes: ['role', 'skill'],
      fallbackUsed: false,
    })
    expect(policy).toMatchObject({
      status: 'clear',
      blocked: false,
      highRiskActualTypes: ['role'],
      highRiskExpectedTypes: ['role'],
    })
  })
})
