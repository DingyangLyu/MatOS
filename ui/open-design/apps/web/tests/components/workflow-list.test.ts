import { expect, it } from 'vitest';
import { isWorkflowDraftFileName, workflowReferenceLabel } from '../../src/components/workflow-model';

it('does not offer internal published snapshots as editable project drafts', () => {
  expect(isWorkflowDraftFileName('experiments/quality.workflow.json')).toBe(true);
  expect(isWorkflowDraftFileName('workflow.yaml')).toBe(true);
  expect(isWorkflowDraftFileName('.matos/assets/workflows/quality/workflow.json')).toBe(false);
  expect(isWorkflowDraftFileName('nested/.matos/assets/workflow.yaml')).toBe(false);
  expect(isWorkflowDraftFileName('notes.md')).toBe(false);
});

it('shortens only the exact content-addressed canvas reference format', () => {
  expect(workflowReferenceLabel('workflow:sample-preparation-27098e43560a-c92623873cf7b160@0.1.0-canvas.c92623873cf7b160')).toBe('sample-preparation');
  expect(workflowReferenceLabel('workflow:co-pt111-adsorption@1.0.0')).toBe('co-pt111-adsorption');
  expect(workflowReferenceLabel('workflow:sample-27098e43560a-c92623873cf7b160@1.0.0')).toBe('sample-27098e43560a-c92623873cf7b160');
  expect(workflowReferenceLabel(null)).toBe('-');
});
